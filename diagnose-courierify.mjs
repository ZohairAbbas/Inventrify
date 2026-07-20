// Run on PROD: node diagnose-courierify.mjs
// Uses the prod DATABASE_URL + COURIERIFY_BASE_URL from the prod environment.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const SHOP = process.argv[2] || "whatsapp-check.myshopify.com";
const base = (process.env.COURIERIFY_BASE_URL || "https://courierify.growzar.com").replace(/\/$/, "");
console.log("DB host:", (process.env.DATABASE_URL||"").replace(/:\/\/[^@]*@/, "://***@"));
console.log("Courierify base:", base, "| shop:", SHOP, "\n");

// 1) Connection + cursor
const s = await p.shopSettings.findUnique({
  where: { shop: SHOP },
  select: { courierifyApiKey: true, courierifyReturnsCursor: true },
});
console.log("1) CONNECTION:",
  s ? { keySet: !!s.courierifyApiKey, keyPrefix: s.courierifyApiKey?.slice(0,12) ?? null, returnsCursor: s.courierifyReturnsCursor } : "NO ShopSettings ROW");

// 2) Product SKUs for the returned item
const prods = await p.product.findMany({
  where: { shop: SHOP, title: { contains: "Multi-location Snowboard", mode: "insensitive" } },
  select: { title: true, variantTitle: true, sku: true, fulfilledReturned: true, fulfilledDelivered: true, codReturnRate: true, fulfilmentSyncedAt: true },
});
console.log("\n2) INVENTRIFY PRODUCTS (Multi-location Snowboard):", JSON.stringify(prods, null, 2));
const total = await p.product.count({ where: { shop: SHOP } });
const withSku = await p.product.count({ where: { shop: SHOP, sku: { not: null } } });
console.log(`   SKU coverage: ${withSku}/${total} products have a non-null sku`);

// 3) Return queue rows
const rets = await p.returnItem.findMany({ where: { shop: SHOP }, select: { sku: true, shipmentId: true, productId: true, status: true } });
console.log("\n3) RETURN ITEMS:", rets.length ? JSON.stringify(rets, null, 2) : "none");

// 4) Live-probe the three endpoints with the real key
if (s?.courierifyApiKey) {
  for (const ep of ["status-summary", "return-rates", "returns"]) {
    try {
      const r = await fetch(`${base}/api/external/inventrify/${ep}?shop=${encodeURIComponent(SHOP)}`, { headers: { Authorization: `Bearer ${s.courierifyApiKey}` } });
      const body = await r.text();
      console.log(`\n4) ${ep} [HTTP ${r.status}]\n${body.slice(0, 1500)}`);
    } catch (e) { console.log(`\n4) ${ep} FETCH ERROR: ${e.message}`); }
  }
} else {
  console.log("\n4) Skipping endpoint probe — no API key persisted.");
}
await p.$disconnect();
