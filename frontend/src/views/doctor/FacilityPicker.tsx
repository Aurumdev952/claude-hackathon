import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import { get } from "@/api/client";
import { useRole } from "@/state/role";
import { int } from "@/lib/format";

export function FacilityPicker() {
  const setFacility = useRole((s) => s.setFacility);
  const [q, setQ] = useState("");
  const { data } = useQuery({ queryKey: ["alerts", "facility-summary"], queryFn: () => get<any[]>("/facilities/alert-summary") });
  const rows = useMemo(() => (data?.data ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase())), [data, q]);
  return (
    <div className="max-w-3xl mx-auto mt-10 animate-rise">
      <h1 className="text-2xl font-bold mb-1">Choose your facility</h1>
      <p className="text-fog text-sm mb-5">The doctor view shows patient-level data for one facility (its own patients, its health centres if it is a district hospital, and patients seen there for stomach complaints in the last 2 years).</p>
      <label className="flex items-center gap-2 panel px-3 mb-3">
        <Search size={16} className="text-fog" />
        <input className="bg-transparent flex-1 py-2.5 outline-none text-sm" placeholder="Search facilities…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search facilities" />
      </label>
      <div className="panel divide-y divide-line/40 max-h-[60vh] overflow-auto">
        {rows.slice(0, 80).map((r) => (
          <button key={r.location_id} onClick={() => setFacility(r.location_id, r.name)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-ridge2/60">
            <Building2 size={16} className="text-fog" />
            <span className="flex-1 text-sm">{r.name.replace(" (Synthetic)", "")}<span className="text-fog text-xs ml-2">{r.facility_type.toLowerCase().replace("_", " ")} · {r.district_code}</span></span>
            <span className="text-xs text-fog tabular w-28 text-right">{int(r.cohort_patients)} GI patients</span>
            <span className={`text-xs tabular w-24 text-right ${r.high_alerts ? "text-laterite font-semibold" : "text-fog"}`}>{int(r.high_alerts)} HIGH alerts</span>
          </button>
        ))}
      </div>
    </div>
  );
}
