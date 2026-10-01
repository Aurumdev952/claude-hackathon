import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@heroui/react";
import { AlertCircle, ArrowDown, CornerDownLeft, RotateCcw } from "lucide-react";
import { EASE, itemEnter, stagger } from "@/lib/motion";
import { agentKeys, fetchConversation, truncateConversation, useAgentScope, useSuggestions } from "./api";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { StateDot } from "./parts/ToolPart";
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
  let t: string;
  try { const j = JSON.parse(e.message); t = j?.error?.message ?? e.message; } catch { t = e.message || "Something went wrong"; }
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
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
  // the welcome screen (no messages yet) reads from the top, even when it is taller than the thread (phones)
  const emptyRef = useRef(true);
  emptyRef.current = messages.length === 0;
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: emptyRef.current ? 0 : el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
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
    if (!autoSend || autoSent.current || messages.length) return;
    // deferred: StrictMode's mount / unmount / mount would otherwise abort the first request (useChat stops on unmount)
    const t = setTimeout(() => { autoSent.current = true; send(autoSend); }, 0);
    return () => clearTimeout(t);
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
      <div ref={scroller} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain -mx-4 px-4" aria-label="Conversation" role="log" aria-live="off">
        <div className="mx-auto w-full max-w-[760px] min-h-full pt-6 pb-8 flex flex-col gap-8">
          {messages.length === 0 && !busy ? (
            <Welcome onPick={send} />
          ) : (
            messages.map((m, i) => (
              <MessageBubble key={m.id} message={m} role={role} isLast={i === messages.length - 1}
                             streaming={busy && i === messages.length - 1 && m.role === "assistant"} busy={busy} errored={status === "error"}
                             animateIn={!mountedIds.current.has(m.id)}
                             onEdit={edit} onRewind={rewind} onRegenerate={regen} />
            ))
          )}
          {waiting && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE }} className="flex items-center gap-2.5 h-6">
              <StateDot state="run" />
              <span className="text-[14px] text-muted">Thinking</span>
            </motion.div>
          )}
          {unanswered && (
            <div className="flex items-center gap-3 text-[14px] text-muted">
              <span>This question has no answer yet.</span>
              <Button size="sm" radius="full" variant="flat" onPress={() => regen()} startContent={<CornerDownLeft size={14} aria-hidden />} className="h-9 px-4 bg-surface text-ink font-medium dark:border dark:border-hairline">Answer</Button>
            </div>
          )}
          {status === "error" && (
            <div role="alert" className="flex items-center gap-4 rounded-card bg-surface dark:border dark:border-hairline p-5">
              <span className="w-9 h-9 shrink-0 rounded-full border border-signal/40 text-signal grid place-items-center" aria-hidden><AlertCircle size={17} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold text-ink">The agent could not answer</div>
                <div className="text-label font-normal text-muted mt-0.5 break-words">{errorText(error)}</div>
              </div>
              <Button radius="full" variant="flat" onPress={() => regen()} startContent={<RotateCcw size={14} aria-hidden />} className="h-10 px-4 bg-tile text-ink font-medium shrink-0">Retry</Button>
            </div>
          )}
        </div>
      </div>

      <div className="relative pb-1 pt-3">
        <AnimatePresence>
          {!pinned && messages.length > 0 && (
            <motion.button type="button" key="jump" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
                           transition={{ duration: 0.18, ease: EASE }} onClick={() => { pinnedRef.current = true; setPinned(true); toBottom(true); }}
                           aria-label="Jump to latest"
                           className="absolute left-1/2 -translate-x-1/2 -top-12 z-10 w-10 h-10 rounded-full bg-surface shadow-float dark:border dark:border-hairline grid place-items-center text-ink hover:bg-tile">
              <ArrowDown size={17} aria-hidden />
            </motion.button>
          )}
        </AnimatePresence>
        <div className="mx-auto w-full max-w-[760px]">
          <Composer ref={composer} onSend={send} onStop={stop} busy={busy}
                    placeholder={role === "doctor" ? "Ask about your patients, alerts or risk" : "Ask about rates, trends, hotspots or care quality"} />
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
    <motion.div className="my-auto flex flex-col items-center text-center py-10" variants={stagger(0.04, 0.02)} initial={reduce ? false : "hidden"} animate="show">
      <motion.h2 variants={itemEnter} className="max-w-[560px] text-[28px] leading-[36px] font-medium tracking-[-0.015em] text-ink text-balance">{PERSONA[role].ask}</motion.h2>
      <motion.p variants={itemEnter} className="mt-2 max-w-[520px] text-[15px] leading-6 text-muted">{PERSONA[role].blurb}</motion.p>
      <motion.ul variants={itemEnter} className="mt-8 flex flex-wrap justify-center gap-2 max-w-[700px]" aria-label="Suggested questions">
        {s.isLoading && [180, 240, 210, 260].map((w, i) => <li key={i} className="h-10 rounded-full bg-ink/[0.05] dark:bg-tile animate-pulse" style={{ width: w }} />)}
        {qs.slice(0, 4).map((q) => (
          <li key={q} className="max-w-full">
            <button type="button" onClick={() => onPick(q)} data-testid="suggestion"
                    className="max-w-full min-h-10 rounded-[20px] bg-ink/[0.05] dark:bg-tile px-4 py-2 text-[14px] leading-5 text-ink text-left transition-colors hover:bg-ink/[0.09] dark:hover:bg-tile-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              {q}
            </button>
          </li>
        ))}
      </motion.ul>
    </motion.div>
  );
}
