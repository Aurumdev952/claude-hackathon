import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { CalendarRange, Gauge, Target, TrendingUp } from "lucide-react";
import { Card, InfoHint, Loading, Seg, useDetailModal } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { useThemeMode } from "@/components/charts/EChart";
import { useStatus } from "@/api/hooks";
import { fmt, signed } from "@/lib/format";
import { HUE, ink } from "@/lib/viz";
import { cardEnter } from "@/lib/motion";
import { useLive } from "@/state/live";
import { alpha } from "../trends/kit";
import { simYearFrac, useForecastSeries, type FcMetric } from "./api";
import { BacktestModal } from "./Backtest";
import { FanChart, fmtValue, FULL_COMPLETENESS } from "./FanChart";
import { pctFmt, Swatch, useNarrow } from "./kit";

/** Outlook hero (design v3, Granger-like): the national forecast fan on the sky stage, a quiet title pill and the
 * cases / rate toggle on top, a white stats strip along the bottom edge (2031 mean, change vs 2025, 95% interval,
 * backtest error that opens the backtest modal). */
export function OutlookHero({ metric, setMetric }: { metric: FcMetric; setMetric: (m: FcMetric) => void }) {
  const narrow = useNarrow();
  const m = useThemeMode();
  const q = useForecastSeries({ metric });
  const st = useStatus();
  const live = useLive();
  const today = simYearFrac(live.simTime ?? st.data?.meta?.sim_time ?? q.data?.meta?.sim_time);
  const bt = useDetailModal();
  const d = q.data?.data;
  const end = d?.forecast[d.forecast.length - 1];
  const base = d ? [...d.history].reverse().find((p) => p.mean !== null && p.year <= (d.run?.last_full_year ?? 9999)) : undefined;
  const change = end && base?.mean ? (100 * (end.mean - base.mean)) / base.mean : null;
  const unit = metric === "cases" ? "cases" : "per 100k";
  const title = metric === "cases" ? "Gastric cancer cases per year, Rwanda" : "Age-standardised rate per 100,000, Rwanda";
  const k = ink(), h = HUE[m];
  const lowYears = d?.history.filter((p) => p.completeness !== undefined && p.completeness < FULL_COMPLETENESS - 1e-6) ?? [];

  return (
    <Card hero padding="none" aria-label="National forecast to 2031" className="min-h-[500px] max-sm:min-h-[560px] overflow-hidden !bg-sky-soft dark:!border-transparent">
      <div className="absolute inset-0 flex flex-col">
        <div className="flex items-start gap-2 flex-wrap px-5 pt-5 relative z-10">
          <span className="inline-flex items-center h-8 pl-3.5 pr-1 rounded-full bg-surface text-label text-ink">
            {title}, {d?.history[0]?.year ?? 2000}–{end?.year ?? 2031}
            <InfoHint title="National forecast" label="About the national forecast" size={14} className="!w-7 !h-7 !min-w-7"
              about={<>History is the synthetic national cancer registry; the forecast runs from {d?.run?.last_full_year ? d.run.last_full_year + 1 : 2026} to {end?.year ?? 2031}. Shaded fans are the 80% (darker) and 95% (lighter) prediction intervals.</>}
              method={<>Ensemble of an age-period-cohort Poisson model with a damped period drift and an exponential smoothing model on the log rate; intervals from {d?.run?.n_draws?.toLocaleString("en-GB") ?? "1,000"} bootstrap draws. {metric === "asr" ? "Rates are age-standardised to the WHO world standard." : ""}</>}
              notes={lowYears.length ? <>Dotted years ({lowYears[0].year}–{lowYears[lowYears.length - 1].year}) are below {fmt(100 * FULL_COMPLETENESS, 0)}% registry completeness: recorded counts understate the true burden there. Synthetic data.</> : "Synthetic data."} />
          </span>
          <div className="ml-auto">
            <Seg label="Forecast measure" variant="surface" value={metric} onChange={setMetric}
                 options={[{ value: "cases", label: "Cases" }, { value: "asr", label: "Rate" }]} />
          </div>
        </div>
        <div className="relative flex-1 min-h-0 -mt-2">
          {q.isLoading ? <div className="absolute inset-0 grid place-items-center"><Loading h={260} label="Loading the forecast" /></div>
            : q.error ? <div className="p-6"><ErrorNote error={q.error} /></div>
            : d ? (
              <div className="absolute inset-0" data-testid="outlook-fan">
                <FanChart history={d.history} forecast={d.forecast} metric={metric} today={today} stage height={narrow ? 400 : 430}
                          grid={{ bottom: narrow ? 150 : 112, left: narrow ? 44 : 60, right: narrow ? 16 : 32 }}
                          ariaLabel={`${title}: registry history and forecast to ${end?.year}, with 80% and 95% intervals`} />
              </div>
            ) : null}
        </div>
      </div>

      {d && end && (
        <motion.div variants={cardEnter} className="absolute left-0 right-0 bottom-0 z-10 p-5 max-sm:p-3 flex items-end gap-3 pointer-events-none">
          <div role="list" aria-label="Forecast summary" className="pointer-events-auto grid grid-cols-4 max-md:grid-cols-2 gap-1 flex-1 max-w-[860px] rounded-[20px] bg-surface p-1.5">
            <Stat icon={<Target />} value={fmtValue(metric, end.mean)} unit={unit} label={`In ${end.year}, forecast mean`} />
            <Stat icon={<TrendingUp />} value={change === null ? "—" : signed(change, 0, "%")} label={`Change vs ${base?.year ?? 2025}`} />
            <Stat icon={<CalendarRange />} value={`${fmtValue(metric, end.lo95)}–${fmtValue(metric, end.hi95)}`} label="95% interval" />
            <Stat icon={<Gauge />} value={d.backtest?.mape !== null && d.backtest?.mape !== undefined ? `${fmt(d.backtest.mape, 1)}%` : "—"} label="Backtest error (MAPE)"
                  onPress={bt.open} pressLabel="Backtest error: open the backtest detail"
                  info={<>Mean absolute percentage error of past national forecasts (origins 2015, 2018, 2021; up to 5 years ahead). Actual values fell inside the 80% band {pctFmt(d.backtest?.cov80)} and the 95% band {pctFmt(d.backtest?.cov95)} of the time. Select the tile for the full backtest.</>} />
          </div>
          {!narrow && (
            <div className="pointer-events-auto hidden xl:flex flex-col gap-1.5 rounded-tile bg-surface px-4 py-3 shrink-0" aria-label="Chart legend">
              <Swatch kind="line" color={k.primary} label="Registry" />
              <Swatch kind="dot-line" color={k.primary} label="Low completeness" />
              <Swatch kind="dash" color={k.primary} label="Forecast mean" />
              <span className="flex gap-3">
                <Swatch kind="band" color={alpha(h.sky, m === "dark" ? 0.55 : 0.7)} label="80%" />
                <Swatch kind="band" color={alpha(h.sky, m === "dark" ? 0.3 : 0.38)} label="95%" />
              </span>
            </div>
          )}
        </motion.div>
      )}
      <BacktestModal isOpen={bt.isOpen} onOpenChange={(o) => (o ? bt.open() : bt.close())} />
    </Card>
  );
}

