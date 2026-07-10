import { useState } from "react";

export interface PickerProduct {
  id: string;
  label: string;
  sku?: string | null;
}

interface Props {
  products: PickerProduct[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function ProductPicker({ products, selected, onChange }: Props) {
  const [query, setQuery] = useState("");

  const filtered = query
    ? products.filter((p) => (p.label + " " + (p.sku ?? "")).toLowerCase().includes(query.toLowerCase()))
    : products;

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const selectedProducts = products.filter((p) => selected.includes(p.id));

  return (
    <div>
      {selectedProducts.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
          {selectedProducts.map((p) => (
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
                onClick={() => toggle(p.id)}
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
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products or variants to scope this event…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: "13px", background: "transparent", color: "var(--inv-ink)" }}
        />
      </div>
      <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid var(--inv-divider-3)", borderRadius: "10px" }}>
        {filtered.length === 0 ? (
          <div style={{ padding: "12px", fontSize: "12px", color: "var(--inv-muted)" }}>No matching products.</div>
        ) : (
          filtered.map((p) => {
            const on = selected.includes(p.id);
            return (
              <div
                key={p.id}
                onClick={() => toggle(p.id)}
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
      </div>
    </div>
  );
}
