import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Kbd, Modal, ModalBody, ModalContent } from "@heroui/react";
import { Building2, CornerDownLeft, MapPin, Search, Sparkles } from "lucide-react";
import { useFiltersMeta } from "@/api/hooks";
import { modalMotion } from "@/lib/motion";
import { useRole } from "@/state/role";
import { useGeoSelection } from "@/state/selection";
import { NAV } from "./nav";

type Item = { label: string; hint: string; icon: JSX.Element; run: () => void };

/** Ctrl/Cmd+K (SPEC §16.2): jump to a view, district, facility, or ask the agent. HeroUI Modal (focus trap, Esc). */
export function CommandPalette({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const nav = useNavigate();
  const meta = useFiltersMeta();
  const setFacility = useRole((s) => s.setFacility);
  const selectDistrict = useGeoSelection((s) => s.select);
  useEffect(() => { if (isOpen) { setQ(""); setActive(0); } }, [isOpen]);
  const items = useMemo(() => {
    const m = meta.data?.data;
    const out: Item[] = NAV.map((n) => ({ label: n.title, hint: "view", icon: <n.icon size={15} aria-hidden />, run: () => nav(n.to) }));
    (m?.districts ?? []).forEach((d: any) => out.push({ label: d.name, hint: `district · ${d.province}`, icon: <MapPin size={15} aria-hidden />, run: () => { selectDistrict(d.district_code); nav("/geo"); } }));
    (m?.facilities ?? []).forEach((f: any) => out.push({ label: f.name.replace(" (Synthetic)", ""), hint: `open as doctor · ${f.facility_type.toLowerCase()}`, icon: <Building2 size={15} aria-hidden />, run: () => { setFacility(f.location_id, f.name); nav("/doctor"); } }));
    return out;
  }, [meta.data, nav, setFacility, selectDistrict]);
  const ql = q.toLowerCase();
  const shown = (ql ? items.filter((i) => i.label.toLowerCase().includes(ql)) : items).slice(0, 9);
  const ask: Item | null = q ? { label: `Ask the agent: “${q}”`, hint: "agent", icon: <Sparkles size={15} aria-hidden />, run: () => nav(`/agent?q=${encodeURIComponent(q)}`) } : null;
  const all = ask ? [...shown, ask] : shown;
  const run = (fn: () => void) => { fn(); onClose(); };
  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="top" size="xl" backdrop="blur" hideCloseButton motionProps={modalMotion as any} aria-label="Command palette"
           classNames={{ base: "mt-[12vh] rounded-modal bg-surface border border-border shadow-float overflow-hidden", backdrop: "bg-[rgb(11_18_32/0.28)] backdrop-blur-[6px]" }}>
      <ModalContent>
        <ModalBody className="p-0 gap-0">
          <div className="flex items-center gap-3 px-5 border-b border-border">
            <Search size={18} className="text-fg-muted" aria-hidden />
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Jump to a view, district or facility… or ask a question"
                   className="flex-1 bg-transparent py-4 text-[15px] text-fg placeholder:text-fg-muted outline-none" aria-label="Search"
                   aria-controls="cmd-results" aria-activedescendant={all[active] ? `cmd-${active}` : undefined}
                   onKeyDown={(e) => {
                     if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(all.length - 1, a + 1)); }
                     if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                     if (e.key === "Enter") run(all[active]?.run ?? (() => nav(`/agent?q=${encodeURIComponent(q)}`)));
                   }} />
            <Kbd className="hidden sm:inline-flex">esc</Kbd>
          </div>
          <ul id="cmd-results" role="listbox" aria-label="Results" className="max-h-[360px] overflow-auto p-2">
            {all.map((i, k) => (
              <li key={k} id={`cmd-${k}`} role="option" aria-selected={k === active}>
                <button type="button" tabIndex={-1} onMouseEnter={() => setActive(k)} onClick={() => run(i.run)}
                        className={`w-full text-left px-3 py-2.5 rounded-[12px] flex items-center gap-3 text-[13.5px] transition-colors ${k === active ? "bg-accent-soft text-fg" : "text-fg hover:bg-surface-2"}`}>
                  <span className={`w-8 h-8 rounded-[10px] grid place-items-center shrink-0 ${k === active ? "bg-surface text-accent" : "bg-surface-2 text-fg-muted"}`}>{i.icon}</span>
                  <span className="flex-1 truncate">{i.label}</span>
                  <span className="text-xs text-fg-muted">{i.hint}</span>
                  {k === active && <CornerDownLeft size={14} className="text-fg-muted" aria-hidden />}
                </button>
              </li>
            ))}
            {!all.length && <li className="px-3 py-6 text-center text-sm text-fg-muted">Type to search views, districts and facilities</li>}
          </ul>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
