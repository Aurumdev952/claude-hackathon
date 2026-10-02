import { useMemo, useState } from "react";
import { Footprints, Scale, Send } from "lucide-react";
import { useThemeMode } from "@/components/charts/EChart";
import { Card, chartDetailTabs, DataTable, Loading, Seg } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt } from "@/lib/format";
import { HUE, hexToRgb, rgbToHex } from "@/lib/viz";
import { FlatMap, type FlatValue } from "../outlook/FlatMap";
import { Count, NatureTag } from "../outlook/kit";
import {
  FUNNEL_STEPS, levelLabel, STEP_LABEL, useAdherence, useChw, useImpact, usePathways,
  type AdherenceDim, type ChwRow, type Funnel, type FunnelStep,
} from "./api";

const HATCH = "repeating-linear-gradient(135deg, rgb(var(--faint) / 0.45) 0 2px, transparent 2px 6px)";
const pctOf = (a: number | null, b: number | null) => (a === null || b === null || !b ? null : (100 * a) / b);

/** The care funnel as horizontal bars, each scaled to the flagged count, with the conversion from the previous step.
 * Suppressed steps (n < 5) show a hatched stub and "<5" instead of a number. */
export function FunnelBars({ funnel, compact = false, only }: { funnel: Funnel; compact?: boolean; only?: readonly FunnelStep[] }) {
  const m = useThemeMode();
  const h = HUE[m];
  const steps = (only ?? FUNNEL_STEPS).map((s) => funnel.steps.find((x) => x.step === s) ?? { step: s, n: 0 });
  const top = Math.max(1, ...steps.map((s) => s.n ?? 0));
  return (
    <ol className={`flex flex-col ${compact ? "gap-2" : "gap-3.5"}`} aria-label="Care funnel">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].n : null;
        const conv = i ? pctOf(s.n, prev) : null;
        const w = s.n === null ? 4 : Math.max(s.n ? 1.5 : 0, (100 * s.n) / top);
        return (
          <li key={s.step} className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_auto] max-sm:grid-cols-[minmax(0,110px)_minmax(0,1fr)_auto] items-center gap-3"
              aria-label={`${STEP_LABEL[s.step as FunnelStep]}: ${s.n === null ? "fewer than 5" : s.n}`}>
            <span className={`${compact ? "text-micro" : "text-label font-normal"} text-ink truncate`}>{STEP_LABEL[s.step as FunnelStep]}</span>
            <span className={`relative ${compact ? "h-2" : "h-3"} rounded-full bg-tile overflow-hidden`}>
              <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
                    style={{ width: `${w}%`, background: s.n === null ? HATCH : s.step === "early_stage" ? h.ink : h.sky }} />
            </span>
            <span className="flex items-baseline gap-2 justify-end min-w-[64px]">
              <Count n={s.n} label={s.n_label} className={`${compact ? "text-[13px]" : "text-[15px]"} font-medium text-ink`} />
              {!compact && <span className="text-micro text-muted tabular w-10 text-right">{conv === null ? "" : `${fmt(conv, 0)}%`}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Adherence: share of care tasks done on time by reminder channel, distance, sex or age, with the median days. */
export function AdherenceCard() {
  const [by, setBy] = useState<AdherenceDim>("channel");
  const q = useAdherence(by);
  const pw = usePathways();
  const m = useThemeMode();
  const h = HUE[m];
  const rows = q.data?.data ?? [];
  const shown = rows.filter((r) => r.level !== "unknown");
  const visible = shown.filter((r) => r.rate !== null);
  return (
    <Card title="Who follows through" icon={<Send size={16} />} className="h-full"
          info={{ about: "Share of follow-up tasks completed on time, by how the patient was reminded, how far they live from the facility, and by sex and age. It shows where SMS and community health worker (CHW) visits help, and who is left behind.",
                  method: "A task counts as on time when its evidence (an endoscopy, a lab, a visit) reached the EMR before the due date plus the grace period. Median days run from the plan's approval to completion.",
                  notes: "Synthetic data. Groups with fewer than 5 tasks are suppressed. Reminder channels are not randomised, so differences are associations." }}
          actions={<Seg label="Break down by" value={by} onChange={setBy} options={[{ value: "channel", label: "Reminder" }, { value: "distance", label: "Distance" }, { value: "sex", label: "Sex" }, { value: "age", label: "Age" }]} />}
          detail={rows.length ? { tabs: chartDetailTabs({ table: <DataTable ariaLabel="Adherence" rows={rows} columns={[
            { key: "level", label: "Group", fmt: (v) => levelLabel(by, String(v), pw.data?.data) },
            { key: "n", label: "Tasks", num: true, fmt: (v, r) => (v === null ? r.n_label ?? "<5" : v) },
            { key: "adhered", label: "On time", num: true, fmt: (v, r) => (v === null ? r.adhered_label ?? "<5" : v) },
            { key: "rate", label: "Rate", num: true, fmt: (v) => (v === null ? "—" : `${fmt(100 * v, 0)}%`) },
            { key: "median_days", label: "Median days", num: true, fmt: (v) => (v === null ? "—" : fmt(v, 0)) }]} /> }), defaultTab: "table" } : undefined}
          detailLabel="Adherence: view as table">
      {q.isLoading ? <Loading h={220} /> : q.error ? <ErrorNote error={q.error} /> : !shown.length ? (
        <Empty>No completed follow-up tasks yet. As patients act on their care plans, on-time rates appear here.</Empty>
      ) : (
        <>
          <ul className="flex flex-col gap-3" aria-label={`On-time rate by ${by}`}>
            {shown.map((r) => (
              <li key={r.level} className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_auto] max-sm:grid-cols-[minmax(0,110px)_minmax(0,1fr)_auto] items-center gap-3">
                <span className="text-label font-normal text-ink truncate">{levelLabel(by, r.level, pw.data?.data)}</span>
                <span className="relative h-3 rounded-full bg-tile overflow-hidden">
                  <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: r.rate === null ? "4%" : `${Math.max(1.5, 100 * r.rate)}%`, background: r.rate === null ? HATCH : h.sky }} />
                </span>
                <span className="text-[14px] text-ink font-medium tabular min-w-[96px] text-right">
                  {r.rate === null ? <span className="text-muted font-normal">{r.n_label ?? "<5"} tasks</span> : <>{fmt(100 * r.rate, 0)}%<span className="text-micro text-muted font-normal"> of {r.n}</span></>}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-label font-normal text-muted mt-4">
            {visible.length ? `Median ${fmt(Math.min(...visible.filter((r) => r.median_days !== null).map((r) => r.median_days as number)), 0)}–${fmt(Math.max(...visible.filter((r) => r.median_days !== null).map((r) => r.median_days as number)), 0)} days from approval to completion across groups.`
              : "Every group is still under 5 tasks, so rates are suppressed. They fill in as the programme grows."}
          </p>
        </>
      )}
    </Card>
  );
}

/** Impact: early-stage share and 1-year survival for cancers found through the care pathway vs the usual route. */
export function ImpactCard() {
  const q = useImpact();
  const rows = q.data?.data ?? [];
  const caveat = (q.data as { caveat?: string } | undefined)?.caveat;
  const cp = rows.find((r) => r.route === "care_pathway"), us = rows.find((r) => r.route === "usual");
  const col = (r: typeof cp, name: string, muted = false) => (
    <div className="min-w-0 rounded-tile bg-tile px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-label text-muted"><span className={`w-2 h-2 rounded-full ${muted ? "bg-faint" : "bg-sky"}`} aria-hidden />{name}</div>
      <div className="mt-2 text-micro text-muted">Early stage</div>
      <div className="text-[24px] leading-8 font-medium text-ink tabular">{r?.early_stage_pct === null || r?.early_stage_pct === undefined ? <span className="text-muted">{r?.n === 0 ? "—" : (r?.n ?? 0) < 5 ? "<5" : "—"}</span> : `${fmt(r.early_stage_pct, 0)}%`}</div>
      <div className="mt-1.5 text-micro text-muted">1-year survival</div>
      <div className="text-[24px] leading-8 font-medium text-ink tabular">{r?.surv_1y === null || r?.surv_1y === undefined ? <span className="text-muted">{r?.n_surv_eligible === 0 ? "—" : (r?.n_surv_eligible ?? 0) < 5 ? "<5" : "—"}</span> : `${fmt(100 * r.surv_1y, 0)}%`}</div>
      <div className="mt-1.5 text-micro text-muted tabular">{r?.n === null || r?.n === undefined ? "Fewer than 5 cancers" : r.n === 0 ? "No cancers yet" : `${r.n} cancers`}</div>
    </div>
  );
  return (
    <Card title="Impact on stage and survival" icon={<Scale size={16} />} className="h-full" bodyClassName="flex flex-col"
          actions={<NatureTag title="Not a causal effect" info={<>{caveat ?? "Care-pathway and usual-route diagnoses differ in who was flagged and when."} Numbers are small, so a few cases move these percentages a lot. Do not read the difference as the effect of the programme.</>}>Not a causal effect</NatureTag>}>
      {q.isLoading ? <Loading h={220} /> : q.error ? <ErrorNote error={q.error} /> : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            {col(cp, "Care pathway")}
            {col(us, "Usual route", true)}
          </div>
          <p className="text-label font-normal text-muted mt-4">Cancers found after a flag was approved and followed up, against cancers diagnosed any other way. Synthetic data, small numbers.</p>
        </>
      )}
    </Card>
  );
}

/** CHW workload: open home visits by district on a flat map, with the overdue and completed counts. */
export function ChwCard() {
  const q = useChw();
  const m = useThemeMode();
  const rows = q.data?.data ?? [];
  const values = useMemo(() => {
    const h = HUE[m];
    const max = Math.max(1, ...rows.map((r) => r.open_visits ?? 0));
    const a = hexToRgb(m === "dark" ? "#22475C" : "#D9EEF9"), b = hexToRgb(m === "dark" ? "#9AD3F2" : "#1F6FA3");
    const mix = (t: number) => rgbToHex(a.map((x, i) => x + (b[i] - x) * t));
    return new Map<string, FlatValue>(rows.map((r) => [r.district_code, {
      fill: r.open_visits === null ? h.skySoft : mix(0.2 + (0.8 * r.open_visits) / max),
      label: r.open_visits === null ? "fewer than 5 open visits" : `${r.open_visits} open visits`,
      tip: <><div className="font-semibold text-ink">{r.district_name ?? r.district_code}</div>
        <div className="flex justify-between gap-4 tabular"><span className="text-muted">Open visits</span><Count n={r.open_visits} label={r.open_visits_label} className="text-ink font-medium" /></div>
        <div className="flex justify-between gap-4 tabular"><span className="text-muted">Overdue</span><Count n={r.overdue} label={r.overdue_label} className="text-ink font-medium" /></div></>,
    }]));
  }, [rows, m]);
  return (
    <Card title="Community health worker visits" icon={<Footprints size={16} />} className="h-full"
          info={{ about: "Home visits the care engine has asked community health workers (CHWs) to make when a patient misses a step, by district.",
                  notes: "Districts with fewer than 5 visits show \"<5\". Districts without any visits are left grey." }}
          detail={rows.length ? { tabs: chartDetailTabs({ table: <ChwTable rows={rows} /> }), defaultTab: "table" } : undefined}
          detailLabel="CHW workload: view as table">
      {q.isLoading ? <Loading h={260} /> : q.error ? <ErrorNote error={q.error} /> : (
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
          <FlatMap values={values} maxHeight={240} highlight={new Set(rows.map((r) => r.district_code))} ariaLabel="Open CHW visits by district" />
          {rows.length ? <ChwTable rows={rows.slice(0, 6)} /> : <Empty>No CHW visits requested yet. They appear when a patient misses a follow-up step.</Empty>}
        </div>
      )}
    </Card>
  );
}

function ChwTable({ rows }: { rows: ChwRow[] }) {
  return (
    <DataTable ariaLabel="CHW visits by district" rows={rows} columns={[
      { key: "district_name", label: "District", fmt: (v, r) => v ?? r.district_code },
      { key: "open_visits", label: "Open", num: true, fmt: (v, r) => <Count n={v} label={r.open_visits_label} /> },
      { key: "overdue", label: "Overdue", num: true, fmt: (v, r) => <Count n={v} label={r.overdue_label} /> },
      { key: "completed_30d", label: "Done, 30 d", num: true, fmt: (v, r) => <Count n={v} label={r.completed_30d_label} /> }]} />
  );
}

export function Empty({ children, h = 160 }: { children: React.ReactNode; h?: number }) {
  return <div className="flex items-center justify-center text-center text-label font-normal text-muted px-6 rounded-tile bg-tile" style={{ minHeight: h }}>{children}</div>;
}

