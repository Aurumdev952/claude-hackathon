import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@heroui/react";
import { PanelLeft, SquarePen, Stethoscope, X } from "lucide-react";
import { EASE } from "@/lib/motion";
import { AgentChip } from "./AgentAvatar";
import { AgentApiError, useAgentScope, useConversation, useConversations } from "./api";
import { ConversationSidebar } from "./ConversationSidebar";
import { Thread } from "./Thread";
import { newConversationId } from "./transport";

/** /agent (plan §B7): conversation sidebar + thread + composer. The top-nav role decides which agent answers
 * (Ministry analyst vs Clinical assistant); `?c=` is the open conversation, `?q=` sends a question in a new one. */
export default function AgentView() {
  const { role, facilityId, facilityName, ready } = useAgentScope();
  const [params, setParams] = useSearchParams();
  const [draftId, setDraftId] = useState(newConversationId);
  const qParam = params.get("q");
  const [autoSend, setAutoSend] = useState<string | null>(qParam);
  const [drawer, setDrawer] = useState(false);
  /** The conversation started in this mount: its thread is live, never refetch / remount it. */
  const [liveId, setLiveId] = useState<string | null>(null);
  const cParam = qParam ? null : params.get("c");
  const activeId = cParam ?? draftId;
  const isLocal = !cParam || cParam === liveId;

  const setConv = useCallback((id: string | null, replace = false) => {
    setParams((p) => { const n = new URLSearchParams(p); n.delete("q"); if (id) n.set("c", id); else n.delete("c"); return n; }, { replace });
  }, [setParams]);

  const newChat = useCallback(() => { setAutoSend(null); setLiveId(null); setDraftId(newConversationId()); setConv(null); setDrawer(false); }, [setConv]);
  const select = useCallback((id: string) => { setAutoSend(null); if (id !== liveId) setLiveId(null); setConv(id); setDrawer(false); }, [setConv, liveId]);

  // ?q= deep link (command palette): send it in a fresh conversation (the first one is already in state)
  const handledQ = useRef<string | null>(null);
  useEffect(() => {
    if (!qParam) return;
    if (!(handledQ.current === null && autoSend === qParam)) { setAutoSend(qParam); setLiveId(null); setDraftId(newConversationId()); }
    handledQ.current = qParam;
    setConv(null, true);
  }, [qParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // the role switch changes the agent: conversations are pinned to the role that created them
  const scopeKey = `${role}:${facilityId ?? ""}`;
  const prevScope = useRef(scopeKey);
  useEffect(() => {
    if (prevScope.current !== scopeKey) { prevScope.current = scopeKey; newChat(); }
  }, [scopeKey, newChat]);

  const conv = useConversation(activeId, !isLocal);
  const list = useConversations();
  const notFound = conv.error instanceof AgentApiError && (conv.error.status === 404 || conv.error.status === 403);
  useEffect(() => { if (notFound) newChat(); }, [notFound, newChat]);

  const title = list.data?.find((c) => c.id === activeId)?.title ?? conv.data?.title ?? (isLocal && !cParam ? "New chat" : "");

  if (!ready) return <PickFacility />;

  const sidebar = (
    <ConversationSidebar activeId={activeId} className="h-full"
                         onSelect={select}
                         onNew={newChat}
                         onDeleted={(id) => { if (id === activeId) newChat(); }} />
  );

  return (
    <div className="h-full min-h-[520px] grid gap-6 lg:grid-cols-[256px_minmax(0,1fr)]" data-testid="agent-view">
      <div className="hidden lg:flex min-h-0">{sidebar}</div>

      <AnimatePresence>
        {drawer && (
          <motion.div className="lg:hidden fixed inset-0 z-50 flex" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            <button type="button" aria-label="Close chats" className="absolute inset-0 bg-[rgb(21_23_28/0.32)]" onClick={() => setDrawer(false)} />
            <motion.div className="relative w-[300px] max-w-[85vw] h-full bg-page shadow-float px-3 pt-4 pb-3 flex" initial={{ x: -320 }} animate={{ x: 0 }} exit={{ x: -320 }} transition={{ duration: 0.28, ease: EASE }}>
              {sidebar}
              <Button isIconOnly size="sm" radius="full" variant="flat" aria-label="Close chats" onPress={() => setDrawer(false)}
                      className="absolute top-4 -right-12 w-10 h-10 min-w-10 bg-surface text-ink"><X size={16} /></Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="min-h-0 min-w-0 flex flex-col" aria-label="Agent chat">
        <header className="flex md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)] items-center gap-2 md:gap-3 h-12 shrink-0">
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <Button isIconOnly radius="full" variant="flat" aria-label="Show chats" onPress={() => setDrawer(true)} className="lg:hidden w-10 h-10 min-w-10 bg-surface text-ink dark:border dark:border-hairline"><PanelLeft size={17} /></Button>
            <AgentChip role={role} facilityName={facilityName} className="min-w-0" />
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1 key={title} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
                       className="hidden md:block min-w-0 max-w-[560px] truncate text-center text-[14px] font-medium text-muted">{title}</motion.h1>
          </AnimatePresence>
          <div className="flex justify-end shrink-0">
            <Button radius="full" variant="flat" onPress={newChat} aria-label="New chat"
                    startContent={<SquarePen size={16} aria-hidden />}
                    className="lg:hidden h-10 min-w-10 px-0 sm:px-4 bg-surface text-ink text-[14px] font-medium data-[hover=true]:bg-tile dark:border dark:border-hairline">
              <span className="hidden sm:inline">New chat</span>
            </Button>
          </div>
        </header>
        {isLocal ? (
          <Thread key={activeId} conversationId={activeId} initialMessages={[]} autoSend={autoSend}
                  onStarted={() => { setLiveId(activeId); setConv(activeId, true); }} />
        ) : conv.data ? (
          <Thread key={activeId} conversationId={activeId} initialMessages={conv.data.messages} />
        ) : (
          <ThreadSkeleton error={conv.isError && !notFound} onRetry={() => conv.refetch()} />
        )}
      </section>
    </div>
  );
}

function ThreadSkeleton({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  if (error) return (
    <div className="flex-1 grid place-items-center text-center p-6">
      <div className="flex flex-col items-center gap-3">
        <p className="text-[14px] text-muted">This chat could not be loaded. Check that the agent is running, then retry.</p>
        <Button radius="full" variant="flat" onPress={onRetry} className="bg-surface text-ink font-medium">Retry</Button>
      </div>
    </div>
  );
  return (
    <div className="flex-1 mx-auto w-full max-w-[760px] px-1 pt-8 flex flex-col gap-7" aria-busy="true" aria-label="Loading chat">
      <div className="self-end h-11 w-64 rounded-[20px] bg-ink/[0.05] dark:bg-tile animate-pulse" />
      <div className="flex flex-col gap-3"><div className="h-4 w-3/4 rounded-full bg-ink/[0.05] dark:bg-tile animate-pulse" /><div className="h-4 w-1/2 rounded-full bg-ink/[0.05] dark:bg-tile animate-pulse" /><div className="h-56 rounded-card bg-surface animate-pulse" /></div>
    </div>
  );
}

function PickFacility() {
  return (
    <div className="h-full min-h-[420px] grid place-items-center">
      <div className="text-center max-w-sm flex flex-col items-center gap-3">
        <span className="w-12 h-12 rounded-full border border-hairline text-ink grid place-items-center" aria-hidden><Stethoscope size={20} strokeWidth={1.75} /></span>
        <h1 className="text-h1 text-ink">Choose your facility</h1>
        <p className="text-[15px] leading-6 text-muted">The clinical assistant only sees the patients of one facility. Pick it in the Patients view first.</p>
        <Button as={Link} to="/doctor" color="primary" radius="full" className="mt-1 h-11 px-6 font-semibold">Open patients</Button>
      </div>
    </div>
  );
}
