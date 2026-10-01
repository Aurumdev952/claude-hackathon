import { useState } from "react";
import { AlertTriangle, BarChart3, Check, CheckCircle2, ChevronRight, Clock, Copy, Database, Info, RotateCcw, ShieldAlert, Table2, Wand2 } from "lucide-react";
import { DataTable } from "@/components/ui/Panel";
import { STATUS } from "@/lib/viz";
import { AnswerChart, resolveSpec } from "./AnswerChart";
import { colLabel, fmtVal, isNumCol } from "./format";
import type { Turn } from "./store";

export function UserBubble({ t }: { t: Turn }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-2xl rounded-br-md bg-kivu/25 border border-kivu/40 px-3.5 py-2 text-sm">
        {t.question}
        <div className="text-[10px] text-fog mt-0.5 text-right tabular">{new Date(t.askedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}{t.role === "doctor" ? " · doctor view" : ""}</div>
      </div>
    </div>
  );
}

export function AnswerCard({ t, onAsk, onRetry }: { t: Turn; onAsk: (q: string) => void; onRetry: () => void }) {
  if (t.status === "pending") return <Thinking />;
  if (t.status === "failed") return <Failed t={t} onRetry={onRetry} />;
  const r = t.result!;
  const unsafe = r.refused || (!r.sql && !r.rows.length && !!r.suggestions);
  if (unsafe || r.error) return <CouldNot t={t} onAsk={onAsk} />;
  return <Answer t={t} />;
}

function Shell({ children, tone = "ok" }: { children: React.ReactNode; tone?: "ok" | "warn" }) {
  return (
    <div className="flex gap-3 items-start animate-rise">
      <div className={`w-7 h-7 rounded-lg shrink-0 flex items-center justify-center ${tone === "warn" ? "bg-sorghum/20 text-sorghum" : "bg-ridge2 text-mist"}`} aria-hidden>
        {tone === "warn" ? <ShieldAlert size={14} /> : <Wand2 size={14} />}
      </div>
      <div className="flex-1 min-w-0 panel p-3.5">{children}</div>
    </div>
  );
}

function Thinking() {
  return (
    <Shell>
      <div className="flex items-center gap-2 text-sm text-fog" role="status">
        <span className="flex gap-1" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="w-1.5 h-1.5 rounded-full bg-fog animate-pulseDot" style={{ animationDelay: `${i * 0.18}s` }} />)}</span>
        Translating to SQL, validating, running on the read-only warehouse…
      </div>
    </Shell>
  );
}

function Failed({ t, onRetry }: { t: Turn; onRetry: () => void }) {
  return (
    <Shell tone="warn">
      <div className="text-sm font-semibold">That request didn't complete</div>
      <p className="text-xs text-fog mt-0.5">{t.error ?? "The server could not be reached."}</p>
      <button className="btn text-xs py-1 mt-2" onClick={onRetry}><RotateCcw size={13} /> Try again</button>
    </Shell>
  );
}

function CouldNot({ t, onAsk }: { t: Turn; onAsk: (q: string) => void }) {
  const r = t.result!;
  return (
    <Shell tone="warn">
      <div className="text-sm font-semibold">I couldn't answer that safely — try one of these…</div>
      <p className="text-xs text-fog mt-0.5 leading-relaxed">
        {r.refused ? "I can only read aggregated data; I won't change, delete or export anything." : "I could only answer questions I can map to the published tables with a validated, read-only query."}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-2.5">
        {(r.suggestions ?? []).map((s) => <Chip key={s} q={s} onAsk={onAsk} />)}
      </div>
      {(r.sql || r.error) && (
        <details className="mt-2.5 group">
          <summary className="text-[11px] text-fog cursor-pointer select-none inline-flex items-center gap-1 hover:text-mist"><ChevronRight size={12} className="group-open:rotate-90 transition" />What went wrong</summary>
          {r.error && <p className="text-[11px] text-fog mt-1 font-mono break-all">{r.error}</p>}
          {r.sql && <pre className="text-[11px] mt-1 p-2 rounded bg-basalt/60 border border-line/50 overflow-auto whitespace-pre-wrap">{r.sql}</pre>}
        </details>
      )}
      <Provenance t={t} />
    </Shell>
  );
}

