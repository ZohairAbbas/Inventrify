/**
 * Tests for alert notification de-duplication and delivery reporting.
 *
 * These hit a real Postgres database (Prisma has no in-memory mode here), so they require
 * a scratch database — the guard below refuses anything not named `*_test`:
 *
 *   createdb inventorify_dispatch_test
 *   DATABASE_URL="postgresql://…/inventorify_dispatch_test?schema=public" npx prisma migrate deploy
 *   DATABASE_URL="postgresql://…/inventorify_dispatch_test?schema=public" npm run test:db
 *
 * Excluded from the default `npm test`, which must not require a database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Resend SDK so no real email is ever sent. `sendResult` is swapped per-test to
// simulate acceptance and failure.
let sendResult: { data?: unknown; error?: { message: string } | null } = {
  data: { id: "test" },
  error: null,
};
const sendSpy = vi.fn(async () => sendResult);
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendSpy };
  },
}));

process.env.RESEND_API_KEY = "test-key";
// Keep WhatsApp out of these tests; email alone exercises the delivery contract.
delete process.env.WAHA_BASE_URL;

// These tests write to whatever DATABASE_URL points at. Refuse to run unless that is
// explicitly a test database — never the production one.
if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error(
    "Refusing to run: DATABASE_URL must point at a database whose name ends in `_test`. " +
      "See the header of this file for how to create one.",
  );
}

const { dispatchAlerts } = await import("./alert-dispatch.server");
const { getDispatchableAlerts, markAlertsNotified } = await import("./alerts.server");
const { default: prisma } = await import("../db.server");

const SHOP = "dispatch-test.myshopify.com";

/** Create a durable Alert row the way generateAlerts() would. */
async function seedAlert(type: string, productId: string) {
  return prisma.alert.create({
    data: {
      shop: SHOP,
      type,
      productId,
      dedupeKey: `${type}:${productId}`,
      message: `${type} on ${productId}`,
      severity: "critical",
    },
  });
}

/** One cron dispatch cycle: pick what is due, send it, record what actually landed. */
async function dispatchCycle() {
  const due = await getDispatchableAlerts(SHOP);
  const result = await dispatchAlerts(SHOP, due);
  await markAlertsNotified(result.deliveredIds);
  return result;
}

beforeEach(async () => {
  sendResult = { data: { id: "test" }, error: null };
  sendSpy.mockClear();
  await prisma.alert.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({
    data: { shop: SHOP, notificationEmail: "merchant@example.com" },
  });
});

describe("dispatchAlerts", () => {
  it("sends new conditions and records them as notified", async () => {
    await seedAlert("stockout", "prod-A");
    await seedAlert("low_stock", "prod-B");

    const result = await dispatchCycle();

    expect(result.sent).toBe(2);
    expect(result.emailOk).toBe(true);
    // One message covering the batch, not one per alert.
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const rows = await prisma.alert.findMany({ where: { shop: SHOP } });
    expect(rows.every((r) => r.lastNotifiedAt !== null)).toBe(true);
  });

  it("does not re-send a condition that is still active", async () => {
    await seedAlert("stockout", "prod-A");

    await dispatchCycle();
    sendSpy.mockClear();
    const second = await dispatchCycle();

    expect(second.sent).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends only the genuinely new condition in a mixed batch", async () => {
    await seedAlert("stockout", "prod-A");
    await dispatchCycle();

    await seedAlert("low_stock", "prod-B");
    const second = await dispatchCycle();

    expect(second.sent).toBe(1);
    expect(second.deliveredIds).toHaveLength(1);
  });

  it("notifies again once a resolved condition recurs", async () => {
    const first = await seedAlert("stockout", "prod-A");
    await dispatchCycle();

    // generateAlerts() marks a cleared condition resolved rather than deleting it.
    await prisma.alert.update({
      where: { id: first.id },
      data: { resolvedAt: new Date() },
    });
    expect(await getDispatchableAlerts(SHOP)).toHaveLength(0);

    // Recurrence: reopened, unread again, cooldown reset.
    await prisma.alert.update({
      where: { id: first.id },
      data: { resolvedAt: null, isRead: false, lastNotifiedAt: null },
    });

    const again = await dispatchCycle();
    expect(again.sent).toBe(1);
  });

  it("does nothing when there is nothing due", async () => {
    const result = await dispatchCycle();
    expect(result.sent).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not record delivery when the send fails, so the next run retries", async () => {
    await seedAlert("stockout", "prod-A");
    sendResult = { error: { message: "provider rejected" } };

    const failed = await dispatchCycle();
    expect(failed.sent).toBe(0);
    expect(failed.failed).toBe(1);

    const row = await prisma.alert.findFirst({ where: { shop: SHOP } });
    expect(row?.lastNotifiedAt).toBeNull();

    // Next run succeeds and the alert is finally delivered.
    sendResult = { data: { id: "test" }, error: null };
    const retried = await dispatchCycle();
    expect(retried.sent).toBe(1);
  });

  it("records nothing when the shop has no delivery channel configured", async () => {
    await prisma.shopSettings.update({
      where: { shop: SHOP },
      data: { notificationEmail: null },
    });
    await seedAlert("stockout", "prod-A");

    const result = await dispatchCycle();

    expect(result.sent).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    // Critically, not marked notified — otherwise configuring email later would never
    // surface the condition.
    const row = await prisma.alert.findFirst({ where: { shop: SHOP } });
    expect(row?.lastNotifiedAt).toBeNull();
  });

  it("caps how many alerts are listed but records them all", async () => {
    for (let i = 0; i < 25; i++) await seedAlert("stockout", `prod-${i}`);

    const result = await dispatchCycle();

    expect(result.sent).toBe(25);
    const notified = await prisma.alert.count({
      where: { shop: SHOP, lastNotifiedAt: { not: null } },
    });
    expect(notified).toBe(25);
  });

  it("suppresses a snoozed alert without marking it notified", async () => {
    const snoozed = await seedAlert("dead_stock", "prod-Z");
    await prisma.alert.update({
      where: { id: snoozed.id },
      data: { snoozedUntil: new Date(Date.now() + 86400000) },
    });

    const result = await dispatchCycle();
    expect(result.sent).toBe(0);

    const row = await prisma.alert.findUnique({ where: { id: snoozed.id } });
    expect(row?.lastNotifiedAt).toBeNull();
  });
});
