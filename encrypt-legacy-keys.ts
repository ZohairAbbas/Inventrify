/**
 * One-off operational script: encrypt integration keys still stored as plaintext.
 *
 * Courierify/Financify keys saved before encryption was added stay plaintext until the
 * merchant saves them again. This upgrades them in place. Idempotent: encrypted values
 * are skipped, so running it twice changes nothing the second time.
 *
 * Needs ENCRYPTION_KEY — the same one the app runs with — in the environment:
 *   set -a; source .env; set +a
 *
 * Dry run (default) — reads only, prints counts, never key values:
 *   npx vite-node encrypt-legacy-keys.ts
 *
 * Apply:
 *   npx vite-node encrypt-legacy-keys.ts -- --apply
 */
import prisma from "./app/db.server";
import { isLegacyPlaintext, upgradeLegacySecret } from "./app/lib/crypto.server";

const apply = process.argv.includes("--apply");
const COLUMNS = ["courierifyApiKey", "financifyApiKey"] as const;

const rows = await prisma.shopSettings.findMany({
  select: { id: true, courierifyApiKey: true, financifyApiKey: true },
});

const summary: Record<string, { set: number; plaintext: number; upgraded: number }> = {};
for (const column of COLUMNS) {
  const stats = { set: 0, plaintext: 0, upgraded: 0 };
  for (const row of rows) {
    const value = row[column];
    if (!value) continue;
    stats.set++;
    if (!isLegacyPlaintext(value)) continue;
    stats.plaintext++;
    if (!apply) continue;

    const encrypted = upgradeLegacySecret(value);
    // Conditional on the value being unchanged, so a merchant saving a new key while
    // this runs is never overwritten with the old one.
    const { count } = await prisma.shopSettings.updateMany({
      where: { id: row.id, [column]: value },
      data: { [column]: encrypted },
    });
    stats.upgraded += count;
  }
  summary[column] = stats;
}

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", shops: rows.length, ...summary }));
await prisma.$disconnect();
