import { ReactNode, useState } from "react";
import { Info, Table2 } from "lucide-react";

/** Panel with title, a "Method" popover (SPEC §12.8) and an optional "View as table" toggle (SPEC §16.5). */
export function Panel({ title, method, children, table, className = "", actions, subtitle }: {
  title: ReactNode; method?: string; children: ReactNode; table?: ReactNode; className?: string; actions?: ReactNode; subtitle?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`panel p-4 flex flex-col min-w-0 animate-rise ${className}`}>
      <header className="flex items-start gap-2 mb-3">
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">{title}</h2>
          {subtitle && <div className="text-xs text-fog mt-0.5">{subtitle}</div>}
        </div>
        {actions}
        {table && (
          <button className="text-fog hover:text-mist p-1 rounded focus-visible:ring-2 ring-kivu" aria-pressed={asTable}
                  title="View as table" aria-label="View as table" onClick={() => setAsTable((v) => !v)}>
            <Table2 size={15} />
          </button>
        )}
        {method && (
          <div className="relative">
            <button className="text-fog hover:text-mist p-1 rounded focus-visible:ring-2 ring-kivu" aria-expanded={open}
                    aria-label="Method" onClick={() => setOpen((v) => !v)} onBlur={() => setOpen(false)}>
              <Info size={15} />
            </button>
            {open && (
              <div role="tooltip" className="absolute right-0 top-7 z-30 w-72 panel p-3 text-xs leading-relaxed text-mist bg-ridge">
                <div className="panel-title mb-1">Method</div>{method}
              </div>
            )}
          </div>
        )}
      </header>
      <div className="flex-1 min-h-0">{asTable && table ? <div className="overflow-auto max-h-[420px]">{table}</div> : children}</div>
    </section>
  );
}

export function DataTable({ columns, rows }: { columns: { key: string; label: string; fmt?: (v: any, r: any) => ReactNode; num?: boolean }[]; rows: any[] }) {
  return (
    <table className="w-full text-xs tabular">
      <thead className="sticky top-0 bg-ridge">
        <tr>{columns.map((c) => <th key={c.key} className={`py-1.5 px-2 font-semibold text-fog border-b border-line ${c.num ? "text-right" : "text-left"}`}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line/40 hover:bg-ridge2/50">
            {columns.map((c) => <td key={c.key} className={`py-1 px-2 ${c.num ? "text-right" : ""}`}>{c.fmt ? c.fmt(r[c.key], r) : String(r[c.key] ?? "—")}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Loading({ h = 220, label = "Loading" }: { h?: number; label?: string }) {
  return <div className="flex items-center justify-center text-fog text-xs" style={{ height: h }}><span className="animate-pulse">{label}…</span></div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return <div className="text-xs text-laterite p-3 border border-laterite/40 rounded-lg bg-laterite/10">{msg}</div>;
}
