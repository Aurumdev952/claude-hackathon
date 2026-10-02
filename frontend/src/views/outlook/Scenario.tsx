import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Button, Select, SelectItem, SelectSection } from "@heroui/react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { AnimatedNumber, Card, InfoHint, Loading, usePortalContainer } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int } from "@/lib/format";
import { HUE, ink } from "@/lib/viz";
import { alpha, bandSeries, chartBase, tipHead, tipRow } from "../trends/kit";
import { useForecastSeries, useOperational, useScenario, type ScenarioIn } from "./api";
import { NatureTag, Swatch } from "./kit";

const PROVINCE: Record<string, string> = { KGL: "Kigali City", NOR: "Northern", SOU: "Southern", EAS: "Eastern", WES: "Western" };
const DEFAULTS = { hp: 0, smoking: 0, salt: 0 };

/** Native range input in the design-v3 look: a 6px grey track filled with sky up to the value, a white thumb with an
 * ink ring (keyboard and screen-reader behaviour of the native control). */
export function RangeSlider({ label, value, min, max, step, onChange, display, hint }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string; hint?: string;
}) {
  const m = useThemeMode();
  const h = HUE[m];
  const t = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-label text-ink">{label}</span>
        <span className="text-[15px] font-medium text-ink tabular">{display}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} aria-valuetext={display}
             onChange={(e) => onChange(Number(e.target.value))}
             style={{ background: `linear-gradient(90deg, ${h.sky} 0 ${t}%, ${m === "dark" ? "#2C313B" : "#E3E5EB"} ${t}% 100%)` }}
             className="mt-2.5 w-full h-1.5 rounded-full appearance-none cursor-pointer focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand
                        [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-solid [&::-webkit-slider-thumb]:border-ink
                        [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-surface [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-solid [&::-moz-range-thumb]:border-ink" />
      {hint && <span className="block text-micro text-muted mt-1.5">{hint}</span>}
    </label>
  );
}

function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** Scenario simulator: H. pylori test-and-treat, smoking and salt reductions and endoscopy access, evaluated by the
 * closed-form covariate model (POST /forecast/scenario, < 300 ms), debounced while sliders move. */
export function ScenarioCard() {
  const portal = usePortalContainer();
  const m = useThemeMode();
  const [hp, setHp] = useState(DEFAULTS.hp);
  const [smoking, setSmoking] = useState(DEFAULTS.smoking);
  const [salt, setSalt] = useState(DEFAULTS.salt);
  const [access, setAccess] = useState<string[]>([]);
  const body = useDebounced<ScenarioIn>(useMemo(() => ({ hp_coverage_delta: hp / 100, smoking_delta: -smoking / 100, salt_delta: -salt / 100, endoscopy_access: access, until: 2031 }), [hp, smoking, salt, access]));
  const q = useScenario(body);
  const ops = useOperational();
  const hist = useForecastSeries({ metric: "cases" });
  const d = q.data?.data;
  const districts = useMemo(() => [...(ops.data?.data.capacity_by_district ?? [])].sort((a, b) => a.district_code.localeCompare(b.district_code)), [ops.data]);
  const byProv = useMemo(() => Object.keys(PROVINCE).map((p) => ({ p, rows: districts.filter((x) => x.district_code.startsWith(`${p}-`)) })).filter((g) => g.rows.length), [districts]);
  const untouched = hp === 0 && smoking === 0 && salt === 0 && access.length === 0;

  const option = useMemo<EChartsOption | null>(() => {
    if (!d) return null;
    const b = chartBase(), k = ink(), h = HUE[m];
    const ctx = (hist.data?.data.history ?? []).filter((p) => p.year >= 2018 && p.mean !== null);
    const lastH = ctx[ctx.length - 1];
    const join = lastH ? [[lastH.year, lastH.mean]] : [];
    const avertBand = d.baseline.map((p, i) => ({ x: p.year, lo: Math.min(p.mean, d.scenario[i]?.mean ?? p.mean), hi: Math.max(p.mean, d.scenario[i]?.mean ?? p.mean) }));
    return {
      ...b, grid: { left: 48, right: 20, top: 18, bottom: 28 },
      xAxis: { ...b.xAxis, type: "value", min: ctx[0]?.year ?? 2026, max: 2031, minInterval: 1, splitNumber: 7, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => String(v) } },
      yAxis: { ...b.yAxis, type: "value", scale: true, axisLabel: { ...b.yAxis.axisLabel, formatter: (v: number) => (v >= 1000 ? `${fmt(v / 1000, v % 1000 ? 1 : 0)}k` : String(v)) } },
      tooltip: { ...b.tooltip, trigger: "axis", formatter: (ps: any) => {
        const yr = Math.round(ps[0].axisValue);
        const bl = d.baseline.find((x) => x.year === yr), sc = d.scenario.find((x) => x.year === yr), hh = ctx.find((x) => x.year === yr);
        if (!bl || !sc) return hh ? tipHead(String(yr)) + tipRow(k.primary, "Registry", int(hh.mean)) : "";
        return tipHead(String(yr)) + tipRow(k.secondary, "Baseline", int(bl.mean)) + tipRow(h.sky, "Scenario", int(sc.mean))
          + tipRow(null, "Averted", int(bl.mean - sc.mean));
      } },
      series: [
        bandSeries("Averted", avertBand, h.sky, { opacity: m === "dark" ? 0.28 : 0.3, z: 1 }),
        { type: "line", name: "Registry", data: ctx.map((p) => [p.year, p.mean]), showSymbol: false, lineStyle: { width: 2, color: k.primary }, z: 3 },
        { type: "line", name: "Baseline", data: [...join, ...d.baseline.map((p) => [p.year, p.mean])], showSymbol: false, lineStyle: { width: 2, color: k.secondary, type: [6, 5] }, z: 3 },
        { type: "line", name: "Scenario", data: [...join, ...d.scenario.map((p) => [p.year, p.mean])], showSymbol: false, lineStyle: { width: 2.5, color: h.sky }, z: 4 },
      ],
    } as EChartsOption;
  }, [d, hist.data, m]);

  const k = ink(), h = HUE[m];
  const early0 = d?.stage_shift.early_pct_baseline ?? null, early1 = d?.stage_shift.early_pct_scenario ?? null;
  const reset = () => { setHp(DEFAULTS.hp); setSmoking(DEFAULTS.smoking); setSalt(DEFAULTS.salt); setAccess([]); };
  return (
    <Card title="What if" icon={<SlidersHorizontal size={16} />} aria-label="Scenario simulator"
          info={{ about: "Move the levers to see how prevention and earlier diagnosis could change expected cases to 2031. The baseline is the national forecast above.",
                  method: <ul className="flex flex-col gap-1.5">{(d?.assumptions ?? []).map((a) => <li key={a}>{a}</li>)}</ul>,
                  notes: d ? `Computed in ${fmt(d.elapsed_ms, 0)} ms from the fitted covariate model.` : undefined }}
          actions={<>
            <NatureTag title="Associational, synthetic" info="Effects come from a covariate model fitted to synthetic district data (lagged H. pylori, smoking and salt prevalence against incidence). They are associations, not causal estimates, and the data are synthetic.">Associational, synthetic</NatureTag>
            <Button size="sm" radius="full" variant="light" isDisabled={untouched} onPress={reset} startContent={<RotateCcw size={13} aria-hidden />} className="h-8 text-muted data-[hover=true]:text-ink data-[hover=true]:bg-tile">Reset</Button>
          </>}>
      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)_260px]">
        <div className="flex flex-col gap-5" role="group" aria-label="Scenario levers">
          <RangeSlider label="H. pylori test and treat" value={hp} min={0} max={100} step={5} onChange={setHp}
                       display={`${hp}%`} hint="Share of infected adults tested and treated" />
          <RangeSlider label="Smoking reduction" value={smoking} min={0} max={50} step={5} onChange={setSmoking}
                       display={smoking ? `−${smoking}%` : "0%"} hint="Relative fall in current smoking" />
          <RangeSlider label="Salt reduction" value={salt} min={0} max={50} step={5} onChange={setSalt}
                       display={salt ? `−${salt}%` : "0%"} hint="Relative fall in high-salt diets" />
          <Select label="Endoscopy access" labelPlacement="outside" placeholder="Add districts" selectionMode="multiple" size="sm" radius="full"
                  aria-label="Districts gaining endoscopy access" popoverProps={{ portalContainer: portal }}
                  selectedKeys={new Set(access)} onSelectionChange={(keys) => setAccess(keys === "all" ? districts.map((x) => x.district_code) : [...(keys as Set<string>)].sort())}
                  renderValue={(items) => <span className="text-[13px] text-ink">{items.length === 1 ? items[0].textValue : `${items.length} districts`}</span>}
                  description="Earlier diagnosis where a unit opens; it shifts stage, not incidence"
                  classNames={{ label: "!text-label !text-ink !font-medium", trigger: "bg-tile data-[hover=true]:bg-tile-hover shadow-none h-10 min-h-10", description: "text-micro text-muted", popoverContent: "rounded-card" }}>
            {byProv.map((g) => (
              <SelectSection key={g.p} title={PROVINCE[g.p]} classNames={{ heading: "text-micro text-muted px-2" }}>
                {g.rows.map((x) => (
                  <SelectItem key={x.district_code} textValue={x.name} description={!x.capacity_12m ? "No endoscopy unit today" : undefined}>{x.name}</SelectItem>
                ))}
              </SelectSection>
            ))}
          </Select>
        </div>

        <div className="min-w-0 flex flex-col">
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1">
            <Swatch kind="line" color={k.primary} label="Registry" />
            <Swatch kind="dash" color={k.secondary} label="Baseline forecast" />
            <Swatch kind="line" color={h.sky} label="Scenario" />
            <Swatch kind="band" color={alpha(h.sky, m === "dark" ? 0.35 : 0.4)} label="Cases averted" />
          </div>
          {q.isLoading && !d ? <Loading h={280} /> : q.error && !d ? <ErrorNote error={q.error} /> : option ? (
            <div className={`transition-opacity ${q.isFetching ? "opacity-70" : ""}`}>
              <EChart option={option} height={290} ariaLabel="Baseline and scenario forecast of national cases to 2031" />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 lg:border-l lg:border-hairline lg:pl-6">
          <div aria-live="polite" data-testid="cases-averted">
            <div className="text-label text-muted">Cases averted, 2026–2031</div>
            <div className="flex items-baseline gap-1.5 mt-1">
              <AnimatedNumber value={Math.round(d?.cases_averted ?? 0)} format={(n) => Math.max(0, Math.round(n)).toLocaleString("en-GB")} className="text-display text-ink tabular" />
              <span className="text-[15px] text-muted">cases</span>
            </div>
            <div className="text-label font-normal text-muted mt-1 tabular">
              {d && !untouched ? <>Range {int(Math.max(0, d.cases_averted_range[0]))}–{int(d.cases_averted_range[1])}</> : "Move a lever to start"}
            </div>
          </div>
          <div className="rounded-tile bg-tile px-4 py-3.5">
            <div className="flex items-center gap-1 text-label text-muted">
              Early stage at diagnosis
              <InfoHint mode="tooltip" size={13} label="About the stage shift" content="Share of 2031 diagnoses at stage I or II. Only endoscopy access moves it in this model: earlier diagnosis where a unit opens, not fewer cancers." className="!w-5 !h-5 !min-w-5 -my-1" />
            </div>
            <StageBar label="Baseline" pct={early0} color={h.grey} />
            <StageBar label="Scenario" pct={early1} color={h.sky} />
            <div className="text-micro text-muted mt-2 tabular">
              {early0 !== null && early1 !== null ? (Math.abs(early1 - early0) < 0.05 ? "No stage shift without new endoscopy access" : `${early1 > early0 ? "+" : ""}${fmt(early1 - early0, 1)} percentage points`) : "—"}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function StageBar({ label, pct, color }: { label: string; pct: number | null; color: string }) {
  return (
    <div className="mt-2.5">
      <div className="flex justify-between text-micro text-muted"><span>{label}</span><span className="text-ink font-medium tabular">{pct === null ? "—" : `${fmt(pct, 1)}%`}</span></div>
      <div className="h-1.5 rounded-full bg-surface mt-1 overflow-hidden" role="img" aria-label={`${label}: ${pct === null ? "unknown" : `${fmt(pct, 1)}%`} early stage`}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%`, background: color }} />
      </div>
    </div>
  );
}
