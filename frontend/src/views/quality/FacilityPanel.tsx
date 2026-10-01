import { useMemo } from "react";
import { motion } from "framer-motion";
import { AnimatedNumber, DeltaChip, StatTile } from "@/components/ui";
import { EASE } from "@/lib/motion";
import { fmt, int, pct } from "@/lib/format";
import { cleanName, Empty, usePalette } from "./kit";
import { FACILITY_TYPE, PROVINCE, TIER_LABEL, type FacilityQ } from "./types";
import { FlagChip, tierColor, type TierMode } from "./FunnelPlot";

/** Click-through panel for one facility on the funnel plot. */
export function FacilityPanel({ rows, selected, onSelect, tierMode }: {
  rows: FacilityQ[]; selected: number | null; onSelect: (id: number) => void; tierMode: TierMode;
}) {
  const { series: S, ink: k } = usePalette();
  const f = rows.find((r) => r.location_id === selected) ?? null;
  const options = useMemo(() => [...rows].sort((a, b) => cleanName(a.name).localeCompare(cleanName(b.name))), [rows]);
  const national = useMemo(() => {
    const w = rows.filter((r) => r.pct_stage4 !== null && r.n_cases > 0);
    const n = w.reduce((s, r) => s + r.n_cases, 0);
    const iv = n ? w.reduce((s, r) => s + (r.pct_stage4 ?? 0) * r.n_cases, 0) / n : null;
    const di = rows.map((r) => r.median_diag_interval).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return { stage4: iv, interval: di.length ? di[Math.floor(di.length / 2)] : null };
  }, [rows]);
  return (
    <div className="flex flex-col gap-3 h-full">
      <select className="bg-tile rounded-full px-4 h-10 text-[14px] text-ink w-full outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal cursor-pointer" value={selected ?? ""}
              onChange={(e) => onSelect(Number(e.target.value))} aria-label="Select facility">
        {!f && <option value="">Select a dot or choose a facility</option>}
        {options.map((o) => <option key={o.location_id} value={o.location_id}>{cleanName(o.name)}</option>)}
      </select>
      {!f ? <Empty h={200}>Select a dot on the funnel plot.</Empty> : (
        <motion.div className="flex flex-col gap-4" key={f.location_id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE }}>
          <div className="mt-1">
            <h3 className="text-[20px] leading-7 font-semibold tracking-[-0.01em]">{cleanName(f.name)}</h3>
            <div className="text-label font-normal text-muted flex flex-wrap items-center gap-x-3 mt-0.5">
              <span>{FACILITY_TYPE[f.facility_type] ?? f.facility_type}</span><span>{f.district_code}</span><span>{PROVINCE[f.province_code] ?? f.province_code}</span></div>
            <div className="mt-3 flex flex-wrap items-center gap-3"><FlagChip flag={f.outlier_flag} />{f.n_cases < 20 && <span className="text-micro text-muted" title="Fewer than 20 cancers first presented here, so stage and interval figures are imprecise.">Small numbers</span>}</div>
          </div>
          <div>
            <div className="flex items-baseline gap-1.5">
              <AnimatedNumber value={f.hp_test_rate === null ? null : 100 * f.hp_test_rate} format={(n) => `${Math.round(n)}%`} className="text-display tabular" />
              <span className="text-[15px] text-muted tabular">tested</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-label font-normal text-muted tabular">
              <span>{int(f.n_hp_tested)} of {int(f.n_dyspepsia)} dyspepsia patients</span>
              <DeltaChip className="!font-normal" delta={{ text: f.hp_test_rate === null ? "—" : `${fmt(100 * (f.hp_test_rate - f.target_rate), 0)} pts vs national ${pct(f.target_rate, 0, 100)}`,
                dir: f.hp_test_rate === null ? 0 : f.hp_test_rate > f.target_rate ? 1 : -1, tone: f.hp_test_rate === null ? "neutral" : f.hp_test_rate >= f.target_rate ? "good" : "bad" }} />
            </div>
            <Bullet f={f} color={tierColor(f[tierMode], S, k.muted)} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <StatTile label="Cancers first seen" value={f.n_cases} />
            <StatTile label="Stage IV" value={f.pct_stage4 === null ? "—" : `${fmt(f.pct_stage4, 0)}%`} info={`Share of known-stage cancers. All facilities: ${fmt(national.stage4, 0)}%.`} />
            <StatTile label="Diagnostic interval" value={f.median_diag_interval === null ? "—" : fmt(f.median_diag_interval / 30.44, 1)} unit="mo" info={`Median, from first GI symptom to diagnosis. Median across facilities: ${fmt((national.interval ?? 0) / 30.44, 1)} months.`} />
            <StatTile label="Testing tier" value={<span className="inline-flex items-center gap-1.5 capitalize"><span className="w-2.5 h-2.5 rounded-full" style={{ background: tierColor(f.tier, S, k.muted) }} />{f.tier ?? "—"}</span>}
                      info={`${TIER_LABEL[f.tier ?? ""] ?? "Unknown"} facility. ${f.derived_tier && f.derived_tier !== f.tier ? `Observed tertile: ${f.derived_tier}.` : "Matches the observed tertile."}`} />
          </div>
        </motion.div>
      )}
    </div>
  );
}

/** One-row slice of the funnel at this facility's volume: 99.8% / 95% bands around the national rate, facility dot. */
function Bullet({ f, color }: { f: FacilityQ; color: string }) {
  const W = 300, H = 40, pad = 8, x = (v: number) => pad + Math.max(0, Math.min(1, v)) * (W - 2 * pad);
  const r = f.hp_test_rate ?? 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full mt-2" style={{ height: H }} role="img"
         aria-label={`Testing rate ${pct(r, 0, 100)} against 95% limits ${pct(f.funnel_lower95, 0, 100)} to ${pct(f.funnel_upper95, 0, 100)}`}>
      <title>{`${pct(r, 1, 100)} vs national ${pct(f.target_rate, 1, 100)}; 95% limits ${pct(f.funnel_lower95, 1, 100)}–${pct(f.funnel_upper95, 1, 100)}, 99.8% limits ${pct(f.funnel_lower998, 1, 100)}–${pct(f.funnel_upper998, 1, 100)}`}</title>
      <line x1={pad} x2={W - pad} y1={14} y2={14} stroke="rgb(var(--hairline))" strokeWidth={1} />
      <rect x={x(f.funnel_lower998)} width={x(f.funnel_upper998) - x(f.funnel_lower998)} y={9} height={10} rx={5} fill="rgb(var(--muted))" opacity={0.14} />
      <rect x={x(f.funnel_lower95)} width={x(f.funnel_upper95) - x(f.funnel_lower95)} y={9} height={10} rx={5} fill="rgb(var(--muted))" opacity={0.24} />
      <line x1={x(f.target_rate)} x2={x(f.target_rate)} y1={5} y2={23} stroke="rgb(var(--ink))" strokeWidth={1.5} />
      <circle cx={x(r)} cy={14} r={5} fill={color} stroke="rgb(var(--surface))" strokeWidth={2} />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x={x(t)} y={H - 3} fontSize={10} fill="rgb(var(--muted))" textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}>{t * 100}%</text>)}
    </svg>
  );
}
