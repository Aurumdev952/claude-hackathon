import { useMemo, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { useThemeMode } from "@/components/charts/EChart";
import { Card, chartDetailTabs, DataTable, Loading, Seg } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int, signed } from "@/lib/format";
import { rgbToHex, SEQ_DARK, SEQ_LIGHT, seqRgb } from "@/lib/viz";
import { useForecastMap, type MapRowFc } from "./api";
import { FlatMap, type FlatValue } from "./FlatMap";

type Metric = "asr" | "change";

/** District map of the projected 2031 age-standardised rate, or the % change in expected cases since the base year. */
export function ProjectedMapCard() {
  const [metric, setMetric] = useState<Metric>("asr");
  const m = useThemeMode();
  const q = useForecastMap(metric);
  const rows = q.data?.data ?? [];
  const env = q.data as (typeof q.data & { unit?: string; base_year?: number; year?: number }) | undefined;
  const year = env?.year ?? 2031;
  const fmtV = (v: number | null | undefined) => (metric === "asr" ? fmt(v, 1) : signed(v ?? null, 0, "%"));
  const { values, lo, hi, top } = useMemo(() => {
    const fin = rows.filter((r) => r.value !== null) as (MapRowFc & { value: number })[];
    const lo = fin.length ? Math.min(...fin.map((r) => r.value)) : 0, hi = fin.length ? Math.max(...fin.map((r) => r.value)) : 1;
    const values = new Map<string, FlatValue>(rows.map((r) => {
      const t = r.value === null ? 0 : (r.value - lo) / (hi - lo || 1);
      return [r.district_code, {
        fill: rgbToHex(seqRgb(0.12 + 0.88 * t)), label: r.value === null ? "no forecast" : `${fmtV(r.value)}${metric === "asr" ? " per 100k" : ""}`,
        tip: <>
          <div className="font-semibold text-ink">{r.name}</div>
          <div className="flex justify-between gap-4 tabular"><span className="text-muted">{metric === "asr" ? `ASR ${year}` : `Change to ${year}`}</span><span className="text-ink font-medium">{fmtV(r.value)}</span></div>
          {metric === "asr" && r.lo95 !== null && r.lo95 !== undefined && <div className="text-micro text-muted tabular">95% interval {fmt(r.lo95, 1)}–{fmt(r.hi95, 1)}</div>}
          {metric === "change" && <div className="text-micro text-muted tabular">{int(r.base_cases)} to {int(r.cases)} expected cases</div>}
        </>,
      }];
    }));
    return { values, lo, hi, top: [...fin].sort((a, b) => b.value - a.value).slice(0, 3) };
  }, [rows, metric, m]); // eslint-disable-line react-hooks/exhaustive-deps
  const ramp = m === "dark" ? SEQ_DARK : SEQ_LIGHT;
  return (
    <Card title={`Districts in ${year}`} icon={<MapIcon size={16} />} className="h-full" bodyClassName="flex flex-col"
          actions={<Seg label="Map measure" value={metric} onChange={setMetric} options={[{ value: "asr", label: "Rate" }, { value: "change", label: "Change" }]} />}
          detail={rows.length ? { tabs: chartDetailTabs({
            table: <DataTable ariaLabel="Projected district values" rows={[...rows].sort((a, b) => (b.value ?? -1e9) - (a.value ?? -1e9))} columns={[
              { key: "name", label: "District" }, { key: "province_code", label: "Province" },
              { key: "value", label: metric === "asr" ? `ASR ${year}` : `Change to ${year}`, num: true, fmt: (v) => fmtV(v) },
              ...(metric === "asr" ? [{ key: "lo95", label: "95% interval", num: true, fmt: (_: unknown, r: MapRowFc) => (r.lo95 === null || r.lo95 === undefined ? "—" : `${fmt(r.lo95, 1)}–${fmt(r.hi95, 1)}`) }]
                : [{ key: "base_cases", label: `Cases ${env?.base_year ?? ""}`, num: true, fmt: (v: number) => int(v) }, { key: "cases", label: `Cases ${year}`, num: true, fmt: (v: number) => int(v) }])]} />,
            method: "District forecasts shrink each district's own trend towards its province (empirical Bayes), so small districts do not swing on noise. Rates are age-standardised (WHO world standard); change compares expected cases in the horizon year with the model-fitted base year.",
            notes: "Synthetic registry. Districts with similar populations and risk profiles project almost the same change, which is why several share a value." }), defaultTab: "table" } : undefined}
          detailLabel="District forecast: view as table">
      {q.isLoading ? <Loading h={300} /> : q.error ? <ErrorNote error={q.error} /> : (
        <>
          <FlatMap values={values} maxHeight={300} ariaLabel={`District map of ${metric === "asr" ? "projected age-standardised rate" : "projected change in cases"}, ${year}`} />
          <div className="mt-3 flex items-center gap-3">
            <span className="text-micro text-muted tabular w-12">{fmtV(lo)}</span>
            <span className="flex-1 h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${ramp.slice(1).join(",")})` }} aria-hidden />
            <span className="text-micro text-muted tabular w-12 text-right">{fmtV(hi)}</span>
          </div>
          <div className="text-micro text-muted text-center mt-1">{metric === "asr" ? "Age-standardised rate per 100,000" : `Change in expected cases since ${env?.base_year ?? "the base year"}`}</div>
          <ol className="mt-4 flex flex-col gap-1.5" aria-label="Highest projected districts">
            {top.map((r, i) => (
              <li key={r.district_code} className="flex items-center gap-3 text-[14px]">
                <span className="w-5 text-micro text-muted tabular">{i + 1}</span>
                <span className="flex-1 text-ink truncate">{r.name}</span>
                <span className="text-ink font-medium tabular">{fmtV(r.value)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}
