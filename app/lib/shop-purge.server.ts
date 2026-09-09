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
export async function purgeShopData(
  shop: string,
  { keepSession = false }: { keepSession?: boolean } = {},
): Promise<void> {
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

  // Cycle counts: items are scoped via their parent count, and both FK to Product /
  // Location, so they must go before the parents below.
  await prisma.stockCountItem.deleteMany({
    where: { stockCount: { shop } },
  });
  await prisma.stockCount.deleteMany({ where: { shop } });

  // Purchase orders: likewise.
  await prisma.purchaseOrderItem.deleteMany({
    where: { purchaseOrder: { shop } },
  });
  await prisma.purchaseOrder.deleteMany({ where: { shop } });

  // Standalone per-shop tables.
  // OrderRegion holds customer delivery cities — the most personal data the app keeps —
  // so it must not survive an uninstall or a redaction request. OrderLineItem and
  // OrderOutcome are order-level records of the same kind.
  await prisma.orderRegion.deleteMany({ where: { shop } });
  await prisma.orderLineItem.deleteMany({ where: { shop } });
  await prisma.orderOutcome.deleteMany({ where: { shop } });
  await prisma.alert.deleteMany({ where: { shop } });
  await prisma.seasonalEvent.deleteMany({ where: { shop } });
  await prisma.webhookEvent.deleteMany({ where: { shop } });
  await prisma.shopDailySnapshot.deleteMany({ where: { shop } });

  // Parents.
  await prisma.product.deleteMany({ where: { shop } });
  await prisma.location.deleteMany({ where: { shop } });
  await prisma.supplier.deleteMany({ where: { shop } });
  await prisma.shopSettings.deleteMany({ where: { shop } });

  // Session goes last, and only when the shop is genuinely gone.
  //
  // `keepSession` exists for the operational "wipe and re-sync from Shopify" case: the app
  // is still installed, the token is still good, and dropping the session would force the
  // merchant to reinstall just to rebuild data we can fetch ourselves. Uninstall and
  // redaction both leave it at the default and take the session with everything else.
  if (!keepSession) {
    await prisma.session.deleteMany({ where: { shop } });
  }
}