function Stat({ icon, value, unit, label, info, onPress, pressLabel }: { icon: ReactNode; value: string; unit?: string; label: string; info?: ReactNode; onPress?: () => void; pressLabel?: string }) {
  const body = (
    <>
      <span className="hidden sm:grid w-10 h-10 shrink-0 rounded-full place-items-center bg-tile text-ink [&_svg]:w-[17px] [&_svg]:h-[17px]" aria-hidden>{icon}</span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1 whitespace-nowrap">
          <span className="text-[22px] max-sm:text-[18px] leading-7 font-medium tracking-[-0.01em] text-ink tabular">{value}</span>
          {unit && <span className="text-micro text-muted">{unit}</span>}
        </span>
        <span className="block text-micro text-muted truncate">{label}</span>
      </span>
    </>
  );
  return (
    <div role="listitem" aria-label={`${label}: ${value}${unit ? ` ${unit}` : ""}`} className="min-w-0 relative flex items-center">
      {onPress ? (
        <button type="button" onClick={onPress} aria-label={pressLabel}
                className="w-full flex items-center gap-3 rounded-tile px-2.5 py-2 text-left hover:bg-tile transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          {body}
        </button>
      ) : <div className="w-full flex items-center gap-3 px-2.5 py-2">{body}</div>}
      {info && <span className="absolute right-1 top-1"><InfoHint content={info} mode="tooltip" size={13} label={`About ${label}`} className="!w-6 !h-6 !min-w-6" /></span>}
    </div>
  );
}
