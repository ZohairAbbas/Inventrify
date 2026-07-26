import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { applyShopifyInventoryDelta } from "./shopify-sync.server";

/**
 * A Prisma unique-constraint violation (P2002) naming a specific column.
 *
 * The column check matters. An earlier version matched any P2002 and reported it as
 * "already reversed", which would put that message in front of a merchant for a
 * completely unrelated collision — every other unique constraint reachable from these
 * transactions would have been misattributed to the reversal guard.
 */
function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== "P2002") return false;

  // `meta.target` is a string[] of column names on Postgres, but the driver has shipped
  // it as a bare string before; treat an unreadable target as "not ours" so an unknown
  // collision surfaces as a real error rather than a misleading message.
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.includes(column);
  if (typeof target === "string") return target.includes(column);
  return false;
}

/**
 * Stock movements are read-modify-write, so they must not compute the new value in
 * application code.
 *
 * Both helpers here previously read `onHand` outside the transaction and then wrote
 * `locOnHand + delta` inside it. Two concurrent movements — a bulk restock from the
 * returns queue and a manual adjustment, say — would both read the same starting value
 * and the second write would silently discard the first. The fix is to let the database
 * do the arithmetic (`increment`) and to re-check the oversell guard inside the same
 * transaction that performs the write.
 */

export async function applyStockDelta(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  delta: number,
  reason: string,
  note: string | null,
  locationId?: string | null,
  options?: {
    /**
     * The StockAdjustment this movement reverses. Unique in the database, so a second
     * attempt to reverse the same adjustment fails the insert rather than moving stock
     * twice — the guard is the constraint, not a prior read, because a read-then-write
     * check loses to two concurrent submits.
     */
    reversalOf?: string | null;
    /** Shopify staff user id (session token `sub`) of whoever made the change. */
    userId?: string | null;
  },
) {
  const product = await prisma.product.findFirst({ where: { id: productId, shop } });
  if (!product) return { error: "Product not found" };

  // Resolve the target location: explicit choice, else the shop's first active location.
  const location = locationId
    ? await prisma.location.findFirst({ where: { id: locationId, shop } })
    : await prisma.location.findFirst({
        where: { shop, isActive: true },
        orderBy: { createdAt: "asc" },
      });
  const targetLocationId = location?.id ?? null;

  let newStock = product.currentStock;
  let guardError: string | null = null;
  const reversalOf = options?.reversalOf ?? null;
  const createdByUserId = options?.userId ?? null;

  try {
    await prisma.$transaction(async (tx) => {
    if (targetLocationId) {
      // Read inside the transaction so the guard sees a consistent value.
      const existingLevel = await tx.productLocationStock.findUnique({
        where: { productId_locationId: { productId, locationId: targetLocationId } },
      });
      const locOnHand = existingLevel?.onHand ?? 0;
      if (locOnHand + delta < 0) {
        guardError = `Cannot remove ${Math.abs(delta)} units — only ${locOnHand} at this location`;
        return;
      }

      await tx.stockAdjustment.create({
        data: { shop, productId, delta, reason, note, locationId: targetLocationId, reversalOf, createdByUserId },
      });

      await tx.productLocationStock.upsert({
        where: { productId_locationId: { productId, locationId: targetLocationId } },
        create: {
          shop,
          productId,
          locationId: targetLocationId,
          onHand: Math.max(0, delta),
        },
        // Database-side arithmetic: concurrent movements accumulate instead of
        // overwriting each other.
        update: { onHand: { increment: delta } },
      });

      const agg = await tx.productLocationStock.aggregate({
        where: { productId },
        _sum: { onHand: true },
      });
      newStock = agg._sum.onHand ?? 0;
      await tx.product.update({
        where: { id: productId },
        data: { currentStock: newStock },
      });
    } else {
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: { currentStock: true },
      });
      const onHand = current?.currentStock ?? 0;
      if (onHand + delta < 0) {
        guardError = `Cannot remove ${Math.abs(delta)} units — only ${onHand} in stock`;
        return;
      }

      await tx.stockAdjustment.create({
        data: { shop, productId, delta, reason, note, locationId: null, reversalOf, createdByUserId },
      });

      const updated = await tx.product.update({
        where: { id: productId },
        data: { currentStock: { increment: delta } },
        select: { currentStock: true },
      });
      newStock = updated.currentStock;
    }
    });
  } catch (err) {
    // Unique violation on `reversalOf`: this adjustment has already been reversed. The
    // whole transaction rolled back, so no stock moved — report it as the ordinary
    // outcome it is rather than a 500. Anything else is a genuine fault and rethrows.
    if (reversalOf && isUniqueViolationOn(err, "reversalOf")) {
      return { error: "That adjustment has already been reversed" };
    }
    throw err;
  }

  if (guardError) return { error: guardError };

  const shopifySync = await applyShopifyInventoryDelta(
    admin,
    product.inventoryItemId,
    delta,
    location?.shopifyLocationId,
  );

  return {
    ok: true as const,
    newStock,
    shopifySynced: shopifySync.ok,
    shopifyError: shopifySync.error,
  };
}

/**
 * Move stock at a single location without creating a StockAdjustment audit row —
 * used by stock transfers and PO receipts, where the transfer/PO record is itself the
 * audit trail. Recomputes Product.currentStock as the sum of on-hand, then best-effort
 * syncs the delta to Shopify at that location. Non-fatal on Shopify failure.
 */
