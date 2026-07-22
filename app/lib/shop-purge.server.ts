import prisma from "../db.server";

/**
 * Erase everything Inventorify holds for a shop.
 *
 * The previous inline uninstall handler predated several migrations and never deleted
 * Location, ProductLocationStock, StockTransfer(+Item), ReturnItem, WebhookEvent or
 * ForecastAccuracy. Those rows outlived uninstall, so a merchant who removed the app
 * left tenant data behind — and SHOP_REDACT, the mandatory compliance topic whose whole
 * job is to guarantee erasure, was an empty case that did nothing at all.
 *
 * Ordering respects foreign keys: leaf rows first, then parents. Child tables without
 * their own `shop` column are scoped through their parent relation.
 */
export async function purgeShopData(shop: string): Promise<void> {
  // Rows referencing Product.
  await prisma.forecastAccuracy.deleteMany({ where: { shop } });
  await prisma.forecast.deleteMany({ where: { shop } });
  await prisma.salesRecord.deleteMany({ where: { shop } });
  await prisma.stockSnapshot.deleteMany({ where: { shop } });
  await prisma.stockAdjustment.deleteMany({ where: { shop } });
  await prisma.returnRateHistory.deleteMany({ where: { shop } });
  await prisma.returnItem.deleteMany({ where: { shop } });
  await prisma.productLocationStock.deleteMany({ where: { shop } });

  // Transfers: items are scoped via their parent transfer.
  await prisma.stockTransferItem.deleteMany({
    where: { stockTransfer: { shop } },
  });
  await prisma.stockTransfer.deleteMany({ where: { shop } });

  // Purchase orders: likewise.
  await prisma.purchaseOrderItem.deleteMany({
    where: { purchaseOrder: { shop } },
  });
  await prisma.purchaseOrder.deleteMany({ where: { shop } });

  // Standalone per-shop tables.
  // OrderRegion holds customer delivery cities — the most personal data the app keeps —
  // so it must not survive an uninstall or a redaction request.
  await prisma.orderRegion.deleteMany({ where: { shop } });
  await prisma.alert.deleteMany({ where: { shop } });
  await prisma.seasonalEvent.deleteMany({ where: { shop } });
  await prisma.webhookEvent.deleteMany({ where: { shop } });

  // Parents.
  await prisma.product.deleteMany({ where: { shop } });
  await prisma.location.deleteMany({ where: { shop } });
  await prisma.supplier.deleteMany({ where: { shop } });
  await prisma.shopSettings.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });
}
