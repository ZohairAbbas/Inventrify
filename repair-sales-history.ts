/**
 * One-off operational script: restore SalesRecord days deleted by the old order sync.
 * See app/lib/sales-history-repair.server.ts for what is restored and why.
 *
 * Dry run (default) — reads only, prints per-shop counts:
 *   npx vite-node repair-sales-history.ts
 *   npx vite-node repair-sales-history.ts -- <shop.myshopify.com>
 *
 * Apply — inserts missing days only, never overwrites:
 *   npx vite-node repair-sales-history.ts -- --apply [<shop.myshopify.com>]
 *
 * Deploy the order-sync fix first. Restored days older than 60 days would otherwise be
 * deleted again by the next hourly sync.
 */
import prisma from "./app/db.server";
import { applyShopRepair, planShopRepair } from "./app/lib/sales-history-repair.server";

const args = process.argv.slice(2).filter((a) => a !== "--");
const apply = args.includes("--apply");
const only = args.find((a) => a.endsWith(".myshopify.com"));

const shops = only
  ? [only]
  : (await prisma.shopSettings.findMany({ select: { shop: true }, orderBy: { shop: "asc" } })).map(
      (s) => s.shop,
    );

let totalDays = 0;
let totalUnits = 0;
for (const shop of shops) {
  const plan = await planShopRepair(shop);
  const units = plan.restore.reduce((sum, r) => sum + r.quantity, 0);
  const oldest = plan.restore.reduce<Date | null>(
    (min, r) => (min === null || r.date < min ? r.date : min),
    null,
  );
  totalDays += plan.restore.length;
  totalUnits += units;

  const inserted = apply ? await applyShopRepair(shop, plan) : undefined;
  console.log(
    JSON.stringify({
      shop,
      missingVariantDays: plan.restore.length,
      missingUnits: units,
      oldestMissingDay: oldest?.toISOString().slice(0, 10) ?? null,
      alreadyPresentDays: plan.presentDays,
      presentButDifferentDays: plan.mismatchedDays,
      ...(apply ? { inserted } : {}),
    }),
  );
}

console.log(
  JSON.stringify({ mode: apply ? "apply" : "dry-run", shops: shops.length, totalDays, totalUnits }),
);
await prisma.$disconnect();
