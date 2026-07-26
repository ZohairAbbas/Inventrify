import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { applyStockDelta } from "./stock.server";

/**
 * Cycle counting.
 *
 * A count is scoped to one location. Lines capture the location's on-hand at the moment
 * they are added (`snapshotQty`), so the variance the operator reviews is measured against
 * a fixed figure. Posting applies each non-zero variance through the same audited,
 * Shopify-synced path as a manual adjustment (reason "count_correction"), all or nothing.
 *
 * The snapshot, not the live figure, is the basis for the posted delta. If stock genuinely
 * moved between counting and posting — a sale, a receipt — that movement is preserved
 * rather than silently overwritten by "set on-hand to the counted number": the count
 * corrects the discrepancy it actually found, and the concurrent movement stands on its
 * own. This is the conservative, auditable choice, and it matches what the review screen
 * shows the operator before they post.
 */

function generateCountNumber(): string {
  const d = new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CC-${datePart}-${rand}`;
}

/** On-hand for a product at a specific location, defaulting to 0 for an unstocked pair. */
async function locationOnHand(productId: string, locationId: string): Promise<number> {
  const level = await prisma.productLocationStock.findUnique({
    where: { productId_locationId: { productId, locationId } },
    select: { onHand: true },
  });
  return level?.onHand ?? 0;
}

export async function createStockCount(
  shop: string,
  input: { locationId: string; notes?: string | null; blind?: boolean },
): Promise<{ ok: boolean; error?: string; countId?: string }> {
  const location = await prisma.location.findFirst({
    where: { id: input.locationId, shop, isActive: true },
    select: { id: true },
  });
  if (!location) return { ok: false, error: "Pick a location from this shop" };

  const count = await prisma.stockCount.create({
    data: {
      shop,
      countNumber: generateCountNumber(),
      locationId: location.id,
      notes: input.notes?.trim() || null,
      blind: input.blind ?? true,
    },
    select: { id: true },
  });
  return { ok: true, countId: count.id };
}

/**
 * Add a product to an open count, snapshotting its current on-hand at the count's
 * location. A product already on the count is left as-is (its snapshot and any entered
 * count are preserved) rather than being reset — re-scanning the same SKU must not wipe a
 * number already keyed in.
 */
export async function addCountItem(
  shop: string,
  countId: string,
  productId: string,
): Promise<{ ok: boolean; error?: string; alreadyPresent?: boolean }> {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, shop },
    select: { id: true, status: true, locationId: true },
  });
  if (!count) return { ok: false, error: "Count not found" };
  if (count.status !== "counting") return { ok: false, error: "This count is no longer open for editing" };

  const product = await prisma.product.findFirst({
    where: { id: productId, shop, isArchived: false },
    select: { id: true },
  });
  if (!product) return { ok: false, error: "Product not found in this shop" };

  const existing = await prisma.stockCountItem.findUnique({
    where: { stockCountId_productId: { stockCountId: count.id, productId: product.id } },
    select: { id: true },
  });
  if (existing) return { ok: true, alreadyPresent: true };

  await prisma.stockCountItem.create({
    data: {
      stockCountId: count.id,
      productId: product.id,
      snapshotQty: await locationOnHand(product.id, count.locationId),
    },
  });
  return { ok: true };
}

/**
 * Add every product currently stocked at the count's location, snapshotting each. Skips
 * products already on the count so it can be run after some lines were added by hand.
 * Bounded per call — a genuinely huge catalogue should be counted in scoped passes rather
 * than one enormous session — and reports whether it hit that bound.
 */
export async function addAllStockedItems(
  shop: string,
  countId: string,
  limit = 2000,
): Promise<{ ok: boolean; error?: string; added?: number; truncated?: boolean }> {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, shop },
    select: { id: true, status: true, locationId: true },
  });
  if (!count) return { ok: false, error: "Count not found" };
  if (count.status !== "counting") return { ok: false, error: "This count is no longer open for editing" };

  const existing = await prisma.stockCountItem.findMany({
    where: { stockCountId: count.id },
    select: { productId: true },
  });
  const already = new Set(existing.map((e) => e.productId));

  const levels = await prisma.productLocationStock.findMany({
    where: { shop, locationId: count.locationId, product: { isArchived: false } },
    select: { productId: true, onHand: true },
    orderBy: { productId: "asc" },
    take: limit + 1,
  });
  const truncated = levels.length > limit;
  const toAdd = levels
    .slice(0, limit)
    .filter((l) => !already.has(l.productId))
    .map((l) => ({ stockCountId: count.id, productId: l.productId, snapshotQty: l.onHand }));

  if (toAdd.length > 0) {
    await prisma.stockCountItem.createMany({ data: toAdd, skipDuplicates: true });
  }
  return { ok: true, added: toAdd.length, truncated };
}

/** Record a counted quantity (or clear it with null). */
export async function setCountedQuantity(
  shop: string,
  countId: string,
  itemId: string,
  countedQty: number | null,
): Promise<{ ok: boolean; error?: string }> {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, shop },
    select: { id: true, status: true },
  });
  if (!count) return { ok: false, error: "Count not found" };
  if (count.status === "posted" || count.status === "cancelled") {
    return { ok: false, error: "This count can no longer be edited" };
  }
  if (countedQty !== null && (!Number.isFinite(countedQty) || countedQty < 0)) {
    return { ok: false, error: "A counted quantity cannot be negative" };
  }

  const { count: updated } = await prisma.stockCountItem.updateMany({
    where: { id: itemId, stockCountId: count.id },
    data: { countedQty: countedQty === null ? null : Math.floor(countedQty) },
  });
  if (updated === 0) return { ok: false, error: "Line not found on this count" };
  return { ok: true };
}

export async function removeCountItem(
  shop: string,
  countId: string,
  itemId: string,
): Promise<{ ok: boolean; error?: string }> {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, shop },
    select: { id: true, status: true },
  });
  if (!count) return { ok: false, error: "Count not found" };
  if (count.status !== "counting") return { ok: false, error: "This count is no longer open for editing" };

  await prisma.stockCountItem.deleteMany({ where: { id: itemId, stockCountId: count.id } });
  return { ok: true };
}

/** Move a count between counting and review without posting. */
export async function setCountStatus(
  shop: string,
  countId: string,
  status: "counting" | "review",
): Promise<{ ok: boolean; error?: string }> {
  const { count } = await prisma.stockCount.updateMany({
    where: { id: countId, shop, status: { in: ["counting", "review"] } },
    data: { status },
  });
  if (count === 0) return { ok: false, error: "Count cannot change state now" };
  return { ok: true };
}

export async function cancelStockCount(
  shop: string,
  countId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { count } = await prisma.stockCount.updateMany({
    where: { id: countId, shop, status: { in: ["counting", "review"] } },
    data: { status: "cancelled" },
  });
  if (count === 0) return { ok: false, error: "Only an open or in-review count can be cancelled" };
  return { ok: true };
}

export interface PostCountResult {
  ok: boolean;
  error?: string;
  /** Lines whose variance moved stock. */
  applied: number;
  /** Lines that were already square (counted == snapshot). */
  unchanged: number;
  /** Lines skipped because they were never counted. */
  uncounted: number;
  /** Per-line failures (e.g. a guard rejected the movement); the count is still posted. */
  failures: { productId: string; error: string }[];
  shopifyWarnings: string[];
}

/**
 * Post a count: apply each counted line's variance as a stock adjustment.
 *
 * The count is claimed atomically before any stock moves, exactly like receiving a PO —
 * the status check is a read, and a read cannot stop a second submit that already passed
 * it, which would post every adjustment twice. If nothing can be applied the claim is
 * released so the count is not stranded as "posted" with no effect.
 *
 * Uncounted lines are skipped, not treated as zero: a blank means "not yet counted", and
 * reading it as a physical count of nil would wrongly zero out real stock.
 */
export async function postStockCount(
  admin: AdminApiContext,
  shop: string,
  countId: string,
  userId?: string | null,
): Promise<PostCountResult> {
  const base: Omit<PostCountResult, "ok" | "error"> = {
    applied: 0,
    unchanged: 0,
    uncounted: 0,
    failures: [],
    shopifyWarnings: [],
  };

  const count = await prisma.stockCount.findFirst({
    where: { id: countId, shop },
    include: { items: true },
  });
  if (!count) return { ok: false, error: "Count not found", ...base };
  if (count.status === "posted") return { ok: false, error: "This count is already posted", ...base };
  if (count.status === "cancelled") return { ok: false, error: "This count was cancelled", ...base };

  // Claim it. Exactly one caller sees count === 1; a racing submit is turned away.
  const claim = await prisma.stockCount.updateMany({
    where: { id: count.id, shop, status: { in: ["counting", "review"] } },
    data: { status: "posted", postedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false, error: "This count is already being posted", ...base };
  const previousStatus = count.status;

  const failures: { productId: string; error: string }[] = [];
  const shopifyWarnings: string[] = [];
  let applied = 0;
  let unchanged = 0;
  let uncounted = 0;

  for (const item of count.items) {
    if (item.countedQty === null) {
      uncounted++;
      continue;
    }
    const delta = item.countedQty - item.snapshotQty;
    if (delta === 0) {
      unchanged++;
      continue;
    }

    const result = await applyStockDelta(
      admin,
      shop,
      item.productId,
      delta,
      "count_correction",
      `Cycle count ${count.countNumber}: counted ${item.countedQty} vs ${item.snapshotQty} on record`,
      count.locationId,
      { userId },
    );

    if ("error" in result) {
      failures.push({ productId: item.productId, error: result.error as string });
      continue;
    }
    if (!result.shopifySynced && result.shopifyError) shopifyWarnings.push(result.shopifyError);
    applied++;
  }

  // Nothing moved and there was work that failed: release the claim so the count can be
  // retried rather than sitting posted with no effect. A count that was simply all-square
  // (everything counted and matching) is legitimately posted with applied === 0.
  if (applied === 0 && failures.length > 0) {
    await prisma.stockCount.updateMany({
      where: { id: count.id, shop },
      data: { status: previousStatus, postedAt: null },
    });
    return {
      ok: false,
      error: failures[0].error,
      applied,
      unchanged,
      uncounted,
      failures,
      shopifyWarnings,
    };
  }

  return { ok: true, applied, unchanged, uncounted, failures, shopifyWarnings };
}
