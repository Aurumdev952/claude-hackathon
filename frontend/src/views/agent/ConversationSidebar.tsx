import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { MessageSquare, MoreHorizontal, PenLine, Search, SquarePen, Trash2 } from "lucide-react";
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
    <aside aria-label="Conversations" className={`flex flex-col min-h-0 rounded-card bg-surface border border-border shadow-card overflow-hidden ${className}`}>
      <div className="p-3 pb-2 flex items-center gap-2">
        <h2 className="text-title text-fg pl-1.5 flex-1">Chats</h2>
        <Button size="sm" radius="full" onPress={onNew} aria-label="New chat" startContent={<SquarePen size={14} aria-hidden />}
                className="bg-accent text-white font-medium h-8 shadow-tile">New</Button>
      </div>
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-full bg-surface-2 border border-border px-3 h-8 focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15 transition">
          <Search size={13} className="text-fg-muted shrink-0" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats"
                 className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-fg placeholder:text-fg-muted" />
        </label>
      </div>
      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-3" aria-label="Conversation history">
        {list.isLoading && <div className="flex flex-col gap-1.5 px-1 pt-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 rounded-[10px] bg-surface-2 animate-pulse" />)}</div>}
        {list.isError && <p className="px-3 py-4 text-label text-fg-muted">Chats unavailable. Is the agent running?</p>}
        {list.isSuccess && !groups.length && (
          <div className="px-3 py-8 text-center text-label text-fg-muted flex flex-col items-center gap-2">
            <MessageSquare size={18} aria-hidden />{query ? "No matches" : "No chats yet"}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.label} className="mt-2" aria-label={g.label}>
            <h3 className="px-2.5 pb-1 text-micro font-medium text-fg-muted">{g.label}</h3>
            <ul className="flex flex-col gap-px">
              <AnimatePresence initial={false}>
                {g.items.map((c) => (
                  <motion.li key={c.id} layout={!reduce} initial={reduce ? false : { opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }}
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

      <Modal isOpen={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }} size="sm" backdrop="blur" motionProps={modalMotion as any}
             classNames={{ base: "rounded-modal bg-surface border border-border shadow-float", backdrop: "bg-[rgb(11_18_32/0.28)] backdrop-blur-[6px]" }}>
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="text-title text-fg">Delete chat?</ModalHeader>
              <ModalBody><p className="text-[13px] text-fg-muted">“{confirm?.title}” and its answers will be removed. This cannot be undone.</p></ModalBody>
              <ModalFooter>
                <Button radius="full" variant="light" onPress={() => setConfirm(null)}>Cancel</Button>
                <Button radius="full" color="danger" onPress={() => { const c = confirm!; setConfirm(null); del.mutate(c.id, { onSuccess: () => onDeleted(c.id) }); }}>Delete</Button>
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
    <div className={`group relative flex items-center rounded-[10px] transition-colors ${active ? "bg-accent-soft" : "hover:bg-surface-2"}`}>
      {active && <motion.span layoutId="conv-active" className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" transition={{ type: "spring", stiffness: 500, damping: 40 }} aria-hidden />}
      <button type="button" onClick={onSelect} aria-current={active ? "page" : undefined} title={c.title}
              className={`flex-1 min-w-0 text-left pl-3 pr-8 py-2 text-[13px] truncate rounded-[10px] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${active ? "text-accent font-medium" : "text-fg"}`}>
        {c.title}
      </button>
      <Dropdown placement="bottom-end" classNames={{ content: "min-w-[150px] bg-surface border border-border shadow-float rounded-tile" }}>
        <DropdownTrigger>
          <Button isIconOnly size="sm" radius="full" variant="light" aria-label={`Actions for ${c.title}`}
                  className={`absolute right-1 min-w-6 w-6 h-6 text-fg-muted data-[hover=true]:bg-fg/[0.06] ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100 data-[focus-visible=true]:opacity-100"}`}>
            <MoreHorizontal size={14} aria-hidden />
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
           className="w-full rounded-[10px] bg-surface border border-accent/50 ring-2 ring-accent/15 px-3 py-[7px] text-[13px] text-fg outline-none" />
  );
}
