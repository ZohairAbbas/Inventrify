// Run on PROD: node probe-writepath.mjs [shop]
// Replays the returns write-path for the ONE returned row, catching any error.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const SHOP = process.argv[2] || "whatsapp-check.myshopify.com";

// Does the SKU from the return match a product?
const match = await p.product.findFirst({ where: { shop: SHOP, sku: "sku-managed-1" }, select: { id: true, title: true, sku: true } });
console.log("Product match for sku-managed-1:", match || "NONE");

// Is there ALREADY a ReturnItem for this shipment+sku (maybe it wrote, but UI filters it)?
const existing = await p.returnItem.findUnique({
  where: { shipmentId_sku: { shipmentId: "b6b95473-79b7-46eb-85b2-68b43aac469c", sku: "sku-managed-1" } },
}).catch(e => ({ ERROR: e.message }));
console.log("Existing ReturnItem for #1550:", existing || "none");

// ALL return items for the shop (any status), unfiltered
const all = await p.returnItem.findMany({ where: { shop: SHOP } });
console.log("ALL ReturnItem rows for shop:", all.length, JSON.stringify(all, null, 2));

// Try the actual create the poller would do, in a rolled-back tx, to surface any DB error
try {
  await p.$transaction(async (tx) => {
    await tx.returnItem.create({ data: {
      shop: SHOP, shipmentId: "b6b95473-79b7-46eb-85b2-68b43aac469c", shopifyOrderName: "#1550",
      sku: "sku-managed-1", productId: match?.id ?? null, quantity: 1,
      returnReceivedAt: new Date("2026-07-19T13:13:18.435Z"), reasonCategory: null,
    }});
    throw new Error("ROLLBACK_OK"); // don't actually persist
  });
} catch (e) {
  console.log("Create dry-run result:", e.message === "ROLLBACK_OK" ? "WOULD SUCCEED (rolled back)" : "FAILED: " + e.message);
}
await p.$disconnect();
