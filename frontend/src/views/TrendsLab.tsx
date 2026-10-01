import { useMemo } from "react";
import { Activity, Layers, TrendingUp, Users } from "lucide-react";
import { fmt, signed } from "@/lib/format";
import { useFilters } from "@/state/filters";
import { StatTile, ViewHeader } from "./trends/kit";
import { useJp, useNationalRates } from "./trends/api";
import { AsrPanel } from "./trends/AsrPanel";
import { JoinpointPanel } from "./trends/JoinpointPanel";
import { AgeContrastPanel } from "./trends/AgeContrastPanel";
import { CrudeVsAsrPanel } from "./trends/CrudeVsAsrPanel";
import { LandscapePanel } from "./trends/LandscapePanel";

/** V3 Trends Lab (SPEC §16.3): multi-series ASR, joinpoint, 3D rate landscape, crude-vs-ASR (INS-2, INS-5, INS-7). */
export default function TrendsLab() {
  return (
    <div className="flex flex-col gap-4 max-w-[1500px] mx-auto" data-testid="trends-lab">
      <ViewHeader eyebrow="V3 · Trends Lab" title="Is gastric cancer rising — and for whom?"
        lede={<>Age-standardised rates per person-year, so that the EMR roll-out and an ageing population don't masquerade as risk. Joinpoint regression finds where trends bend.</>} />
      <Headline />
      <AsrPanel />
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <JoinpointPanel />
        <AgeContrastPanel />
      </div>
      <LandscapePanel />
      <CrudeVsAsrPanel />
    </div>
  );
}

function Headline() {
  const f = useFilters();
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
  return (
    <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
      <StatTile label="Under-50 trend" icon={<TrendingUp size={12} aria-hidden />} tone={ys?.significant && ys.apc > 0 ? "warn" : "neutral"}
        value={ys ? signed(ys.apc, 1, "%") : "—"} unit="per year"
        sub={ys ? <>since {ys.start_year} · 95% CI {fmt(ys.apc_lci, 1)} to {fmt(ys.apc_uci, 1)}</> : "Joinpoint, national <50"} />
      <StatTile label="65+ trend" icon={<Users size={12} aria-hidden />} tone={os?.significant ? "warn" : "neutral"}
        value={os ? signed(os.apc, 1, "%") : "—"} unit="per year"
        sub={os ? <>{os.start_year}–{os.end_year} · {os.significant ? "significant" : "CI includes 0"} [{fmt(os.apc_lci, 1)}, {fmt(os.apc_uci, 1)}]</> : "Joinpoint, national 65+"} />
      <StatTile label="Cases 2015 → 2019" icon={<Layers size={12} aria-hidden />} tone="neutral"
        value={crude ? `×${fmt(crude.cases, 1)}` : "—"}
        sub={crude ? <>while the ASR moved {signed(crude.asr, 0, "%")} — EMR roll-out, not risk</> : "Crude counts vs ASR"} />
      <StatTile label={`National ASR ${lastFull?.year ?? ""}`} icon={<Activity size={12} aria-hidden />} tone="neutral"
        value={lastFull ? fmt(lastFull.asr, 1) : "—"} unit="per 100k"
        sub={lastFull ? <>95% CI {fmt(lastFull.lci, 1)}–{fmt(lastFull.uci, 1)} · AAPC {signed(nat?.aapc_last10.value, 1, "%")}</> : "World standard population"} />
    </div>
  );
}
