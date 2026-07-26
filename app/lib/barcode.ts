/**
 * Code 128 (subset B) encoder.
 *
 * Turns a string into the bar/space widths of a scannable Code 128 barcode. Subset B
 * covers all printable ASCII (32–126), which is every character a SKU or a typical
 * retail barcode uses, so one subset keeps the encoder simple and correct rather than
 * juggling A/B/C shifts. A pure function with no dependencies: the alternative is pulling
 * a barcode library into the bundle for what is a small, fixed lookup table.
 *
 * Correctness is the whole point — a mis-encoded barcode is an unscannable label, which
 * is worse than no label. The check symbol and the module widths are validated in
 * barcode.test.ts by decoding the output back to the input.
 */

// The 107 Code 128 symbol patterns, as bar/space module widths. Index is the symbol
// value; each string is six digits summing to 11 modules (bar, space, bar, space, …
// starting with a bar), except the stop pattern which carries a seventh. This is the
// canonical table from the Code 128 specification.
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;

/** A character usable in Code 128 subset B — printable ASCII. */
export function isEncodable(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

export interface EncodedBarcode {
  /** Alternating bar/space module widths, starting with a bar. */
  modules: number[];
  /** Total module count, for laying the SVG out at an exact width. */
  totalModules: number;
}

/**
 * Encode `value` into Code 128-B module widths.
 *
 * Returns null for a value that cannot be represented (empty, or containing a character
 * outside printable ASCII), so a caller renders nothing rather than a barcode that scans
 * to the wrong thing.
 */
export function encodeCode128(value: string): EncodedBarcode | null {
  if (value.length === 0 || !isEncodable(value)) return null;

  // Symbol values: start, one per character (ASCII − 32), then the mod-103 check.
  const symbols: number[] = [START_B];
  for (const ch of value) symbols.push(ch.charCodeAt(0) - 32);

  let checksum = START_B;
  for (let i = 1; i < symbols.length; i++) checksum += symbols[i] * i;
  symbols.push(checksum % 103);
  symbols.push(STOP);

  const modules: number[] = [];
  for (const symbol of symbols) {
    for (const width of PATTERNS[symbol]) modules.push(Number(width));
  }

  return { modules, totalModules: modules.reduce((sum, w) => sum + w, 0) };
}

/**
 * Render a Code 128 barcode as a self-contained SVG string.
 *
 * `moduleWidth` is the width of one narrow bar in px; height and a quiet zone are added
 * around it. The quiet zone (10 modules each side) is mandatory — scanners need the clear
 * margin, and a barcode printed flush to other content often will not read. Returns null
 * for an unencodable value.
 */
export function barcodeSvg(
  value: string,
  opts: { moduleWidth?: number; height?: number; quietModules?: number } = {},
): string | null {
  const encoded = encodeCode128(value);
  if (!encoded) return null;

  const moduleWidth = opts.moduleWidth ?? 2;
  const height = opts.height ?? 60;
  const quiet = opts.quietModules ?? 10;

  const totalWidth = (encoded.totalModules + quiet * 2) * moduleWidth;
  const rects: string[] = [];
  let x = quiet * moduleWidth;
  let isBar = true; // patterns always start with a bar
  for (const w of encoded.modules) {
    const width = w * moduleWidth;
    if (isBar) {
      rects.push(`<rect x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="${height}"/>`);
    }
    x += width;
    isBar = !isBar;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth.toFixed(2)}" height="${height}" ` +
    `viewBox="0 0 ${totalWidth.toFixed(2)} ${height}" fill="#000" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${totalWidth.toFixed(2)}" height="${height}" fill="#fff"/>` +
    rects.join("") +
    `</svg>`
  );
}
