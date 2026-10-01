import { useQuery } from "@tanstack/react-query";
import { Drawer, DrawerBody, DrawerContent, DrawerHeader } from "@heroui/react";
import { Database } from "lucide-react";
import { motion } from "framer-motion";
import { get } from "@/api/client";
import { GradientRangeBar } from "@/components/ui/GradientRangeBar";
import { InfoHint } from "@/components/ui/InfoHint";
import { StatTile } from "@/components/ui/MetricCard";
import { fmt, int } from "@/lib/format";
import { EASE } from "@/lib/motion";

/** Data Quality drawer (SPEC §16.3): completeness, duplicates merged, unit fixes, voided rows. HeroUI Drawer (focus trap). */
export function DataQualityDrawer({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["quality", "dq"], queryFn: () => get<any[]>("/data-quality"), enabled: isOpen });
  const rows = data?.data ?? [];
  const national = rows.filter((r) => r.district_code === "RW" || (!r.district_code && !r.facility_id));
  const byDistrict = rows.filter((r) => r.district_code && r.district_code !== "RW" && r.metric === "completeness_smoking_pct");
  const counts = Object.fromEntries(national.map((r) => [r.metric, r.value]));
  const comp = [["Smoking recorded", counts.completeness_smoking_pct, 50], ["Family history recorded", counts.completeness_family_hx_pct, 50],
                ["H. pylori ever tested (GI cohort)", counts.hp_tested_pct, 30]] as const;
  const cleaning = [["Duplicates merged", counts.duplicates_merged], ["Hb g/L → g/dL fixes", counts.hb_unit_fixes],
    ["Amended labs resolved", counts.amended_labs_resolved], ["Voided obs excluded", counts.voided_obs_excluded],
    ["Future-dated dropped", counts.encounters_dropped_future_dated], ["Before-birth dropped", counts.encounters_dropped_before_birth],
    ["Estimated birthdates", counts.birthdate_estimated_pct !== undefined ? `${fmt(counts.birthdate_estimated_pct, 0)}%` : undefined]] as const;
  return (
    <Drawer isOpen={isOpen} onClose={onClose} placement="right" size="md" backdrop="blur" aria-label="Data quality"
            classNames={{ base: "bg-surface border-l border-border sm:m-3 sm:rounded-modal", backdrop: "bg-[rgb(11_18_32/0.22)] backdrop-blur-[4px]", closeButton: "top-4 right-4 rounded-full" }}>
      <DrawerContent>
        <DrawerHeader className="flex items-center gap-3 pt-5">
          <span className="w-9 h-9 rounded-tile bg-accent-soft text-accent grid place-items-center" aria-hidden><Database size={17} /></span>
          <h2 className="text-h1 text-fg">Data quality</h2>
        </DrawerHeader>
        <DrawerBody className="pb-6 gap-6">
          <section>
            <div className="flex items-center gap-0.5 mb-2">
              <h3 className="text-title text-fg">Completeness</h3>
              <InfoHint label="About completeness" content="Share of the GI cohort with the field recorded at least once. The marker shows the target; below it, risk features built from this field are less reliable." />
            </div>
            <div className="flex flex-col gap-3.5">
              {comp.map(([label, v, thr]) => (
                <div key={label}>
                  <div className="flex justify-between text-label mb-0.5"><span className="text-fg">{label}</span><span className="tabular font-semibold text-fg">{v === undefined ? "—" : `${fmt(v, 0)}%`}</span></div>
                  <GradientRangeBar value={v ?? null} min={0} max={100} reverse markers={[{ value: thr, label: `target ${thr}%` }]} format={(n) => `${fmt(n, 0)}%`}
                                    label={`${label}, target ${thr}%`} minLabel="0%" maxLabel={`target ${thr}%`} height={6} />
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3 className="text-title text-fg mb-2">Cleaning applied this run</h3>
            <div className="grid grid-cols-2 gap-2">
              {cleaning.map(([k, v]) => <StatTile key={k} label={k} value={typeof v === "number" ? int(v) : v ?? "—"} />)}
            </div>
          </section>
          <section>
            <h3 className="text-title text-fg mb-2">Smoking recorded, by district</h3>
            <ul className="flex flex-col gap-1.5">
              {[...byDistrict].sort((a, b) => a.value - b.value).map((r, i) => (
                <li key={r.district_code} className="flex items-center gap-2 text-xs">
                  <span className="w-20 text-fg-muted truncate">{r.district_code}</span>
                  <div className="flex-1 h-1.5 bg-fg/[0.06] rounded-full overflow-hidden">
                    <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${r.value}%` }} transition={{ duration: 0.6, ease: EASE, delay: Math.min(i * 0.02, 0.5) }} />
                  </div>
                  <span className="w-10 text-right tabular text-fg">{fmt(r.value, 0)}%</span>
                </li>
              ))}
            </ul>
          </section>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
