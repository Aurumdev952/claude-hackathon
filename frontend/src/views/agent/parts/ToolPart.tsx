import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Brain, Check, ChevronDown, Code2, Database, ScanSearch, X } from "lucide-react";
import { DataTable, DetailModal, useDetailModal, type DetailTab } from "@/components/ui";
import { EASE } from "@/lib/motion";
import { colLabel } from "../widgets/format";
import { toolLabel, toolNameOf, type ToolPartLike } from "../types";
import { Markdown } from "./Markdown";

export type StepItem =
  | { kind: "tool"; key: string; part: ToolPartLike }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean };

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const failed = (p: ToolPartLike) => p.state === "output-error" || (isRecord(p.output) && p.output.ok === false);
const running = (p: ToolPartLike) => p.state === "input-streaming" || p.state === "input-available";

/** Short result hint shown at the end of a row ("12 rows", "line chart", the error). */
function hint(p: ToolPartLike): string | null {
  if (p.state === "input-streaming") return null;
  if (p.state === "output-error") return p.errorText ?? "Failed";
  const o = p.output;
  if (!isRecord(o)) return null;
  if (o.ok === false) return typeof o.error === "string" ? o.error : "Failed";
  if (o.kind === "chart" && isRecord(o.spec)) return `${String(o.spec.type)} chart`;
  if (o.kind === "patient") return "patient card";
  if (o.kind === "artifact") return `${Array.isArray(o.files) ? o.files.length : 0} file(s)`;
  if (typeof o.row_count === "number") return `${o.row_count} row${o.row_count === 1 ? "" : "s"}`;
  if (Array.isArray(o.rows)) return `${o.rows.length} row${o.rows.length === 1 ? "" : "s"}`;
  if (typeof o.total === "number") return `${o.total} total`;
  return null;
}

