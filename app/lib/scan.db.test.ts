/**
 * Resolving a scanned code to a product.
 *
 * The risk this file guards is a lookup that guesses. Receiving and counting act on the
 * result immediately — often without the operator reading the screen — so a match against
 * the wrong SKU, or a silent choice between two candidates, books stock incorrectly. The
 * resolver only ever returns an exact match, and reports ambiguity rather than picking.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { resolveScan } = await import("./scan.server");
const { default: prisma } = await import("../db.server");

const SHOP = "scan-test.myshopify.com";
const OTHER = "other-scan-test.myshopify.com";

let seq = 0;
async function product(opts: {
  shop?: string;
  sku?: string | null;
  barcode?: string | null;
  title?: string;
  stock?: number;
  archived?: boolean;
}) {
  seq += 1;
  return prisma.product.create({
    data: {
      id: `gid://shopify/ProductVariant/scan-${seq}`,
      shop: opts.shop ?? SHOP,
      productGid: `gid://shopify/Product/scan-${seq}`,
      title: opts.title ?? "Kurta",
      sku: opts.sku ?? null,
      barcode: opts.barcode ?? null,
      currentStock: opts.stock ?? 0,
      isArchived: opts.archived ?? false,
    },
  });
}

beforeEach(async () => {
  await prisma.product.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  seq = 0;
});

describe("resolveScan", () => {
  it("matches a barcode exactly", async () => {
    const p = await product({ barcode: "8964000123456", sku: "KUR-1", stock: 12 });
    const r = await resolveScan(SHOP, "8964000123456");
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.product.id).toBe(p.id);
      expect(r.matchedOn).toBe("barcode");
      expect(r.product.currentStock).toBe(12);
    }
  });

  it("falls back to SKU when no barcode matches", async () => {
    await product({ barcode: "111", sku: "KUR-1" });
    const r = await resolveScan(SHOP, "KUR-1");
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.matchedOn).toBe("sku");
  });

  it("prefers a barcode match over a SKU match on a different product", async () => {
    // One product's barcode equals another product's SKU. The barcode is what was
    // physically scanned, so it must win.
    const barcoded = await product({ barcode: "SHARED", sku: "A" });
    await product({ barcode: "999", sku: "SHARED" });
    const r = await resolveScan(SHOP, "SHARED");
    expect(r.status).toBe("found");
    if (r.status === "found") {
      expect(r.product.id).toBe(barcoded.id);
      expect(r.matchedOn).toBe("barcode");
    }
  });

  it("is case-insensitive", async () => {
    await product({ sku: "kur-1" });
    const r = await resolveScan(SHOP, "KUR-1");
    expect(r.status).toBe("found");
  });

  it("does not match a prefix — ABC-1 must not resolve to ABC-10", async () => {
    await product({ sku: "ABC-10" });
    const r = await resolveScan(SHOP, "ABC-1");
    expect(r.status).toBe("not_found");
  });

  it("reports duplicate barcodes as ambiguous instead of guessing", async () => {
    await product({ barcode: "DUP", sku: "A" });
    await product({ barcode: "DUP", sku: "B" });
    const r = await resolveScan(SHOP, "DUP");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("reports duplicate SKUs as ambiguous", async () => {
    await product({ sku: "SAME" });
    await product({ sku: "SAME" });
    const r = await resolveScan(SHOP, "SAME");
    expect(r.status).toBe("ambiguous");
  });

  it("ignores archived products — a scan of one is a stale label", async () => {
    await product({ barcode: "GONE", archived: true });
    const r = await resolveScan(SHOP, "GONE");
    expect(r.status).toBe("not_found");
  });

  it("does not resolve a code that belongs only to another shop", async () => {
    await product({ shop: OTHER, barcode: "TENANT" });
    const r = await resolveScan(SHOP, "TENANT");
    expect(r.status).toBe("not_found");
  });

  it("trims surrounding whitespace from the scanned value", async () => {
    // Scanners commonly append a carriage return or trailing space before Enter.
    await product({ barcode: "8964000000001" });
    const r = await resolveScan(SHOP, "  8964000000001\r");
    expect(r.status).toBe("found");
  });

  it("treats an empty scan as not found rather than matching a blank column", async () => {
    // Most rows have a null barcode; an empty query must not sweep them all up.
    await product({ sku: "HASNOBARCODE" });
    await product({ sku: "ALSONOBARCODE" });
    const r = await resolveScan(SHOP, "   ");
    expect(r.status).toBe("not_found");
  });

  it("does not treat two blank-barcode products as an ambiguous barcode match", async () => {
    await product({ sku: "X", barcode: null });
    await product({ sku: "Y", barcode: null });
    const r = await resolveScan(SHOP, "X");
    // Resolves cleanly by SKU; the null barcodes must not collide into an ambiguity.
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.matchedOn).toBe("sku");
  });
});
