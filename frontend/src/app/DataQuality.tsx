import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { get } from "@/api/client";
import { fmt, int } from "@/lib/format";
import { STATUS } from "@/lib/viz";

/** Data Quality drawer (SPEC §16.3): completeness, duplicates merged, unit fixes, voided rows. */
export function DataQualityDrawer({ onClose }: { onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["quality", "dq"], queryFn: () => get<any[]>("/data-quality") });
  const rows = data?.data ?? [];
  const national = rows.filter((r) => r.district_code === "RW" || (!r.district_code && !r.facility_id));
  const byDistrict = rows.filter((r) => r.district_code && r.district_code !== "RW" && r.metric === "completeness_smoking_pct");
  const counts = Object.fromEntries(national.map((r) => [r.metric, r.value]));
  const comp = [["Smoking recorded", counts.completeness_smoking_pct, 50], ["Family history recorded", counts.completeness_family_hx_pct, 50],
                ["H. pylori ever tested (GI cohort)", counts.hp_tested_pct, 30]] as const;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Data quality">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-[440px] h-full bg-basalt border-l border-line overflow-auto p-5 animate-rise">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Data quality</h2>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <h3 className="panel-title mb-2">Completeness · GI cohort</h3>
        <div className="flex flex-col gap-3 mb-6">
          {comp.map(([label, v, thr]) => (
            <div key={label}>
              <div className="flex justify-between text-xs mb-1"><span>{label}</span><span className="tabular">{fmt(v, 0)}% <span className="text-fog">(target {thr}%)</span></span></div>
              <div className="h-2 rounded bg-ridge2 overflow-hidden" aria-hidden>
                <div className="h-full rounded" style={{ width: `${Math.min(100, v ?? 0)}%`, background: (v ?? 0) >= thr ? STATUS.good : STATUS.serious }} />
              </div>
            </div>
          ))}
        </div>
        <h3 className="panel-title mb-2">Cleaning applied this run</h3>
        <dl className="grid grid-cols-2 gap-2 text-xs mb-6 tabular">
          {[["Duplicate records merged", counts.duplicates_merged], ["Hb g/L → g/dL fixes", counts.hb_unit_fixes],
            ["Amended labs resolved", counts.amended_labs_resolved], ["Voided obs excluded", counts.voided_obs_excluded],
            ["Future-dated encounters dropped", counts.encounters_dropped_future_dated], ["Before-birth encounters dropped", counts.encounters_dropped_before_birth],
            ["Estimated birthdates", counts.birthdate_estimated_pct !== undefined ? `${fmt(counts.birthdate_estimated_pct, 0)}%` : undefined]].map(([k, v]) => (
            <div key={String(k)} className="panel p-2.5"><dt className="text-fog">{k}</dt><dd className="text-base font-semibold">{typeof v === "number" ? int(v) : v ?? "—"}</dd></div>
          ))}
        </dl>
        <h3 className="panel-title mb-2">Smoking recorded, by district</h3>
        <div className="flex flex-col gap-1">
          {byDistrict.sort((a, b) => a.value - b.value).map((r) => (
            <div key={r.district_code} className="flex items-center gap-2 text-xs">
              <span className="w-20 text-fog">{r.district_code}</span>
              <div className="flex-1 h-1.5 bg-ridge2 rounded"><div className="h-full rounded bg-kivu" style={{ width: `${r.value}%` }} /></div>
              <span className="w-10 text-right tabular">{fmt(r.value, 0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
