import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  dayLabel,
  feedResponse,
  iso,
  keysetOrder,
  keysetWhere,
  money,
  numericId,
  openFeed,
  pageTake,
} from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/variants — one row per Product (each is a Shopify variant).
 * Phase 5, G-INV5-1.
 *
 * Inventorify's planning settings and its own demand estimate are returned as stored;
 * Growzar labels them as Inventorify's and computes its own demand from /daily-sales.
 * The Courierify-derived fields (courierRtoRate, fulfilled*, derivedRtoRate) are left
 * out: Growzar reads outcomes from Courierify itself (Phase 5 rule 12).
 *
 * Archiving is an update (`archived`), not a delete. A Product row is hard-deleted only
 * by a shop purge, which the feeds report as 410 or `shopPurged`, so
 * `deletedVariantIds` is there for the contract and is normally empty.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.product.findMany({
      where: { shop: facts.shop, ...keysetWhere(params) },
      orderBy: keysetOrder,
      take: pageTake(params),
      select: {
        id: true,
        productGid: true,
        title: true,
        variantTitle: true,
        sku: true,
        barcode: true,
        currentStock: true,
        reorderPoint: true,
        safetyStock: true,
        leadTimeDays: true,
        moq: true,
        casePackSize: true,
        avgDailySales: true,
        abcClass: true,
        xyzClass: true,
        forecastMape: true,
        unitCost: true,
        supplierId: true,
        isArchived: true,
        archivedAt: true,
        firstSoldAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return await feedResponse(
      feed.value,
      rows,
      (p) => {
        const variantId = numericId(p.id);
        return {
          id: variantId,
          variantId,
          productId: numericId(p.productGid),
          title: p.title,
          variantTitle: p.variantTitle,
          sku: p.sku,
          barcode: p.barcode,
          stock: p.currentStock,
          reorderPoint: p.reorderPoint,
          safetyStock: p.safetyStock,
          leadTimeDays: p.leadTimeDays,
          moq: p.moq,
          casePackSize: p.casePackSize,
          avgDailySales: p.avgDailySales,
          abcClass: p.abcClass,
          xyzClass: p.xyzClass,
          forecastMape: p.forecastMape,
          // 0 is the column default, so it means "never entered", not "free".
          unitCost: p.unitCost > 0 ? money(p.unitCost, facts.shopCurrency) : null,
          supplierId: p.supplierId,
          archived: p.isArchived,
          archivedAt: iso(p.archivedAt),
          // Stored as the shop-local day at UTC midnight, so it is a day, not an instant.
          firstSoldDate: p.firstSoldAt ? dayLabel(p.firstSoldAt) : null,
          createdAt: iso(p.createdAt),
          updatedAt: iso(p.updatedAt),
        };
      },
      { feed: "variants", key: "deletedVariantIds" },
    );
  } catch (err) {
    console.error("[growzar] variants feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read variants.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
