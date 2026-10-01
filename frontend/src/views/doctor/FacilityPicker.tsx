import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { Building2, ChevronRight, Hospital, Search, Users } from "lucide-react";
import { get } from "@/api/client";
import { Card, PageHeader, Skeleton, StatusChip } from "@/components/ui";
import { useRole } from "@/state/role";
import { int } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";

const ABOUT = "The doctor view shows patient-level data for one facility: its own patients, its health centres if it is a district hospital, and patients seen there for stomach complaints in the last 2 years.";

/** Facility chooser for the doctor role (search + list of facilities with their GI cohort and HIGH alerts). */
export function FacilityPicker() {
  const setFacility = useRole((s) => s.setFacility);
  const [q, setQ] = useState("");
  const reduce = useReducedMotion();
  const { data, isLoading } = useQuery({ queryKey: ["alerts", "facility-summary"], queryFn: () => get<any[]>("/facilities/alert-summary") });
  const all = data?.data ?? [];
  const rows = useMemo(() => all.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())), [all, q]);
  const totals = useMemo(() => ({ n: all.length, high: all.reduce((s, r) => s + (r.high_alerts ?? 0), 0) }), [all]);
  return (
    <div className="max-w-3xl mx-auto mt-8 flex flex-col gap-4">
      <PageHeader eyebrow="Doctor workspace" title="Choose your facility" icon={<Hospital size={20} />} info={ABOUT}
                  right={totals.n ? (
                    <div className="flex items-center gap-2">
                      <StatusChip status="info" size="md" icon={<Building2 size={12} aria-hidden />} label={`${int(totals.n)} facilities`} />
                      <StatusChip status="critical" size="md" label={`${int(totals.high)} HIGH alerts`} />
                    </div>
                  ) : undefined} />
      <Input aria-label="Search facilities" placeholder="Search facilities…" value={q} onValueChange={setQ} size="lg" radius="full" isClearable onClear={() => setQ("")}
             startContent={<Search size={17} className="text-fg-muted" aria-hidden />}
             classNames={{ inputWrapper: "bg-surface border border-border shadow-card data-[hover=true]:bg-surface group-data-[focus=true]:bg-surface", input: "text-[14px]" }} />
      <Card padding="none" className="overflow-hidden">
        {isLoading ? <div className="p-5"><Skeleton variant="list" rows={6} label="Loading facilities" /></div> : (
          <motion.ul className="max-h-[62vh] overflow-auto p-2" variants={stagger(0.025)} initial={reduce ? false : "hidden"} animate="show" aria-label="Facilities">
            {rows.slice(0, 80).map((r) => (
              <motion.li key={r.location_id} variants={itemEnter}>
                <button onClick={() => setFacility(r.location_id, r.name)}
                        className="group w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-tile hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors">
                  <span className="w-9 h-9 shrink-0 rounded-[11px] grid place-items-center bg-accent-soft text-accent" aria-hidden><Building2 size={17} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14px] font-medium text-fg truncate">{r.name.replace(" (Synthetic)", "")}</span>
                    <span className="block text-micro text-fg-muted capitalize">{String(r.facility_type).toLowerCase().replace("_", " ")} · {r.district_code}</span>
                  </span>
                  <span className="hidden sm:inline-flex items-center gap-1 text-label text-fg-muted tabular w-28 justify-end" title="GI-cohort patients">
                    <Users size={13} aria-hidden />{int(r.cohort_patients)}
                  </span>
                  <span className="w-28 flex justify-end">
                    {r.high_alerts ? <StatusChip status="critical" label={`${int(r.high_alerts)} HIGH`} /> : <span className="text-micro text-fg-muted">no HIGH alerts</span>}
                  </span>
                  <ChevronRight size={16} className="text-fg-muted/60 group-hover:text-fg transition-colors" aria-hidden />
                </button>
              </motion.li>
            ))}
            {!rows.length && <li className="p-8 text-center text-label text-fg-muted">No facility matches</li>}
          </motion.ul>
        )}
      </Card>
    </div>
  );
}
