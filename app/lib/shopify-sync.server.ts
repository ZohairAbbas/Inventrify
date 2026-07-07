import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { calculateReorderPoint } from "./forecast.server";

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
                inventoryItem { id }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  inventoryItem: { id: string } | null;
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
          const currentStock = variant.inventoryQuantity ?? 0;
          const variantTitle =
            variant.title === "Default Title" ? null : variant.title;
          const inventoryItemId = variant.inventoryItem?.id ?? null;

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
