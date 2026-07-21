import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { calculateReorderPoint } from "./forecast.server";
import { graphqlWithRetry, mapPool, type Paged } from "./shopify-graphql.server";

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

// Named response shapes. These are annotated at the call sites rather than left to
// inference: `cursor` is assigned out of the same object it is used to fetch, and TS
// reports that round trip as circular (TS7022) unless the result type is explicit.
interface LocationsResponse {
  locations: Paged<ShopifyLocation>;
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
    const data: LocationsResponse = await graphqlWithRetry<LocationsResponse>(
      admin,
      LOCATIONS_QUERY,
      { cursor },
    );

    for (const { node } of data.locations.edges) {
      const location = await prisma.location.upsert({
        where: { shop_shopifyLocationId: { shop, shopifyLocationId: node.id } },
        create: { shop, shopifyLocationId: node.id, name: node.name, isActive: node.isActive },
        update: { name: node.name, isActive: node.isActive },
      });
      map.set(node.id, location.id);
    }

    hasNextPage = data.locations.pageInfo.hasNextPage;
    cursor = data.locations.pageInfo.endCursor;
  }

  return map;
}

/**
 * Pushes a stock-adjustment delta to Shopify's own inventory count so it stays
 * in sync with Inventorify's tracked stock. Non-fatal on failure — the local
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
      const locData = await graphqlWithRetry<{
        locations: { edges: { node: { id: string } }[] };
      }>(admin, PRIMARY_LOCATION_QUERY);
      locationId = locData.locations?.edges?.[0]?.node?.id;
    }
    if (!locationId) return { ok: false, error: "No Shopify location found" };

    const data = await graphqlWithRetry<{
      inventoryAdjustQuantities?: { userErrors: { message: string }[] };
    }>(admin, INVENTORY_ADJUST_MUTATION, {
      input: {
        reason: "correction",
        name: "available",
        changes: [{ delta, inventoryItemId, locationId }],
      },
    });

    const userErrors = data.inventoryAdjustQuantities?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, error: userErrors.map((e) => e.message).join(", ") };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Flat pagination over every variant in the shop.
 *
 * This deliberately does NOT nest variants under products. The old query asked for
 * `products(first: 50) { variants(first: 20) }`, which silently dropped variant 21+ of
 * any product — and those dropped variants were then treated as deleted-from-Shopify
 * and hard-deleted along with their sales history. A flat `productVariants` connection
 * has no such ceiling.
 */
