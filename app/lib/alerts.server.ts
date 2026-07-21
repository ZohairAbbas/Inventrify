import prisma from "../db.server";

/**
 * Alert severity, highest first. Used for ordering and for deciding what is worth
 * interrupting someone with.
 */
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** A condition detected during a run, before it is reconciled against stored alerts. */
interface DetectedAlert {
  type: string;
  productId: string;
  dedupeKey: string;
  message: string;
  severity: "critical" | "warning" | "info";
  revenueAtRisk: number;
}

/**
 * Best-effort unit revenue. `avgMargin` is a fraction of price (see the analytics page,
 * which renders it as a percentage), so price = cost / (1 - margin). Falls back to cost
 * when margin is unknown, and to 0 when the merchant has not supplied a cost at all —
 * in which case money-based ranking degrades to zero rather than to a fabricated number.
 */
function estimateUnitRevenue(p: { unitCost: number; avgMargin: number }): number {
  if (p.unitCost <= 0) return 0;
  if (p.avgMargin > 0 && p.avgMargin < 0.95) return p.unitCost / (1 - p.avgMargin);
  return p.unitCost;
}

/**
 * Recompute every alert condition for a shop and reconcile it with what is stored.
 *
 * Alerts are upserted on a stable (shop, dedupeKey) identity rather than deleted and
 * recreated. The old implementation ran `deleteMany({ shop, isRead: false })` at the top
 * of every run, which threw away read state and creation times and made it impossible to
 * tell a new problem from a standing one — so the daily digest re-sent the same list
 * forever. Conditions that no longer hold are marked resolved, not deleted.
 *
 * Returns counts describing what actually changed.
 */