function Answer({ t }: { t: Turn }) {
  const r = t.result!;
  const spec = resolveSpec(r);
  const [view, setView] = useState<"chart" | "table">(spec ? "chart" : "table");
  const hasRows = r.rows.length > 0;
  return (
    <Shell>
      <p className="text-sm leading-relaxed">{r.answer}</p>
      {r.caveats.filter((c) => !c.startsWith("Synthetic data")).map((c) => (
        <p key={c} className="text-[11px] text-fog mt-1.5 flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" aria-hidden />{c}</p>
      ))}
      {hasRows && (
        <div className="mt-3 rounded-lg border border-line/50 bg-basalt/30 p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="panel-title truncate">{spec?.type === "kpi" ? "Result" : spec ? `${colLabel((spec as any).y ?? (spec as any).value ?? "")}` : "Result"}</span>
            <span className="text-[10px] text-fog tabular">{r.rows.length} row{r.rows.length === 1 ? "" : "s"}</span>
            <span className="flex-1" />
            {spec && (
              <div className="seg" role="group" aria-label="Result view">
                <button aria-pressed={view === "chart"} onClick={() => setView("chart")}><span className="inline-flex items-center gap-1"><BarChart3 size={12} />Chart</span></button>
                <button aria-pressed={view === "table"} onClick={() => setView("table")}><span className="inline-flex items-center gap-1"><Table2 size={12} />Table</span></button>
              </div>
            )}
          </div>
          {view === "chart" && spec ? <AnswerChart r={r} spec={spec} /> : (
            <div className="max-h-[300px] overflow-auto">
              <DataTable rows={r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])))}
                columns={r.columns.map((c, i) => ({ key: c, label: colLabel(c), num: isNumCol(r.rows, i), fmt: (v: unknown) => fmtVal(c, v) }))} />
            </div>
          )}
        </div>
      )}
      {r.sql && <Sql sql={r.sql} />}
      <Provenance t={t} />
    </Shell>
  );
}

function Sql({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  const pretty = sql.replace(/\s+(FROM|WHERE|AND|ORDER BY|GROUP BY|JOIN|LIMIT|HAVING)\s/g, "\n$1 ").replace(/^SELECT /, "SELECT ");
  return (
    <details className="mt-2.5 group">
      <summary className="text-[11px] text-fog cursor-pointer select-none inline-flex items-center gap-1 hover:text-mist rounded focus-visible:ring-2 ring-kivu outline-none">
        <ChevronRight size={12} className="group-open:rotate-90 transition" aria-hidden /><Database size={11} aria-hidden /> SQL
      </summary>
      <div className="relative mt-1.5">
        <pre className="text-[11px] leading-relaxed p-2.5 pr-10 rounded-lg bg-basalt/70 border border-line/50 overflow-auto whitespace-pre-wrap text-mist font-mono">{pretty}</pre>
        <button className="absolute top-1.5 right-1.5 p-1 rounded text-fog hover:text-mist focus-visible:ring-2 ring-kivu" aria-label="Copy SQL"
                onClick={() => { navigator.clipboard?.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </details>
  );
}

function Provenance({ t }: { t: Turn }) {
  const r = t.result!;
  const src = r.source === "rules" ? "rule-based template" : r.source ? `${r.source} LLM` : t.provider === "template" ? "rule-based template" : t.provider ?? "—";
  const ok = r.validated_numbers;
  const c = ok ? STATUS.good : STATUS.warning;
  return (
    <div className="mt-2.5 pt-2 border-t border-line/40 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fog tabular">
      <span className="inline-flex items-center gap-1"><Wand2 size={10} aria-hidden />SQL by {src}</span>
      {r.sql && <span className="inline-flex items-center gap-1"><ShieldAlert size={10} aria-hidden />read-only · validated</span>}
      {(r.rows.length > 0) && <span className="inline-flex items-center gap-1" style={{ color: c }}>{ok ? <CheckCircle2 size={10} aria-hidden /> : <AlertTriangle size={10} aria-hidden />}{ok ? "numbers checked against result" : "number check failed — template answer"}</span>}
      {r.latency_ms !== undefined && <span className="inline-flex items-center gap-1"><Clock size={10} aria-hidden />{r.latency_ms} ms</span>}
      {t.runId !== undefined && t.runId !== null && <span>run #{t.runId}</span>}
      <span>synthetic data</span>
    </div>
  );
}

export function Chip({ q, onAsk }: { q: string; onAsk: (q: string) => void }) {
  return (
    <button onClick={() => onAsk(q)} className="text-left text-xs rounded-full border border-line/70 bg-ridge2/50 px-3 py-1.5 hover:border-kivu hover:bg-kivu/15 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-kivu">
      {q}
    </button>
  );
}

