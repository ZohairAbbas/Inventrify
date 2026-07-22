import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { applyShopifyInventoryDelta } from "./shopify-sync.server";

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
        data: { shop, productId, delta, reason, note, locationId: targetLocationId },
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
        data: { shop, productId, delta, reason, note, locationId: null },
      });

      const updated = await tx.product.update({
        where: { id: productId },
        data: { currentStock: { increment: delta } },
        select: { currentStock: true },
      });
      newStock = updated.currentStock;
    }
  });

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
