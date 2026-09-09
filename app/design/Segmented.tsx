export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Optional trailing count, e.g. "Stockout 4". */
  count?: number;
}

interface Props<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group — required, since the buttons alone carry no context. */
  label: string;
  /** "light" sits on the page; "sunken" sits on a card header. */
  tone?: "light" | "sunken";
}

/**
 * A pill-track toggle: date window on the dashboard head, status filter on its table.
 *
 * Rendered as radios rather than buttons. These select among mutually exclusive views, so
 * arrow-key navigation and a single tab stop are what a screen reader user expects; a row
 * of buttons would announce as five unrelated actions with no indication which is active.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone = "light",
}: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: "flex",
        gap: "2px",
        background: tone === "sunken" ? "#f2f0ea" : "#ece9e1",
        border: tone === "sunken" ? "none" : "1px solid var(--inv-divider-2)",
        borderRadius: tone === "sunken" ? "9px" : "10px",
        padding: "3px",
        flex: "none",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            style={{
              border: "none",
              background: active ? "#fff" : "transparent",
              color: active ? "var(--inv-ink)" : "#8b877d",
              fontSize: tone === "sunken" ? "11.5px" : "12px",
              fontWeight: 500,
              padding: tone === "sunken" ? "5px 11px" : "5px 11px",
              borderRadius: "7px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,.06)" : "none",
            }}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span
                style={{
                  fontFamily: "var(--inv-font-mono)",
                  marginLeft: "6px",
                  color: active ? "var(--inv-text-2)" : "var(--inv-muted)",
                }}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
