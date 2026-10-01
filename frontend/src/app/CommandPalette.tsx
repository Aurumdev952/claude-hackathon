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
    const out: Item[] = NAV.map((n) => ({ label: n.title, hint: "View", icon: <n.icon size={15} aria-hidden />, run: () => nav(n.to) }));
    (m?.districts ?? []).forEach((d: any) => out.push({ label: d.name, hint: `District in ${d.province}`, icon: <MapPin size={15} aria-hidden />, run: () => { selectDistrict(d.district_code); nav("/geo"); } }));
    (m?.facilities ?? []).forEach((f: any) => out.push({ label: f.name.replace(" (Synthetic)", ""), hint: `Open as doctor, ${f.facility_type.toLowerCase()}`, icon: <Building2 size={15} aria-hidden />, run: () => { setFacility(f.location_id, f.name); nav("/doctor"); } }));
    return out;
  }, [meta.data, nav, setFacility, selectDistrict]);
  const ql = q.toLowerCase();
  const shown = (ql ? items.filter((i) => i.label.toLowerCase().includes(ql)) : items).slice(0, 9);
  const ask: Item | null = q ? { label: `Ask the agent: “${q}”`, hint: "Agent", icon: <Sparkles size={15} aria-hidden />, run: () => nav(`/agent?q=${encodeURIComponent(q)}`) } : null;
  const all = ask ? [...shown, ask] : shown;
  const run = (fn: () => void) => { fn(); onClose(); };
  return (
    <Modal isOpen={isOpen} onClose={onClose} placement="top" size="xl" backdrop="opaque" hideCloseButton motionProps={modalMotion as any} aria-label="Command palette"
           classNames={{ base: "mt-[12vh] rounded-modal bg-surface shadow-float overflow-hidden dark:border dark:border-hairline", backdrop: "bg-[rgb(21_23_28/0.32)]" }}>
      <ModalContent>
        <ModalBody className="p-0 gap-0">
          <div className="flex items-center gap-3 px-6 border-b border-hairline">
            <Search size={18} className="text-ink" aria-hidden />
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Jump to a view, district or facility, or ask a question"
                   className="flex-1 bg-transparent py-5 text-[16px] text-ink placeholder:text-muted outline-none focus-visible:outline-none" aria-label="Search"
                   aria-controls="cmd-results" aria-activedescendant={all[active] ? `cmd-${active}` : undefined}
                   onKeyDown={(e) => {
                     if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(all.length - 1, a + 1)); }
                     if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                     if (e.key === "Enter") run(all[active]?.run ?? (() => nav(`/agent?q=${encodeURIComponent(q)}`)));
                   }} />
            <Kbd className="hidden sm:inline-flex bg-tile shadow-none text-muted">Esc</Kbd>
          </div>
          <ul id="cmd-results" role="listbox" aria-label="Results" className="max-h-[380px] overflow-auto p-2.5">
            {all.map((i, k) => (
              <li key={k} id={`cmd-${k}`} role="option" aria-selected={k === active}>
                <button type="button" tabIndex={-1} onMouseEnter={() => setActive(k)} onClick={() => run(i.run)}
                        className={`w-full text-left px-3 py-2.5 rounded-[14px] flex items-center gap-3 text-[14px] transition-colors ${k === active ? "bg-tile text-ink" : "text-ink hover:bg-tile/60"}`}>
                  <span className="w-8 h-8 rounded-full border border-hairline text-ink grid place-items-center shrink-0 bg-surface">{i.icon}</span>
                  <span className="flex-1 truncate">{i.label}</span>
                  <span className="text-[13px] text-muted">{i.hint}</span>
                  {k === active && <CornerDownLeft size={14} className="text-muted" aria-hidden />}
                </button>
              </li>
            ))}
            {!all.length && <li className="px-3 py-6 text-center text-[14px] text-muted">Type to search views, districts and facilities</li>}
          </ul>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
