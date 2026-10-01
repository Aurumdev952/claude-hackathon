import { useMemo } from "react";
import { Activity, Layers, TrendingUp, Users } from "lucide-react";
import type { Segment } from "@/api/types";
import { BentoGrid, GridItem, MetricCard, PageHeader, type StatusKind } from "@/components/ui";
import { fmt, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { usePalette } from "./trends/kit";
import { useJp, useNationalRates } from "./trends/api";
import { AsrPanel } from "./trends/AsrPanel";
import { JoinpointPanel } from "./trends/JoinpointPanel";
import { AgeContrastPanel } from "./trends/AgeContrastPanel";
import { CrudeVsAsrPanel } from "./trends/CrudeVsAsrPanel";
import { LandscapePanel } from "./trends/LandscapePanel";

/** V3 Trends Lab (SPEC §16.3): multi-series ASR, joinpoint, 3D rate landscape, crude-vs-ASR (INS-2, INS-5, INS-7). */
export default function TrendsLab() {
  return (
    <div className="flex flex-col gap-4 min-w-0" data-testid="trends-lab">
      <PageHeader icon={<TrendingUp size={18} />} title="Is gastric cancer rising — and for whom?"
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
  value: s.apc, min: -12, max: 12, thresholds: [0], label: "Annual percent change, −12% to +12%",
  markers: [{ value: s.apc_lci, label: "95% CI lower" }, { value: s.apc_uci, label: "95% CI upper" }], minLabel: "−12%", maxLabel: "+12%",
} : undefined;

function Headline() {
  const f = useFilters();
  const pal = usePalette();
  const young = useJp(`NATIONAL|ALL|<50|${f.caseDef}`).data?.data;
  const old = useJp(`NATIONAL|ALL|65+|${f.caseDef}`).data?.data;
  const nat = useJp(`NATIONAL|ALL|ALL|${f.caseDef}`).data?.data;
  const rates = useNationalRates("ALL", "ALL", f.caseDef).data?.data;
  const ys = young?.segments[young.segments.length - 1];
  const os = old?.segments[old.segments.length - 1];
  const crude = useMemo(() => {
    const r = (rates ?? []).filter((x) => !x.partial_year);
    const a = r.find((x) => x.period === "2015"), b = r.find((x) => x.period === "2019");
    return a?.cases && b?.cases && a.asr && b.asr ? { cases: b.cases / a.cases, asr: (100 * (b.asr - a.asr)) / a.asr } : null;
  }, [rates]);
  const lastFull = (nat?.observed ?? []).filter((o) => !o.partial_year).slice(-1)[0];
  const aapc = nat?.aapc_last10.value ?? null;
  return (
    <BentoGrid>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="Under-50 trend" icon={<TrendingUp size={15} />} iconTone={ys?.significant && ys.apc > 0 ? "warning" : "accent"}
          value={ys ? signed(ys.apc, 1, "%") : "—"} unit="per year" status={trendStatus(ys)} aside={ys ? `since ${ys.start_year}` : undefined}
          range={apcRange(ys)} info={ys ? <>Joinpoint, national under 50, latest segment since {ys.start_year} · 95% CI {fmt(ys.apc_lci, 1)} to {fmt(ys.apc_uci, 1)}.</> : "Joinpoint, national <50"} />
      </GridItem>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="65+ trend" icon={<Users size={15} />} iconTone={os?.significant ? "warning" : "accent"}
          value={os ? signed(os.apc, 1, "%") : "—"} unit="per year" status={trendStatus(os)} aside={os ? `${os.start_year}–${os.end_year}` : undefined}
          range={apcRange(os)} info={os ? <>Joinpoint, national 65+, {os.start_year}–{os.end_year} · {os.significant ? "significant" : "CI includes 0"} [{fmt(os.apc_lci, 1)}, {fmt(os.apc_uci, 1)}].</> : "Joinpoint, national 65+"} />
      </GridItem>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label="Cases 2015 → 2019" icon={<Layers size={15} />}
          value={crude ? `×${fmt(crude.cases, 1)}` : "—"} status={crude ? { status: "info", label: "EMR roll-out" } : null}
          delta={crude ? { text: `ASR ${signed(crude.asr, 0, "%")}`, dir: crude.asr > 2 ? 1 : crude.asr < -2 ? -1 : 0, tone: "neutral" } : null}
          info={crude ? <>Recorded cases multiplied by {fmt(crude.cases, 1)} while the ASR moved {signed(crude.asr, 0, "%")} — EMR roll-out, not risk.</> : "Crude counts vs ASR"}>
          {crude && <CasesVsAsrBars cases={crude.cases} asr={1 + crude.asr / 100} colors={[pal.series[0], pal.series[2]]} />}
        </MetricCard>
      </GridItem>
      <GridItem span={{ sm: 6, xl: 3 }}>
        <MetricCard label={`National ASR ${lastFull?.year ?? ""}`} icon={<Activity size={15} />}
          value={lastFull ? fmt(lastFull.asr, 1) : "—"} unit="per 100k"
          delta={aapc !== null ? { text: `AAPC ${signed(aapc, 1, "%")}`, dir: aapc > 0.5 ? 1 : aapc < -0.5 ? -1 : 0, tone: "neutral" } : null}
          spark={(nat?.observed ?? []).filter((o) => !o.partial_year).map((o) => o.asr)} sparkColor={pal.series[0]}
          info={lastFull ? <>World standard population · 95% CI {fmt(lastFull.lci, 1)}–{fmt(lastFull.uci, 1)} · AAPC over the last 10 years {signed(aapc, 1, "%")} [{fmt(nat?.aapc_last10.lci, 1)}, {fmt(nat?.aapc_last10.uci, 1)}].</> : "World standard population"} />
      </GridItem>
    </BentoGrid>
  );
}

/** Two horizontal bars on one scale: how much counts grew vs how much the rate moved. */
function CasesVsAsrBars({ cases, asr, colors }: { cases: number; asr: number; colors: [string, string] }) {
  const max = Math.max(cases, asr, 1);
  const row = (label: string, v: number, c: string) => (
    <div className="flex items-center gap-2 text-micro text-fg-muted">
      <span className="w-10 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full origin-left animate-[rise_.6s_ease-out_both]" style={{ width: `${(100 * v) / max}%`, background: c }} />
      </div>
      <span className="w-9 text-right tabular text-fg">×{fmt(v, v >= 10 ? 0 : 1)}</span>
    </div>
  );
  return <div className="mt-3 flex flex-col gap-1.5" aria-hidden>{row("Cases", cases, colors[0])}{row("ASR", asr, colors[1])}</div>;
}
