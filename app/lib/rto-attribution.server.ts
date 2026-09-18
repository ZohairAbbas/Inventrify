import prisma from "../db.server";

/**
 * Per-SKU RTO derived from order-level courier outcomes.
 *
 * Courierify's per-SKU endpoints group on `ShipmentLineItem.sku`, which in practice is
 * almost never populated: on one production shop, 1,563 of 1,594 shipments had no line
 * items at all and not one had a SKU, so per-SKU RTO came back empty despite 624 real
 * returns. Several larger shops had zero line items across tens of thousands of shipments.
 *
 * The same figure can be reconstructed locally without any of that. Every shipment does
 * carry the Shopify order name, and Inventorify already knows which SKUs were in which
 * order (OrderLineItem, captured during the order sync). Joining the two gives per-SKU
 * shipped and returned units — no shipment line items, and no backfill.
 *
 * Everything below is pure apart from the two thin DB wrappers at the end, so the
 * arithmetic is testable without a courier feed.
 */

/** One order's outcome as reported by the courier. */
export interface OrderOutcomeRow {
  orderName: string;
  status: string;
}

/** One order line, as captured from Shopify. */
export interface OrderLineRow {
  orderName: string;
  productId: string;
  quantity: number;
}

export interface SkuRto {
  productId: string;
  /** Units on orders whose journey has finished (delivered or returned). */
  shippedUnits: number;
  returnedUnits: number;
  /** returnedUnits / shippedUnits, 0..1. */
  rtoRate: number;
}

/**
 * Statuses that represent a completed journey. Anything still moving is excluded from
 * both numerator and denominator: counting in-transit units as "not returned" would
 * understate the rate, and counting them as returned would overstate it.
 *
 * Two vocabularies land here. Courierify uses its own lowercase statuses. Shopify uses
 * FulfillmentDisplayStatus, where NOT_DELIVERED is the COD return signal — a parcel that
 * went out and came back. That is distinct from Shopify's Returns API (an RMA the
 * customer raised), which needs a read_returns scope and describes a different event.
 */
const DELIVERED = new Set(["delivered"]);
const RETURNED = new Set([
  "returned",
  "rto",
  "returned_to_shipper",
  // Shopify: the carrier could not deliver and the parcel is coming back.
  "not_delivered",
]);

/**
 * Statuses that end a shipment without it being either delivered or returned. Excluded
 * entirely rather than counted as a non-return, which would dilute the rate.
 *
 * FAILURE is deliberately here rather than in RETURNED: it can mean a carrier error or a
 * voided label as easily as a genuine RTO, and inflating the return rate on an ambiguous
 * status is the more damaging mistake — it would inflate safety stock.
 */
const TERMINAL_NON_JOURNEY = new Set(["canceled", "cancelled", "label_voided", "failure"]);

export function isTerminalNonJourney(status: string): boolean {
  return TERMINAL_NON_JOURNEY.has(status.trim().toLowerCase());
}

export function isResolvedStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return DELIVERED.has(s) || RETURNED.has(s);
}

export function isReturnedStatus(status: string): boolean {
  return RETURNED.has(status.trim().toLowerCase());
}

/**
 * Attribute order outcomes to SKUs.
 *
 * `minShipped` guards against meaningless rates: one return out of two shipments is not a
 * 50% RTO SKU, and feeding that into safety stock would be worse than having no figure.
 */