export async function generateAlerts(
  shop: string,
): Promise<{ total: number; opened: number; resolved: number }> {
  const [products, settings] = await Promise.all([
    prisma.product.findMany({ where: { shop, isArchived: false } }),
    prisma.shopSettings.findUnique({ where: { shop } }),
  ]);

  const deadStockDays = settings?.deadStockDays ?? 60;
  const deadStockMinUnits = settings?.deadStockMinUnits ?? 20;

  const nDaysAgo = new Date(Date.now() - deadStockDays * 86400000);

  // Single query replacing N individual aggregates (N+1 fix)
  const salesSums = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: { shop, date: { gte: nDaysAgo } },
    _sum: { quantity: true },
  });
  const salesMap = new Map(
    salesSums.map((s) => [s.productId, s._sum.quantity ?? 0]),
  );

  // Return rate spike detection: compare latest week vs 4-week avg
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
  const returnRateRecords = await prisma.returnRateHistory.findMany({
    where: { shop, weekStart: { gte: fourWeeksAgo } },
    orderBy: [{ productId: "asc" }, { weekStart: "desc" }],
  });
  const rrByProduct = new Map<
    string,
    { weekStart: Date; returnRate: number }[]
  >();
  for (const r of returnRateRecords) {
    const arr = rrByProduct.get(r.productId) ?? [];
    arr.push({ weekStart: r.weekStart, returnRate: r.returnRate });
    rrByProduct.set(r.productId, arr);
  }

  const detected: DetectedAlert[] = [];

  for (const product of products) {
    const displayName = product.variantTitle
      ? `${product.title} — ${product.variantTitle}`
      : product.title;
    const unitRevenue = estimateUnitRevenue(product);
    const leadTime = product.leadTimeDays || 7;

    if (product.currentStock <= 0) {
      // Nothing can ship until replenishment lands, so the exposure is a full lead
      // time of demand.
      detected.push({
        type: "stockout",
        productId: product.id,
        dedupeKey: `stockout:${product.id}`,
        message: `${displayName} is out of stock.`,
        severity: "critical",
        revenueAtRisk: product.avgDailySales * leadTime * unitRevenue,
      });
    } else if (product.currentStock <= product.reorderPoint) {
      const shortfall = Math.max(
        0,
        product.avgDailySales * leadTime - product.currentStock,
      );
      detected.push({
        type: "low_stock",
        productId: product.id,
        dedupeKey: `low_stock:${product.id}`,
        message: `${displayName} is below reorder point (${product.currentStock} units left, reorder at ${product.reorderPoint}).`,
        severity: shortfall > 0 ? "critical" : "warning",
        revenueAtRisk: shortfall * unitRevenue,
      });
    }

    // Dead stock: stock above threshold with no sales in configured period
    if (product.currentStock >= deadStockMinUnits) {
      const totalSold = salesMap.get(product.id) ?? 0;
      if (totalSold === 0) {
        detected.push({
          type: "dead_stock",
          productId: product.id,
          dedupeKey: `dead_stock:${product.id}`,
          message: `${displayName} may be dead stock — ${product.currentStock} units with no sales in ${deadStockDays} days.`,
          severity: "warning",
          // Capital tied up, not revenue forgone.
          revenueAtRisk: product.currentStock * product.unitCost,
        });
      }
    }

    // Return rate spike: latest week > 1.5× 4-week average
    const rrHistory = rrByProduct.get(product.id) ?? [];
    if (rrHistory.length >= 2) {
      const [latest, ...older] = rrHistory;
      const olderAvg =
        older.reduce((s, r) => s + r.returnRate, 0) / older.length;
      if (olderAvg > 0 && latest.returnRate > olderAvg * 1.5 && latest.returnRate > 0.3) {
        detected.push({
          type: "return_rate_spike",
          productId: product.id,
          dedupeKey: `return_rate_spike:${product.id}`,
          message: `${displayName} return rate spiked to ${(latest.returnRate * 100).toFixed(0)}% (was ${(olderAvg * 100).toFixed(0)}% avg).`,
          severity: "critical",
          // Every RTO unit burns the margin plus round-trip freight.
          revenueAtRisk:
            product.avgDailySales * 30 * latest.returnRate * unitRevenue,
        });
      }
    }
  }

  // Lead-time breach: POs sent but past their expected delivery date. The schema has
  // always listed this alert type; nothing ever generated it.
  const overduePos = await prisma.purchaseOrder.findMany({
    where: {
      shop,
      status: "sent",
      expectedDeliveryDate: { lt: new Date() },
    },
    include: {
      supplier: { select: { name: true } },
      items: {
        include: {
          product: { select: { id: true, title: true, variantTitle: true } },
        },
      },
    },
  });

  for (const po of overduePos) {
    const daysLate = Math.floor(
      (Date.now() - (po.expectedDeliveryDate as Date).getTime()) / 86400000,
    );
    if (daysLate <= 0) continue;
    for (const item of po.items) {
      if (!item.product) continue;
      const name = item.product.variantTitle
        ? `${item.product.title} — ${item.product.variantTitle}`
        : item.product.title;
      detected.push({
        type: "lead_time_breach",
        productId: item.product.id,
        dedupeKey: `lead_time_breach:${po.id}:${item.product.id}`,
        message: `${po.poNumber}${po.supplier ? ` (${po.supplier.name})` : ""} is ${daysLate} day${daysLate === 1 ? "" : "s"} late — ${item.quantityOrdered} × ${name} not received.`,
        severity: daysLate >= 7 ? "critical" : "warning",
        revenueAtRisk: item.quantityOrdered * item.unitCost,
      });
    }
  }

  // Reconcile against stored alerts.
  const existing = await prisma.alert.findMany({
    where: { shop },
    select: { id: true, dedupeKey: true, resolvedAt: true },
  });
  const existingByKey = new Map(existing.map((a) => [a.dedupeKey, a]));
  const detectedKeys = new Set(detected.map((d) => d.dedupeKey));

  let opened = 0;
  for (const d of detected) {
    const prior = existingByKey.get(d.dedupeKey);
    // A condition that had been resolved and has come back counts as newly opened, and
    // is marked unread so it surfaces again.
    const reopened = prior?.resolvedAt != null;
    if (!prior || reopened) opened++;

    await prisma.alert.upsert({
      where: { shop_dedupeKey: { shop, dedupeKey: d.dedupeKey } },
      create: {
        shop,
        type: d.type,
        productId: d.productId,
        dedupeKey: d.dedupeKey,
        message: d.message,
        severity: d.severity,
        revenueAtRisk: d.revenueAtRisk,
      },
      update: {
        // Message/severity/exposure are refreshed; isRead, snoozedUntil, createdAt and
        // lastNotifiedAt are deliberately preserved.
        type: d.type,
        productId: d.productId,
        message: d.message,
        severity: d.severity,
        revenueAtRisk: d.revenueAtRisk,
        resolvedAt: null,
        ...(reopened ? { isRead: false } : {}),
      },
    });
  }

  // Conditions that no longer hold are marked resolved rather than deleted.
  const staleKeys = existing
    .filter((a) => a.resolvedAt == null && !detectedKeys.has(a.dedupeKey))
    .map((a) => a.dedupeKey);
  let resolved = 0;
  if (staleKeys.length > 0) {
    const res = await prisma.alert.updateMany({
      where: { shop, dedupeKey: { in: staleKeys }, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    resolved = res.count;
  }

  return { total: detected.length, opened, resolved };
}

/**
 * Alerts to show in the UI: open (unresolved), not snoozed, unread — worst first.
 * Ordering is by severity then money at risk, so a stockout on a fast mover outranks
 * a stockout on something that sells once a month.
 */
export async function getUnreadAlerts(shop: string, take = 20) {
  const alerts = await prisma.alert.findMany({
    where: {
      shop,
      isRead: false,
      resolvedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }],
    },
  });

  return alerts
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        b.revenueAtRisk - a.revenueAtRisk,
    )
    .slice(0, take);
}

/**
 * Alerts eligible to be pushed to email/WhatsApp: open, unsnoozed, and either never
 * notified or not notified within `cooldownHours`. Without this a standing condition
 * such as "this SKU is dead stock" was re-sent every single day.
 */
export async function getDispatchableAlerts(shop: string, cooldownHours = 24) {
  const cutoff = new Date(Date.now() - cooldownHours * 3600_000);
  const alerts = await prisma.alert.findMany({
    where: {
      shop,
      resolvedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }],
      AND: [{ OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: cutoff } }] }],
    },
  });

  return alerts.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      b.revenueAtRisk - a.revenueAtRisk,
  );
}

/** Record that these alerts have been pushed, so the cooldown starts. */
export async function markAlertsNotified(ids: string[]) {
  if (ids.length === 0) return;
  await prisma.alert.updateMany({
    where: { id: { in: ids } },
    data: { lastNotifiedAt: new Date() },
  });
}

/** Shop-scoped: an alert id alone must never be enough to touch another shop's row. */
export async function markAlertRead(id: string, shop: string) {
  return prisma.alert.updateMany({
    where: { id, shop },
    data: { isRead: true },
  });
}

/** Shop-scoped snooze — hides the alert and suppresses notifications until `until`. */
export async function snoozeAlert(id: string, shop: string, until: Date) {
  return prisma.alert.updateMany({
    where: { id, shop },
    data: { snoozedUntil: until },
  });
}
