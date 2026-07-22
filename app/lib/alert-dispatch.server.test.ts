/**
 * Tests for alert notification de-duplication.
 *
 * These hit a real Postgres database (Prisma has no in-memory mode here), so they require
 * a scratch database — the guard below refuses anything not named `*_test`:
 *
 *   createdb inventorify_dispatch_test
 *   DATABASE_URL="postgresql://…/inventorify_dispatch_test?schema=public" npx prisma migrate deploy
 *   DATABASE_URL="postgresql://…/inventorify_dispatch_test?schema=public" npx vitest run
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

// These tests write to whatever DATABASE_URL points at. Refuse to run unless that is
// explicitly a test database — never the production one.
if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error(
    "Refusing to run: DATABASE_URL must point at a database whose name ends in `_test`. " +
      "See the header of this file for how to create one.",
  );
}

const { dispatchAlerts } = await import("./alert-dispatch.server");
const { default: prisma } = await import("../db.server");

const SHOP = "dispatch-test.myshopify.com";

const alert = (type: string, productId: string) => ({
  type,
  productId,
  message: `${type} on ${productId}`,
});

const stockoutA = alert("stockout", "prod-A");
const lowStockB = alert("low_stock", "prod-B");

async function ledgerKeys() {
  const rows = await prisma.alertNotification.findMany({
    where: { shop: SHOP },
    select: { type: true, productId: true },
    orderBy: [{ type: "asc" }, { productId: "asc" }],
  });
  return rows.map((r) => `${r.type} ${r.productId}`);
}

beforeEach(async () => {
  sendResult = { data: { id: "test" }, error: null };
  sendSpy.mockClear();
  await prisma.alertNotification.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({
    data: { shop: SHOP, notificationEmail: "merchant@example.com" },
  });
});

describe("dispatchAlerts", () => {
  it("sends new conditions and records them", async () => {
    const result = await dispatchAlerts(SHOP, [stockoutA, lowStockB]);

    expect(result.sent).toBe(2);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await ledgerKeys()).toEqual(["low_stock prod-B", "stockout prod-A"]);
  });

  it("does not re-send a condition that is still active", async () => {
    await dispatchAlerts(SHOP, [stockoutA, lowStockB]);
    sendSpy.mockClear();

    const result = await dispatchAlerts(SHOP, [stockoutA, lowStockB]);

    expect(result.sent).toBe(0);
    expect(result.suppressed).toBe(2);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends only the genuinely new condition in a mixed batch", async () => {
    await dispatchAlerts(SHOP, [stockoutA]);
    sendSpy.mockClear();

    const result = await dispatchAlerts(SHOP, [stockoutA, lowStockB]);

    expect(result.sent).toBe(1);
    expect(result.suppressed).toBe(1);
    const [[payload]] = sendSpy.mock.calls as unknown as [[{ html: string }]];
    expect(payload.html).toContain("prod-B");
    expect(payload.html).not.toContain("prod-A");
  });

  it("clears the ledger when a condition resolves, and notifies again if it recurs", async () => {
    await dispatchAlerts(SHOP, [stockoutA, lowStockB]);

    // prod-A restocked: it is absent from the active set.
    const resolved = await dispatchAlerts(SHOP, [lowStockB]);
    expect(resolved.cleared).toBe(1);
    expect(await ledgerKeys()).toEqual(["low_stock prod-B"]);

    // It goes out of stock again — the merchant should hear about it.
    sendSpy.mockClear();
    const recurrence = await dispatchAlerts(SHOP, [stockoutA, lowStockB]);
    expect(recurrence.sent).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("reconciles even when no alerts are active", async () => {
    await dispatchAlerts(SHOP, [stockoutA]);

    const result = await dispatchAlerts(SHOP, []);

    expect(result.cleared).toBe(1);
    expect(await ledgerKeys()).toEqual([]);
  });

  it("does not record delivery when the send fails, so the next run retries", async () => {
    sendResult = { error: { message: "rate limited" } };

    const result = await dispatchAlerts(SHOP, [stockoutA]);

    expect(result.sent).toBe(0);
    expect(await ledgerKeys()).toEqual([]);

    // Next run succeeds and the condition is delivered.
    sendResult = { data: { id: "test" }, error: null };
    const retry = await dispatchAlerts(SHOP, [stockoutA]);
    expect(retry.sent).toBe(1);
    expect(await ledgerKeys()).toEqual(["stockout prod-A"]);
  });

  it("records nothing when the shop has no delivery channel configured", async () => {
    await prisma.shopSettings.update({
      where: { shop: SHOP },
      data: { notificationEmail: null },
    });

    const result = await dispatchAlerts(SHOP, [stockoutA]);

    expect(result.sent).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    // Nothing suppressed permanently: configuring an email later still notifies.
    expect(await ledgerKeys()).toEqual([]);
  });

  it("caps how many alerts are listed but records them all", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      alert("stockout", `bulk-${String(i).padStart(2, "0")}`),
    );

    const result = await dispatchAlerts(SHOP, many);

    expect(result.sent).toBe(25);
    const [[payload]] = sendSpy.mock.calls as unknown as [[{ html: string }]];
    expect(payload.html).toContain("…and 5 more.");
    expect(await ledgerKeys()).toHaveLength(25);
  });
});
