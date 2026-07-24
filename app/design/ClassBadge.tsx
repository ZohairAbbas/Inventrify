interface Props {
  /** A | B | C — revenue contribution. */
  abc?: string | null;
  /** X | Y | Z — demand variability. */
  xyz?: string | null;
  title?: string;
}

/**
 * ABC/XYZ classification badge.
 *
 * Both scales are ordinal, not categorical, so the encoding is a single hue stepped
 * light-to-dark rather than distinct colours — A is not "a different kind of thing" from
 * C, it is more of the same thing. The letter is always rendered, so identity never rests
 * on colour alone and the badge survives greyscale, CVD and forced-colors.
 *
 * Steps come from the existing neutral ramp rather than a new palette, so this introduces
 * no colour that has not already been checked against the app's surfaces.
 */
const ABC_STEP: Record<string, { bg: string; fg: string; border: string }> = {
  A: { bg: "var(--inv-ink)", fg: "#fff", border: "var(--inv-ink)" },
  B: { bg: "var(--inv-divider-2)", fg: "var(--inv-ink)", border: "var(--inv-divider-2)" },
  C: { bg: "transparent", fg: "var(--inv-muted)", border: "var(--inv-divider-2)" },
};

const ABC_MEANING: Record<string, string> = {
  A: "Top ~80% of demand value — highest service level",
  B: "Next ~15% of demand value — standard service level",
  C: "The long tail — lower service level, less capital tied up",
};

const XYZ_MEANING: Record<string, string> = {
  X: "Steady demand — forecasts are reliable",
  Y: "Variable demand — moderate buffer",
  Z: "Erratic or intermittent demand — hardest to forecast",
};

export function ClassBadge({ abc, xyz, title }: Props) {
  if (!abc && !xyz) {
    return <span style={{ fontSize: "11.5px", color: "var(--inv-faint)" }}>—</span>;
  }

  const step = ABC_STEP[abc ?? ""] ?? ABC_STEP.C;
  const tooltip =
    title ??
    [abc ? `${abc}: ${ABC_MEANING[abc] ?? ""}` : null, xyz ? `${xyz}: ${XYZ_MEANING[xyz] ?? ""}` : null]
      .filter(Boolean)
      .join("\n");

  return (
    <span
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "1px",
        fontFamily: "var(--inv-font-mono)",
        fontSize: "11px",
        fontWeight: 600,
        lineHeight: 1,
        padding: "4px 7px",
        borderRadius: "var(--inv-radius-badge)",
        background: step.bg,
        color: step.fg,
        border: `1px solid ${step.border}`,
        cursor: "help",
        whiteSpace: "nowrap",
      }}
    >
      {abc ?? "·"}
      <span style={{ opacity: 0.65 }}>{xyz ?? ""}</span>
    </span>
  );
}
