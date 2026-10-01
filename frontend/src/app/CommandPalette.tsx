import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { useFiltersMeta } from "@/api/hooks";
import { useRole } from "@/state/role";
import { useGeoSelection } from "@/state/selection";
import { NAV } from "./Shell";

/** Ctrl/Cmd+K (SPEC §16.2): jump to a view, district, facility, or ask a question. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const meta = useFiltersMeta();
  const setFacility = useRole((s) => s.setFacility);
  const selectDistrict = useGeoSelection((s) => s.select);
  const items = useMemo(() => {
    const m = meta.data?.data;
    const out: { label: string; hint: string; run: () => void }[] = NAV.map((n) => ({ label: n.label, hint: "view", run: () => nav(n.to) }));
    (m?.districts ?? []).forEach((d: any) => out.push({ label: d.name, hint: `district · ${d.province}`, run: () => { selectDistrict(d.district_code); nav("/geo"); } }));
    (m?.facilities ?? []).forEach((f: any) => out.push({ label: f.name.replace(" (Synthetic)", ""), hint: `open as doctor · ${f.facility_type.toLowerCase()}`, run: () => { setFacility(f.location_id, f.name); nav("/doctor"); } }));
    return out;
  }, [meta.data, nav, setFacility, selectDistrict]);
  const ql = q.toLowerCase();
  const shown = (ql ? items.filter((i) => i.label.toLowerCase().includes(ql)) : items).slice(0, 9);
  const run = (fn: () => void) => { fn(); onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24" role="dialog" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-[560px] panel bg-ridge overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-line">
          <Search size={16} className="text-fog" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a view, district or facility… or type a question"
                 className="flex-1 bg-transparent py-3 text-sm outline-none" aria-label="Search"
                 onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter") run(shown[0]?.run ?? (() => nav(`/ask?q=${encodeURIComponent(q)}`))); }} />
        </div>
        <ul className="max-h-80 overflow-auto py-1">
          {shown.map((i, k) => (
            <li key={k}><button className="w-full text-left px-4 py-2 hover:bg-ridge2 flex justify-between text-sm" onClick={() => run(i.run)}>
              <span>{i.label}</span><span className="text-xs text-fog">{i.hint}</span></button></li>
          ))}
          {q && <li><button className="w-full text-left px-4 py-2 hover:bg-ridge2 text-sm text-kivu" onClick={() => run(() => nav(`/ask?q=${encodeURIComponent(q)}`))}>Ask the data: “{q}”</button></li>}
        </ul>
      </div>
    </div>
  );
}
