export interface ChipOption {
  value: string;
  label: string;
}

interface Props {
  options: ChipOption[];
  active: string;
  onChange: (value: string) => void;
}

export function FilterChips({ options, active, onChange }: Props) {
  return (
    <div style={{ display: "flex", gap: "7px", marginBottom: "14px", flexWrap: "wrap" }}>
      {options.map((opt) => {
        const on = active === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontSize: "12.5px",
              fontWeight: on ? 600 : 500,
              padding: "6px 12px",
              borderRadius: "var(--inv-radius-pill)",
              cursor: "pointer",
              border: "1px solid " + (on ? "var(--inv-ink)" : "var(--inv-input-border)"),
              background: on ? "var(--inv-ink)" : "#fff",
              color: on ? "#fff" : "#5d5a51",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface TogglePillsProps {
  options: ChipOption[];
  active: string;
  onChange: (value: string) => void;
}

export function TogglePills({ options, active, onChange }: TogglePillsProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--inv-divider-3)",
        borderRadius: "var(--inv-radius-control)",
        padding: "3px",
        gap: "2px",
      }}
    >
      {options.map((opt) => {
        const on = active === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontSize: "12.5px",
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: "8px",
              border: "none",
              cursor: "pointer",
              background: on ? "#fff" : "transparent",
              color: on ? "var(--inv-ink)" : "#8b877d",
              boxShadow: on ? "0 1px 2px rgba(0,0,0,.08)" : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