export function attributeRto(
  outcomes: OrderOutcomeRow[],
  lines: OrderLineRow[],
  minShipped = 10,
): SkuRto[] {
  const statusByOrder = new Map<string, string>();
  for (const o of outcomes) {
    if (!isResolvedStatus(o.status)) continue;
    // Last write wins; outcomes are pulled newest-last.
    statusByOrder.set(o.orderName, o.status);
  }

  const shipped = new Map<string, number>();
  const returned = new Map<string, number>();

  for (const line of lines) {
    const status = statusByOrder.get(line.orderName);
    if (!status) continue; // order never shipped, or still in transit

    shipped.set(line.productId, (shipped.get(line.productId) ?? 0) + line.quantity);
    if (isReturnedStatus(status)) {
      returned.set(line.productId, (returned.get(line.productId) ?? 0) + line.quantity);
    }
  }

  const out: SkuRto[] = [];
  for (const [productId, shippedUnits] of shipped) {
    if (shippedUnits < minShipped) continue;
    const returnedUnits = returned.get(productId) ?? 0;
    out.push({
      productId,
      shippedUnits,
      returnedUnits,
      rtoRate: returnedUnits / shippedUnits,
    });
  }
  return out.sort((a, b) => b.rtoRate - a.rtoRate);
}

/**
 * Recompute derivedRtoRate for a shop from stored outcomes and order lines.
 *
 * Writes `derivedRtoRate` only. `courierRtoRate` remains the courier's own per-SKU figure
 * and still wins when present — see resolveReturnRate() for the precedence.
 *
 * The window matters more than it looks. Measured on a live store: 27.2% RTO over 30 days,
 * 43.0% over 60, 41.2% over 90. A shop whose return rate is moving that fast gets a
 * materially different safety stock depending on the window, and a 90-day average will
 * over-buy against an improving rate. 90 days is the default because it matches the demand
 * window and is stable enough to size buffers from, but a fast-moving rate wants shorter.
 */
export async function recomputeDerivedRto(
  shop: string,
  windowDays = 90,
): Promise<{
  attributed: number;
  skipped: number;
  /** Newest courier outcome the rates were computed from; null when there were none. */
  dataThrough: Date | null;
}> {
  const since = new Date(Date.now() - windowDays * 86400000);

  const [outcomes, lines] = await Promise.all([
    prisma.orderOutcome.findMany({
      where: { shop, updatedAt: { gte: since } },
      select: { orderName: true, status: true, source: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
    }),
    prisma.orderLineItem.findMany({
      where: { shop, orderedAt: { gte: since } },
      select: { orderName: true, productId: true, quantity: true },
    }),
  ]);

  if (outcomes.length === 0) return { attributed: 0, skipped: 0, dataThrough: null };

  // Collapse to one status per order first, so a shop with both a courier feed and
  // Shopify tracking does not count the same parcel twice.
  const resolvedByOrder = resolveOutcomeByOrder(outcomes);
  const rates = attributeRto(
    [...resolvedByOrder].map(([orderName, status]) => ({ orderName, status })),
    lines,
  );

  for (const r of rates) {
    await prisma.product.update({
      where: { id: r.productId },
      data: { derivedRtoRate: r.rtoRate },
    });
  }

  // Resolve codReturnRate for everything this shop tracks, so the field the planning
  // maths reads reflects the new precedence.
  await refreshResolvedReturnRates(shop);

  // Report what was attributed and how many SKUs fell below the volume floor, rather
  // than subtracting a SKU count from a shipment count — different units, meaningless
  // difference.
  const resolvedOrders = new Set(
    [...resolvedByOrder]
      .filter(([, status]) => isResolvedStatus(status))
      .map(([orderName]) => orderName),
  );
  const candidateSkus = new Set(
    lines.filter((l) => resolvedOrders.has(l.orderName)).map((l) => l.productId),
  );

  // Record how current the underlying courier data actually is. A feed can go quiet
  // without erroring — a shop that switches carrier simply stops appearing — and an RTO
  // rate computed from history but shown as today's number sizes safety stock wrongly.
  const dataThrough = outcomes
    .filter((o) => isResolvedStatus(o.status))
    .reduce<Date | null>((max, o) => (max === null || o.updatedAt > max ? o.updatedAt : max), null);

  // Upsert, not update: a shop has no settings row until something writes one, and this
  // runs on the hourly sync for every shop. An `update` threw "no record was found" and
  // took the whole sync down with it — for a newly installed shop whose merchant had not
  // yet opened the settings page, and for any shop whose data was reset to be rebuilt
  // from Shopify. The defaults in the schema are the right starting point.
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, rtoDataThrough: dataThrough, rtoOrdersAttributed: resolvedOrders.size },
    update: { rtoDataThrough: dataThrough, rtoOrdersAttributed: resolvedOrders.size },
  });

  return {
    attributed: rates.length,
    skipped: Math.max(0, candidateSkus.size - rates.length),
    dataThrough,
  };
}

