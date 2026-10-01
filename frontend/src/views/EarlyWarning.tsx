import { Clock, MapPin, Pill, Repeat } from "lucide-react";
import { fmt } from "@/lib/format";
import { StatTile, ViewHeader } from "./trends/kit";
import { DAYS_PER_MONTH, SummaryRow, useIntervals, useOr } from "./warning/api";
import { CascadePanel } from "./warning/CascadePanel";
import { CurvesPanel } from "./warning/CurvesPanel";
import { ForestPanel } from "./warning/ForestPanel";
import { IntervalPanel } from "./warning/IntervalPanel";
import { HelixPanel } from "./warning/HelixPanel";

/** V4 Early Warning — missed signals (SPEC §16.3): cascade, aligned pre-diagnostic curves, signal ORs, diagnostic interval, journey helix. */
export default function EarlyWarning() {
  return (
    <div className="flex flex-col gap-4 max-w-[1500px] mx-auto" data-testid="early-warning">
      <ViewHeader eyebrow="V4 · Early Warning" title="The signals were there — months before diagnosis"
        lede={<>Patients who went on to be diagnosed with gastric cancer kept coming back with stomach complaints, falling haemoglobin and repeat acid-suppressant prescriptions. Compared with matched patients who did not develop cancer, the gap opens a year or more before anyone scoped them.</>} />
      <Headline />
      <CascadePanel />
      <CurvesPanel />
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
        <ForestPanel />
        <IntervalPanel />
      </div>
      <HelixPanel />
    </div>
  );
}

function Headline() {
  const or = useOr();
  const iv = useIntervals();
  const s: SummaryRow[] = ((or.data as any)?.summary ?? []) as SummaryRow[];
  const v = (k: string) => s.find((x) => x.metric === k);
  const ge3 = v("pct_ge3_gi_visits_24m"), ppi = v("pct_ge2_ppi_no_scope"), med = v("median_diag_interval_months"), alarm = v("pct_alarm45_no_scope_90d_among_alarm");
  const mal = (iv.data?.data ?? []).filter((r) => r.group_var === "malaria_region");
  const e = mal.find((r) => r.group === "malaria_endemic"), o = mal.find((r) => r.group === "other");
  const gap = e && o ? (e.median_days - o.median_days) / DAYS_PER_MONTH : null;
  return (
    <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
      <StatTile label="≥3 GI visits before dx" icon={<Repeat size={12} aria-hidden />} tone="warn"
        value={ge3?.case != null ? `${fmt(ge3.case, 0)}%` : "—"} unit="of cases"
        sub={ge3?.control != null ? <>vs {fmt(ge3.control, 0)}% of matched controls, 24 months before</> : "24 months before diagnosis"} />
      <StatTile label="Repeat PPIs, never scoped" icon={<Pill size={12} aria-hidden />} tone="warn"
        value={ppi?.case != null ? `${fmt(ppi.case, 0)}%` : "—"} unit="of cases"
        sub={alarm?.case != null ? <>≥2 PPI courses without endoscopy · {fmt(alarm.case, 0)}% of 45+ with an alarm feature not scoped in 90 days</> : "≥2 PPI courses without endoscopy"} />
      <StatTile label="Median diagnostic interval" icon={<Clock size={12} aria-hidden />} tone="neutral"
        value={med?.case != null ? fmt(med.case, 1) : "—"} unit="months"
        sub="First GI symptom → diagnosis" />
      <StatTile label="Malaria-endemic provinces" icon={<MapPin size={12} aria-hidden />} tone="warn"
        value={gap !== null ? `+${fmt(gap, 1)}` : "—"} unit="months longer"
        sub="Eastern + Southern: anaemia treated as malaria or worms first" />
    </div>
  );
}
