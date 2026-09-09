/**
 * One-off operational script: wipe a shop's data and let the next sync rebuild it from
 * Shopify. Keeps the session, so the merchant does not have to reinstall.
 *
 *   npx vite-node reset-shop.ts -- <shop.myshopify.com>
 */
import { purgeShopData } from "./app/lib/shop-purge.server";
import prisma from "./app/db.server";

const shop = process.argv[process.argv.length - 1];
if (!shop.endsWith(".myshopify.com")) {
  throw new Error(`Refusing to run: "${shop}" is not a shop domain.`);
}

const before = await prisma.session.count({ where: { shop } });
if (before === 0) {
  throw new Error(
    `Refusing to run: ${shop} has no session, so nothing could re-sync afterwards.`,
  );
}

await purgeShopData(shop, { keepSession: true });

console.log(
  JSON.stringify({
    shop,
    products: await prisma.product.count({ where: { shop } }),
    levels: await prisma.productLocationStock.count({ where: { shop } }),
    sessions: await prisma.session.count({ where: { shop } }),
  }),
);

await prisma.$disconnect();
