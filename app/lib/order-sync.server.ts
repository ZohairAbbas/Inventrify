import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry, type Paged } from "./shopify-graphql.server";
import { isCodOrder, parseCodGateways } from "./cod.server";
import { shopDateKey, shopWeekStart } from "./tz.server";
import { estimateDemand } from "./demand.server";

const ORDERS_QUERY = `
  query getOrders($cursor: String, $query: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          paymentGatewayNames
          tags
          displayFulfillmentStatus
          # Shopify's own carrier tracking. This is the delivery signal every shop has
          # without any courier integration: DELIVERED / NOT_DELIVERED are what make a
          # per-SKU RTO rate possible on their own.
          # trackingInfo.company is the carrier. Shopify reports it for every shop that
          # books through a tracked carrier, so RTO can be broken down per courier with
          # no courier integration at all — and in COD the spread between carriers on the
          # same route is routinely larger than the spread between products.
          fulfillments { id displayStatus updatedAt trackingInfo { company } }
          shippingAddress { city province country }
          lineItems(first: 100) {
            edges {
              node {
                variant { id sku }
                quantity
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  paymentGatewayNames: string[] | null;
  tags: string[] | null;
  displayFulfillmentStatus: string | null;
  fulfillments: {
    id: string;
    displayStatus: string | null;
    updatedAt: string | null;
    trackingInfo: { company: string | null }[] | null;
  }[];
  shippingAddress: { city: string | null; province: string | null; country: string | null } | null;
  lineItems: Paged<{
    variant: { id: string; sku: string | null } | null;
    quantity: number;
  }>;
}

interface OrdersResponse {
  orders: Paged<OrderNode>;
}

const SYNC_WINDOW_DAYS = 90;

/**
 * How far back Shopify returns orders to an app without `read_all_orders`: 60 days.
 * One day is kept in hand so the boundary day is never treated as complete.
 */
const DEFAULT_ORDER_ACCESS_DAYS = 59;

const DAY_MS = 86400000;

const ACCESS_SCOPES_QUERY = `
  query accessScopes {
    currentAppInstallation { accessScopes { handle } }
  }
