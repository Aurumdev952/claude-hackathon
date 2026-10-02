import { Activity, TrendingUp, Users } from "lucide-react";
import type { Segment } from "@/api/types";
import { BentoGrid, GridItem, MetricCard, PageHeader, type StatusKind } from "@/components/ui";
import { fmt, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { usePalette } from "./trends/kit";
import { useJp } from "./trends/api";
import { AsrPanel } from "./trends/AsrPanel";
import { JoinpointPanel } from "./trends/JoinpointPanel";
import { AgeContrastPanel } from "./trends/AgeContrastPanel";
import { CrudeVsAsrPanel } from "./trends/CrudeVsAsrPanel";
import { LandscapePanel } from "./trends/LandscapePanel";

/** V3 Trends Lab (SPEC §16.3): multi-series ASR, joinpoint, 3D rate landscape, crude-vs-ASR (INS-2, INS-5, INS-7). */
export default function TrendsLab() {
  return (
    <div className="flex flex-col gap-5 min-w-0" data-testid="trends-lab">
      <PageHeader icon={<TrendingUp size={18} />} title="Is gastric cancer rising, and for whom?"
        info={<>Age-standardised rates per person-year, so that the EMR roll-out and an ageing population don't masquerade as risk. Joinpoint regression finds where trends bend.</>} />
      <Headline />
      <BentoGrid>
        <GridItem span={12}><AsrPanel /></GridItem>
        <GridItem span={{ lg: 7 }}><JoinpointPanel /></GridItem>
        <GridItem span={{ lg: 5 }}><AgeContrastPanel /></GridItem>
        <GridItem span={12}><LandscapePanel /></GridItem>
        <GridItem span={12}><CrudeVsAsrPanel /></GridItem>
      </BentoGrid>
    </div>
  );
}

/** Trend direction chip: significant rise / fall, else flat (CI includes 0). */
export function trendStatus(s: Pick<Segment, "apc" | "significant"> | undefined | null): { status: StatusKind; label: string } | null {
  if (!s) return null;
  if (!s.significant) return { status: "neutral", label: "Flat" };
  return s.apc > 0 ? { status: "serious", label: "Rising" } : { status: "good", label: "Falling" };
}

const apcRange = (s: Segment | undefined) => s ? {
  value: s.apc, min: -12, max: 12, thresholds: [0], label: "Annual percent change, −12% to +12%", tone: s.significant && s.apc > 0 ? ("signal" as const) : ("sky" as const),
  markers: [{ value: s.apc_lci, label: "95% CI lower" }, { value: s.apc_uci, label: "95% CI upper" }], minLabel: "−12%", maxLabel: "+12%",
} : undefined;

function Headline() {
  const f = useFilters();
  const pal = usePalette();
  const young = useJp(`NATIONAL|ALL|<50|${f.caseDef}`).data?.data;
  const old = useJp(`NATIONAL|ALL|65+|${f.caseDef}`).data?.data;
  const nat = useJp(`NATIONAL|ALL|ALL|${f.caseDef}`).data?.data;
  const ys = young?.segments[young.segments.length - 1];
  const os = old?.segments[old.segments.length - 1];
  const lastFull = (nat?.observed ?? []).filter((o) => !o.partial_year).slice(-1)[0];
  const aapc = nat?.aapc_last10.value ?? null;
  // the cases-vs-rate comparison lives in the "Crude counts vs age-standardised rate" card below
  return (
    <BentoGrid role="list" aria-label="Trend headlines">
      <GridItem span={{ md: 4 }} role="listitem">
        <MetricCard label="Under-50 trend" icon={<TrendingUp size={15} />}
          value={ys ? signed(ys.apc, 1, "%") : "—"} unit="per year" status={trendStatus(ys)} aside={ys ? `Since ${ys.start_year}` : undefined}
          range={apcRange(ys)} info={ys ? <>Joinpoint, national under 50, latest segment since {ys.start_year}; 95% CI {fmt(ys.apc_lci, 1)} to {fmt(ys.apc_uci, 1)}.</> : "Joinpoint, national under 50"} />
      </GridItem>
      <GridItem span={{ md: 4 }} role="listitem">
        <MetricCard label="65 and over trend" icon={<Users size={15} />}
          value={os ? signed(os.apc, 1, "%") : "—"} unit="per year" status={trendStatus(os)} aside={os ? `${os.start_year}–${os.end_year}` : undefined}
          range={apcRange(os)} info={os ? <>Joinpoint, national 65 and over, {os.start_year}–{os.end_year}; {os.significant ? "significant" : "the CI includes 0"} ({fmt(os.apc_lci, 1)} to {fmt(os.apc_uci, 1)}).</> : "Joinpoint, national 65 and over"} />
      </GridItem>
      <GridItem span={{ md: 4 }} role="listitem">
        <MetricCard label={lastFull ? `National ASR ${lastFull.year}` : "National ASR"} icon={<Activity size={15} />}
          value={lastFull ? fmt(lastFull.asr, 1) : "—"} unit="per 100k"
          delta={aapc !== null ? { text: `${signed(aapc, 1, "%")} a year over 10 years`, dir: aapc > 0.5 ? 1 : aapc < -0.5 ? -1 : 0, tone: "neutral" } : null}
          spark={(nat?.observed ?? []).filter((o) => !o.partial_year).map((o) => o.asr)} sparkColor={pal.series[0]}
          info={lastFull ? <>World standard population; 95% CI {fmt(lastFull.lci, 1)}–{fmt(lastFull.uci, 1)}. Average annual change over the last 10 years {signed(aapc, 1, "%")} ({fmt(nat?.aapc_last10.lci, 1)} to {fmt(nat?.aapc_last10.uci, 1)}).</> : "World standard population"} />
      </GridItem>
    </BentoGrid>
  );
}
