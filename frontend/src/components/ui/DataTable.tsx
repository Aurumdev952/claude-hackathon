import type { ReactNode } from "react";

export type Column<R = any> = { key: string; label: ReactNode; fmt?: (v: any, r: R) => ReactNode; num?: boolean; className?: string };

/** Accessible data table (moved out of Panel.tsx, restyled). Same API as before, plus optional caption / aria-label. */
export function DataTable<R extends Record<string, any> = any>({ columns, rows, caption, ariaLabel, dense = true, className = "" }: {
  columns: Column<R>[]; rows: R[]; caption?: ReactNode; ariaLabel?: string; dense?: boolean; className?: string;
}) {
  const pad = dense ? "py-1.5 px-3" : "py-2.5 px-3.5";
  return (
    <table className={`w-full text-xs tabular border-separate border-spacing-0 ${className}`} aria-label={ariaLabel}>
      {caption && <caption className="text-left text-label text-fg-muted pb-2">{caption}</caption>}
      <thead className="sticky top-0 z-[1]">
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={`${pad} bg-surface-2 font-medium text-fg-muted border-b border-border first:rounded-tl-[10px] last:rounded-tr-[10px] ${c.num ? "text-right" : "text-left"} ${c.className ?? ""}`}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-accent-soft/40 transition-colors">
            {columns.map((c) => (
              <td key={c.key} className={`${pad} border-b border-border/70 text-fg ${c.num ? "text-right" : ""} ${c.className ?? ""}`}>{c.fmt ? c.fmt(r[c.key], r) : String(r[c.key] ?? "—")}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
