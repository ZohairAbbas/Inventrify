import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { feedResponse, iso, keysetOrder, keysetWhere, money, openFeed, pageTake } from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/suppliers — Phase 5, G-INV5-5.
 *
 * Lead time as configured (`leadTimeDays`, a setting) and as measured from received POs
 * (`avgActualLeadTime`, `leadTimeSigma`, over `totalPosReceived` orders, sent → first
 * delivery). Growzar picks between them and says which.
 *
 * No contact name, email, phone or address: those are the merchant's supplier's personal
 * details, and nothing in Growzar needs them. Deleted suppliers are listed in
 * `deletedSupplierIds`.
 *
 * `minOrderValue` of 0 means the supplier has no minimum, so it is sent as 0, not null.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.supplier.findMany({
      where: { shop: facts.shop, ...keysetWhere(params) },
      orderBy: keysetOrder,
      take: pageTake(params),
      select: {
        id: true,
        name: true,
        leadTimeDays: true,
        avgActualLeadTime: true,
        leadTimeVariance: true,
        totalPosReceived: true,
        minOrderValue: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return await feedResponse(
      feed.value,
      rows,
      (s) => ({
        id: s.id,
        name: s.name,
        leadTimeDays: s.leadTimeDays,
        avgActualLeadTime: s.avgActualLeadTime,
        // Stored as leadTimeVariance, but it holds the standard deviation (days).
        leadTimeSigma: s.leadTimeVariance,
        totalPosReceived: s.totalPosReceived,
        minOrderValue: money(s.minOrderValue, facts.shopCurrency),
        isActive: s.isActive,
        updatedAt: iso(s.updatedAt),
      }),
      { feed: "suppliers", key: "deletedSupplierIds" },
    );
  } catch (err) {
    console.error("[growzar] suppliers feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read suppliers.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
