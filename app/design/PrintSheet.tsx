import type { ReactNode } from "react";

interface Props {
  /** Unique id for the printable region; must differ if two are on one page. */
  id: string;
  children: ReactNode;
}

/**
 * A printable document region.
 *
 * Print-only: hidden on screen (the detail page already shows the same data), shown and
 * isolated to fill the page when printed. Pure CSS `@media print`, no PDF dependency, so
 * the printed sheet is defined entirely here — the same approach the label sheet uses.
 *
 * Hiding everything else by default and revealing only the sheet is the robust way to
 * isolate one region regardless of what else is on the page.
 */
export function PrintSheet({ id, children }: Props) {
  return (
    <>
      <style>{`
        #${id} { display: none; }
        @media print {
          body * { visibility: hidden; }
          #${id}, #${id} * { visibility: visible; }
          #${id} { display: block; position: absolute; left: 0; top: 0; width: 100%; color: #000; background: #fff; }
          #${id} .sheet-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          #${id} .sheet-table th { text-align: left; background: #f4f2ec; }
          #${id} .sheet-table th, #${id} .sheet-table td { border: 1px solid #999; padding: 6px 8px; font-size: 11pt; }
          #${id} .sheet-table td.num, #${id} .sheet-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
          @page { margin: 12mm; }
        }
      `}</style>
      <div id={id}>{children}</div>
    </>
  );
}
