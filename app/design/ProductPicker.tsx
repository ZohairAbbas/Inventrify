import { useEffect, useState } from "react";
import { useFetcher } from "@remix-run/react";

export interface PickerProduct {
  id: string;
  label: string;
  sku?: string | null;
}

interface Props {
  /** Chosen products, carried with their labels so chips survive a new search. */
  selected: PickerProduct[];
  onChange: (products: PickerProduct[]) => void;
  placeholder?: string;
}

/**
 * Multi-select product picker, searching on demand.
 *
 * This used to take the entire catalogue as a prop and filter it in the browser, which
 * meant the seasonal-events page loaded every variant in the shop just to populate a
 * scroll box. It now queries /api/products/search, which is shop-scoped by the session.
 *
 * Selections are held as whole products rather than bare ids: a chosen SKU has to keep
 * rendering as its own name after the search box is retyped and the results no longer
 * contain it. Holding ids alone made chips blank out as soon as the query changed.
 */
export function ProductPicker({ selected, onChange, placeholder }: Props) {
  const fetcher = useFetcher<{ products: PickerProduct[]; truncated: boolean }>();
  const [query, setQuery] = useState("");
  const [touched, setTouched] = useState(false);

  const results = fetcher.data?.products ?? [];
  const selectedIds = new Set(selected.map((p) => p.id));

  useEffect(() => {
    if (!touched) return;
    const timer = setTimeout(() => {
      fetcher.load(`/api/products/search?q=${encodeURIComponent(query)}`);
    }, 250);
    return () => clearTimeout(timer);
    // fetcher identity changes each render; including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, touched]);

  const toggle = (product: PickerProduct) => {
    onChange(
      selectedIds.has(product.id)
        ? selected.filter((p) => p.id !== product.id)
        : [...selected, { id: product.id, label: product.label, sku: product.sku }],
    );
  };

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
          {selected.map((p) => (
            <span
              key={p.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "11.5px",
                fontWeight: 500,
                background: "var(--inv-accent-soft)",
                color: "var(--inv-accent)",
                padding: "4px 6px 4px 10px",
                borderRadius: "20px",
              }}
            >
              {p.label}
              <button
                type="button"
                onClick={() => toggle(p)}
                aria-label={`Remove ${p.label}`}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit", fontSize: "12px", lineHeight: 1, padding: "2px" }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "9px",
          background: "#fff",
          border: "1px solid var(--inv-input-border)",
          borderRadius: "10px",
          padding: "0 12px",
          height: "38px",
          marginBottom: "6px",
        }}
      >
        <span style={{ color: "var(--inv-muted)" }}>⌕</span>
        <input
          value={query}
          onFocus={() => setTouched(true)}
          onChange={(e) => { setQuery(e.target.value); setTouched(true); }}
          placeholder={placeholder ?? "Search products or variants to scope this event…"}
          style={{ border: "none", outline: "none", flex: 1, fontSize: "13px", background: "transparent", color: "var(--inv-ink)" }}
        />
      </div>

      {touched && (
        <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid var(--inv-divider-3)", borderRadius: "10px" }}>
          {fetcher.state !== "idle" && results.length === 0 ? (
            <div style={{ padding: "12px", fontSize: "12px", color: "var(--inv-muted)" }}>Searching…</div>
          ) : results.length === 0 ? (
            <div style={{ padding: "12px", fontSize: "12px", color: "var(--inv-muted)" }}>No matching products.</div>
          ) : (
            results.map((p) => {
              const on = selectedIds.has(p.id);
              return (
                <div
                  key={p.id}
                  onClick={() => toggle(p)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    cursor: "pointer",
                    fontSize: "12.5px",
                    background: on ? "var(--inv-accent-soft)" : "transparent",
                    borderBottom: "1px solid var(--inv-divider-3)",
                  }}
                >
                  <input type="checkbox" checked={on} readOnly />
                  <span style={{ fontWeight: on ? 600 : 400 }}>{p.label}</span>
                  {p.sku && <span style={{ color: "var(--inv-muted)", fontFamily: "var(--inv-font-mono)", fontSize: "11px" }}>{p.sku}</span>}
                </div>
              );
            })
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
