import type { ReactNode } from "react";
import { useState } from "react";

export interface DataTableColumn {
  header: string;
  width?: string;
  align?: "left" | "right";
  wrap?: boolean;
}

export interface DataTableRow {
  cells: ReactNode[];
  onClick?: () => void;
  key?: string;
}

interface Props {
  columns: DataTableColumn[];
  rows: DataTableRow[];
  compact?: boolean;
}

export function DataTable({ columns, rows, compact = false }: Props) {
  const gridTemplateColumns = columns.map((c) => c.width || "1fr").join(" ");
  const rowPad = compact ? "var(--inv-row-pad-compact)" : "var(--inv-row-pad)";

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--inv-border)",
        borderRadius: "var(--inv-radius-card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns,
          gap: "12px",
          padding: "10px 16px",
          borderBottom: "1px solid var(--inv-divider)",
          fontSize: "10.5px",
          fontWeight: 600,
          letterSpacing: ".4px",
          color: "var(--inv-muted)",
          textTransform: "uppercase",
        }}
      >
        {columns.map((c, i) => (
          <div key={i} style={{ textAlign: c.align || "left" }}>
            {c.header}
          </div>
        ))}
      </div>
      {rows.map((row, ri) => (
        <TableRow
          key={row.key ?? ri}
          row={row}
          columns={columns}
          gridTemplateColumns={gridTemplateColumns}
          rowPad={rowPad}
          isFirst={ri === 0}
        />
      ))}
    </div>
  );
}

function TableRow({
  row,
  columns,
  gridTemplateColumns,
  rowPad,
  isFirst,
}: {
  row: DataTableRow;
  columns: DataTableColumn[];
  gridTemplateColumns: string;
  rowPad: string;
  isFirst: boolean;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      onClick={row.onClick}
      onMouseEnter={() => row.onClick && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns,
        gap: "12px",
        padding: rowPad,
        borderTop: isFirst ? "none" : "1px solid var(--inv-divider-3)",
        fontSize: "13px",
        alignItems: "center",
        cursor: row.onClick ? "pointer" : "default",
        background: hover ? "var(--inv-subtle)" : "transparent",
      }}
    >
      {row.cells.map((cell, ci) => {
        const col = columns[ci];
        return (
          <div
            key={ci}
            style={{
              textAlign: col.align || "left",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: col.wrap ? "normal" : "nowrap",
              display: col.align === "right" ? "flex" : "block",
              justifyContent: col.align === "right" ? "flex-end" : "flex-start",
            }}
          >
            {cell}
          </div>
        );
      })}
    </div>
  );
}
