import { useMemo } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import type { PatientLab, PatientWidget as PatientWidgetT, PatientTimelineEvent } from "@agent/widgets";
import { Activity, ArrowUpRight, BellRing, Building2, CalendarDays, CheckCircle2, FlaskConical, MapPin, Sparkles, TrendingDown, TrendingUp, UserRound } from "lucide-react";
import { EChart, base, useThemeMode } from "@/components/charts/EChart";
import { RiskScoreBar, StatusChip, type StatusKind } from "@/components/ui";
import { BandChip } from "@/components/ui/Status";
import { EASE, cardEnter, stagger, itemEnter } from "@/lib/motion";
import { DIVERGING, ink, SERIES } from "@/lib/viz";
import { fmtNumber, humanCode, initials, shortDate } from "./format";

/** make_patient_widget output (plan §B7): MedEx-style header, risk, 12-month timeline, latest labs, alerts, actions. */
export function PatientWidget({ widget: p }: { widget: PatientWidgetT }) {
  const reduce = useReducedMotion();
  const name = p.name ?? p.display_id ?? `Patient ${p.patient_id}`;
  const sex = p.sex === "F" ? "Female" : p.sex === "M" ? "Male" : p.sex;
  return (
    <motion.article aria-label={`Patient: ${name}`} variants={cardEnter} initial={reduce ? false : "hidden"} animate="show"
                    className="agent-widget rounded-card bg-surface border border-border shadow-card overflow-hidden min-w-0">
      {/* header */}
      <header className="relative p-5 pb-4 flex flex-wrap items-start gap-4 bg-gradient-to-br from-accent-soft/80 via-surface to-surface">
        <div className="relative shrink-0">
          <div className="w-14 h-14 rounded-full grid place-items-center text-white text-lg font-semibold tracking-wide shadow-tile ring-4 ring-surface"
               style={{ background: "linear-gradient(135deg, rgb(var(--accent)) 0%, #6E5BD6 100%)" }} aria-hidden>{initials(p.name, "")|| <UserRound size={22} />}</div>
          {p.risk?.band === "HIGH" && <span className="absolute -right-0.5 -bottom-0.5 w-4 h-4 rounded-full bg-danger ring-[3px] ring-surface" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-micro text-fg-muted">
            <span className="tabular">{p.display_id}</span>
            {p.risk?.rank_in_facility ? <><span aria-hidden>·</span><span>#{p.risk.rank_in_facility} in facility</span></> : null}
          </div>
          <h3 className="text-h1 text-fg truncate">{name}</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Demographics">
            {p.age !== null && <Pill icon={<CalendarDays size={12} />}>{Math.round(p.age)} years</Pill>}
            {sex && <Pill icon={<UserRound size={12} />}>{sex}</Pill>}
            {p.district_name && <Pill icon={<MapPin size={12} />}>{p.district_name}</Pill>}
            {p.home_facility_name && <Pill icon={<Building2 size={12} />}>{p.home_facility_name.replace(" (Synthetic)", "")}</Pill>}
            {p.is_case && <Pill tone="danger">Diagnosed{p.dx_date ? ` ${shortDate(p.dx_date)}` : ""}</Pill>}
          </ul>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <BandChip band={p.risk?.band ?? null} size="md" />
          <Link to={p.links.case} className="inline-flex items-center gap-1 rounded-full bg-nav text-nav-fg text-[12.5px] font-medium px-3.5 py-1.5 shadow-tile hover:opacity-90 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            Open case <ArrowUpRight size={14} aria-hidden />
          </Link>
        </div>
      </header>
      {p.focus && (
        <p className="px-5 pb-1 flex items-center gap-1.5 text-label text-fg-muted"><Sparkles size={13} className="text-accent shrink-0" aria-hidden />{p.focus}</p>
      )}

      <motion.div className="grid gap-3 p-5 pt-3 md:grid-cols-2" variants={stagger(0.06, 0.12)} initial={reduce ? false : "hidden"} animate="show">
        <Tile title="Risk" icon={<Activity size={14} />}>
          {p.risk ? (
            <div className="flex flex-col gap-3">
              <RiskScoreBar score={p.risk.probability} band={p.risk.band} label="12-month probability" />
              <div className="flex flex-wrap gap-1.5">
                {p.risk.scoped_since_flag === false && <StatusChip status="warning" label="Not scoped since flagged" />}
                {p.risk.scoped_since_flag === true && <StatusChip status="good" label="Scoped since flagged" />}
                {p.risk.first_high_at && <StatusChip status="neutral" icon={false} label={`High since ${shortDate(p.risk.first_high_at)}`} />}
              </div>
              <Reasons reasons={p.risk.top_reasons} />
            </div>
          ) : <p className="text-label text-fg-muted">Not scored (diagnosed, outside the GI cohort or no model run).</p>}
        </Tile>

        <Tile title="Last 12 months" icon={<CalendarDays size={14} />}>
          <Timeline p={p} />
        </Tile>

        <Tile title="Latest labs" icon={<FlaskConical size={14} />} className="md:col-span-2">
          {p.labs.length ? (
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
              {p.labs.slice(0, 8).map((l) => <LabCard key={l.concept_id} lab={l} />)}
            </div>
          ) : <p className="text-label text-fg-muted">No lab results in the window.</p>}
        </Tile>

        <Tile title="Alerts" icon={<BellRing size={14} />} count={p.alerts.length}>
          {p.alerts.length ? (
            <ul className="flex flex-col gap-2">
              {p.alerts.slice(0, 4).map((a) => (
                <li key={a.alert_id} className="rounded-tile bg-surface border border-border p-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StatusChip status={severityKind(a.severity)} label={humanCode(a.severity)} />
                    <span className="text-[12.5px] font-medium text-fg">{humanCode(a.trigger)}</span>
                    <span className="flex-1" />
                    <span className="text-micro text-fg-muted">{humanCode(a.status)} · {shortDate(a.created_at)}</span>
                  </div>
                  {a.summary && <p className="text-[12.5px] text-fg-muted mt-1.5 leading-snug">{a.summary}</p>}
                </li>
              ))}
            </ul>
          ) : <p className="text-label text-fg-muted flex items-center gap-1.5"><CheckCircle2 size={14} className="text-success" aria-hidden />No open alerts</p>}
        </Tile>

        <Tile title="Suggested actions" icon={<CheckCircle2 size={14} />}>
          {p.suggested_actions.length ? (
            <ul className="flex flex-col gap-1.5">
              {p.suggested_actions.map((s) => (
                <li key={s} className="flex items-start gap-2 rounded-tile bg-accent-soft/60 px-3 py-2 text-[13px] text-fg">
                  <span className="mt-0.5 w-4 h-4 rounded-full bg-accent text-white grid place-items-center shrink-0" aria-hidden><ArrowUpRight size={11} /></span>{s}
                </li>
              ))}
            </ul>
          ) : <p className="text-label text-fg-muted">Nothing suggested.</p>}
          <p className="text-micro text-fg-muted mt-2.5">Decision support only · synthetic data</p>
        </Tile>
      </motion.div>
    </motion.article>
  );
}

function Pill({ icon, tone, children }: { icon?: JSX.Element; tone?: "danger"; children: React.ReactNode }) {
  return (
    <li className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium ${tone === "danger" ? "bg-danger/10 border-danger/20 text-tone-danger" : "bg-surface border-border text-fg shadow-tile"}`}>
      {icon && <span className="text-fg-muted" aria-hidden>{icon}</span>}{children}
    </li>
  );
}

function Tile({ title, icon, count, className = "", children }: { title: string; icon: JSX.Element; count?: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.section variants={itemEnter} className={`rounded-tile bg-surface-2 border border-border/70 p-4 min-w-0 ${className}`} aria-label={title}>
      <h4 className="flex items-center gap-2 text-[13px] font-semibold text-fg mb-3">
        <span className="w-6 h-6 rounded-[8px] bg-surface border border-border text-accent grid place-items-center" aria-hidden>{icon}</span>
        {title}
        {count !== undefined && count > 0 && <span className="ml-0.5 rounded-full bg-fg/[0.07] px-1.5 text-micro text-fg-muted tabular">{count}</span>}
      </h4>
      {children}
    </motion.section>
  );
}

const severityKind = (s: string): StatusKind => (s === "HIGH" || s === "CRITICAL" ? "critical" : s === "MEDIUM" ? "warning" : "info");

function Reasons({ reasons }: { reasons: NonNullable<PatientWidgetT["risk"]>["top_reasons"] }) {
  const reduce = useReducedMotion();
  const rs = reasons.filter((r) => (r.contribution ?? 0) > 0).slice(0, 4);
  const max = Math.max(0.01, ...rs.map((r) => Math.abs(r.contribution ?? 0)));
  if (!rs.length) return null;
  return (
    <div>
      <div className="text-micro text-fg-muted mb-1.5">Top drivers</div>
      <ul className="flex flex-col gap-2">
        {rs.map((r, i) => (
          <li key={r.feature} className="text-[12.5px]">
            <div className="flex justify-between gap-2"><span className="text-fg truncate" title={r.label ?? r.feature}>{r.label ?? humanCode(r.feature)}</span>
              <span className="text-fg-muted tabular">+{(r.contribution ?? 0).toFixed(2)}</span></div>
            <div className="h-1.5 rounded-full bg-fg/[0.06] mt-1 overflow-hidden" aria-hidden>
              <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${DIVERGING.pos}88, ${DIVERGING.pos})` }}
                          initial={reduce ? false : { width: 0 }} animate={{ width: `${(100 * Math.abs(r.contribution ?? 0)) / max}%` }}
                          transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : 0.2 + i * 0.07 }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabCard({ lab }: { lab: PatientLab }) {
  const v = typeof lab.latest === "number" ? fmtNumber(lab.latest) : lab.latest ?? "—";
  const ch = lab.change_pct_12m;
  return (
    <div className="rounded-tile bg-surface border border-border p-3 min-w-0 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-1">
        <span className="text-micro font-semibold text-accent bg-accent-soft rounded-full px-2 py-0.5 truncate" title={lab.name}>{lab.name}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-0.5 min-w-0">
        <span className="text-[19px] font-semibold text-fg tabular truncate">{v}</span>
        {lab.unit && <span className="text-micro text-fg-muted">{lab.unit}</span>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <StatusChip status={lab.abnormal ? "critical" : "optimal"} label={lab.abnormal ? "Abnormal" : "Normal"} />
        {ch !== null && ch !== undefined && Number.isFinite(ch) && (
          <span className="inline-flex items-center gap-0.5 text-micro text-fg-muted tabular">
            {ch < 0 ? <TrendingDown size={11} aria-hidden /> : <TrendingUp size={11} aria-hidden />}{ch > 0 ? "+" : ""}{fmtNumber(ch)}%
          </span>
        )}
      </div>
      <div className="text-micro text-fg-muted">{shortDate(lab.latest_ts)}{lab.n > 1 ? ` · ${lab.n} readings` : ""}</div>
    </div>
  );
}

/** Hb + weight over the 12-month window (dual axis) and an event strip underneath. */
function Timeline({ p }: { p: PatientWidgetT }) {
  const mode = useThemeMode();
  const { hb, weight } = p.timeline.series;
  const start = new Date(p.timeline.window.start).getTime(), end = new Date(p.timeline.window.end).getTime();
  const option = useMemo(() => {
    const k = ink(), S = SERIES[mode];
    const pts = (xs: { ts: string; value: number | null }[]) => xs.filter((x) => x.value !== null).map((x) => [new Date(x.ts).getTime(), x.value as number]);
    const H = pts(hb), W = pts(weight);
    /** Three even steps that always land on whole numbers, so tick labels never collide. */
    const range = (xs: number[][], lo: number, hi: number, pad: number) => {
      const v = xs.map((x) => x[1]);
      const min = Math.floor(Math.min(lo, ...v) - pad);
      const interval = Math.max(1, Math.ceil((Math.ceil(Math.max(hi, ...v) + pad) - min) / 3));
      return { min, max: min + interval * 3, interval };
    };
    const line = (name: string, data: number[][], c: string, yAxisIndex: number) => ({
      name, type: "line", data, yAxisIndex, symbol: "circle", symbolSize: 7, showSymbol: true, lineStyle: { width: 2, color: c }, itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
    });
    const b = base();
    const hbR = range(H, 10, 15, 0.5);
    const wR = W.length ? range(W, Infinity, -Infinity, 3) : { min: 40, max: 85, interval: 15 };
    return {
      ...b, legend: { show: false }, grid: { left: 4, right: 4, top: 12, bottom: 2, containLabel: true },
      tooltip: { ...(b.tooltip as object), trigger: "axis",
        formatter: (ps: any[]) => `<div style="font-weight:600;margin-bottom:2px">${shortDate(new Date(ps[0].value[0]).toISOString())}</div>` + ps.map((q) => `<div>${q.marker}${q.seriesName} <b>${fmtNumber(q.value[1])}</b></div>`).join("") },
      xAxis: { ...(b.xAxis as object), type: "time", min: start, max: end, axisLabel: { color: k.muted, fontSize: 10, hideOverlap: true, formatter: { month: "{MMM}", year: "{yyyy}" } }, splitNumber: 4 },
      yAxis: [
        { ...(b.yAxis as object), type: "value", ...hbR, axisLabel: { color: S[0], fontSize: 10 } },
        { ...(b.yAxis as object), type: "value", ...wR, splitLine: { show: false }, axisLabel: { color: S[1], fontSize: 10 } },
      ],
      series: [line("Hb (g/dL)", H, S[0], 0), line("Weight (kg)", W, S[1], 1)],
    } as any;
  }, [hb, weight, mode, start, end]);
  const S = SERIES[mode];
  const latest = (xs: { value: number | null }[]) => [...xs].reverse().find((x) => x.value !== null)?.value ?? null;
  const events = p.timeline.events.filter((e) => e.event_type !== "VITAL" || e.highlight || e.is_abnormal);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-4 text-micro text-fg-muted">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-[3px] rounded-full" style={{ background: S[0] }} aria-hidden />Hb <b className="text-fg tabular">{latest(hb) !== null ? `${fmtNumber(latest(hb)!)} g/dL` : "—"}</b></span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-[3px] rounded-full" style={{ background: S[1] }} aria-hidden />Weight <b className="text-fg tabular">{latest(weight) !== null ? `${fmtNumber(latest(weight)!)} kg` : "—"}</b></span>
      </div>
      {hb.length + weight.length > 0
        ? <EChart option={option} height={132} ariaLabel={`Haemoglobin and weight over the last ${p.timeline.window.months} months`} />
        : <div className="h-[132px] grid place-items-center text-label text-fg-muted">No Hb or weight readings</div>}
      <EventStrip events={events} start={start} end={end} />
    </div>
  );
}

/** Event-type dots (categorical palette slots, fixed order); red is reserved for abnormal / key events. */
const EVENT_TONE: Record<string, string> = {
  VISIT: "bg-accent", LAB: "bg-[#1baf7a]", DIAGNOSIS: "bg-[#4a3aa7]", SYMPTOM: "bg-[#eda100]", DRUG: "bg-[#e87ba4]", ORDER: "bg-[#eb6834]", PROCEDURE: "bg-[#008300]", VITAL: "bg-fg-muted",
};

function EventStrip({ events, start, end }: { events: PatientTimelineEvent[]; start: number; end: number }) {
  const span = Math.max(1, end - start);
  const types = [...new Set(events.map((e) => e.event_type))].slice(0, 5);
  return (
    <div>
      <div className="relative h-6 rounded-full bg-surface border border-border" role="list" aria-label={`${events.length} events in the window`}>
        {events.map((e, i) => {
          const x = ((new Date(e.ts).getTime() - start) / span) * 100;
          if (!Number.isFinite(x)) return null;
          const strong = e.highlight || e.is_abnormal;
          return (
            <span key={i} role="listitem" title={`${shortDate(e.ts)} · ${e.label ?? humanCode(e.event_type)}${e.value_num !== null && e.value_num !== undefined ? ` ${fmtNumber(e.value_num)}${e.unit ? ` ${e.unit}` : ""}` : e.value_text ? ` ${e.value_text}` : ""}`}
                  className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full ring-2 ring-surface ${strong ? "w-3 h-3 bg-danger" : `w-2 h-2 ${EVENT_TONE[e.event_type] ?? "bg-fg-muted"}`}`}
                  style={{ left: `${Math.max(2, Math.min(98, x))}%` }} />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-micro text-fg-muted">
        {types.map((t) => <span key={t} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${EVENT_TONE[t] ?? "bg-fg-muted"}`} aria-hidden />{humanCode(t)}</span>)}
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-danger" aria-hidden />Abnormal / key</span>
      </div>
    </div>
  );
}