/**
 * Recompute the resolved `codReturnRate` and its provenance for every product in a shop.
 *
 * Precedence: the courier's own per-SKU rate, then one derived from order outcomes, then a
 * local estimate. Keeping this in one place is what stopped two writers racing over the
 * same column.
 */
export async function refreshResolvedReturnRates(
  shop: string,
  derivedLabel: "shopify_tracking" | "courierify_orders" = "shopify_tracking",
): Promise<number> {
  const products = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: {
      id: true,
      courierRtoRate: true,
      courierRtoSyncedAt: true,
      derivedRtoRate: true,
      estimatedRtoRate: true,
      codReturnRate: true,
      returnRateSource: true,
    },
  });

  let updated = 0;
  for (const p of products) {
    // "Available" means currently reported, not reported once. A courier rate that has
    // not refreshed within the precedence window steps aside for live Shopify tracking.
    const courierIsCurrent = p.courierRtoRate != null && isFresh(p.courierRtoSyncedAt);

    const resolved =
      courierIsCurrent
        ? { rate: p.courierRtoRate as number, source: "courierify" }
        : p.derivedRtoRate != null
          ? { rate: p.derivedRtoRate, source: derivedLabel }
          : p.estimatedRtoRate != null
            ? { rate: p.estimatedRtoRate, source: "estimated" }
            : { rate: 0, source: "none" };

    const rate = Math.min(1, Math.max(0, resolved.rate));
    if (p.codReturnRate === rate && p.returnRateSource === resolved.source) continue;

    await prisma.product.update({
      where: { id: p.id },
      data: { codReturnRate: rate, returnRateSource: resolved.source },
    });
    updated++;
  }
  return updated;
}

/** Days after which courier-derived RTO stops being treated as current. */
export const RTO_STALE_AFTER_DAYS = 14;

/**
 * How long a courier's own per-SKU report keeps precedence over Shopify tracking.
 *
 * The Courierify pull runs hourly, so anything older than this means that feed has gone
 * quiet for the SKU — a shop that changed carrier, or a product it no longer ships. At
 * that point the live Shopify signal is the better answer, and continuing to prefer the
 * courier's last word would pin the shop to a number that stopped moving.
 */
export const COURIER_PRECEDENCE_HOURS = 48;

function isFresh(at: Date | null | undefined, hours = COURIER_PRECEDENCE_HOURS): boolean {
  return at != null && Date.now() - at.getTime() < hours * 3600_000;
}

export interface RtoFreshness {
  dataThrough: Date | null;
  ordersAttributed: number;
  ageDays: number | null;
  isStale: boolean;
  /** Merchant-facing explanation, or null when the data is current. */
  warning: string | null;
  /** Outcomes in the last 90 days whose status is not recognised, so not in the ratio. */
  unrecognisedOutcomes: number;
  /** Merchant-facing explanation of those, or null when there are none. */
  unrecognisedWarning: string | null;
}

/**
 * How current the shop's derived RTO figures are.
 *
 * Seen in production: a shop's courier volume fell 786 -> 560 -> 99 shipments a month and
 * then stopped entirely, because it moved to another carrier. The RTO rates stayed on
 * screen looking authoritative while describing a period that had ended two and a half
 * weeks earlier. Safety stock sized off that is sized off the past.
 */
