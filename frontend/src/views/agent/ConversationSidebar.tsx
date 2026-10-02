import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { MoreHorizontal, PenLine, Search, SquarePen, Trash2 } from "lucide-react";
import { EASE, modalMotion } from "@/lib/motion";
import { useConversations, useDeleteConversation, useRenameConversation } from "./api";
import type { Conversation } from "./types";

const GROUPS = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"] as const;
function groupOf(iso: string, now = new Date()): (typeof GROUPS)[number] {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? "Previous 7 days" : diff < 30 ? "Previous 30 days" : "Older";
}

type Props = {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  className?: string;
};

/** Conversation list (plan §B7): new, rename, delete; grouped by last activity; filtered by the role's agent server-side. */
export function ConversationSidebar({ activeId, onSelect, onNew, onDeleted, className = "" }: Props) {
  const reduce = useReducedMotion();
  const list = useConversations();
  const rename = useRenameConversation();
  const del = useDeleteConversation();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Conversation | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const xs = (list.data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q) || (c.last_message_preview ?? "").toLowerCase().includes(q));
    const by = new Map<string, Conversation[]>();
    xs.forEach((c) => { const g = groupOf(c.updated_at); by.set(g, [...(by.get(g) ?? []), c]); });
    return GROUPS.filter((g) => by.has(g)).map((g) => ({ label: g, items: by.get(g)! }));
  }, [list.data, query]);

  return (
    <aside aria-label="Conversations" className={`flex flex-col w-full min-h-0 ${className}`}>
      <div className="h-12 pl-3 pr-0 flex items-center gap-2 shrink-0">
        <h2 className="text-title text-ink flex-1">Chats</h2>
        <Button isIconOnly radius="full" variant="flat" onPress={onNew} aria-label="New chat"
                className="w-10 h-10 min-w-10 bg-surface text-ink data-[hover=true]:bg-tile dark:border dark:border-hairline">
          <SquarePen size={16} aria-hidden />
        </Button>
      </div>
      <div className="pt-3 pb-2 shrink-0">
        <label className="flex items-center gap-2.5 rounded-full bg-surface dark:border dark:border-hairline px-4 h-10 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
          <Search size={16} className="text-ink shrink-0" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats"
                 className="flex-1 min-w-0 bg-transparent outline-none focus-visible:outline-none text-[14px] text-ink placeholder:text-muted" />
        </label>
      </div>
      <nav className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 pb-3 scrollbar-none" aria-label="Conversation history">
        {list.isLoading && <div className="flex flex-col gap-1.5 pt-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-10 rounded-full bg-ink/[0.04] dark:bg-tile animate-pulse" />)}</div>}
        {list.isError && <p className="px-3 py-4 text-[14px] text-muted">Chats are unavailable. Start the agent server, then reload.</p>}
        {list.isSuccess && !groups.length && (
          <p className="px-3 py-6 text-[14px] text-muted">{query ? "No chats match this search." : "No chats yet. Ask a question to start one."}</p>
        )}
        {groups.map((g) => (
          <section key={g.label} className="mt-4" aria-label={g.label}>
            <h3 className="px-3 pb-1.5 text-micro text-muted">{g.label}</h3>
            <ul className="flex flex-col gap-0.5">
              <AnimatePresence initial={false}>
                {g.items.map((c) => (
                  <motion.li key={c.id} layout={!reduce} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }}
                             transition={{ duration: 0.25, ease: EASE }}>
                    {renaming === c.id ? (
                      <RenameInput initial={c.title} onDone={(t) => { setRenaming(null); if (t && t !== c.title) rename.mutate({ id: c.id, title: t }); }} />
                    ) : (
                      <Item c={c} active={c.id === activeId} onSelect={() => onSelect(c.id)} onRename={() => setRenaming(c.id)} onDelete={() => setConfirm(c)} />
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </section>
        ))}
      </nav>

      <Modal isOpen={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }} size="sm" backdrop="opaque" motionProps={modalMotion as any}
             classNames={{ base: "rounded-modal bg-surface shadow-float dark:border dark:border-hairline", backdrop: "bg-[rgb(21_23_28/0.32)]",
                           header: "px-7 pt-6 pb-1", body: "px-7", footer: "px-7 pb-6 pt-4", closeButton: "top-5 right-5 w-9 h-9 rounded-full border border-hairline text-ink hover:bg-tile" }}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="text-[20px] leading-7 font-semibold text-ink">Delete this chat?</ModalHeader>
              <ModalBody><p className="text-[14px] leading-[21px] text-muted">“{confirm?.title}” and its answers will be removed. This cannot be undone.</p></ModalBody>
              <ModalFooter>
                <Button radius="full" variant="flat" className="bg-tile text-ink font-medium" onPress={() => setConfirm(null)}>Cancel</Button>
                <Button radius="full" color="danger" className="font-semibold" onPress={() => { const c = confirm!; setConfirm(null); del.mutate(c.id, { onSuccess: () => onDeleted(c.id) }); }}>Delete chat</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </aside>
  );
}

function Item({ c, active, onSelect, onRename, onDelete }: { c: Conversation; active: boolean; onSelect: () => void; onRename: () => void; onDelete: () => void }) {
  return (
    <div className={`group relative flex items-center rounded-full transition-colors ${active ? "bg-surface dark:bg-tile" : "hover:bg-ink/[0.04] dark:hover:bg-surface"}`}>
      <button type="button" onClick={onSelect} aria-current={active ? "page" : undefined} title={c.title}
              className={`flex-1 min-w-0 h-10 text-left pl-3 pr-9 text-[14px] truncate rounded-full focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${active ? "text-ink font-semibold" : "text-ink/80"}`}>
        {c.title}
      </button>
      <Dropdown placement="bottom-end" classNames={{ content: "min-w-[160px] p-1.5 bg-surface shadow-float rounded-tile dark:border dark:border-hairline" }}>
        <DropdownTrigger>
          <Button isIconOnly size="sm" radius="full" variant="light" aria-label={`Actions for ${c.title}`}
                  className={`absolute right-1.5 min-w-7 w-7 h-7 text-muted data-[hover=true]:bg-tile data-[hover=true]:text-ink ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100 data-[focus-visible=true]:opacity-100"}`}>
            <MoreHorizontal size={15} aria-hidden />
          </Button>
        </DropdownTrigger>
        <DropdownMenu aria-label="Chat actions" onAction={(k) => (k === "rename" ? onRename() : onDelete())}>
          <DropdownItem key="rename" startContent={<PenLine size={14} aria-hidden />}>Rename</DropdownItem>
          <DropdownItem key="delete" className="text-danger" color="danger" startContent={<Trash2 size={14} aria-hidden />}>Delete</DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (t: string | null) => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} aria-label="Chat title" maxLength={200}
           onKeyDown={(e) => { if (e.key === "Enter") onDone(v.trim() || null); if (e.key === "Escape") onDone(null); }}
           onBlur={() => onDone(v.trim() || null)}
           className="w-full h-10 rounded-full bg-surface border border-hairline px-3 text-[14px] text-ink outline outline-2 outline-offset-0 outline-brand/40" />
  );
}