const PRODUCT_VARIANTS_QUERY = `
  query getProductVariants($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      edges {
        node {
          id
          title
          sku
          inventoryQuantity
          image { url }
          product { id title featuredImage { url } }
          inventoryItem {
            id
            inventoryLevels(first: 50) {
              edges {
                node {
                  location { id }
                  quantities(names: ["available", "on_hand"]) { name quantity }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Follow-up pagination for the rare variant stocked at more than 50 locations. */
const INVENTORY_LEVELS_QUERY = `
  query getInventoryLevels($id: ID!, $cursor: String) {
    inventoryItem(id: $id) {
      inventoryLevels(first: 50, after: $cursor) {
        edges {
          node {
            location { id }
            quantities(names: ["available", "on_hand"]) { name quantity }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface ShopifyInventoryLevel {
  location: { id: string };
  quantities: { name: string; quantity: number }[];
}

interface ProductVariantsResponse {
  productVariants: Paged<ShopifyVariant>;
}

interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  image: { url: string } | null;
  product: { id: string; title: string; featuredImage: { url: string } | null };
  inventoryItem: {
    id: string;
    inventoryLevels?: Paged<ShopifyInventoryLevel>;
  } | null;
}

export async function syncShopifyInventory(
  admin: AdminApiContext,
  shop: string,
): Promise<{ synced: number; errors: number; archived: number; completed: boolean; error?: string }> {
  let synced = 0;
  let errors = 0;
  const seenVariantIds = new Set<string>();

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const defaultLeadTime = settings?.defaultLeadTime ?? 7;

  // Sync locations first so per-location stock has stable FKs (shopifyLocationId → Location.id)
  const locationMap = await syncLocations(admin, shop);

  // One read instead of a findUnique per variant.
  const existingRows = await prisma.product.findMany({
    where: { shop },
    select: { id: true, leadTimeDays: true, avgDailySales: true, reorderPoint: true, isArchived: true },
  });
  const existingById = new Map(existingRows.map((p) => [p.id, p]));

  let cursor: string | null = null;
  let hasNextPage = true;
  // Only a clean, complete walk of the catalogue may drive the archive sweep below.
  let completed = false;
  let fatalError: string | undefined;

  try {
    while (hasNextPage) {
      const data: ProductVariantsResponse = await graphqlWithRetry<ProductVariantsResponse>(
        admin,
        PRODUCT_VARIANTS_QUERY,
        { cursor },
      );

      const variants = data.productVariants.edges.map((e) => e.node);
      for (const v of variants) seenVariantIds.add(v.id);

      await mapPool(variants, 8, async (variant) => {
        try {
          const variantTitle = variant.title === "Default Title" ? null : variant.title;
          const inventoryItemId = variant.inventoryItem?.id ?? null;
          // Variant image when it has its own, else the product's featured image.
          const imageUrl =
            variant.image?.url ?? variant.product.featuredImage?.url ?? null;

          // Build per-location stock from inventory levels; fall back to the
          // aggregate inventoryQuantity when no levels are returned.
          const levelNodes: ShopifyInventoryLevel[] =
            variant.inventoryItem?.inventoryLevels?.edges.map((e) => e.node) ?? [];

          // Rare, but a variant stocked at >50 locations must not be truncated.
          let levelPage = variant.inventoryItem?.inventoryLevels?.pageInfo;
          while (levelPage?.hasNextPage && inventoryItemId) {
            const more = await graphqlWithRetry<{
              inventoryItem: { inventoryLevels: Paged<ShopifyInventoryLevel> } | null;
            }>(admin, INVENTORY_LEVELS_QUERY, { id: inventoryItemId, cursor: levelPage.endCursor });
            const page = more.inventoryItem?.inventoryLevels;
            if (!page) break;
            levelNodes.push(...page.edges.map((e) => e.node));
            levelPage = page.pageInfo;
          }

          const perLocation: { locationId: string; onHand: number; reserved: number }[] = [];
          for (const level of levelNodes) {
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

          const existing = existingById.get(variant.id);
          const leadTimeDays = existing?.leadTimeDays ?? defaultLeadTime;
          const avgDailySales = existing?.avgDailySales ?? 0;
          const reorderPoint =
            existing?.reorderPoint ?? calculateReorderPoint(avgDailySales, leadTimeDays);

          await prisma.product.upsert({
            where: { id: variant.id },
            create: {
              id: variant.id,
              shop,
              productGid: variant.product.id,
              inventoryItemId,
              title: variant.product.title,
              variantTitle,
              sku: variant.sku ?? null,
              imageUrl,
              currentStock,
              reorderPoint,
              leadTimeDays,
              codReturnRate: 0,
              avgMargin: 0,
              avgDailySales: 0,
            },
            update: {
              title: variant.product.title,
              variantTitle,
              sku: variant.sku ?? null,
              imageUrl,
              currentStock,
              inventoryItemId,
              productGid: variant.product.id,
              // A variant that reappears in Shopify is un-archived rather than recreated,
              // so its demand history stays attached.
              ...(existing?.isArchived ? { isArchived: false, archivedAt: null } : {}),
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
      });

      hasNextPage = data.productVariants.pageInfo.hasNextPage;
      cursor = data.productVariants.pageInfo.endCursor;
    }
    completed = true;
  } catch (err) {
    fatalError = err instanceof Error ? err.message : "Unknown error";
    console.error(`[inventorify] product sync aborted for ${shop}: ${fatalError}`);
  }

  let archived = 0;

  // Archive products that no longer exist in Shopify.
  //
  // Guarded on `completed`: if pagination died partway through, everything we had not
  // reached yet is missing from seenVariantIds through no fault of its own. Sweeping on a
  // partial walk is what previously destroyed products and their 90 days of demand
  // history on a single throttled request.
  if (completed) {
    const orphanIds = existingRows
      .map((p) => p.id)
      .filter((id) => !seenVariantIds.has(id));

    if (orphanIds.length > 0) {
      // Never archive something still referenced by an open PO.
      const blocked = await prisma.purchaseOrderItem.findMany({
        where: {
          productId: { in: orphanIds },
          purchaseOrder: { status: { in: ["draft", "sent"] } },
        },
        select: { productId: true },
        distinct: ["productId"],
      });
      const blockedIds = new Set(blocked.map((b) => b.productId));
      const toArchive = orphanIds.filter((id) => !blockedIds.has(id));

      if (toArchive.length > 0) {
        // Soft delete. History (sales, forecasts, adjustments, returns) is retained:
        // it is the only record of demand for a SKU Shopify no longer lists, and it is
        // needed if the variant comes back.
        const res = await prisma.product.updateMany({
          where: { id: { in: toArchive }, shop, isArchived: false },
          data: { isArchived: true, archivedAt: new Date() },
        });
        archived = res.count;
      }
    }
  }

  // Daily stock snapshot — live products only.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const allProducts = await prisma.product.findMany({
    where: { shop, isArchived: false },
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

  return { synced, errors, archived, completed, error: fatalError };
}
