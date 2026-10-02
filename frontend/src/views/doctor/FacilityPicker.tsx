import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { Building2, ChevronRight, Hospital, Search } from "lucide-react";
import { get } from "@/api/client";
import { Card, PageHeader, Skeleton } from "@/components/ui";
import { useRole } from "@/state/role";
import { int } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { Dot } from "./BandMark";

const ABOUT = "The doctor view shows patient-level data for one facility: its own patients, its health centres if it is a district hospital, and patients seen there for stomach complaints in the last 2 years.";

const typeLabel = (t: unknown) => {
  const s = String(t ?? "").toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Facility chooser for the doctor role: a plain search field and a reference-style list (outlined icon, name, muted
 * second line, GI cohort and HIGH alerts right-aligned). */
export function FacilityPicker() {
  const setFacility = useRole((s) => s.setFacility);
  const [q, setQ] = useState("");
  const reduce = useReducedMotion();
  const { data, isLoading } = useQuery({ queryKey: ["alerts", "facility-summary"], queryFn: () => get<any[]>("/facilities/alert-summary") });
  const all = data?.data ?? [];
  const rows = useMemo(() => all.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())), [all, q]);
  const totals = useMemo(() => ({ n: all.length, high: all.reduce((s, r) => s + (r.high_alerts ?? 0), 0) }), [all]);
  return (
    <div className="w-full max-w-[760px] mx-auto pt-6 sm:pt-10 flex flex-col gap-5">
      <PageHeader title="Choose your facility" eyebrow="Doctor workspace" icon={<Hospital size={18} />} info={ABOUT}
                  actions={totals.n ? (
                    <div className="hidden sm:flex items-center gap-5 text-label font-normal text-muted tabular">
                      <span><span className="text-ink font-semibold">{int(totals.n)}</span> facilities</span>
                      <span className="inline-flex items-center gap-1.5"><Dot level="high" /><span className="text-ink font-semibold">{int(totals.high)}</span> high alerts</span>
                    </div>
                  ) : undefined} />
      <Input aria-label="Search facilities" placeholder="Search facilities" value={q} onValueChange={setQ} size="lg" radius="full" isClearable onClear={() => setQ("")}
             startContent={<Search size={17} className="text-muted shrink-0" aria-hidden />}
             classNames={{ inputWrapper: "bg-surface shadow-none h-12 px-5 dark:border dark:border-hairline data-[hover=true]:bg-surface group-data-[focus=true]:bg-surface", input: "text-[15px] placeholder:text-muted" }} />
      <Card padding="none" className="overflow-hidden">
        {isLoading ? <div className="p-6"><Skeleton variant="list" rows={6} label="Loading facilities" /></div> : (
          <motion.ul className="max-h-[62vh] overflow-auto p-3" variants={stagger(0.02)} initial={reduce ? false : "hidden"} animate="show" aria-label="Facilities">
            {rows.slice(0, 80).map((r) => (
              <motion.li key={r.location_id} variants={itemEnter}>
                <button onClick={() => setFacility(r.location_id, r.name)}
                        className="group w-full min-h-[64px] flex items-center gap-4 px-4 py-2.5 text-left rounded-tile hover:bg-tile focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand transition-colors">
                  <span className="w-10 h-10 shrink-0 rounded-full border border-hairline text-ink grid place-items-center bg-surface" aria-hidden><Building2 size={17} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[15px] leading-5 font-semibold text-ink truncate">{r.name.replace(" (Synthetic)", "")}</span>
                    <span className="flex items-center gap-3 text-label font-normal text-muted mt-0.5 min-w-0">
                      <span className="truncate">{typeLabel(r.facility_type)}</span>
                      <span className="shrink-0">{r.district_code}</span>
                    </span>
                  </span>
                  <span className="hidden sm:flex flex-col items-end w-24 shrink-0" title="GI-cohort patients">
                    <span className="text-[15px] leading-5 font-medium text-ink tabular">{int(r.cohort_patients)}</span>
                    <span className="text-micro text-muted">patients</span>
                  </span>
                  <span className="flex flex-col items-end w-20 shrink-0">
                    {r.high_alerts ? (
                      <>
                        <span className="text-[15px] leading-5 font-medium text-ink tabular">{int(r.high_alerts)}</span>
                        <span className="text-micro text-muted">high alerts</span>
                      </>
                    ) : <span className="text-micro text-muted">No high alerts</span>}
                  </span>
                  <ChevronRight size={16} className="text-faint group-hover:text-ink transition-colors shrink-0" aria-hidden />
                </button>
              </motion.li>
            ))}
            {!rows.length && <li className="p-8 text-center text-label text-muted">No facility matches</li>}
          </motion.ul>
        )}
      </Card>
    </div>
  );
}
