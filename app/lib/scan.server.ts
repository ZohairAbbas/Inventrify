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

  // Archived products are excluded: they are gone from Shopify, so a scan matching one
  // is a stale label rather than stock to act on.
  const byBarcode = await prisma.product.findMany({
    where: { shop, isArchived: false, barcode: { equals: code, mode: "insensitive" } },
    select: SELECT,
    take: 5,
  });
  if (byBarcode.length === 1) {
    return { status: "found", product: toScanned(byBarcode[0]), matchedOn: "barcode" };
  }
  if (byBarcode.length > 1) {
    // Duplicate barcodes across variants are a real and common data-entry mistake.
    // Guessing would put stock against the wrong SKU without anyone noticing.
    return { status: "ambiguous", candidates: byBarcode.map(toScanned) };
  }

  const bySku = await prisma.product.findMany({
    where: { shop, isArchived: false, sku: { equals: code, mode: "insensitive" } },
    select: SELECT,
    take: 5,
  });
  if (bySku.length === 1) {
    return { status: "found", product: toScanned(bySku[0]), matchedOn: "sku" };
  }
  if (bySku.length > 1) {
    return { status: "ambiguous", candidates: bySku.map(toScanned) };
  }

  return { status: "not_found" };
}
