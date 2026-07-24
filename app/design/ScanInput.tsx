import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";

export interface ScannedProduct {
  id: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  currentStock: number;
  unitCost: number;
}

type ScanOutcome =
  | { status: "found"; product: ScannedProduct; matchedOn: "barcode" | "sku" }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: ScannedProduct[] };

interface Props {
  onScan: (product: ScannedProduct, matchedOn: "barcode" | "sku") => void;
  /** Shown under the field; use it to say what the scan will do. */
  hint?: string;
  placeholder?: string;
  /** Keeps focus in the field after each scan, for scanning a run of items. */
  keepFocus?: boolean;
  autoFocus?: boolean;
}

/**
 * Barcode scan field.
 *
 * A handheld scanner presents as a keyboard: it types the code far faster than a person
 * can and then sends Enter. So this is an ordinary text input — the work is in what
 * happens around it.
 *
 * Submission is on Enter, never on a timer. Timer-based "detect the burst and fire"
 * heuristics guess wrong for short codes and for anyone typing a code by hand, and a
 * wrong guess here books stock against the wrong SKU. Enter is unambiguous and every
 * scanner sends it by default.
 *
 * The field clears and refocuses after a successful scan so a run of items can be
 * scanned without touching the mouse, and it reports not-found and ambiguous results
 * rather than silently doing nothing — a scanner user is looking at the shelf, not the
 * screen, and needs the failure to be loud.
 */
export function ScanInput({
  onScan,
  hint,
  placeholder = "Scan or type a barcode / SKU, then press Enter",
  keepFocus = true,
  autoFocus = false,
}: Props) {
  const fetcher = useFetcher<ScanOutcome>();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The code that produced the response currently in `fetcher.data`, so one result is
  // never handled twice across re-renders.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle" || pending.current === null) return;
    const scanned = pending.current;
    pending.current = null;

    const result = fetcher.data;
    if (result.status === "found") {
      onScan(result.product, result.matchedOn);
      setMessage({
        tone: "ok",
        text: `${result.product.label} · matched on ${result.matchedOn}`,
      });
      setCode("");
      if (keepFocus) inputRef.current?.focus();
    } else if (result.status === "ambiguous") {
      // Deliberately not resolved for the operator: two variants sharing a barcode is a
      // data problem, and picking one would put stock against the wrong SKU silently.
      setMessage({
        tone: "error",
        text: `“${scanned}” matches ${result.candidates.length} products — fix the duplicate barcode in Shopify before scanning it.`,
      });
    } else {
      setMessage({ tone: "error", text: `Nothing matches “${scanned}”.` });
    }
    // onScan identity changes per render for inline closures; re-running on it would
    // reprocess the same result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const submit = () => {
    const trimmed = code.trim();
    if (trimmed === "" || fetcher.state !== "idle") return;
    setMessage(null);
    pending.current = trimmed;
    fetcher.load(`/api/products/scan?code=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "9px",
          background: "#fff",
          border: "1px solid var(--inv-input-border-2)",
          borderRadius: "10px",
          padding: "0 12px",
          height: "40px",
        }}
      >
        <span aria-hidden style={{ fontSize: "15px", color: "var(--inv-muted)" }}>▮▯▮</span>
        <input
          ref={inputRef}
          value={code}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Stop the surrounding form from submitting: the scanner's Enter means
              // "here is the code", not "save this page".
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Scan a barcode or SKU"
          style={{
            border: "none",
            outline: "none",
            flex: 1,
            fontSize: "13.5px",
            fontFamily: "var(--inv-font-mono)",
            background: "transparent",
            color: "var(--inv-ink)",
          }}
        />
        {fetcher.state !== "idle" && (
          <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>Looking up…</span>
        )}
      </div>

      {(message || hint) && (
        <div
          style={{
            fontSize: "11.5px",
            marginTop: "6px",
            lineHeight: 1.5,
            color: message
              ? message.tone === "ok"
                ? "var(--inv-status-healthy-fg)"
                : "var(--inv-status-critical-fg)"
              : "var(--inv-muted)",
          }}
          role={message?.tone === "error" ? "alert" : undefined}
        >
          {message ? message.text : hint}
        </div>
      )}
    </div>
  );
}
