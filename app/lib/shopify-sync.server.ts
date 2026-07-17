import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { calculateReorderPoint } from "./forecast.server";

const LOCATIONS_QUERY = `
  query getLocations($cursor: String) {
    locations(first: 50, after: $cursor) {
      edges { node { id name isActive } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRIMARY_LOCATION_QUERY = `
  query getPrimaryLocation {
    locations(first: 1) {
      edges { node { id } }
    }
  }
`;

const INVENTORY_ADJUST_MUTATION = `
  mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * Upserts every Shopify location into the local `Location` table so per-location
 * stock has a stable foreign key. Returns a map of shopifyLocationId → Location.id.
 */
export async function syncLocations(
  admin: AdminApiContext,
  shop: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const resp = await admin.graphql(LOCATIONS_QUERY, { variables: { cursor } });
    const json = await resp.json();
    const data = json.data?.locations;
    if (!data) break;

    for (const { node } of data.edges as { node: ShopifyLocation }[]) {
      const location = await prisma.location.upsert({
        where: { shop_shopifyLocationId: { shop, shopifyLocationId: node.id } },
        create: { shop, shopifyLocationId: node.id, name: node.name, isActive: node.isActive },
        update: { name: node.name, isActive: node.isActive },
      });
      map.set(node.id, location.id);
    }

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return map;
}

/**
 * Pushes a stock-adjustment delta to Shopify's own inventory count so it stays
 * in sync with Inventrify's tracked stock. Non-fatal on failure — the local
 * adjustment already succeeded, so we surface the error without rolling back.
 * When `shopifyLocationId` is given the delta targets that location; otherwise
 * it falls back to the shop's first (primary) location.
 */
export async function applyShopifyInventoryDelta(
  admin: AdminApiContext,
  inventoryItemId: string | null,
  delta: number,
  shopifyLocationId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!inventoryItemId) return { ok: false, error: "Product not linked to a Shopify inventory item" };

  try {
    let locationId = shopifyLocationId ?? undefined;
    if (!locationId) {
      const locResp = await admin.graphql(PRIMARY_LOCATION_QUERY);
      const locJson = await locResp.json();
      locationId = locJson.data?.locations?.edges?.[0]?.node?.id;
    }
    if (!locationId) return { ok: false, error: "No Shopify location found" };

    const resp = await admin.graphql(INVENTORY_ADJUST_MUTATION, {
      variables: {
        input: {
          reason: "correction",
          name: "available",
          changes: [{ delta, inventoryItemId, locationId }],
        },
      },
    });
    const json = await resp.json();
    const userErrors = json.data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, error: userErrors.map((e: { message: string }) => e.message).join(", ") };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

