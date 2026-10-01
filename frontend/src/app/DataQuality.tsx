import { useQuery } from "@tanstack/react-query";
import { Drawer, DrawerBody, DrawerContent, DrawerHeader } from "@heroui/react";
import { Database } from "lucide-react";
import { motion } from "framer-motion";
import { get } from "@/api/client";
import { useFiltersMeta } from "@/api/hooks";
import { GradientRangeBar } from "@/components/ui/GradientRangeBar";
import { fmt, int } from "@/lib/format";
import { EASE } from "@/lib/motion";

/** Data Quality drawer (SPEC §16.3, design v3): white, radius 24, one soft shadow; completeness bars with a target tick,
 * the cleaning counts as a plain list, smoking completeness by district as thin sky bars. HeroUI Drawer (focus trap). */
export function DataQualityDrawer({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["quality", "dq"], queryFn: () => get<any[]>("/data-quality"), enabled: isOpen });
  const meta = useFiltersMeta();
  const names = new Map<string, string>((meta.data?.data?.districts ?? []).map((d: any) => [d.district_code, d.name]));
  const rows = data?.data ?? [];
  const national = rows.filter((r) => r.district_code === "RW" || (!r.district_code && !r.facility_id));
  const byDistrict = rows.filter((r) => r.district_code && r.district_code !== "RW" && r.metric === "completeness_smoking_pct");
  const counts = Object.fromEntries(national.map((r) => [r.metric, r.value]));
  const comp = [["Smoking recorded", counts.completeness_smoking_pct, 50], ["Family history recorded", counts.completeness_family_hx_pct, 50],
                ["H. pylori ever tested (GI cohort)", counts.hp_tested_pct, 30]] as const;
  const cleaning = [["Duplicate patients merged", counts.duplicates_merged], ["Hb values converted from g/L to g/dL", counts.hb_unit_fixes],
    ["Amended lab results resolved", counts.amended_labs_resolved], ["Voided observations excluded", counts.voided_obs_excluded],
    ["Future-dated encounters dropped", counts.encounters_dropped_future_dated], ["Encounters before birth dropped", counts.encounters_dropped_before_birth],
    ["Birthdates estimated", counts.birthdate_estimated_pct !== undefined ? `${fmt(counts.birthdate_estimated_pct, 0)}%` : undefined]] as const;
  return (
    <Drawer isOpen={isOpen} onClose={onClose} placement="right" size="md" backdrop="opaque" aria-label="Data quality"
            classNames={{ base: "bg-surface sm:m-3 sm:rounded-modal shadow-float dark:border dark:border-hairline", backdrop: "bg-[rgb(21_23_28/0.32)]", closeButton: "top-6 right-6 w-9 h-9 rounded-full border border-hairline text-ink hover:bg-tile" }}>
      <DrawerContent>
        <DrawerHeader className="flex items-center gap-3 px-7 pt-6 pb-2">
          <span className="w-9 h-9 rounded-full border border-hairline text-ink grid place-items-center" aria-hidden><Database size={17} /></span>
          <div className="min-w-0">
            <h2 className="text-[22px] leading-7 font-semibold text-ink">Data quality</h2>
            <p className="text-[13px] font-normal text-muted">Checks from the latest pipeline run</p>
          </div>
        </DrawerHeader>
        <DrawerBody className="px-7 pt-4 pb-8 gap-9">
          <section aria-labelledby="dq-comp">
            <h3 id="dq-comp" className="text-title text-ink">Completeness</h3>
            <p className="text-[13px] text-muted mt-0.5 mb-4">Share of the GI cohort with the field recorded at least once.</p>
            <div className="flex flex-col gap-4">
              {comp.map(([label, v, thr]) => (
                <div key={label}>
                  <div className="flex items-baseline justify-between gap-3 text-[14px]">
                    <span className="text-ink">{label}</span>
                    <span className="tabular flex items-baseline gap-2.5"><span className="text-[13px] text-muted">Target {thr}%</span><span className="font-semibold text-ink">{v === undefined ? "—" : `${fmt(v, 0)}%`}</span></span>
                  </div>
                  <GradientRangeBar value={v ?? null} min={0} max={100} reverse markers={[{ value: thr, label: `Target ${thr}%` }]} format={(n) => `${fmt(n, 0)}%`}
                                    label={`${label}, target ${thr}%`} showMinMax={false} height={6} />
                </div>
              ))}
            </div>
          </section>
          <section aria-labelledby="dq-clean">
            <h3 id="dq-clean" className="text-title text-ink mb-2">Cleaning applied this run</h3>
            <dl className="flex flex-col">
              {cleaning.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 py-2.5 border-b border-hairline last:border-0">
                  <dt className="text-[14px] text-muted">{k}</dt>
                  <dd className="text-[17px] font-medium text-ink tabular">{typeof v === "number" ? int(v) : v ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="dq-district">
            <h3 id="dq-district" className="text-title text-ink">Smoking recorded, by district</h3>
            <p className="text-[13px] text-muted mt-0.5 mb-4">Lowest first. Target 50%.</p>
            <ul className="flex flex-col gap-2.5">
              {[...byDistrict].sort((a, b) => a.value - b.value).map((r, i) => (
                <li key={r.district_code} className="grid grid-cols-[104px_minmax(0,1fr)_40px] items-center gap-3 text-[14px]">
                  <span className="text-ink truncate" title={names.get(r.district_code) ?? r.district_code}>{names.get(r.district_code) ?? r.district_code}</span>
                  <div className="relative h-1.5 bg-tile dark:bg-hairline rounded-full">
                    <motion.div className="absolute inset-y-0 left-0 rounded-full bg-sky" initial={{ width: 0 }} animate={{ width: `${r.value}%` }} transition={{ duration: 0.6, ease: EASE, delay: Math.min(i * 0.02, 0.5) }} />
                    <span className="absolute -top-1 -bottom-1 left-1/2 w-[2px] -ml-px rounded-full bg-ink/70" aria-hidden />
                  </div>
                  <span className="text-right tabular text-ink">{fmt(r.value, 0)}%</span>
                </li>
              ))}
            </ul>
          </section>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
