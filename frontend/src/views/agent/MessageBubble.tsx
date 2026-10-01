import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@heroui/react";
import { ArtifactSpec, ChartWidget as ChartWidgetSchema, PatientWidget as PatientWidgetSchema } from "@agent/widgets";
import { AlertTriangle, Check, Copy, History, Pencil, RefreshCw } from "lucide-react";
import { EASE } from "@/lib/motion";
import { Markdown } from "./parts/Markdown";
import { StateDot, Steps, type StepItem } from "./parts/ToolPart";
import { ArtifactWidget } from "./widgets/ArtifactWidget";
import { ChartWidget } from "./widgets/ChartWidget";
import { PatientWidget } from "./widgets/PatientWidget";
import { shortDate } from "./widgets/format";
import { isToolPart, toolNameOf, WIDGET_TOOLS, type AgentMessage, type AgentRole, type ToolPartLike } from "./types";

type Block =
  | { kind: "steps"; key: string; items: StepItem[] }
  | { kind: "text"; key: string; text: string }
  | { kind: "widget"; key: string; node: ReactNode };

/** Message parts -> render blocks: consecutive reasoning / tool parts merge into one steps block; widget tool outputs
 * become cards (validated against the shared zod contract); text becomes markdown. */
function toBlocks(m: AgentMessage, streaming: boolean): Block[] {
  const out: Block[] = [];
  const steps = (key: string) => {
    const last = out[out.length - 1];
    if (last?.kind === "steps") return last.items;
    const b: Block = { kind: "steps", key, items: [] };
    out.push(b);
    return b.items;
  };
  m.parts.forEach((p, i) => {
    if (p.type === "reasoning") {
      const st = (p as { state?: string }).state;
      if (!p.text.trim() && !(streaming && st === "streaming")) return;
      steps(`s${i}`).push({ kind: "reasoning", key: `r${i}`, text: p.text, streaming: streaming && st === "streaming" });
      return;
    }
    if (p.type === "text") {
      if (!p.text.trim()) return;
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += `\n\n${p.text}`;
      else out.push({ kind: "text", key: `t${i}`, text: p.text });
      return;
    }
    if (isToolPart(p)) {
      const tp = p as unknown as ToolPartLike;
      const name = toolNameOf(tp);
      if (WIDGET_TOOLS.has(name) && tp.state === "output-available") {
        const node = widgetFor(name, tp.output);
        if (node) { out.push({ kind: "widget", key: `w${tp.toolCallId}`, node }); return; }
      }
      steps(`s${i}`).push({ kind: "tool", key: tp.toolCallId, part: tp });
    }
  });
  return out;
}

function widgetFor(name: string, output: unknown): ReactNode {
  if (name === "make_chart") { const r = ChartWidgetSchema.safeParse(output); return r.success ? <ChartWidget widget={r.data} /> : null; }
  if (name === "make_patient_widget") { const r = PatientWidgetSchema.safeParse(output); return r.success ? <PatientWidget widget={r.data} /> : null; }
  if (name === "run_python") { const r = ArtifactSpec.safeParse(output); return r.success ? <ArtifactWidget widget={r.data} /> : null; }
  return null;
}

export const messageText = (m: AgentMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n\n").trim();

type Props = {
  message: AgentMessage;
  role: AgentRole;
  /** This message is the one being streamed right now. */
  streaming: boolean;
  /** Any request in flight (actions are disabled). */
  busy: boolean;
  isLast: boolean;
  /** The last turn ended with an error (the thread shows the error card instead of the "interrupted" hint). */
  errored?: boolean;
  animateIn: boolean;
  onEdit: (id: string, text: string) => void;
  onRewind: (id: string) => void;
  onRegenerate: (id: string) => void;
};

export const MessageBubble = memo(function MessageBubble(props: Props) {
  const reduce = useReducedMotion();
  const { message, animateIn } = props;
  return (
    <motion.div data-role={message.role} data-message-id={message.id}
                initial={animateIn && !reduce ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE }}
                className="group/msg">
      {message.role === "user" ? <UserMessage {...props} /> : <AssistantMessage {...props} />}
    </motion.div>
  );
});

