import { describe, expect, it } from "vitest";
import { displayShopName, greetingFor } from "./greeting";

describe("greetingFor", () => {
  it.each([
    [5, "Good morning"],
    [9, "Good morning"],
    [11, "Good morning"],
    [12, "Good afternoon"],
    [16, "Good afternoon"],
    [17, "Good evening"],
    [21, "Good evening"],
  ])("hour %i reads %s", (hour, expected) => {
    expect(greetingFor(hour)).toBe(expected);
  });

  it("greets the small hours as evening rather than morning", () => {
    // 2am is the tail of a long night, not the start of a morning.
    expect(greetingFor(0)).toBe("Good evening");
    expect(greetingFor(2)).toBe("Good evening");
    expect(greetingFor(4)).toBe("Good evening");
  });

  it("covers every hour of the day", () => {
    for (let h = 0; h < 24; h++) {
      expect(greetingFor(h)).toMatch(/^Good (morning|afternoon|evening)$/);
    }
  });
});

describe("displayShopName", () => {
  it("prefers the name Shopify reports", () => {
    expect(displayShopName("Laziz Snowboards", "aziz-boards.myshopify.com")).toBe(
      "Laziz Snowboards",
    );
  });

  it("de-slugs the domain until the first sync fills the name in", () => {
    expect(displayShopName(null, "aziz-snowboards.myshopify.com")).toBe("Aziz Snowboards");
  });

  it("treats a blank or whitespace name as absent", () => {
    expect(displayShopName("   ", "test-shop.myshopify.com")).toBe("Test Shop");
  });

  it("trims a name that has stray whitespace but real content", () => {
    expect(displayShopName("  Laziz  ", "x.myshopify.com")).toBe("Laziz");
  });

  it("handles underscores and repeated separators", () => {
    expect(displayShopName(null, "aziz__snow_boards.myshopify.com")).toBe("Aziz Snow Boards");
  });

  it("leaves a single-word domain capitalised", () => {
    expect(displayShopName(null, "laziz.myshopify.com")).toBe("Laziz");
  });

  it("copes with a domain that is not myshopify", () => {
    expect(displayShopName(null, "shop.example.com")).toBe("Shop.example.com");
  });

  it("returns null when there is nothing to show, so the greeting can stand alone", () => {
    expect(displayShopName(null, "")).toBeNull();
    expect(displayShopName(null, ".myshopify.com")).toBeNull();
  });
});