export async function getRtoFreshness(shop: string): Promise<RtoFreshness> {
  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { rtoDataThrough: true, rtoOrdersAttributed: true },
  });

  const byStatus = await prisma.orderOutcome.groupBy({
    by: ["status"],
    where: { shop, updatedAt: { gte: new Date(Date.now() - 90 * 86400000) } },
    _count: { _all: true },
  });
  const unrecognised = summariseUnrecognised(
    byStatus.map((g) => ({ status: g.status, count: g._count._all })),
  );
  const coverage = {
    unrecognisedOutcomes: unrecognised.count,
    unrecognisedWarning: unrecognised.count
      ? `${unrecognised.count} shipment${unrecognised.count === 1 ? " has" : "s have"} a ` +
        `courier status Inventorify does not recognise (${unrecognised.examples
          .map((e) => `"${e}"`)
          .join(", ")}), so ${unrecognised.count === 1 ? "it is" : "they are"} left out ` +
        `of return rates. If any of these mean the parcel was returned, return rates are ` +
        `understated.`
      : null,
  };

  const dataThrough = settings?.rtoDataThrough ?? null;
  const ordersAttributed = settings?.rtoOrdersAttributed ?? 0;
  if (!dataThrough) {
    return {
      dataThrough: null,
      ordersAttributed,
      ageDays: null,
      isStale: false,
      warning: null,
      ...coverage,
    };
  }

  const ageDays = Math.floor((Date.now() - dataThrough.getTime()) / 86400000);
  const isStale = ageDays > RTO_STALE_AFTER_DAYS;

  return {
    dataThrough,
    ordersAttributed,
    ageDays,
    isStale,
    ...coverage,
    warning: isStale
      ? `Return rates are based on courier data up to ${dataThrough.toISOString().slice(0, 10)} ` +
        `(${ageDays} days ago). If shipments moved to another carrier, these rates describe ` +
        `the past and should not drive new purchase orders.`
      : null,
  };
}

/**
 * Per-SKU fulfilment pipeline counts, derived from whatever outcomes we hold.
 *
 * This is what fills the dashboard's delivery pipeline for shops with no courier
 * integration at all. Shopify's own carrier tracking already knows how many units were
 * delivered, are still moving, or came back undelivered; joining that to the per-order SKU
 * breakdown turns it into per-product figures.
 */