function UserMessage({ message, busy, isLast, onEdit, onRewind }: Props) {
  const text = messageText(message);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { const el = ref.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [editing]);
  const save = () => { const t = draft.trim(); if (!t) return; setEditing(false); onEdit(message.id, t); };
  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[640px] rounded-[24px] bg-surface border border-hairline p-2 outline outline-2 outline-offset-2 outline-signal/40">
          <label htmlFor={`edit-${message.id}`} className="sr-only">Edit message</label>
          <textarea id={`edit-${message.id}`} ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
                      if (e.key === "Escape") { setEditing(false); setDraft(text); }
                    }}
                    className="w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-6 text-ink outline-none focus-visible:outline-none" />
          <div className="flex items-center justify-end gap-2 px-1 pb-0.5">
            <span className="text-micro font-normal text-muted mr-auto pl-2">Later messages will be replaced</span>
            <Button size="sm" radius="full" variant="flat" className="h-9 px-4 bg-tile text-ink font-medium" onPress={() => { setEditing(false); setDraft(text); }}>Cancel</Button>
            <Button size="sm" radius="full" color="primary" onPress={save} isDisabled={!draft.trim()} className="h-9 px-4 font-semibold">Save & send</Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[min(600px,85%)] rounded-[22px] bg-ink/[0.055] dark:bg-tile text-ink px-5 py-3 text-[15px] leading-6 whitespace-pre-wrap break-words">
        {text}
      </div>
      <div className={`flex items-center gap-0.5 transition-opacity ${busy ? "opacity-0 pointer-events-none" : "opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100"}`}>
        <CopyButton text={text} />
        <IconAction label="Edit message" onPress={() => { setDraft(text); setEditing(true); }} disabled={busy}><Pencil size={15} /></IconAction>
        {!isLast && <RewindButton onConfirm={() => onRewind(message.id)} disabled={busy} />}
      </div>
    </div>
  );
}

function AssistantMessage({ message, streaming, busy, isLast, errored, onRegenerate, onRewind }: Props) {
  const blocks = useMemo(() => toBlocks(message, streaming), [message, streaming]);
  const text = messageText(message);
  const lastTextIdx = blocks.reduce((acc, b, i) => (b.kind === "text" ? i : acc), -1);
  const empty = blocks.length === 0;
  return (
    <div className="min-w-0 flex flex-col gap-4">
        {empty && streaming && <div className="h-6 flex items-center gap-2.5 text-[14px] text-muted"><StateDot state="run" />Thinking</div>}
        {blocks.map((b, i) => {
          if (b.kind === "steps") return <Steps key={b.key} items={b.items} live={streaming && i === blocks.length - 1} />;
          if (b.kind === "text") return <Markdown key={b.key} streaming={streaming && i === lastTextIdx && i === blocks.length - 1}>{b.text}</Markdown>;
          return <div key={b.key} className="min-w-0">{b.node}</div>;
        })}
        {streaming && !empty && blocks[blocks.length - 1]?.kind === "widget" && <div className="h-6 flex items-center gap-2.5 text-[14px] text-muted"><StateDot state="run" />Writing</div>}
        {!streaming && isLast && !errored && !blocks.some((b) => b.kind !== "steps") && (
          <div className="flex items-center gap-2 text-[14px] text-muted">
            <span>The answer was interrupted.</span>
            <button type="button" onClick={() => onRegenerate(message.id)} disabled={busy}
                    className="text-ink font-medium rounded-full h-8 px-3 bg-surface hover:bg-tile transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">Try again</button>
          </div>
        )}
        {!streaming && !empty && (
          <div className={`flex flex-wrap items-center gap-x-1 gap-y-1 -ml-2 -mt-1 transition-opacity ${isLast ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100"}`}>
            {text && <CopyButton text={text} />}
            <IconAction label="Regenerate response" onPress={() => onRegenerate(message.id)} disabled={busy}><RefreshCw size={15} /></IconAction>
            {!isLast && <RewindButton onConfirm={() => onRewind(message.id)} disabled={busy} />}
            <MetaChips message={message} />
          </div>
        )}
    </div>
  );
}

export function IconAction({ label, onPress, disabled, children }: { label: string; onPress: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={label} delay={350} closeDelay={0} classNames={{ content: "text-[12px] px-2.5 py-1 bg-ink text-ink-on rounded-full shadow-none" }}>
      <Button isIconOnly size="sm" radius="full" variant="light" aria-label={label} onPress={onPress} isDisabled={disabled}
              className="min-w-8 w-8 h-8 text-muted data-[hover=true]:text-ink data-[hover=true]:bg-ink/[0.05] dark:data-[hover=true]:bg-surface">
        {children}
      </Button>
    </Tooltip>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconAction label={done ? "Copied" : "Copy"} onPress={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* blocked */ }
    }}>
      {done ? <Check size={15} className="text-tone-success" /> : <Copy size={15} />}
    </IconAction>
  );
}

