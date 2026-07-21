import { describe, expect, it } from "vitest";
import { shopDateKey, shopDateString, shopWeekStart } from "./tz.server";

describe("shopDateString", () => {
  it("attributes a late-evening Karachi order to the local day, not the next UTC day", () => {
    // 2026-03-10 21:30 in Karachi (UTC+5) is 16:30 UTC the same day.
    const instant = new Date("2026-03-10T16:30:00.000Z");
    expect(shopDateString(instant, "Asia/Karachi")).toBe("2026-03-10");
  });

  it("is the regression case: 23:30 local rolls the UTC date but not the local one", () => {
    // 2026-03-10 23:30 Karachi == 2026-03-10 18:30 UTC.
    const instant = new Date("2026-03-10T18:30:00.000Z");
    expect(shopDateString(instant, "Asia/Karachi")).toBe("2026-03-10");
    // The naive UTC bucketing this replaces would also say the 10th here, but at
    // 20:30 local (15:30Z on the 10th) vs 02:00 local next day it diverges:
    const pastMidnightLocal = new Date("2026-03-10T21:00:00.000Z"); // 02:00 on the 11th
    expect(shopDateString(pastMidnightLocal, "Asia/Karachi")).toBe("2026-03-11");
    expect(pastMidnightLocal.toISOString().slice(0, 10)).toBe("2026-03-10");
  });

  it("handles a UTC-behind zone", () => {
    // 2026-03-10 01:00 UTC is 2026-03-09 20:00 in New York.
    const instant = new Date("2026-03-10T01:00:00.000Z");
    expect(shopDateString(instant, "America/New_York")).toBe("2026-03-09");
  });

  it("falls back to UTC for an unknown zone rather than throwing", () => {
    const instant = new Date("2026-03-10T18:30:00.000Z");
    expect(shopDateString(instant, "Not/AZone")).toBe("2026-03-10");
  });
});

describe("shopDateKey", () => {
  it("returns midnight UTC of the shop-local date", () => {
    const instant = new Date("2026-03-10T21:00:00.000Z"); // 02:00 on the 11th in Karachi
    expect(shopDateKey(instant, "Asia/Karachi").toISOString()).toBe(
      "2026-03-11T00:00:00.000Z",
    );
  });
});

describe("shopWeekStart", () => {
  it("snaps to the preceding Monday", () => {
    // 2026-03-11 is a Wednesday.
    const instant = new Date("2026-03-11T09:00:00.000Z");
    expect(shopWeekStart(instant, "UTC").toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("treats Sunday as the end of the week, not the start", () => {
    // 2026-03-15 is a Sunday; its week began Monday the 9th.
    const instant = new Date("2026-03-15T09:00:00.000Z");
    expect(shopWeekStart(instant, "UTC").toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("uses the shop-local date when deciding the week", () => {
    // 2026-03-08T21:00Z is Sunday in UTC but Monday 02:00 in Karachi, so the two
    // disagree about which week it belongs to.
    const instant = new Date("2026-03-08T21:00:00.000Z");
    expect(shopWeekStart(instant, "UTC").toISOString()).toBe("2026-03-02T00:00:00.000Z");
    expect(shopWeekStart(instant, "Asia/Karachi").toISOString()).toBe(
      "2026-03-09T00:00:00.000Z",
    );
  });
});
