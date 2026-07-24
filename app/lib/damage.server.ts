import prisma from "../db.server";

/**
 * Units written off as damaged, per product.
 *
 * Two sources feed one figure: stock adjustments recorded with reason "damage", and
 * returned parcels resolved as written_off from the returns queue.
 *
 * The subtlety is the sign. This used to be `Math.abs(sum(delta))` over every "damage"
 * adjustment, which is wrong twice over:
 *
 *   - A *positive* adjustment tagged "damage" is stock being added back, not destroyed.
 *     One live shop recorded +15 with the note "they were missing, they came back"; the
 *     inventory page and the dashboard both reported 15 damaged units against a true
 *     count of zero.
 *   - Summing before taking the absolute value nets opposing movements together, so a
 *     SKU with 20 units damaged and a later +15 correction reported 5 damaged.
 *
 * Only units that actually left sellable stock count, so the query filters to negative
 * deltas and the absolute value is taken per row by the database.
 */
export async function getDamagedUnitsByProduct(
  shop: string,
  options: { from?: Date; to?: Date } = {},
): Promise<Map<string, number>> {
  // `to` is exclusive, matching DateRange. Both bounds are optional so the inventory
  // page can ask for an all-time tally while the dashboard windows it to the selected
  // reporting range — a custom range that ends in the past needs the upper bound too.
  const window =
    options.from || options.to
      ? { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lt: options.to } : {}) }
      : undefined;

  const [damageTally, writeOffTally] = await Promise.all([
    prisma.stockAdjustment.groupBy({
      by: ["productId"],
      where: {
        shop,
        reason: "damage",
        // Stock removed, never stock added back under a "damage" label.
        delta: { lt: 0 },
        ...(window ? { createdAt: window } : {}),
      },
      _sum: { delta: true },
    }),
    prisma.returnItem.groupBy({
      by: ["productId"],
      where: {
        shop,
        status: "written_off",
        productId: { not: null },
        ...(window ? { resolvedAt: window } : {}),
      },
      _sum: { quantity: true },
    }),
  ]);

  const byProduct = new Map<string, number>();
  for (const row of damageTally) {
    // Every delta in this set is negative, so the sum is too; flip it once, at the end.
    byProduct.set(row.productId, Math.abs(row._sum.delta ?? 0));
  }
  for (const row of writeOffTally) {
    if (!row.productId) continue;
    byProduct.set(
      row.productId,
      (byProduct.get(row.productId) ?? 0) + (row._sum.quantity ?? 0),
    );
  }
  return byProduct;
}

/** Shop-wide damaged total, for the dashboard's fulfilment breakdown. */
export async function getDamagedUnitsTotal(
  shop: string,
  options: { from?: Date; to?: Date } = {},
): Promise<number> {
  const byProduct = await getDamagedUnitsByProduct(shop, options);
  let total = 0;
  for (const units of byProduct.values()) total += units;
  return total;
}
