import { describe, expect, it } from "vitest";
import { encodeCode128, barcodeSvg, isEncodable } from "./barcode";

/**
 * The encoder is validated by decoding its output back to the input. A mis-encoded
 * barcode is an unscannable label, so "it produced some bars" is not enough — the bars
 * have to mean the original string, with a correct check symbol.
 */

// The canonical pattern table, rebuilt here independently so the test does not just echo
// the encoder's own constant.
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

/** Decode module widths back to the list of symbol values. */
function decodeSymbols(modules: number[]): number[] {
  const widths = modules.join("");
  const symbols: number[] = [];
  let i = 0;
  while (i < widths.length) {
    // Every symbol is six modules except the trailing stop (seven).
    const remaining = widths.length - i;
    const len = remaining === 7 ? 7 : 6;
    const chunk = widths.slice(i, i + len);
    const value = PATTERNS.indexOf(chunk);
    symbols.push(value);
    i += len;
  }
  return symbols;
}

function decodeToString(modules: number[]): { text: string; checkOk: boolean; stopOk: boolean } {
  const symbols = decodeSymbols(modules);
  const start = symbols[0];
  const stop = symbols[symbols.length - 1];
  const check = symbols[symbols.length - 2];
  const data = symbols.slice(1, symbols.length - 2);

  let expected = start;
  data.forEach((v, idx) => (expected += v * (idx + 1)));
  expected %= 103;

  return {
    text: data.map((v) => String.fromCharCode(v + 32)).join(""),
    checkOk: check === expected,
    stopOk: stop === 106 && start === 104,
  };
}

describe("encodeCode128", () => {
  for (const value of ["KUR-1", "8964000123456", "ABC-10", "a", "Size M / Blue", "12345678901234567890"]) {
    it(`round-trips ${JSON.stringify(value)} through encode → decode`, () => {
      const encoded = encodeCode128(value);
      expect(encoded).not.toBeNull();
      const decoded = decodeToString(encoded!.modules);
      expect(decoded.text).toBe(value);
      expect(decoded.checkOk).toBe(true);
      expect(decoded.stopOk).toBe(true);
    });
  }

  it("every symbol pattern is a known table entry (no stray widths)", () => {
    const encoded = encodeCode128("HELLO-123")!;
    // Rebuilding the width string and walking it must consume exactly the whole thing.
    const symbols = decodeSymbols(encoded.modules);
    expect(symbols.every((s) => s >= 0)).toBe(true);
    expect(symbols[0]).toBe(104); // start B
    expect(symbols[symbols.length - 1]).toBe(106); // stop
  });

  it("computes the check symbol against a hand-worked example", () => {
    // "AB": start 104, A=33, B=34. check = (104 + 33*1 + 34*2) % 103 = 205 % 103 = 102.
    const symbols = decodeSymbols(encodeCode128("AB")!.modules);
    expect(symbols).toEqual([104, 33, 34, 102, 106]);
  });

  it("returns null for empty or non-encodable input", () => {
    expect(encodeCode128("")).toBeNull();
    expect(encodeCode128("café")).toBeNull(); // é is outside printable ASCII
    expect(encodeCode128("tab\there")).toBeNull();
  });
});

describe("isEncodable", () => {
  it("accepts printable ASCII and rejects the rest", () => {
    expect(isEncodable("KUR-1")).toBe(true);
    expect(isEncodable("~")).toBe(true);
    expect(isEncodable("")).toBe(false);
    expect(isEncodable("emoji🙂")).toBe(false);
    expect(isEncodable("\n")).toBe(false);
  });
});

describe("barcodeSvg", () => {
  it("produces a self-contained SVG with a white background and a quiet zone", () => {
    const svg = barcodeSvg("KUR-1", { moduleWidth: 2, height: 50 });
    expect(svg).toContain("<svg");
    expect(svg).toContain('fill="#fff"'); // background/quiet zone
    expect(svg).toContain("<rect"); // bars
    expect(svg).toContain("</svg>");
  });

  it("widens with the module width", () => {
    const narrow = barcodeSvg("KUR-1", { moduleWidth: 1 })!;
    const wide = barcodeSvg("KUR-1", { moduleWidth: 3 })!;
    const w = (s: string) => Number(s.match(/width="([\d.]+)"/)![1]);
    expect(w(wide)).toBeGreaterThan(w(narrow));
  });

  it("returns null for an unencodable value rather than an empty barcode", () => {
    expect(barcodeSvg("")).toBeNull();
    expect(barcodeSvg("café")).toBeNull();
  });
});
