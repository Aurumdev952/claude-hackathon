import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@heroui/react";
import { AlertCircle, ArrowDown, ArrowUpRight, CornerDownLeft, RotateCcw } from "lucide-react";
import { EASE, itemEnter, stagger } from "@/lib/motion";
import { AgentAvatar } from "./AgentAvatar";
import { agentKeys, fetchConversation, truncateConversation, useAgentScope, useSuggestions } from "./api";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { createAgentTransport } from "./transport";
import { PERSONA, type AgentMessage } from "./types";

type Props = {
  conversationId: string;
  initialMessages: AgentMessage[];
  /** Question to send as soon as the thread mounts (from `?q=`). */
  autoSend?: string | null;
  /** Called when the first message of a new conversation is sent. */
  onStarted?: () => void;
};

/** Error text from the AI SDK error (the server's `{error:{message}}` envelope when present). */
function errorText(e: Error | undefined) {
  if (!e) return "";
  try { const j = JSON.parse(e.message); return j?.error?.message ?? e.message; } catch { return e.message || "Something went wrong"; }
}

/** One conversation (plan §B7): useChat over the agent transport, edit / rewind / regenerate, auto-scroll, composer. */
export function Thread({ conversationId, initialMessages, autoSend, onStarted }: Props) {
  const qc = useQueryClient();
  const { role, facilityId } = useAgentScope();
  const transport = useMemo(() => createAgentTransport(), []);
  const listKey = agentKeys.list(role, facilityId);

  /** After a turn the server adds validated_numbers / tools_called to the persisted message: merge that metadata in. */
  const refreshMeta = useCallback(async (messageId: string, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 500 + i * 900));
      try {
        const conv = await fetchConversation(conversationId);
        const srv = conv.messages.find((m) => m.id === messageId);
        if (srv?.metadata && (srv.metadata.validated_numbers !== undefined || i === tries - 1)) {
          chatRef.current?.setMessages((ms) => ms.map((m) => (m.id === messageId ? { ...m, metadata: { ...m.metadata, ...srv.metadata } } : m)));
          return;
        }
      } catch { return; }
    }
  }, [conversationId]);

  const chat = useChat<AgentMessage>({
    id: conversationId,
    messages: initialMessages,
    transport,
    onFinish: ({ message, isAbort, isError }) => {
      qc.invalidateQueries({ queryKey: listKey });
      if (!isAbort && !isError) void refreshMeta(message.id);
    },
  });
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const { messages, sendMessage, regenerate, setMessages, stop, status, error, clearError } = chat;
  const busy = status === "submitted" || status === "streaming";

  // ------------------------------------------------------------------ scrolling: stick to the bottom unless the user scrolls up
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const p = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    pinnedRef.current = p;
    setPinned(p);
  };
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useLayoutEffect(() => { if (pinnedRef.current) toBottom(false); }, [messages, status, toBottom]);
  useEffect(() => {
    // widgets grow after mount (maps, images): keep following while pinned
    const el = scroller.current?.firstElementChild;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (pinnedRef.current) toBottom(false); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  // ------------------------------------------------------------------ actions
  const startedRef = useRef(initialMessages.length > 0);
  const composer = useRef<ComposerHandle>(null);
  const send = useCallback((text: string) => {
    if (!text.trim() || busy) return;
    clearError();
    pinnedRef.current = true;
    setPinned(true);
    void sendMessage({ text });
    if (!startedRef.current) {
      startedRef.current = true;
      onStarted?.();
      setTimeout(() => qc.invalidateQueries({ queryKey: listKey }), 700);
    }
  }, [busy, clearError, sendMessage, onStarted, qc, listKey]);

  const edit = useCallback(async (id: string, text: string) => {
    if (busy) return;
    clearError();
    try {
      const res = await truncateConversation(conversationId, id, true);
      setMessages(res.messages);
    } catch {
      setMessages((ms) => ms.slice(0, Math.max(0, ms.findIndex((m) => m.id === id))));
    }
    pinnedRef.current = true;
    void sendMessage({ text });
  }, [busy, clearError, conversationId, setMessages, sendMessage]);

  const rewind = useCallback(async (id: string) => {
    if (busy) return;
    clearError();
    try {
      const res = await truncateConversation(conversationId, id, false);
      setMessages(res.messages);
    } catch {
      setMessages((ms) => ms.slice(0, ms.findIndex((m) => m.id === id) + 1));
    }
    qc.invalidateQueries({ queryKey: listKey });
  }, [busy, clearError, conversationId, setMessages, qc, listKey]);

  const regen = useCallback((id?: string) => {
    if (busy) return;
    clearError();
    pinnedRef.current = true;
    void regenerate(id ? { messageId: id } : undefined);
  }, [busy, clearError, regenerate]);

  // ?q= deep link: send once on mount
  const autoSent = useRef(false);
  useEffect(() => {
    if (autoSend && !autoSent.current && messages.length === 0) { autoSent.current = true; send(autoSend); }
  }, [autoSend]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" focuses the composer
  useEffect(() => {
    composer.current?.focus();
    const h = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      if (e.key === "/" && t !== "TEXTAREA" && t !== "INPUT" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); composer.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const mountedIds = useRef(new Set(initialMessages.map((m) => m.id)));
  const last = messages[messages.length - 1];
  const waiting = status === "submitted" && last?.role === "user";
  const unanswered = !busy && status !== "error" && last?.role === "user";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div ref={scroller} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain" aria-label="Conversation" role="log" aria-live="off">
        <div className="mx-auto w-full max-w-[860px] px-4 sm:px-6 pt-6 pb-6 flex flex-col gap-6">
          {messages.length === 0 && !busy ? (
            <Welcome onPick={send} />
          ) : (
            messages.map((m, i) => (
              <MessageBubble key={m.id} message={m} role={role} isLast={i === messages.length - 1}
                             streaming={busy && i === messages.length - 1 && m.role === "assistant"} busy={busy}
                             animateIn={!mountedIds.current.has(m.id)}
                             onEdit={edit} onRewind={rewind} onRegenerate={regen} />
            ))
          )}
          {waiting && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }} className="flex gap-3 items-center">
              <AgentAvatar role={role} size={28} busy />
              <span className="text-[13.5px] agent-shimmer font-medium">Thinking</span>
            </motion.div>
          )}
          {unanswered && (
            <div className="flex items-center gap-3 pl-10 text-label text-fg-muted">
              <span>Not answered yet</span>
              <Button size="sm" radius="full" variant="flat" onPress={() => regen()} startContent={<CornerDownLeft size={13} aria-hidden />} className="bg-accent-soft text-accent">Answer</Button>
            </div>
          )}
          {status === "error" && (
            <div role="alert" className="ml-10 flex items-start gap-3 rounded-tile border border-danger/25 bg-danger/[0.06] px-4 py-3">
              <AlertCircle size={16} className="text-tone-danger mt-0.5 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-fg">The agent could not answer</div>
                <div className="text-micro text-fg-muted mt-0.5 break-words">{errorText(error)}</div>
              </div>
              <Button size="sm" radius="full" variant="flat" onPress={() => regen()} startContent={<RotateCcw size={13} aria-hidden />}>Retry</Button>
            </div>
          )}
        </div>
      </div>

      <div className="relative px-3 sm:px-6 pb-3 pt-2">
        <AnimatePresence>
          {!pinned && messages.length > 0 && (
            <motion.button type="button" key="jump" initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.9 }}
                           transition={{ duration: 0.2, ease: EASE }} onClick={() => { pinnedRef.current = true; setPinned(true); toBottom(true); }}
                           aria-label="Jump to latest"
                           className="absolute left-1/2 -translate-x-1/2 -top-11 w-9 h-9 rounded-full bg-surface border border-border shadow-float grid place-items-center text-fg-muted hover:text-fg">
              <ArrowDown size={16} aria-hidden />
            </motion.button>
          )}
        </AnimatePresence>
        <div className="mx-auto w-full max-w-[860px]">
          <Composer ref={composer} onSend={send} onStop={stop} busy={busy}
                    placeholder={role === "doctor" ? "Ask about your patients, alerts or risk…" : "Ask about rates, trends, hotspots or care quality…"} />
        </div>
      </div>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (q: string) => void }) {
  const { role } = useAgentScope();
  const s = useSuggestions();
  const reduce = useReducedMotion();
  const qs = s.data?.questions ?? [];
  return (
    <motion.div className="flex flex-col items-center text-center pt-[6vh] pb-4" variants={stagger(0.05, 0.05)} initial={reduce ? false : "hidden"} animate="show">
      <motion.div variants={itemEnter} className="relative">
        <div className="absolute inset-0 -m-6 rounded-full blur-2xl opacity-60" style={{ background: "radial-gradient(circle, rgb(var(--accent) / 0.35), transparent 70%)" }} aria-hidden />
        <AgentAvatar role={role} size={56} />
      </motion.div>
      <motion.h2 variants={itemEnter} className="mt-5 text-h1 text-fg">{PERSONA[role].name}</motion.h2>
      <motion.p variants={itemEnter} className="mt-1 text-[14px] text-fg-muted max-w-md">{PERSONA[role].blurb}</motion.p>
      <motion.ul variants={stagger(0.04, 0.15)} className="mt-8 grid w-full max-w-[720px] gap-2.5 sm:grid-cols-2 text-left" aria-label="Suggested questions">
        {s.isLoading && Array.from({ length: 4 }).map((_, i) => <li key={i} className="h-[52px] rounded-tile bg-surface-2 animate-pulse" />)}
        {qs.slice(0, 6).map((q) => (
          <motion.li key={q} variants={itemEnter}>
            <button type="button" onClick={() => onPick(q)} data-testid="suggestion"
                    className="group w-full h-full flex items-center gap-3 rounded-tile bg-surface border border-border shadow-tile px-4 py-3 text-[13.5px] text-fg text-left transition hover:border-accent/40 hover:shadow-card hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              <span className="flex-1">{q}</span>
              <ArrowUpRight size={15} className="text-fg-muted group-hover:text-accent transition-colors shrink-0" aria-hidden />
            </button>
          </motion.li>
        ))}
      </motion.ul>
    </motion.div>
  );
}
