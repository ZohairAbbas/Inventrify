// Run on PROD: node probe-returns.mjs [shop]
// Distinguishes "Courierify returns empty" from "updatedSince window excludes the return".
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const SHOP = process.argv[2] || "whatsapp-check.myshopify.com";
const base = (process.env.COURIERIFY_BASE_URL || "https://courierify.growzar.com").replace(/\/$/, "");
const s = await p.shopSettings.findUnique({ where: { shop: SHOP }, select: { courierifyApiKey: true, courierifyReturnsCursor: true } });
if (!s?.courierifyApiKey) { console.log("No key"); process.exit(0); }
console.log("Stored cursor:", s.courierifyReturnsCursor, "\n");

const hdr = { Authorization: `Bearer ${s.courierifyApiKey}` };
async function hit(label, qs) {
  const url = `${base}/api/external/inventrify/returns?shop=${encodeURIComponent(SHOP)}${qs}`;
  const r = await fetch(url, { headers: hdr });
  const body = await r.text();
  let rows = null; try { rows = JSON.parse(body).rows; } catch {}
  console.log(`${label} [HTTP ${r.status}] rowCount=${Array.isArray(rows)?rows.length:"?"}`);
  console.log("  " + body.slice(0, 900) + "\n");
}
// A) Exactly what the app sends (with stored cursor)
await hit("A) WITH stored cursor", s.courierifyReturnsCursor ? `&updatedSince=${encodeURIComponent(s.courierifyReturnsCursor.toISOString())}` : "");
// B) No cursor at all — full backlog (what a first sync / rewind would fetch)
await hit("B) NO updatedSince (full backlog)", "");
// C) Very old window — force-include everything
await hit("C) updatedSince=2020-01-01", "&updatedSince=2020-01-01T00:00:00.000Z");
await p.$disconnect();
