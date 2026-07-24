import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";

export interface ComboboxProduct {
  id: string;
  label: string;
  sku: string | null;
  currentStock: number;
}

interface Props {
  value: string;
  /** Shown before a search runs, so an already-chosen product reads as itself. */
  valueLabel?: string | null;
  onChange: (id: string, product?: ComboboxProduct) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Rendered as the first option; selecting it clears the value. */
  emptyOption?: string;
}

/**
 * Type-to-search single product picker.
 *
 * Replaces the `<select>` elements that rendered one `<option>` per variant. Beyond the
 * page weight, a native select of that size cannot be navigated: there is no search, and
 * "Kurta — Blue / M" is indistinguishable from twenty neighbours at a glance.
 *
 * Results come from /api/products/search, which is shop-scoped by the session, so the
 * component never has to be trusted with tenancy.
 */
export function ProductCombobox({
  value,
  valueLabel,
  onChange,
  placeholder = "Search products…",
  disabled = false,
  emptyOption,
}: Props) {
  const fetcher = useFetcher<{ products: ComboboxProduct[]; truncated: boolean }>();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = fetcher.data?.products ?? [];
  const loading = fetcher.state !== "idle";

  // Debounced search. Runs on open with an empty query too, so clicking the field shows
  // the first page of products rather than an empty box demanding input.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      fetcher.load(`/api/products/search?q=${encodeURIComponent(query)}`);
    }, 200);
    return () => clearTimeout(timer);
    // fetcher identity changes every render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  // Close on outside click. Without this the list stays open behind other controls and
  // swallows the next click the user makes.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const options = emptyOption
    ? [{ id: "", label: emptyOption, sku: null, currentStock: 0 }, ...results]
    : results;

  const choose = (product: ComboboxProduct) => {
    onChange(product.id, product.id ? product : undefined);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      // Only swallow Enter when a choice is actually being made; otherwise it must still
      // submit the surrounding form.
      if (open && options[highlight]) {
        e.preventDefault();
        choose(options[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const display = open ? query : valueLabel ?? "";

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        value={display}
        disabled={disabled}
        placeholder={valueLabel ? valueLabel : placeholder}
        onFocus={() => { setOpen(true); setHighlight(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls="product-combobox-list"
        style={{
          width: "100%",
          height: "38px",
          padding: "0 12px",
          fontSize: "13px",
          border: "1px solid var(--inv-input-border-2)",
          borderRadius: "10px",
          background: disabled ? "var(--inv-subtle)" : "#fff",
          color: "var(--inv-ink)",
          outline: "none",
        }}
      />

      {open && (
        <div
          id="product-combobox-list"
          role="listbox"
          style={{
            position: "absolute",
            top: "42px",
            left: 0,
            right: 0,
            zIndex: 40,
            maxHeight: "260px",
            overflowY: "auto",
            background: "#fff",
            border: "1px solid var(--inv-input-border-2)",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,.10)",
          }}
        >
          {loading && results.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: "12.5px", color: "var(--inv-muted)" }}>Searching…</div>
          ) : options.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: "12.5px", color: "var(--inv-muted)" }}>
              No products match “{query}”.
            </div>
          ) : (
            options.map((p, i) => (
              <div
                key={p.id || "__none__"}
                role="option"
                aria-selected={p.id === value}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(p); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: "12.5px",
                  background: i === highlight ? "var(--inv-accent-soft)" : "transparent",
                  borderBottom: "1px solid var(--inv-divider-3)",
                }}
              >
                <span style={{ fontWeight: p.id === value ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.label}
                </span>
                {p.id && (
                  <span style={{ flexShrink: 0, fontFamily: "var(--inv-font-mono)", fontSize: "11px", color: "var(--inv-muted)" }}>
                    {p.sku ?? "—"} · {p.currentStock}
                  </span>
                )}
              </div>
            ))
          )}
          {fetcher.data?.truncated && (
            <div style={{ padding: "8px 12px", fontSize: "11px", color: "var(--inv-muted)" }}>
              Showing the first 20 matches — keep typing to narrow.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