export async function recomputeFulfilmentFromOutcomes(
  shop: string,
  windowDays = 90,
): Promise<{ products: number }> {
  const since = new Date(Date.now() - windowDays * 86400000);

  const [outcomes, lines] = await Promise.all([
    prisma.orderOutcome.findMany({
      where: { shop, updatedAt: { gte: since } },
      select: { orderName: true, status: true, source: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
    }),
    prisma.orderLineItem.findMany({
      where: { shop, orderedAt: { gte: since } },
      select: { orderName: true, productId: true, quantity: true },
    }),
  ]);
  if (outcomes.length === 0) return { products: 0 };

  const statusByOrder = resolveOutcomeByOrder(outcomes);

  const counts = new Map<string, { delivered: number; inTransit: number; returned: number }>();
  for (const line of lines) {
    const status = statusByOrder.get(line.orderName);
    if (!status || isTerminalNonJourney(status)) continue;

    const entry = counts.get(line.productId) ?? { delivered: 0, inTransit: 0, returned: 0 };
    if (isReturnedStatus(status)) entry.returned += line.quantity;
    else if (isResolvedStatus(status)) entry.delivered += line.quantity;
    else entry.inTransit += line.quantity;
    counts.set(line.productId, entry);
  }

  // Do not overwrite a SKU the courier is actively reporting. Both syncs write these
  // fields, so without this the last cron to run won — and the courier's numbers are the
  // better ones while they keep arriving.
  const courierOwned = new Set(
    (
      await prisma.product.findMany({
        where: {
          shop,
          id: { in: [...counts.keys()] },
          fulfilmentSource: "courierify",
          fulfilmentSyncedAt: {
            gte: new Date(Date.now() - COURIER_PRECEDENCE_HOURS * 3600_000),
          },
        },
        select: { id: true },
      })
    ).map((p) => p.id),
  );

  const now = new Date();
  let written = 0;
  for (const [productId, c] of counts) {
    if (courierOwned.has(productId)) continue;
    await prisma.product.updateMany({
      where: { id: productId, shop },
      data: {
        fulfilledDelivered: c.delivered,
        fulfilledInTransit: c.inTransit,
        fulfilledReturned: c.returned,
        fulfilmentSyncedAt: now,
        fulfilmentSource: "shopify",
      },
    });
    written++;
  }
  return { products: written };
}

/**
 * One status per order, preferring a courier's own report over Shopify's tracking.
 *
 * Both describe the same parcel. A courier integration knows more (it distinguishes a
 * return in progress from one already back on the shelf), so it wins where both exist;
 * Shopify covers everything else, which for most shops is everything.
 *
 * Within one source the last row seen wins, so callers MUST pass `outcomes` ordered by
 * `updatedAt` ascending — otherwise "last" means whatever order the database returned and
 * an order with two rows classifies differently between calls. Every caller orders its
 * query; one did not, and that was a real nondeterminism on shops where a parcel is
 * reported by both feeds.
 */
export function resolveOutcomeByOrder(
  outcomes: { orderName: string; status: string; source: string }[],
): Map<string, string> {
  const chosen = new Map<string, { status: string; source: string }>();
  for (const o of outcomes) {
    const existing = chosen.get(o.orderName);
    if (existing && existing.source === "courierify" && o.source !== "courierify") continue;
    chosen.set(o.orderName, { status: o.status, source: o.source });
  }
  return new Map([...chosen].map(([k, v]) => [k, v.status]));
}

/** Stages a dispatched unit passes through, in journey order. */
export const FULFILMENT_STAGES = [
  "dispatched",
  "in_transit",
  "out_for_delivery",
  "attempted",
  "delivered",
  "not_delivered",
] as const;
export type FulfilmentStage = (typeof FULFILMENT_STAGES)[number];

export const STAGE_LABELS: Record<FulfilmentStage, string> = {
  dispatched: "Dispatched",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  attempted: "Attempted",
  delivered: "Delivered",
  not_delivered: "Not delivered",
};

/**
 * Map a carrier status onto a journey stage.
 *
 * "Dispatched" means the shop handed the parcel over but no carrier scan has come back
 * yet — worth separating from in-transit, because a large dispatched bucket usually means
 * tracking is not flowing rather than that parcels are sitting still.
 *
 * Returns null for statuses that end the journey without a delivery outcome (cancelled,
 * voided labels), which must not appear in any stage total.
 */
export function classifyFulfilmentStage(status: string): FulfilmentStage | null {
  const s = status.trim().toLowerCase();
  if (isTerminalNonJourney(s)) return null;
  if (RETURNED.has(s)) return "not_delivered";
  if (DELIVERED.has(s)) return "delivered";
  if (OUT_FOR_DELIVERY.has(s)) return "out_for_delivery";
  if (ATTEMPTED.has(s)) return "attempted";
  if (IN_TRANSIT.has(s)) return "in_transit";
  // DISPATCHED, and anything unrecognised: nothing usable back from the carrier yet.
  // Unrecognised statuses are counted separately; see isRecognisedStatus.
  return "dispatched";
}

// Stage vocabularies. Shopify's FulfillmentDisplayStatus values are lower-cased here;
// Courierify's are already lower-case.
const OUT_FOR_DELIVERY = new Set(["out_for_delivery"]);
// Shopify says attempted_delivery, Courierify says attempted: the same failed attempt.
const ATTEMPTED = new Set(["attempted_delivery", "attempted"]);
const IN_TRANSIT = new Set(["in_transit", "picked_up"]);
/**
 * Handed over, but no carrier scan yet. Courierify's pending and booked are its
 * pre-pickup states: a booking exists, the courier has not collected the parcel.
 */
const DISPATCHED = new Set([
  "fulfilled",
  "marked_as_fulfilled",
  "submitted",
  "confirmed",
  "label_printed",
  "label_purchased",
  "ready_for_pickup",
  "booked",
  "pending",
]);

/**
 * Whether a status belongs to a vocabulary this module understands.
 *
 * An unrecognised status still lands in "dispatched" and stays out of the RTO ratio, as
 * an unresolved journey should. What it must not do is disappear silently: if a courier
 * starts sending a raw "RTO" string, every return behind it would be missing from the
 * rate. Callers count these so the gap is visible.
 */
export function isRecognisedStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return (
    DELIVERED.has(s) ||
    RETURNED.has(s) ||
    TERMINAL_NON_JOURNEY.has(s) ||
    OUT_FOR_DELIVERY.has(s) ||
    ATTEMPTED.has(s) ||
    IN_TRANSIT.has(s) ||
    DISPATCHED.has(s)
  );
}