/** Collapsible tool-progress block (plan §B7): live rows while the agent works, one summary line once it is done. */
export function Steps({ items, live }: { items: StepItem[]; live: boolean }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const tools = items.filter((i): i is Extract<StepItem, { kind: "tool" }> => i.kind === "tool");
  const expanded = live || open;
  const errors = tools.filter((t) => failed(t.part)).length;
  const summary = tools.length
    ? `${tools.length} step${tools.length === 1 ? "" : "s"}${errors ? ` · ${errors} failed` : ""}`
    : "Thought";
  const labels = [...new Set(tools.map((t) => toolLabel(toolNameOf(t.part))))];
  return (
    <div className="my-1">
      {!live && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                className="group inline-flex items-center gap-2 max-w-full rounded-full pl-1 pr-2.5 py-1 text-[12.5px] text-fg-muted hover:text-fg hover:bg-fg/[0.04] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          <span className={`w-5 h-5 rounded-full grid place-items-center ${errors ? "bg-warning/15 text-tone-warning" : "bg-success/15 text-tone-success"}`} aria-hidden>
            {tools.length ? <Check size={12} strokeWidth={2.5} /> : <Brain size={12} />}
          </span>
          <span className="font-medium shrink-0">{summary}</span>
          {labels.length > 0 && <span className="truncate hidden sm:inline">· {labels.join(" · ")}</span>}
          <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      )}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ol key="rows" aria-label="Agent steps" aria-live={live ? "polite" : undefined}
                     initial={reduce || live ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }}
                     transition={{ duration: 0.28, ease: EASE }}
                     className={`relative flex flex-col gap-0.5 overflow-hidden ${live ? "" : "mt-1"} pl-[9px]`}>
            <span className="absolute left-[18px] top-3 bottom-3 w-px bg-border" aria-hidden />
            <AnimatePresence initial={false}>
              {items.map((it) => (
                <motion.li key={it.key} initial={reduce ? false : { opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease: EASE }} className="relative">
                  {it.kind === "tool" ? <ToolRow part={it.part} /> : <ReasoningRow text={it.text} streaming={it.streaming} />}
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}

function StateDot({ state }: { state: "run" | "ok" | "err" | "think" }) {
  if (state === "run") return <span className="w-[19px] h-[19px] rounded-full bg-surface border border-border grid place-items-center" aria-hidden><span className="w-3 h-3 rounded-full border-[1.6px] border-accent/25 border-t-accent animate-spin" /></span>;
  if (state === "err") return <span className="w-[19px] h-[19px] rounded-full bg-danger/10 text-tone-danger grid place-items-center ring-2 ring-surface" aria-hidden><X size={11} strokeWidth={2.6} /></span>;
  if (state === "think") return <span className="w-[19px] h-[19px] rounded-full bg-accent-soft text-accent grid place-items-center ring-2 ring-surface" aria-hidden><Brain size={11} /></span>;
  return <span className="w-[19px] h-[19px] rounded-full bg-success/15 text-tone-success grid place-items-center ring-2 ring-surface" aria-hidden><Check size={11} strokeWidth={2.6} /></span>;
}

export function ToolRow({ part }: { part: ToolPartLike }) {
  const d = useDetailModal();
  const name = toolNameOf(part);
  const st = running(part) ? "run" : failed(part) ? "err" : "ok";
  const h = hint(part);
  return (
    <div className="flex items-center gap-2.5 py-1 pr-1 min-w-0">
      <StateDot state={st} />
      <span className={`text-[13px] shrink-0 ${st === "run" ? "agent-shimmer font-medium" : "text-fg"}`}>{toolLabel(name)}</span>
      {h && <span className={`text-micro truncate ${st === "err" ? "text-tone-danger" : "text-fg-muted"}`} title={h}>{h}</span>}
      <span className="flex-1" />
      {part.state !== "input-streaming" && (
        <button type="button" onClick={d.open} aria-label={`Inspect ${toolLabel(name)}`}
                className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro text-fg-muted hover:text-fg hover:bg-fg/[0.05] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          <ScanSearch size={12} aria-hidden />Inspect
        </button>
      )}
      {d.isOpen && <Inspector part={part} modal={d.modalProps} />}
    </div>
  );
}

function ReasoningRow({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const clean = text.trim();
  return (
    <div className="py-1 pr-1">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!clean}
              className="flex items-center gap-2.5 text-left rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        <StateDot state="think" />
        <span className={`text-[13px] ${streaming ? "agent-shimmer font-medium" : "text-fg-muted"}`}>{streaming ? "Thinking" : "Thought"}</span>
        {clean && <ChevronDown size={13} className={`text-fg-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />}
      </button>
      {open && clean && <p className="ml-[29px] mt-1 mb-1 text-[12.5px] leading-relaxed text-fg-muted whitespace-pre-wrap border-l-2 border-border pl-3">{clean}</p>}
    </div>
  );
}

/** SQL / JSON inspector for one tool call (DetailModal: Result table · Input · Output · SQL). */
function Inspector({ part, modal }: { part: ToolPartLike; modal: { isOpen: boolean; onOpenChange: (o: boolean) => void } }) {
  const name = toolNameOf(part);
  const tabs = useMemo<DetailTab[]>(() => {
    const out: DetailTab[] = [];
    const o = part.output;
    const rows = isRecord(o) && Array.isArray(o.rows) ? (o.rows as Record<string, unknown>[]) : null;
    const sql = (isRecord(o) && typeof o.sql_executed === "string" && o.sql_executed)
      || (isRecord(part.input) && typeof part.input.sql === "string" && part.input.sql)
      || (isRecord(o) && isRecord(o.spec) && isRecord(o.spec.source) && typeof o.spec.source.sql === "string" && o.spec.source.sql) || null;
    if (rows && rows.length) {
      const keys = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))].slice(0, 16);
      out.push({ key: "rows", label: "Result", count: rows.length, icon: <Database size={13} aria-hidden />, content: (
        <div className="overflow-auto max-h-[60vh] rounded-tile border border-border">
          <DataTable ariaLabel={`${toolLabel(name)} result`} rows={rows.slice(0, 300)}
                     columns={keys.map((k) => ({ key: k, label: colLabel(k), num: rows.some((r) => typeof r[k] === "number"), fmt: (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)) }))} />
        </div>
      ) });
    }
    if (sql) out.push({ key: "sql", label: "SQL", icon: <Code2 size={13} aria-hidden />, content: <Markdown>{"```sql\n" + sql.trim() + "\n```"}</Markdown> });
    out.push({ key: "input", label: "Input", content: <JsonBlock value={part.input} /> });
    if (part.state === "output-error") out.push({ key: "error", label: "Error", content: <p className="text-tone-danger text-[13px]">{part.errorText}</p> });
    else if (o !== undefined) out.push({ key: "output", label: "Output", content: <JsonBlock value={o} /> });
    return out;
  }, [part, name]);
  return (
    <DetailModal {...modal} title={toolLabel(name)} subtitle={<code className="text-[12px]">{name}</code>} icon={<ScanSearch size={16} />} size="4xl" tabs={tabs} />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  let s = JSON.stringify(value ?? null, null, 2) ?? "null";
  if (s.length > 60_000) s = `${s.slice(0, 60_000)}\n… (truncated)`;
  return <Markdown>{"```json\n" + s + "\n```"}</Markdown>;
}