function RewindButton({ onConfirm, disabled }: { onConfirm: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen} placement="bottom" classNames={{ content: "rounded-tile p-4 bg-surface shadow-float dark:border dark:border-hairline" }}>
      <PopoverTrigger>
        <Button isIconOnly size="sm" radius="full" variant="light" aria-label="Rewind to here" isDisabled={disabled}
                className="min-w-8 w-8 h-8 text-muted data-[hover=true]:text-ink data-[hover=true]:bg-ink/[0.05] dark:data-[hover=true]:bg-surface">
          <History size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-1.5 max-w-[240px]">
          <div className="text-[15px] font-semibold text-ink">Rewind to here?</div>
          <p className="text-label font-normal text-muted">Everything after this message is removed.</p>
          <div className="flex justify-end gap-2 mt-2">
            <Button size="sm" radius="full" variant="flat" className="h-9 px-4 bg-tile text-ink font-medium" onPress={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" radius="full" color="danger" className="h-9 px-4 font-semibold" onPress={() => { setOpen(false); onConfirm(); }}>Rewind</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Answer metadata (design v3): muted text, no chips. The model name opens the run details on hover / focus; the
 * number check is a tiny glyph + text. */
function MetaChips({ message }: { message: AgentMessage }) {
  const m = message.metadata;
  if (!m) return null;
  const model = m.model?.split("/").pop();
  const secs = m.created_at && m.finished_at ? (new Date(m.finished_at).getTime() - new Date(m.created_at).getTime()) / 1000 : null;
  const details = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px] py-1">
      {m.model && <><dt className="text-muted">Model</dt><dd className="text-ink">{m.model}</dd></>}
      {m.sim_time && <><dt className="text-muted">Data as of</dt><dd className="text-ink">{shortDate(m.sim_time)}</dd></>}
      {m.run_id !== null && m.run_id !== undefined && <><dt className="text-muted">Pipeline run</dt><dd className="text-ink tabular">{m.run_id}</dd></>}
      {secs !== null && <><dt className="text-muted">Time</dt><dd className="text-ink tabular">{secs.toFixed(1)} s</dd></>}
      {m.usage?.totalTokens && <><dt className="text-muted">Tokens</dt><dd className="text-ink tabular">{m.usage.totalTokens.toLocaleString("en-US")}</dd></>}
      {!!m.tools_called?.length && <><dt className="text-muted">Tools</dt><dd className="text-ink">{m.tools_called.join(", ")}</dd></>}
    </dl>
  );
  const meta = "inline-flex items-center gap-1.5 h-8 px-2 rounded-full text-[13px] text-muted cursor-default focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal";
  const tip = "bg-surface shadow-float rounded-tile px-4 py-3 dark:border dark:border-hairline";
  return (
    <>
      {model && (
        <Tooltip content={details} delay={250} classNames={{ content: tip }}>
          <span className={meta} tabIndex={0} data-testid="meta-model">{model}</span>
        </Tooltip>
      )}
      {m.validated_numbers === true && (
        <Tooltip content="Every number in this answer was found in the tool outputs" delay={250} classNames={{ content: `${tip} text-[13px] max-w-[240px]` }}>
          <span className={meta} tabIndex={0} data-testid="numbers-verified"><Check size={14} strokeWidth={2.25} className="text-success" aria-hidden />Numbers verified</span>
        </Tooltip>
      )}
      {m.validated_numbers === false && (
        <Tooltip content={`Not found in the tool outputs: ${(m.unsupported_numbers ?? []).join(", ") || "some numbers"}. Check before quoting.`} delay={250}
                 classNames={{ content: `${tip} text-[13px] max-w-[260px]` }}>
          <span className={meta} tabIndex={0}><AlertTriangle size={14} className="text-warning" aria-hidden />{m.unsupported_numbers?.length ? `${m.unsupported_numbers.length} unverified` : "Unverified numbers"}</span>
        </Tooltip>
      )}
    </>
  );
}
