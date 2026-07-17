import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { applyShopifyInventoryDelta } from "./shopify-sync.server";

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
    : await prisma.location.findFirst({ where: { shop, isActive: true }, orderBy: { createdAt: "asc" } });
  const targetLocationId = location?.id ?? null;

  // Guard against oversell at the target location when we know its on-hand.
  const existingLevel = targetLocationId
    ? await prisma.productLocationStock.findUnique({
        where: { productId_locationId: { productId, locationId: targetLocationId } },
      })
    : null;
  const locOnHand = existingLevel?.onHand ?? 0;
  if (targetLocationId && locOnHand + delta < 0) {
    return { error: `Cannot remove ${Math.abs(delta)} units — only ${locOnHand} at this location` };
  }
  if (!targetLocationId && product.currentStock + delta < 0) {
    return { error: `Cannot remove ${Math.abs(delta)} units — only ${product.currentStock} in stock` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.stockAdjustment.create({ data: { shop, productId, delta, reason, note, locationId: targetLocationId } });

    if (targetLocationId) {
      await tx.productLocationStock.upsert({
        where: { productId_locationId: { productId, locationId: targetLocationId } },
        create: { shop, productId, locationId: targetLocationId, onHand: Math.max(0, delta) },
        update: { onHand: locOnHand + delta },
      });
      const agg = await tx.productLocationStock.aggregate({
        where: { productId },
        _sum: { onHand: true },
      });
      await tx.product.update({ where: { id: productId }, data: { currentStock: agg._sum.onHand ?? 0 } });
    } else {
      await tx.product.update({ where: { id: productId }, data: { currentStock: product.currentStock + delta } });
    }
  });

  const updated = await prisma.product.findUnique({ where: { id: productId }, select: { currentStock: true } });
  const newStock = updated?.currentStock ?? product.currentStock + delta;

  const shopifySync = await applyShopifyInventoryDelta(
    admin,
    product.inventoryItemId,
    delta,
    location?.shopifyLocationId,
  );

  return { ok: true as const, newStock, shopifySynced: shopifySync.ok, shopifyError: shopifySync.error };
}

/**
 * Move stock at a single location without creating a StockAdjustment audit row —
 * used by stock transfers, where the transfer record is itself the audit trail.
 * Upserts ProductLocationStock at `locationId`, recomputes Product.currentStock
 * as the sum of on-hand, then best-effort syncs the delta to Shopify at that
 * location. Non-fatal on Shopify failure. Returns { ok, shopifySynced, shopifyError }.
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

  const existingLevel = await prisma.productLocationStock.findUnique({
    where: { productId_locationId: { productId, locationId } },
  });
  const locOnHand = existingLevel?.onHand ?? 0;
  if (locOnHand + delta < 0) {
    return { ok: false as const, error: `Cannot move ${Math.abs(delta)} units — only ${locOnHand} at this location` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.productLocationStock.upsert({
      where: { productId_locationId: { productId, locationId } },
      create: { shop, productId, locationId, onHand: Math.max(0, delta) },
      update: { onHand: locOnHand + delta },
    });
    const agg = await tx.productLocationStock.aggregate({
      where: { productId },
      _sum: { onHand: true },
    });
    await tx.product.update({ where: { id: productId }, data: { currentStock: agg._sum.onHand ?? 0 } });
  });

  const shopifySync = await applyShopifyInventoryDelta(
    admin,
    product.inventoryItemId,
    delta,
    location.shopifyLocationId,
  );

  return { ok: true as const, shopifySynced: shopifySync.ok, shopifyError: shopifySync.error };
}