export async function applyLocationDelta(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  locationId: string,
  delta: number,
) {
  const product = await prisma.product.findFirst({ where: { id: productId, shop } });
  if (!product) return { ok: false as const, error: "Product not found" };

  const location = await prisma.location.findFirst({ where: { id: locationId, shop } });
  if (!location) return { ok: false as const, error: "Location not found" };

  let guardError: string | null = null;

  await prisma.$transaction(async (tx) => {
    const existingLevel = await tx.productLocationStock.findUnique({
      where: { productId_locationId: { productId, locationId } },
    });
    const locOnHand = existingLevel?.onHand ?? 0;
    if (locOnHand + delta < 0) {
      guardError = `Cannot move ${Math.abs(delta)} units — only ${locOnHand} at this location`;
      return;
    }

    await tx.productLocationStock.upsert({
      where: { productId_locationId: { productId, locationId } },
      create: { shop, productId, locationId, onHand: Math.max(0, delta) },
      update: { onHand: { increment: delta } },
    });

    const agg = await tx.productLocationStock.aggregate({
      where: { productId },
      _sum: { onHand: true },
    });
    await tx.product.update({
      where: { id: productId },
      data: { currentStock: agg._sum.onHand ?? 0 },
    });
  });

  if (guardError) return { ok: false as const, error: guardError };

  const shopifySync = await applyShopifyInventoryDelta(
    admin,
    product.inventoryItemId,
    delta,
    location.shopifyLocationId,
  );

  return { ok: true as const, shopifySynced: shopifySync.ok, shopifyError: shopifySync.error };
}

/**
 * Apply an INVENTORY_LEVELS_UPDATE webhook to per-location stock.
 *
 * Two things make this subtler than it looks.
 *
 * The webhook reports `available`, but `onHand` means on-hand everywhere else — the
 * catalogue sync writes Shopify's real `on_hand` and derives `reserved = on_hand -
 * available`. Writing `available` into that column understated stock by whatever was
 * committed to unfulfilled orders and left `reserved` double-counted, so every inventory
 * position was wrong until the next full sync. Since available = onHand - reserved,
 * on-hand is reconstructed from the last known reserved figure.
 *
 * And an unrecognised location must not fall back to overwriting Product.currentStock:
 * on a multi-location shop that collapses the whole product to whichever location
 * reported last, which is the bug the per-location model exists to prevent. That fallback
 * is only correct for a shop with no per-location data at all.
 */
export async function applyInventoryLevelUpdate(
  shop: string,
  inventoryItemGid: string,
  locationGid: string,
  available: number,
): Promise<
  { applied: "location" | "aggregate" | "none"; productId?: string; onHand?: number }
> {
  const product = await prisma.product.findFirst({
    where: { shop, inventoryItemId: inventoryItemGid },
    select: { id: true },
  });
  if (!product) return { applied: "none" };

  const location = await prisma.location.findUnique({
    where: { shop_shopifyLocationId: { shop, shopifyLocationId: locationGid } },
    select: { id: true },
  });

  if (!location) {
    const knownLocations = await prisma.location.count({ where: { shop } });
    if (knownLocations > 0) {
      // A brand-new Shopify location lands here until the next catalogue sync registers
      // it. Dropping the signal beats corrupting the total.
      console.warn(
        `[inventorify] ${shop}: inventory level for unsynced location ${locationGid} ignored; ` +
          `it will be picked up by the next catalogue sync.`,
      );
      return { applied: "none", productId: product.id };
    }
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { currentStock: available },
      select: { currentStock: true },
    });
    return { applied: "aggregate", productId: product.id, onHand: updated.currentStock };
  }

  const onHand = await prisma.$transaction(async (tx) => {
    const existing = await tx.productLocationStock.findUnique({
      where: { productId_locationId: { productId: product.id, locationId: location.id } },
      select: { reserved: true },
    });
    // A row we have never seen before has nothing committed against it yet.
    const reserved = existing?.reserved ?? 0;

    await tx.productLocationStock.upsert({
      where: { productId_locationId: { productId: product.id, locationId: location.id } },
      create: {
        shop,
        productId: product.id,
        locationId: location.id,
        onHand: available,
        reserved: 0,
      },
      update: { onHand: available + reserved },
    });

    const agg = await tx.productLocationStock.aggregate({
      where: { productId: product.id },
      _sum: { onHand: true },
    });
    await tx.product.update({
      where: { id: product.id },
      data: { currentStock: agg._sum.onHand ?? 0 },
    });
    return agg._sum.onHand ?? 0;
  });

  return { applied: "location", productId: product.id, onHand };
}

/**
 * Set (or clear) the bin/shelf label for a product at a location.
 *
 * Shop-scoped through the location, so a product id posted from a form cannot label
 * another tenant's stock. Creates the per-location row if the pair has no stock record
 * yet — a merchant can shelve something before any quantity is synced. Trimmed, and an
 * empty string clears it so "no bin" is one state.
 */
export async function setBinLocation(
  shop: string,
  productId: string,
  locationId: string,
  bin: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const [product, location] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, shop }, select: { id: true } }),
    prisma.location.findFirst({ where: { id: locationId, shop }, select: { id: true } }),
  ]);
  if (!product || !location) return { ok: false, error: "Product or location not found in this shop" };

  const value = bin?.trim() ? bin.trim().slice(0, 60) : null;
  await prisma.productLocationStock.upsert({
    where: { productId_locationId: { productId, locationId } },
    create: { shop, productId, locationId, onHand: 0, reserved: 0, binLocation: value },
    update: { binLocation: value },
  });
  return { ok: true };
}

/** The location a receipt should land at: explicit choice, else first active. */
export async function resolveDefaultLocationId(
  shop: string,
  preferred?: string | null,
): Promise<string | null> {
  if (preferred) {
    const chosen = await prisma.location.findFirst({ where: { id: preferred, shop } });
    if (chosen) return chosen.id;
  }
  const fallback = await prisma.location.findFirst({
    where: { shop, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  return fallback?.id ?? null;
}
