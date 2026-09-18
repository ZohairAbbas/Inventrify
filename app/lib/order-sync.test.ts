import { describe, expect, it } from "vitest";
import { reconcileFloor } from "./order-sync.server";

describe("reconcileFloor", () => {
  // 08:00 in Karachi (UTC+5).
  const now = new Date("2026-09-18T03:00:00.000Z");

  it("starts a full shop-local day inside Shopify's 60-day window", () => {
    const floor = reconcileFloor(now, false, "Asia/Karachi");
    expect(floor.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    // That local day begins at 19:00 UTC the evening before, which must not be earlier
    // than the oldest order Shopify returns (now − 60 days).
    const localStart = new Date("2026-07-21T19:00:00.000Z");
    expect(localStart.getTime()).toBeGreaterThanOrEqual(now.getTime() - 60 * 86400000);
  });

  it("covers the full 90 days when read_all_orders is granted", () => {
    expect(reconcileFloor(now, true, "Asia/Karachi").toISOString()).toBe(
      "2026-06-21T00:00:00.000Z",
    );
  });

  it("follows the shop's calendar, not UTC", () => {
    // 23:30 UTC is already the next day in Karachi.
    const late = new Date("2026-09-17T23:30:00.000Z");
    expect(reconcileFloor(late, false, "UTC").toISOString()).toBe("2026-07-21T00:00:00.000Z");
    expect(reconcileFloor(late, false, "Asia/Karachi").toISOString()).toBe(
      "2026-07-22T00:00:00.000Z",
    );
  });
});
