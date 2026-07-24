import prisma from "../db.server";

/**
 * Resolving a scanned code to a product.
 *
 * A USB or Bluetooth barcode scanner is a keyboard: it types the code and presses Enter.
 * There is no SDK and no device integration — the whole feature is a focused input, this
 * lookup, and being strict about what counts as a match.
 *
 * Strictness is the part worth getting right. Receiving and counting act on the result
 * immediately, often without the operator reading the screen, so a lookup that guesses
 * puts stock against the wrong SKU. This resolves only exact matches, and reports
 * ambiguity rather than picking a winner.
 */

export type ScanOutcome =
  | { status: "found"; product: ScannedProduct; matchedOn: "barcode" | "sku" }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: ScannedProduct[] };

export interface ScannedProduct {
  id: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  currentStock: number;
  unitCost: number;
}

const SELECT = {
  id: true,
  title: true,
  variantTitle: true,
  sku: true,
  barcode: true,
  currentStock: true,
  unitCost: true,
} as const;

type Row = {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  currentStock: number;
  unitCost: number;
};

function toScanned(p: Row): ScannedProduct {
  return {
    id: p.id,
    label: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    sku: p.sku,
    barcode: p.barcode,
    currentStock: p.currentStock,
    unitCost: p.unitCost,
  };
}

/**
 * Look up one scanned code within a shop.
 *
 * Barcode is tried before SKU because it is the machine-readable identity: where both
 * exist, the barcode is what was physically scanned. SKU is the fallback for the many
 * catalogues that carry no barcodes at all, and because merchants do print SKU-encoded
 * labels themselves.
 *
 * Matching is case-insensitive but otherwise exact — no prefix or substring matching.
 * A scan of "ABC-1" must not silently resolve to "ABC-10".
 */
export async function resolveScan(shop: string, rawCode: string): Promise<ScanOutcome> {
  const code = rawCode.trim();
  if (code === "") return { status: "not_found" };

  // Four lookups, ordered so the common case stays on the index.
  //
  //   1. barcode, exact case      3. sku, exact case
  //   2. barcode, any case        4. sku, any case
  //
  // The (shop, barcode) and (shop, sku) btree indexes serve case-sensitive equality but
  // not a case-insensitive one, which Postgres can only satisfy with a scan. A scanner
  // reproduces a code byte-for-byte, so the exact match is what almost every scan hits —
  // keeping it index-backed matters during a receiving session of hundreds of scans over
  // a large catalogue. The insensitive passes exist only for a hand-typed odd-case entry
  // and run only when the exact ones miss.
  const attempts: { field: "barcode" | "sku"; where: object }[] = [
    { field: "barcode", where: { barcode: code } },
    { field: "barcode", where: { barcode: { equals: code, mode: "insensitive" } } },
    { field: "sku", where: { sku: code } },
    { field: "sku", where: { sku: { equals: code, mode: "insensitive" } } },
  ];

  for (const attempt of attempts) {
    // Archived products are excluded: they are gone from Shopify, so a scan matching one
    // is a stale label rather than stock to act on.
    const rows = await prisma.product.findMany({
      where: { shop, isArchived: false, ...attempt.where },
      select: SELECT,
      take: 5,
    });
    if (rows.length === 1) {
      return { status: "found", product: toScanned(rows[0]), matchedOn: attempt.field };
    }
    if (rows.length > 1) {
      // Duplicate codes across variants are a real and common data-entry mistake.
      // Guessing would put stock against the wrong SKU without anyone noticing.
      return { status: "ambiguous", candidates: rows.map(toScanned) };
    }
  }

  return { status: "not_found" };
}
