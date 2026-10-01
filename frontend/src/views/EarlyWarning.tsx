import { motion } from "framer-motion";
import { Clock, Pill, Repeat, Siren } from "lucide-react";
import { BentoGrid, GradientRangeBar, GridItem, MetricCard, PageHeader } from "@/components/ui";
import { DotMatrix } from "@/components/charts/DotMatrix";
import { fmt } from "@/lib/format";
import { EASE } from "@/lib/motion";
import { usePalette } from "./trends/kit";
import { SummaryRow, useCurves, useOr } from "./warning/api";
import { CascadePanel } from "./warning/CascadePanel";
import { CurvesPanel } from "./warning/CurvesPanel";
import { ForestPanel } from "./warning/ForestPanel";
import { IntervalPanel } from "./warning/IntervalPanel";
import { HelixPanel } from "./warning/HelixPanel";

/** V4 Early Warning — missed signals (SPEC §16.3): cascade, aligned pre-diagnostic curves, signal ORs, diagnostic interval, journey helix. */
export default function EarlyWarning() {
  return (
    <div className="flex flex-col gap-5 min-w-0" data-testid="early-warning">
      <PageHeader icon={<Siren size={18} />} title="The signals were there months before diagnosis"
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
  const cv = useCurves();
  const pal = usePalette();
  const s: SummaryRow[] = ((or.data as any)?.summary ?? []) as SummaryRow[];
  const v = (k: string) => s.find((x) => x.metric === k);
  const ge3 = v("pct_ge3_gi_visits_24m"), ppi = v("pct_ge2_ppi_no_scope"), med = v("median_diag_interval_months"), alarm = v("pct_alarm45_no_scope_90d_among_alarm");
  // monthly GI visits among future cases, 24 months before diagnosis -> the dot matrix
  const gi = (cv.data?.data ?? []).filter((r) => r.metric === "gi_visits" && r.group === "case" && r.month_before < 0).sort((a, b) => a.month_before - b.month_before);
  const C: [string, string] = [pal.series[0], pal.ink.muted];
  // the malaria-endemic gap is shown with the diagnostic interval card below
  return (
    <BentoGrid>
      <GridItem span={{ md: 4 }}>
        <MetricCard label="GI visits before diagnosis" icon={<Repeat size={15} />}
          value={ge3?.case != null ? `${fmt(ge3.case, 0)}%` : "—"} unit="had 3 or more"
          info={<>{ge3?.case != null && ge3.control != null ? <>{fmt(ge3.case, 0)}% of cases had 3 or more GI visits in the 24 months before diagnosis, against {fmt(ge3.control, 0)}% of matched controls. </> : null}The dots show GI visits per 100 future cases in each month, from 24 months before diagnosis to the last month.</>}
          aside={ge3?.control != null ? `Controls ${fmt(ge3.control, 0)}%` : undefined}>
          {gi.length > 1 && (
            <div className="mt-5">
              <DotMatrix values={gi.map((r) => r.value)} labels={gi.map((r) => `${Math.abs(r.month_before)} months before`)} ariaLabel="GI visits per 100 future cases, by month before diagnosis"
                         rows={6} height={124} format={(n) => fmt(n, 1)} unit="per 100" ticks={["24 months", "12", "Diagnosis"]} />
            </div>
          )}
        </MetricCard>
      </GridItem>
      <GridItem span={{ md: 4 }}>
        <MetricCard label="Repeat PPIs, never scoped" icon={<Pill size={15} />}
          value={ppi?.case != null ? `${fmt(ppi.case, 0)}%` : "—"} unit="of cases"
          info={alarm?.case != null ? <>Two or more PPI courses without an endoscopy. {fmt(alarm.case, 0)}% of patients aged 45 and over with an alarm feature were not scoped within 90 days.</> : "Two or more PPI courses without an endoscopy"}>
          <div className="pt-6">
            {ppi?.case != null && ppi.control != null && <CompareBars a={["Cases", ppi.case]} b={["Controls", ppi.control]} colors={C} fmtV={(x) => `${fmt(x, 0)}%`} max={100} />}
            {ppi?.case != null && ppi.control == null && alarm?.case != null && <CompareBars a={["Alarm, 45+", alarm.case]} colors={C} fmtV={(x) => `${fmt(x, 0)}%`} max={100} />}
          </div>
        </MetricCard>
      </GridItem>
      <GridItem span={{ md: 4 }}>
        <MetricCard label="Median diagnostic interval" icon={<Clock size={15} />}
          value={med?.case != null ? fmt(med.case, 1) : "—"} unit="months" info="From the first GI symptom to diagnosis (cases with a GI symptom in the preceding 24 months).">
          {med?.case != null && <div className="pt-6"><GradientRangeBarLite value={med.case} /></div>}
        </MetricCard>
      </GridItem>
    </BentoGrid>
  );
}

function GradientRangeBarLite({ value }: { value: number }) {
  return <GradientRangeBar value={value} min={0} max={12} minLabel="0" maxLabel="12 months" tone="sky" label="Median diagnostic interval, 0 to 12 months" />;
}

/** Two thin bars on one scale (cases vs controls): 6px grey track, one solid fill each. */
function CompareBars({ a, b, colors, fmtV, max }: { a: [string, number]; b?: [string, number]; colors: [string, string]; fmtV: (n: number) => string; max?: number }) {
  const top = max ?? Math.max(a[1], b?.[1] ?? 0, 1e-9);
  const row = ([label, v]: [string, number], c: string) => (
    <div className="flex items-center gap-3 text-label font-normal text-muted">
      <span className="w-[64px] shrink-0 truncate">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-tile dark:bg-hairline overflow-hidden">
        <motion.div className="h-full rounded-full" style={{ background: c }} initial={{ width: 0 }} animate={{ width: `${Math.min(100, (100 * v) / top)}%` }} transition={{ duration: 0.8, ease: EASE }} />
      </div>
      <span className="w-10 text-right tabular text-ink">{fmtV(v)}</span>
    </div>
  );
  return <div className="flex flex-col gap-2.5" role="img" aria-label={`${a[0]} ${fmtV(a[1])}${b ? `, ${b[0]} ${fmtV(b[1])}` : ""}`}>{row(a, colors[0])}{b && row(b, colors[1])}</div>;
}
