import { motion } from "framer-motion";
import { Clock, MapPin, Pill, Repeat, Siren } from "lucide-react";
import { BentoGrid, GridItem, MetricCard, PageHeader } from "@/components/ui";
import { fmt } from "@/lib/format";
import { EASE } from "@/lib/motion";
import { usePalette } from "./trends/kit";
import { DAYS_PER_MONTH, SummaryRow, useIntervals, useOr } from "./warning/api";
import { CascadePanel } from "./warning/CascadePanel";
import { CurvesPanel } from "./warning/CurvesPanel";
import { ForestPanel } from "./warning/ForestPanel";
import { IntervalPanel } from "./warning/IntervalPanel";
import { HelixPanel } from "./warning/HelixPanel";

/** V4 Early Warning — missed signals (SPEC §16.3): cascade, aligned pre-diagnostic curves, signal ORs, diagnostic interval, journey helix. */
export default function EarlyWarning() {
  return (
    <div className="flex flex-col gap-4 min-w-0" data-testid="early-warning">
      <PageHeader icon={<Siren size={18} />} title="The signals were there — months before diagnosis"
        info={<>Patients who went on to be diagnosed with gastric cancer kept coming back with stomach complaints, falling haemoglobin and repeat acid-suppressant prescriptions. Compared with matched patients who did not develop cancer, the gap opens a year or more before anyone scoped them.</>} />
      <Headline />
      <BentoGrid>
        <GridItem span={12}><CurvesPanel /></GridItem>
        <GridItem span={12}><CascadePanel /></GridItem>
        <GridItem span={{ lg: 6 }}><ForestPanel /></GridItem>
        <GridItem span={{ lg: 6 }}><IntervalPanel /></GridItem>
        <GridItem span={12}><HelixPanel /></GridItem>
      </BentoGrid>
    </div>
  );
}

function Headline() {
  const or = useOr();
  const iv = useIntervals();
  const pal = usePalette();
  const s: SummaryRow[] = ((or.data as any)?.summary ?? []) as SummaryRow[];
  const v = (k: string) => s.find((x) => x.metric === k);
  const ge3 = v("pct_ge3_gi_visits_24m"), ppi = v("pct_ge2_ppi_no_scope"), med = v("median_diag_interval_months"), alarm = v("pct_alarm45_no_scope_90d_among_alarm");
  const mal = (iv.data?.data ?? []).filter((r) => r.group_var === "malaria_region");
  const e = mal.find((r) => r.group === "malaria_endemic"), o = mal.find((r) => r.group === "other");
  const gap = e && o ? (e.median_days - o.median_days) / DAYS_PER_MONTH : null;
  const C: [string, string] = [pal.series[0], pal.ink.muted];
  return (
    <BentoGrid>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="≥3 GI visits before dx" icon={<Repeat size={15} />} iconTone="warning"
          value={ge3?.case != null ? `${fmt(ge3.case, 0)}%` : "—"} unit="of cases" status={ge3?.case != null ? { status: "warning", label: "Missed signal" } : null}
          info={ge3?.control != null ? <>vs {fmt(ge3.control, 0)}% of matched controls, in the 24 months before diagnosis.</> : "24 months before diagnosis"}>
          {ge3?.case != null && ge3.control != null && <CompareBars a={["Cases", ge3.case]} b={["Controls", ge3.control]} colors={C} fmtV={(x) => `${fmt(x, 0)}%`} max={100} />}
        </MetricCard>
      </GridItem>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="Repeat PPIs, never scoped" icon={<Pill size={15} />} iconTone="warning"
          value={ppi?.case != null ? `${fmt(ppi.case, 0)}%` : "—"} unit="of cases" status={ppi?.case != null ? { status: "warning", label: "≥2 courses" } : null}
          info={alarm?.case != null ? <>≥2 PPI courses without endoscopy. {fmt(alarm.case, 0)}% of patients aged 45+ with an alarm feature were not scoped within 90 days.</> : "≥2 PPI courses without endoscopy"}>
          {ppi?.case != null && ppi.control != null && <CompareBars a={["Cases", ppi.case]} b={["Controls", ppi.control]} colors={C} fmtV={(x) => `${fmt(x, 0)}%`} max={100} />}
          {ppi?.case != null && ppi.control == null && alarm?.case != null && <CompareBars a={["Alarm 45+", alarm.case]} colors={C} fmtV={(x) => `${fmt(x, 0)}%`} max={100} />}
        </MetricCard>
      </GridItem>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="Median diagnostic interval" icon={<Clock size={15} />}
          value={med?.case != null ? fmt(med.case, 1) : "—"} unit="months" info="First GI symptom → diagnosis (cases with a GI symptom in the preceding 24 months)."
          range={med?.case != null ? { value: med.case, min: 0, max: 12, minLabel: "0", maxLabel: "12 mo", label: "Median diagnostic interval, 0 to 12 months" } : undefined} />
      </GridItem>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="Malaria-endemic provinces" icon={<MapPin size={15} />} iconTone="danger"
          value={gap !== null ? `+${fmt(gap, 1)}` : "—"} unit="months longer" status={gap !== null ? { status: "serious", label: "Eastern + Southern" } : null}
          info="Eastern + Southern provinces: anaemia from a bleeding tumour is often treated as malaria or worms first.">
          {e && o && <CompareBars a={["Endemic", e.median_days / DAYS_PER_MONTH]} b={["Other", o.median_days / DAYS_PER_MONTH]} colors={[pal.series[1], pal.ink.muted]} fmtV={(x) => `${fmt(x, 1)} mo`} />}
        </MetricCard>
      </GridItem>
    </BentoGrid>
  );
}

/** Two thin bars on one scale (cases vs controls, endemic vs other). */
function CompareBars({ a, b, colors, fmtV, max }: { a: [string, number]; b?: [string, number]; colors: [string, string]; fmtV: (n: number) => string; max?: number }) {
  const top = max ?? Math.max(a[1], b?.[1] ?? 0, 1e-9);
  const row = ([label, v]: [string, number], c: string) => (
    <div className="flex items-center gap-2 text-micro text-fg-muted">
      <span className="w-[58px] shrink-0 truncate">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
        <motion.div className="h-full rounded-full" style={{ background: c }} initial={{ width: 0 }} animate={{ width: `${Math.min(100, (100 * v) / top)}%` }} transition={{ duration: 0.8, ease: EASE }} />
      </div>
      <span className="w-12 text-right tabular text-fg">{fmtV(v)}</span>
    </div>
  );
  return <div className="mt-3 flex flex-col gap-1.5" role="img" aria-label={`${a[0]} ${fmtV(a[1])}${b ? `, ${b[0]} ${fmtV(b[1])}` : ""}`}>{row(a, colors[0])}{b && row(b, colors[1])}</div>;
}