`;

/**
 * Whether this installation can read orders older than 60 days.
 *
 * Asked of Shopify rather than read from the stored session, because the granted scopes
 * are what bound the order walk. Any failure answers false: assuming the shorter window
 * only means reconciling fewer days, whereas wrongly assuming the longer one deletes
 * history the walk never re-read.
 */
async function canReadAllOrders(admin: AdminApiContext): Promise<boolean> {
  try {
    const data = await graphqlWithRetry<{
      currentAppInstallation: { accessScopes: { handle: string }[] } | null;
    }>(admin, ACCESS_SCOPES_QUERY, {}, 2);
    return (data.currentAppInstallation?.accessScopes ?? []).some(
      (s) => s.handle === "read_all_orders",
    );
  } catch {
    return false;
  }
}

/**
 * The first shop-local day this walk is guaranteed to have seen in full.
 *
 * Only days on or after this are rebuilt. Anything earlier is outside what Shopify
 * returned — without `read_all_orders` that is everything past 60 days — so it must be
 * left exactly as stored. The day containing the window's edge is skipped as well,
 * because the walk saw only part of it.
 */
export function reconcileFloor(
  now: Date,
  hasAllOrders: boolean,
  timezone: string,
): Date {
  const days = hasAllOrders ? SYNC_WINDOW_DAYS : DEFAULT_ORDER_ACCESS_DAYS;
  const edge = shopDateKey(new Date(now.getTime() - days * DAY_MS), timezone);
  return new Date(edge.getTime() + DAY_MS);
}

/**
 * Reconcile recent demand history against Shopify.
 *
 * ORDERS_CREATE keeps demand current in real time; this re-derives the days Shopify
 * actually returns to repair anything missed while the app was down or webhooks were
 * failing. That is the last 60 days, or 90 with `read_all_orders`. Older rows are
 * never touched: they are the only record of that demand.
 */
export async function syncOrderHistory(
  admin: AdminApiContext,
  shop: string,
): Promise<{
  recordsSynced: number;
  recordsDeleted: number;
  variantsSeen: number;
  completed: boolean;
  error?: string;
}> {
  const now = new Date();
  const since = new Date(now.getTime() - SYNC_WINDOW_DAYS * DAY_MS);
  const sinceStr = since.toISOString().split("T")[0];

  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { timezone: true, codGateways: true, confirmedOrderTag: true },
  });
  const timezone = settings?.timezone ?? "UTC";
  const floor = reconcileFloor(now, await canReadAllOrders(admin), timezone);
  const codGateways = parseCodGateways(settings?.codGateways);
  const confirmedTag = (settings?.confirmedOrderTag ?? "").trim().toLowerCase();

  // variantGid -> (dateKey ISO -> qty)
  const salesMap = new Map<string, Map<string, number>>();
  // variantGid -> (weekStart ISO -> COD order units), the RTO denominator.
  const codMap = new Map<string, Map<string, number>>();
  // Per-order delivery region — the denominator for regional RTO analysis.
  const regions: {
    orderName: string;
    city: string | null;
    province: string | null;
    country: string | null;
    units: number;
    isCod: boolean;
    isConfirmed: boolean;
    isDispatched: boolean;
    isCancelled: boolean;
    orderedAt: Date;
  }[] = [];
  // Per-order SKU breakdown — the join that turns an order-level courier outcome into a
  // per-SKU return rate. See OrderOutcome / rto-attribution.server.ts.
  const orderLines: {
    orderName: string;
    productId: string;
    sku: string | null;
    quantity: number;
    orderedAt: Date;
  }[] = [];
  // One row per Shopify fulfilment, carrying its delivery outcome.
  const outcomes: {
    shipmentId: string;
    orderName: string;
    status: string;
    courier: string | null;
    updatedAt: Date;
  }[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  let completed = false;
  let fatalError: string | undefined;

  try {
    while (hasNextPage) {
      const data: OrdersResponse = await graphqlWithRetry<OrdersResponse>(
        admin,
        ORDERS_QUERY,
        { cursor, query: `created_at:>=${sinceStr} status:any` },
      );

      for (const { node: order } of data.orders.edges) {
        // Cancelled orders are excluded from demand but still recorded in the funnel,
        // because "how many placed orders die before dispatch" is exactly the question
        // the funnel exists to answer.
        if (order.cancelledAt) {
          if (order.name) {
            regions.push({
              orderName: order.name,
              city: normaliseCity(order.shippingAddress?.city),
              province: order.shippingAddress?.province ?? null,
              country: order.shippingAddress?.country ?? null,
              units: 0,
              isCod: isCodOrder(
                { payment_gateway_names: order.paymentGatewayNames },
                codGateways,
              ),
              isConfirmed: false,
              isDispatched: false,
              isCancelled: true,
              orderedAt: new Date(order.createdAt),
            });
          }
          continue;
        }

        const placedAt = new Date(order.createdAt);
        const dateKey = shopDateKey(placedAt, timezone).toISOString();
        const weekKey = shopWeekStart(placedAt, timezone).toISOString();
        const isCod = isCodOrder(
          { payment_gateway_names: order.paymentGatewayNames },
          codGateways,
        );

        if (order.lineItems.pageInfo?.hasNextPage) {
          // >100 line items on one order is vanishingly rare, but silently dropping
          // the tail would understate demand, so make it visible.
          console.warn(
            `[inventorify] order ${order.id} has more line items than fetched; demand may be understated`,
          );
        }

        let orderUnits = 0;
        for (const { node: lineItem } of order.lineItems.edges) {
          orderUnits += lineItem.quantity;
          const variantId = lineItem.variant?.id;
          if (!variantId) continue;

          if (!salesMap.has(variantId)) salesMap.set(variantId, new Map());
          const dayMap = salesMap.get(variantId)!;
          dayMap.set(dateKey, (dayMap.get(dateKey) ?? 0) + lineItem.quantity);

          if (isCod) {
            if (!codMap.has(variantId)) codMap.set(variantId, new Map());
            const weekMap = codMap.get(variantId)!;
            weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + lineItem.quantity);
          }

          if (order.name) {
            orderLines.push({
              orderName: order.name,
              productId: variantId,
              sku: lineItem.variant?.sku ?? null,
              quantity: lineItem.quantity,
              orderedAt: placedAt,
            });
          }
        }

        if (order.name) {
          regions.push({
            orderName: order.name,
            // Normalised so "karachi", "Karachi " and "KARACHI" do not become three
            // separate cities in the breakdown.
            city: normaliseCity(order.shippingAddress?.city),
            province: order.shippingAddress?.province ?? null,
            country: order.shippingAddress?.country ?? null,
            units: orderUnits,
            isCod,
            // No configured tag means confirmation is not tracked; the funnel then
            // reports it as untracked rather than as 0% confirmed.
            isConfirmed: confirmedTag
              ? (order.tags ?? []).some((t) => t.trim().toLowerCase() === confirmedTag)
              : false,
            isDispatched: ["FULFILLED", "PARTIALLY_FULFILLED"].includes(
              order.displayFulfillmentStatus ?? "",
            ),
            isCancelled: false,
            orderedAt: placedAt,
          });

          for (const f of order.fulfillments ?? []) {
            if (!f.displayStatus) continue;
            outcomes.push({
              shipmentId: f.id,
              orderName: order.name,
              status: f.displayStatus,
              courier: normaliseCarrier(f.trackingInfo?.[0]?.company),
              updatedAt: f.updatedAt ? new Date(f.updatedAt) : placedAt,
            });
          }
        }
      }

      hasNextPage = data.orders.pageInfo.hasNextPage;
      cursor = data.orders.pageInfo.endCursor;
    }
    completed = true;
  } catch (err) {
    fatalError = err instanceof Error ? err.message : "Unknown error";
    console.error(`[inventorify] order sync aborted for ${shop}: ${fatalError}`);
  }

  // A partial fetch must never be written as if it were the whole window: rebuilding
  // days from an aborted walk would delete real demand.
  if (!completed) {
    return {
      recordsSynced: 0,
      recordsDeleted: 0,
      variantsSeen: salesMap.size,
      completed,
      error: fatalError,
    };
  }

  let recordsSynced = 0;
  let recordsDeleted = 0;
  const variantsSeen = salesMap.size;

  // Only variants we track, resolved in one query rather than one per variant.
  const tracked = await prisma.product.findMany({
    where: { shop, id: { in: [...salesMap.keys()] } },
    select: { id: true, firstSoldAt: true },
  });

  // Stored history from the part of the demand window this walk did not rebuild. The
  // estimate below needs it: estimating from the walk alone treats those days as zero.
  const olderRows = await prisma.salesRecord.findMany({
    where: {
      shop,
      productId: { in: tracked.map((t) => t.id) },
      date: { gte: since, lt: floor },
    },
    select: { productId: true, date: true, quantity: true },
  });
  const olderByVariant = new Map<string, Map<number, number>>();
  for (const row of olderRows) {
    if (!olderByVariant.has(row.productId)) olderByVariant.set(row.productId, new Map());
    olderByVariant.get(row.productId)!.set(row.date.getTime(), row.quantity);
  }

  for (const { id: variantId, firstSoldAt: knownFirstSold } of tracked) {
    const dayMap = salesMap.get(variantId);
    if (!dayMap) continue;

    const records = [...dayMap.entries()].map(([dateIso, quantity]) => ({
      shop,
      productId: variantId,
      date: new Date(dateIso),
      quantity,
    }));

    // Delete-then-insert is only safe inside a transaction. Previously a crash between
    // the two statements left the product with no demand history at all.
    //
    // The delete covers only days the walk saw in full. Days before `floor` are
    // inserted only where no row exists yet (skipDuplicates), which backfills a fresh
    // install without overwriting a complete day with the partial count the walk saw.
    const [deleted] = await prisma.$transaction([
      prisma.salesRecord.deleteMany({
        where: { shop, productId: variantId, date: { gte: floor } },
      }),
      prisma.salesRecord.createMany({ data: records, skipDuplicates: true }),
    ]);
    recordsSynced += records.length;
    recordsDeleted += deleted.count;

    // What is now stored for the window: the untouched older days, then the rebuilt
    // ones, plus any older day this walk has just created.
    const stored = new Map(olderByVariant.get(variantId) ?? []);
    for (const r of records) {
      const t = r.date.getTime();
      if (r.date >= floor || !stored.has(t)) stored.set(t, r.quantity);
    }
    const history = [...stored.entries()].map(([t, quantity]) => ({
      date: new Date(t),
      quantity,
    }));

    const firstInWindow = records.reduce<Date | null>(
      (min, r) => (min === null || r.date < min ? r.date : min),
      null,
    );

    // firstSoldAt only ever moves earlier.
    //
    // `firstInWindow` is the earliest sale in *this sync window*, which is not the
    // earliest sale full stop: the delete above only clears recent days, so older
    // history survives, and a shop that has been selling for a year has a first sale
    // far outside the window. Writing the window's minimum unconditionally pushed
    // firstSoldAt forward every sync. That matters because this bounds the demand-
    // variance window — moving it later shortens the window and understates sigma, the
    // mirror image of the padding problem the field was added to prevent.
    const firstSold =
      knownFirstSold && (!firstInWindow || knownFirstSold < firstInWindow)
        ? knownFirstSold
        : firstInWindow;

    // One estimator for the whole app: the cached avgDailySales that drives reorder
    // points is now the same number the forecast uses, rather than a second, slightly
    // different moving average maintained in parallel here.
    const { dailyRate } = estimateDemand(history, {
      windowStart: since,
      firstSoldAt: firstSold,
    });

    await prisma.product.update({
      where: { id: variantId },
      data: {
        avgDailySales: dailyRate,
        // Bounds the variance window so a SKU launched three weeks ago is not treated
        // as having 70 days of zero demand.
        ...(firstSold && firstSold.getTime() !== knownFirstSold?.getTime()
          ? { firstSoldAt: firstSold }
          : {}),
      },
    });

    // Backfill the COD order counts that form the RTO denominator. Without this a
    // fresh install had no return-rate history until a week of webhooks accumulated.
    // A week that starts before `floor` was only partly walked, so an existing count
    // for it is kept rather than overwritten with the partial one.
    const weekMap = codMap.get(variantId);
    if (weekMap) {
      for (const [weekIso, orderCount] of weekMap) {
        const weekStart = new Date(weekIso);
        await prisma.returnRateHistory.upsert({
          where: {
            productId_weekStart: { productId: variantId, weekStart },
          },
          create: {
            shop,
            productId: variantId,
            weekStart,
            returnRate: 0,
            orderCount,
          },
          update: weekStart >= floor ? { orderCount } : {},
        });
      }
    }
  }

  // Persist the per-order SKU breakdown. Only variants we track, and summed per
  // (order, product) so a repeated product across lines becomes one row.
  const trackedIds = new Set(tracked.map((t) => t.id));
  const byOrderProduct = new Map<string, (typeof orderLines)[number]>();
  for (const line of orderLines) {
    if (!trackedIds.has(line.productId)) continue;
    const key = `${line.orderName}\u0000${line.productId}`;
    const existing = byOrderProduct.get(key);
    if (existing) existing.quantity += line.quantity;
    else byOrderProduct.set(key, { ...line });
  }
  for (const line of byOrderProduct.values()) {
    await prisma.orderLineItem.upsert({
      where: {
        shop_orderName_productId: {
          shop,
          orderName: line.orderName,
          productId: line.productId,
        },
      },
      create: { shop, ...line },
      update: { sku: line.sku, quantity: line.quantity, orderedAt: line.orderedAt },
    });
  }

  // Persist Shopify's own delivery outcomes. Upserted on the fulfilment id, so a
  // shipment that moves from IN_TRANSIT to DELIVERED updates in place.
  for (const o of outcomes) {
    await prisma.orderOutcome.upsert({
      where: { shop_shipmentId: { shop, shipmentId: o.shipmentId } },
      create: { shop, source: "shopify", ...o },
      update: {
        status: o.status,
        updatedAt: o.updatedAt,
        orderName: o.orderName,
        // Only overwrite with a known carrier; a later fulfilment fetch that omits
        // tracking must not erase one we already recorded.
        ...(o.courier ? { courier: o.courier } : {}),
      },
    });
  }

  // Persist delivery regions. Upserted per order so a re-run is idempotent.
  for (const region of regions) {
    await prisma.orderRegion.upsert({
      where: { shop_orderName: { shop, orderName: region.orderName } },
      create: { shop, ...region },
      update: {
        city: region.city,
        province: region.province,
        country: region.country,
        units: region.units,
        isCod: region.isCod,
        isConfirmed: region.isConfirmed,
        isDispatched: region.isDispatched,
        isCancelled: region.isCancelled,
      },
    });
  }

  return { recordsSynced, recordsDeleted, variantsSeen, completed };
}

/**
 * Normalise a carrier name so it groups consistently.
 *
 * Merchants and apps spell the same courier differently — "PostEx", "postex partner",
 * "POSTEX  " — and each spelling would otherwise become its own row with its own
 * too-small sample, which is exactly how a rate stops meaning anything.
 */
function normaliseCarrier(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Trim, collapse whitespace and title-case a city so it groups consistently. */
function normaliseCity(city: string | null | undefined): string | null {
  if (!city) return null;
  const cleaned = city.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
