import { useState } from "react";
import { FilterChips } from "./FilterChips";

export interface DateRangeValue {
  preset: string;
  days: number;
  label: string;
  fromInput: string;
  toInput: string;
  exceedsHistory: boolean;
}

interface Props {
  value: DateRangeValue;
  /** Applies a preset ("7"/"30"/"90"). */
  onPreset: (days: string) => void;
  /** Applies an explicit range; both dates are inclusive ISO days. */
  onCustom: (from: string, to: string) => void;
  /** Days of history actually retained, for the out-of-range warning. */
  historyDays?: number;
}

const PRESETS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "custom", label: "Custom" },
];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Preset windows plus an explicit from/to range.
 *
 * The custom inputs are capped at today: a window extending into the future has no data
 * in it and would quietly dilute every per-day average with empty days.
 */
export function DateRangePicker({ value, onPreset, onCustom, historyDays = 90 }: Props) {
  const [open, setOpen] = useState(value.preset === "custom");
  const [from, setFrom] = useState(value.fromInput);
  const [to, setTo] = useState(value.toInput);

  const dirty = from !== value.fromInput || to !== value.toInput;
  const valid = Boolean(from && to);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
      <FilterChips
        options={PRESETS}
        active={value.preset}
        onChange={(next) => {
          if (next === "custom") {
            setOpen(true);
            return;
          }
          setOpen(false);
          onPreset(next);
        }}
      />

      {open && (
        <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap", marginTop: "-8px", marginBottom: "10px" }}>
          <input
            type="date"
            value={from}
            max={to || today()}
            onChange={(e) => setFrom(e.target.value)}
            style={inputStyle}
            aria-label="From date"
          />
          <span style={{ fontSize: "12px", color: "var(--inv-muted)" }}>→</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            max={today()}
            onChange={(e) => setTo(e.target.value)}
            style={inputStyle}
            aria-label="To date"
          />
          <button
            disabled={!valid || (!dirty && value.preset === "custom")}
            onClick={() => onCustom(from, to)}
            style={{
              fontSize: "12.5px",
              fontWeight: 600,
              padding: "6px 12px",
              borderRadius: "var(--inv-radius-pill)",
              border: "1px solid var(--inv-ink)",
              background: valid ? "var(--inv-ink)" : "var(--inv-divider-3)",
              color: valid ? "#fff" : "var(--inv-muted)",
              cursor: valid ? "pointer" : "not-allowed",
            }}
          >
            Apply
          </button>
        </div>
      )}

      {value.exceedsHistory && (
        <div style={{ fontSize: "11.5px", color: "var(--inv-status-critical-fg)", maxWidth: "460px", textAlign: "right", lineHeight: 1.45 }}>
          This range reaches further back than the {historyDays} days of order history the
          app retains, so the earliest part of it will read as zero rather than as missing.
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: "12.5px",
  padding: "5px 9px",
  borderRadius: "8px",
  border: "1px solid var(--inv-input-border)",
  background: "#fff",
  color: "var(--inv-ink)",
  font: "inherit",
  fontFamily: "var(--inv-font-mono)",
};
