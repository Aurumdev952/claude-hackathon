import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Code2, Database } from "lucide-react";
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

/** Tool-progress block (plan §B7, design v3): quiet muted lines with a small status dot. Live rows while the agent works;
 * one summary line (dot + what was done + step count) once it is done, expandable to the rows. */
export function Steps({ items, live }: { items: StepItem[]; live: boolean }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const tools = items.filter((i): i is Extract<StepItem, { kind: "tool" }> => i.kind === "tool");
  const expanded = live || open;
  const errors = tools.filter((t) => failed(t.part)).length;
  const labels = [...new Set(tools.map((t) => toolLabel(toolNameOf(t.part))))];
  const count = tools.length ? `${tools.length} step${tools.length === 1 ? "" : "s"}${errors ? `, ${errors} failed` : ""}` : null;
  return (
    <div>
      {!live && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
                className="group inline-flex items-center gap-2.5 max-w-full h-7 -ml-2 pl-2 pr-2.5 rounded-full text-[14px] text-muted hover:text-ink hover:bg-ink/[0.04] dark:hover:bg-surface transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
          <StateDot state={errors ? "err" : tools.length ? "ok" : "think"} />
          <span className="truncate">{labels.length ? labels.join(", ") : "Thought"}</span>
          {count && <span className="shrink-0 text-faint group-hover:text-muted">{count}</span>}
          <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      )}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ol key="rows" aria-label="Agent steps" aria-live={live ? "polite" : undefined}
                     initial={reduce || live ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }}
                     transition={{ duration: 0.24, ease: EASE }}
                     className={`flex flex-col overflow-hidden ${live ? "" : "mt-1 pl-[18px]"}`}>
            <AnimatePresence initial={false}>
              {items.map((it) => (
                <motion.li key={it.key} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease: EASE }}>
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

/** 8px status dot: sky pulse = running, green = done, signal = failed, faint = thought. Paired with text, never alone. */
export function StateDot({ state }: { state: "run" | "ok" | "err" | "think" }) {
  const c = state === "run" ? "bg-sky" : state === "ok" ? "bg-success" : state === "err" ? "bg-signal" : "bg-faint";
  return (
    <span className="relative w-2 h-2 shrink-0" aria-hidden>
      {state === "run" && <span className="absolute inset-0 rounded-full bg-sky animate-ping2" />}
      <span className={`absolute inset-0 rounded-full ${c}`} />
    </span>
  );
}

export function ToolRow({ part }: { part: ToolPartLike }) {
  const d = useDetailModal();
  const name = toolNameOf(part);
  const st = running(part) ? "run" : failed(part) ? "err" : "ok";
  const h = hint(part);
  return (
    <div className="flex items-center gap-2.5 h-8 min-w-0">
      <StateDot state={st} />
      <span className={`text-[14px] shrink-0 ${st === "run" ? "text-ink" : "text-muted"}`}>{toolLabel(name)}{st === "run" ? "…" : ""}</span>
      {h && <span className={`text-[13px] truncate ${st === "err" ? "text-tone-danger" : "text-faint"}`} title={h}>{h}</span>}
      <span className="flex-1" />
      {part.state !== "input-streaming" && (
        <button type="button" onClick={d.open} aria-label={`Inspect ${toolLabel(name)}`}
                className="shrink-0 h-7 rounded-full px-3 text-[13px] font-medium text-muted hover:text-ink hover:bg-ink/[0.05] dark:hover:bg-surface transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
          Inspect
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
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!clean}
              className="flex items-center gap-2.5 h-8 text-left rounded-full focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
        <StateDot state={streaming ? "run" : "think"} />
        <span className={`text-[14px] ${streaming ? "text-ink" : "text-muted"}`}>{streaming ? "Thinking…" : "Thought"}</span>
        {clean && <ChevronDown size={14} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />}
      </button>
      {open && clean && <p className="ml-[18px] mb-2 max-w-[640px] text-[13px] leading-5 text-muted whitespace-pre-wrap">{clean}</p>}
    </div>
  );
}

/** SQL / JSON inspector for one tool call (DetailModal tabs: Result table, SQL, Input, Output). */
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
        <div className="overflow-auto max-h-[60vh] rounded-tile border border-hairline">
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
    <DetailModal {...modal} title={toolLabel(name)} subtitle={<span className="font-mono text-[12px]">{name}</span>} icon={<Database size={16} />} size="4xl" tabs={tabs} />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  let s = JSON.stringify(value ?? null, null, 2) ?? "null";
  if (s.length > 60_000) s = `${s.slice(0, 60_000)}\n… (truncated)`;
  return <Markdown>{"```json\n" + s + "\n```"}</Markdown>;
}