/**
 * Summarise outcome rows whose status is not recognised, from per-status counts.
 * `examples` holds up to three of the statuses, most frequent first.
 */
export function summariseUnrecognised(
  byStatus: { status: string; count: number }[],
): { count: number; examples: string[] } {
  const unknown = byStatus
    .filter((g) => !isRecognisedStatus(g.status))
    .sort((a, b) => b.count - a.count);
  return {
    count: unknown.reduce((sum, g) => sum + g.count, 0),
    examples: unknown.slice(0, 3).map((g) => g.status),
  };
}

export interface FulfilmentBreakdown {
  /** Units per stage, in journey order. */
  stages: { stage: FulfilmentStage; label: string; units: number }[];
  /** Dispatched but not yet delivered or returned — stock that has left the building. */
  inRouteUnits: number;
  /** Journeys that finished, i.e. the denominator for a delivery rate. */
  resolvedUnits: number;
  deliveredUnits: number;
  notDeliveredUnits: number;
  /** notDelivered / resolved, or null when nothing has resolved yet. */
  rtoRate: number | null;
  source: "courierify" | "shopify" | "none";
}

/**
 * Units by fulfilment stage for a shop, consolidated across every tracked SKU.
 *
 * Works from Shopify's own carrier tracking, so it needs no courier integration.
 */
export async function getFulfilmentBreakdown(
  shop: string,
  range: { from: Date; to: Date },
): Promise<FulfilmentBreakdown> {
  const [outcomes, lines] = await Promise.all([
    prisma.orderOutcome.findMany({
      where: { shop, updatedAt: { gte: range.from, lt: range.to } },
      select: { orderName: true, status: true, source: true },
      // resolveOutcomeByOrder resolves ties by last-one-wins, so "last" has to mean
      // "most recently updated" rather than whatever order the database happened to
      // return. Without this, an order carrying both a Shopify and a courier row — 19 of
      // them inside one live shop's 30-day window — could classify differently between
      // two page loads, moving units between stages on the dashboard for no reason.
      orderBy: { updatedAt: "asc" },
    }),
    prisma.orderLineItem.findMany({
      where: { shop, orderedAt: { gte: range.from, lt: range.to } },
      select: { orderName: true, quantity: true },
    }),
  ]);

  const empty: FulfilmentBreakdown = {
    stages: FULFILMENT_STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], units: 0 })),
    inRouteUnits: 0,
    resolvedUnits: 0,
    deliveredUnits: 0,
    notDeliveredUnits: 0,
    rtoRate: null,
    source: "none",
  };
  if (outcomes.length === 0 || lines.length === 0) return empty;

  const statusByOrder = resolveOutcomeByOrder(outcomes);
  const tally = new Map<FulfilmentStage, number>();

  for (const line of lines) {
    const status = statusByOrder.get(line.orderName);
    if (!status) continue;
    const stage = classifyFulfilmentStage(status);
    if (!stage) continue;
    tally.set(stage, (tally.get(stage) ?? 0) + line.quantity);
  }

  const stages = FULFILMENT_STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    units: tally.get(stage) ?? 0,
  }));
  const delivered = tally.get("delivered") ?? 0;
  const notDelivered = tally.get("not_delivered") ?? 0;
  const resolved = delivered + notDelivered;
  const inRoute =
    (tally.get("dispatched") ?? 0) +
    (tally.get("in_transit") ?? 0) +
    (tally.get("out_for_delivery") ?? 0) +
    (tally.get("attempted") ?? 0);

  return {
    stages,
    inRouteUnits: inRoute,
    resolvedUnits: resolved,
    deliveredUnits: delivered,
    notDeliveredUnits: notDelivered,
    rtoRate: resolved > 0 ? notDelivered / resolved : null,
    source: outcomes.some((o) => o.source === "courierify") ? "courierify" : "shopify",
  };
}