const PRODUCTS_QUERY = `
  query getProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      edges {
        node {
          id
          title
          variants(first: 20) {
            edges {
              node {
                id
                title
                sku
                inventoryQuantity
                inventoryItem {
                  id
                  inventoryLevels(first: 20) {
                    edges {
                      node {
                        location { id }
                        quantities(names: ["available", "on_hand"]) { name quantity }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface ShopifyInventoryLevel {
  location: { id: string };
  quantities: { name: string; quantity: number }[];
}

interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  inventoryItem: {
    id: string;
    inventoryLevels?: { edges: { node: ShopifyInventoryLevel }[] };
  } | null;
}

interface ShopifyProduct {
  id: string;
  title: string;
  variants: { edges: { node: ShopifyVariant }[] };
}

export async function syncShopifyInventory(
  admin: AdminApiContext,
  shop: string,
): Promise<{ synced: number; errors: number }> {
  let synced = 0;
  let errors = 0;
  let cursor: string | null = null;
  let hasNextPage = true;
  const seenVariantIds = new Set<string>();

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const defaultLeadTime = settings?.defaultLeadTime ?? 7;

  // Sync locations first so per-location stock has stable FKs (shopifyLocationId → Location.id)
  const locationMap = await syncLocations(admin, shop);

  while (hasNextPage) {
    const response = await admin.graphql(PRODUCTS_QUERY, {
      variables: { cursor },
    });

    const json = await response.json();
    const productsData = json.data?.products;
    if (!productsData) break;

    const products: ShopifyProduct[] = productsData.edges.map(
      (e: { node: ShopifyProduct }) => e.node,
    );

    for (const product of products) {
      for (const { node: variant } of product.variants.edges) {
        seenVariantIds.add(variant.id);
        try {
          const variantTitle =
            variant.title === "Default Title" ? null : variant.title;
          const inventoryItemId = variant.inventoryItem?.id ?? null;

          // Build per-location stock from inventory levels; fall back to the
          // aggregate inventoryQuantity when no levels are returned.
          const levels = variant.inventoryItem?.inventoryLevels?.edges ?? [];
          const perLocation: { locationId: string; onHand: number; reserved: number }[] = [];
          for (const { node: level } of levels) {
            const localLocationId = locationMap.get(level.location.id);
            if (!localLocationId) continue;
            const qtyByName = new Map(level.quantities.map((q) => [q.name, q.quantity]));
            const onHand = qtyByName.get("on_hand") ?? qtyByName.get("available") ?? 0;
            const available = qtyByName.get("available") ?? onHand;
            perLocation.push({
              locationId: localLocationId,
              onHand,
              reserved: Math.max(0, onHand - available),
            });
          }

          const currentStock =
            perLocation.length > 0
              ? perLocation.reduce((sum, l) => sum + l.onHand, 0)
              : variant.inventoryQuantity ?? 0;

          const existing = await prisma.product.findUnique({
            where: { id: variant.id },
          });

          const leadTimeDays = existing?.leadTimeDays ?? defaultLeadTime;
          const avgDailySales = existing?.avgDailySales ?? 0;
          const reorderPoint =
            existing?.reorderPoint ??
            calculateReorderPoint(avgDailySales || 1, leadTimeDays);

          await prisma.product.upsert({
            where: { id: variant.id },
            create: {
              id: variant.id,
              shop,
              productGid: product.id,
              inventoryItemId,
              title: product.title,
              variantTitle,
              sku: variant.sku ?? null,
              currentStock,
              reorderPoint,
              leadTimeDays,
              codReturnRate: 0,
              avgMargin: 0,
              avgDailySales: 0,
            },
            update: {
              title: product.title,
              variantTitle,
              sku: variant.sku ?? null,
              currentStock,
              inventoryItemId,
            },
          });

          for (const l of perLocation) {
            await prisma.productLocationStock.upsert({
              where: { productId_locationId: { productId: variant.id, locationId: l.locationId } },
              create: { shop, productId: variant.id, locationId: l.locationId, onHand: l.onHand, reserved: l.reserved },
              update: { onHand: l.onHand, reserved: l.reserved },
            });
          }

          synced++;
        } catch {
          errors++;
        }
      }
    }

    hasNextPage = productsData.pageInfo.hasNextPage;
    cursor = productsData.pageInfo.endCursor;
  }

  // Remove products deleted from Shopify (skip if in active POs)
  const allDbProducts = await prisma.product.findMany({
    where: { shop },
    select: { id: true },
  });
  const orphanIds = allDbProducts
    .map((p) => p.id)
    .filter((id) => !seenVariantIds.has(id));

  for (const orphanId of orphanIds) {
    const activePOItem = await prisma.purchaseOrderItem.findFirst({
      where: {
        productId: orphanId,
        purchaseOrder: { status: { in: ["draft", "sent"] } },
      },
    });
    if (activePOItem) continue;

    await prisma.$transaction([
      prisma.salesRecord.deleteMany({ where: { productId: orphanId } }),
      prisma.forecast.deleteMany({ where: { productId: orphanId } }),
      prisma.stockSnapshot.deleteMany({ where: { productId: orphanId } }),
      prisma.stockAdjustment.deleteMany({ where: { productId: orphanId } }),
      prisma.returnRateHistory.deleteMany({ where: { productId: orphanId } }),
      prisma.purchaseOrderItem.deleteMany({ where: { productId: orphanId } }),
      prisma.product.delete({ where: { id: orphanId } }),
    ]);
  }

  // Daily stock snapshot
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const allProducts = await prisma.product.findMany({
    where: { shop },
    select: { id: true, currentStock: true },
  });
  await prisma.stockSnapshot.createMany({
    data: allProducts.map((p) => ({
      shop,
      productId: p.id,
      date: today,
      stock: p.currentStock,
    })),
    skipDuplicates: true,
  });

  return { synced, errors };
}