export interface CarrierRto {
  carrier: string;
  deliveredUnits: number;
  notDeliveredUnits: number;
  /** Units on journeys that finished — the denominator. */
  resolvedUnits: number;
  rtoRate: number;
  /** Units still moving with this carrier. */
  inRouteUnits: number;
}

/**
 * RTO broken down by carrier.
 *
 * In COD the spread between couriers on the same lane is routinely larger than the spread
 * between products — one carrier's reattempt policy or rider coverage can move the return
 * rate by fifteen points. A shop-wide average hides that completely, and it is directly
 * actionable: move volume, renegotiate, or drop the worst lane.
 *
 * Derived from Shopify's own tracking company, so it needs no courier integration.
 * Carriers below `minResolved` are omitted rather than shown with a meaningless rate —
 * two shipments and one return is not a 50% carrier.
 */
export async function getRtoByCarrier(
  shop: string,
  range: { from: Date; to: Date },
  minResolved = 10,
): Promise<CarrierRto[]> {
  const [outcomes, lines] = await Promise.all([
    prisma.orderOutcome.findMany({
      where: {
        shop,
        updatedAt: { gte: range.from, lt: range.to },
        courier: { not: null },
      },
      select: { orderName: true, status: true, source: true, courier: true },
      // Same last-one-wins rule as resolveOutcomeByOrder, inlined here to carry the
      // courier through — so it needs the same ordering guarantee.
      orderBy: { updatedAt: "asc" },
    }),
    prisma.orderLineItem.findMany({
      where: { shop, orderedAt: { gte: range.from, lt: range.to } },
      select: { orderName: true, quantity: true },
    }),
  ]);
  if (outcomes.length === 0) return [];

  // Units per order, so a multi-line order counts once per line as elsewhere.
  const unitsByOrder = new Map<string, number>();
  for (const l of lines) {
    unitsByOrder.set(l.orderName, (unitsByOrder.get(l.orderName) ?? 0) + l.quantity);
  }

  // One outcome per order, courier feed preferred — same rule the rest of the module uses.
  const chosen = new Map<string, { status: string; source: string; courier: string }>();
  for (const o of outcomes) {
    if (!o.courier) continue;
    const existing = chosen.get(o.orderName);
    if (existing && existing.source === "courierify" && o.source !== "courierify") continue;
    chosen.set(o.orderName, { status: o.status, source: o.source, courier: o.courier });
  }

  const tally = new Map<string, CarrierRto>();
  for (const [orderName, { status, courier }] of chosen) {
    const units = unitsByOrder.get(orderName) ?? 0;
    if (units <= 0) continue;

    const stage = classifyFulfilmentStage(status);
    if (!stage) continue; // cancelled or voided: never a journey

    const entry =
      tally.get(courier) ??
      {
        carrier: courier,
        deliveredUnits: 0,
        notDeliveredUnits: 0,
        resolvedUnits: 0,
        rtoRate: 0,
        inRouteUnits: 0,
      };

    if (stage === "not_delivered") entry.notDeliveredUnits += units;
    else if (stage === "delivered") entry.deliveredUnits += units;
    else entry.inRouteUnits += units;

    tally.set(courier, entry);
  }

  return [...tally.values()]
    .map((c) => {
      c.resolvedUnits = c.deliveredUnits + c.notDeliveredUnits;
      c.rtoRate = c.resolvedUnits > 0 ? c.notDeliveredUnits / c.resolvedUnits : 0;
      return c;
    })
    .filter((c) => c.resolvedUnits >= minResolved)
    .sort((a, b) => b.rtoRate - a.rtoRate);
}
