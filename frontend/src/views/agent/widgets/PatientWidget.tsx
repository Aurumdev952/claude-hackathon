import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import type { PatientLab, PatientWidget as PatientWidgetT, PatientTimelineEvent } from "@agent/widgets";
import { ArrowUpRight, Building2, CalendarDays, MapPin, UserRound } from "lucide-react";
import { EChart, base, useThemeMode } from "@/components/charts/EChart";
import { RiskScoreBar } from "@/components/ui";
import { BandChip } from "@/components/ui/Status";
import { EASE, cardEnter } from "@/lib/motion";
import { CORE, ink } from "@/lib/viz";
import { fmtNumber, humanCode, initials, shortDate } from "./format";

/** make_patient_widget output (plan §B7, design v3 / reference "Sleep" card): grey initials avatar, the name large, quiet
 * demographic pills, then risk (big number, thin track, drivers in sky), the 12-month Hb + weight lines, 2x2 grey lab
 * tiles, alert rows (dot + text) and suggested actions. One orange element: the band pill. */
export function PatientWidget({ widget: p }: { widget: PatientWidgetT }) {
  const reduce = useReducedMotion();
  const name = p.name ?? p.display_id ?? `Patient ${p.patient_id}`;
  const sex = p.sex === "F" ? "Female" : p.sex === "M" ? "Male" : p.sex;
  return (
    <motion.article aria-label={`Patient: ${name}`} variants={cardEnter} initial={reduce ? false : "hidden"} animate="show"
                    className="agent-widget rounded-card bg-surface dark:border dark:border-hairline p-7 min-w-0 flex flex-col gap-7">
      {/* header */}
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="w-14 h-14 shrink-0 rounded-full bg-tile text-ink grid place-items-center text-[18px] font-semibold tracking-wide" aria-hidden>
          {initials(p.name, "") || <UserRound size={22} strokeWidth={1.75} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 text-[13px] text-muted">
            <span className="tabular">{p.display_id}</span>
            {p.risk?.rank_in_facility ? <span>Rank {p.risk.rank_in_facility} in facility</span> : null}
          </div>
          <h3 className="text-h1 text-ink truncate mt-0.5">{name}</h3>
        </div>
        <Link to={p.links.case}
              className="max-sm:order-last shrink-0 inline-flex items-center gap-1.5 h-10 rounded-full bg-ink text-ink-on text-[14px] font-semibold pl-4 pr-3.5 hover:bg-ink/85 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
          Open case <ArrowUpRight size={16} aria-hidden />
        </Link>
        <ul className="basis-full flex flex-wrap gap-2 sm:pl-[72px]" aria-label="Demographics">
          {p.age !== null && <Pill icon={<CalendarDays size={14} />}>{Math.round(p.age)} years</Pill>}
          {sex && <Pill icon={<UserRound size={14} />}>{sex}</Pill>}
          {p.district_name && <Pill icon={<MapPin size={14} />}>{p.district_name}</Pill>}
          {p.home_facility_name && <Pill icon={<Building2 size={14} />}>{p.home_facility_name.replace(" (Synthetic)", "")}</Pill>}
          {p.is_case && <Pill>Diagnosed{p.dx_date ? ` ${shortDate(p.dx_date)}` : ""}</Pill>}
        </ul>
        {p.focus && <p className="basis-full sm:pl-[72px] text-[14px] leading-5 text-muted">{p.focus}</p>}
      </header>

      <div className="grid gap-x-8 gap-y-7 md:grid-cols-2">
        <Section title="Risk">
          {p.risk ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-end justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[44px] leading-[48px] font-medium tracking-[-0.02em] text-ink tabular">
                      {p.risk.probability !== null ? `${(p.risk.probability * 100).toFixed(1)}%` : "—"}
                    </span>
                  </div>
                  <span className="mb-2"><BandChip band={p.risk.band} /></span>
                </div>
                <p className="text-[13px] text-muted mt-0.5">12-month probability{p.risk.as_of ? `, scored ${shortDate(p.risk.as_of)}` : ""}</p>
                <RiskScoreBar compact score={p.risk.probability} band={p.risk.band} label="12-month probability" className="mt-3" />
              </div>
              {(p.risk.scoped_since_flag !== null && p.risk.scoped_since_flag !== undefined || p.risk.first_high_at) && (
                <ul className="flex flex-col gap-1.5 text-[14px]">
                  {p.risk.scoped_since_flag === false && <DotRow tone="signal">Not scoped since flagged</DotRow>}
                  {p.risk.scoped_since_flag === true && <DotRow tone="success">Scoped since flagged</DotRow>}
                  {p.risk.first_high_at && <DotRow tone="faint">High since {shortDate(p.risk.first_high_at)}</DotRow>}
                </ul>
              )}
              <Reasons reasons={p.risk.top_reasons} />
            </div>
          ) : <p className="text-[14px] text-muted">Not scored: diagnosed, outside the GI cohort, or no model run yet.</p>}
        </Section>

        <Section title={`Last ${p.timeline.window.months} months`}>
          <Timeline p={p} />
        </Section>

        <Section title="Latest labs">
          {p.labs.length ? (
            <div className="grid gap-2.5 grid-cols-2">
              {p.labs.slice(0, 4).map((l) => <LabTile key={l.concept_id} lab={l} />)}
            </div>
          ) : <p className="text-[14px] text-muted">No lab results in the window.</p>}
          {p.labs.length > 4 && <p className="text-[13px] text-muted mt-2.5">{p.labs.length - 4} more on the case page</p>}
        </Section>

        <div className="flex flex-col gap-7 min-w-0">
          <Section title="Alerts" count={p.alerts.length}>
            {p.alerts.length ? (
              <ul className="flex flex-col gap-3">
                {p.alerts.slice(0, 4).map((a) => (
                  <li key={a.alert_id} className="flex gap-3 min-w-0">
                    <span className={`mt-[7px] w-2 h-2 rounded-full shrink-0 ${a.severity === "HIGH" || a.severity === "CRITICAL" ? "bg-signal" : a.severity === "MEDIUM" ? "bg-warning" : "bg-sky"}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-3">
                        <span className="text-[14px] font-semibold text-ink flex-1 min-w-0">{humanCode(a.trigger)}</span>
                        <span className="text-[13px] text-muted shrink-0">{shortDate(a.created_at)}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-[13px] text-muted">
                        <span>{humanCode(a.severity)} severity</span>
                        <span>{humanCode(a.status)}</span>
                      </div>
                      {a.summary && <p className="text-[14px] leading-5 text-ink/80 mt-1">{a.summary}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[14px] text-muted"><DotInline tone="success" />No open alerts</p>}
          </Section>

          <Section title="Suggested actions">
            {p.suggested_actions.length ? (
              <ul className="flex flex-col gap-2">
                {p.suggested_actions.map((s) => (
                  <li key={s} className="rounded-tile bg-tile px-4 py-3 text-[14px] leading-5 text-ink">{s}</li>
                ))}
              </ul>
            ) : <p className="text-[14px] text-muted">Nothing suggested.</p>}
            <p className="text-[13px] text-muted mt-2.5">Decision support only. Apply clinical judgement and national guidelines.</p>
          </Section>
        </div>
      </div>
    </motion.article>
  );
}

function Pill({ icon, children }: { icon?: JSX.Element; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5 h-8 rounded-full bg-tile px-3 text-[13px] font-medium text-ink">
      {icon && <span className="text-muted" aria-hidden>{icon}</span>}{children}
    </li>
  );
}

function Section({ title, count, className = "", children }: { title: string; count?: number; className?: string; children: ReactNode }) {
  return (
    <section className={`min-w-0 ${className}`} aria-label={title}>
      <h4 className="flex items-baseline gap-2 text-[15px] font-semibold text-ink mb-3">
        {title}
        {count !== undefined && count > 0 && <span className="text-[13px] font-medium text-muted tabular">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

const DOT = { signal: "bg-signal", success: "bg-success", faint: "bg-faint", sky: "bg-sky" } as const;
function DotInline({ tone }: { tone: keyof typeof DOT }) {
  return <span className={`inline-block w-2 h-2 rounded-full mr-2 align-[1px] ${DOT[tone]}`} aria-hidden />;
}
function DotRow({ tone, children }: { tone: keyof typeof DOT; children: ReactNode }) {
  return <li className={`flex items-center gap-2.5 ${tone === "faint" ? "text-muted" : "text-ink"}`}><span className={`w-2 h-2 rounded-full shrink-0 ${DOT[tone]}`} aria-hidden />{children}</li>;
}

function Reasons({ reasons }: { reasons: NonNullable<PatientWidgetT["risk"]>["top_reasons"] }) {
  const reduce = useReducedMotion();
  const rs = reasons.filter((r) => (r.contribution ?? 0) > 0).slice(0, 4);
  const max = Math.max(0.01, ...rs.map((r) => Math.abs(r.contribution ?? 0)));
  if (!rs.length) return null;
  return (
    <div>
      <div className="text-[13px] text-muted mb-2">Why flagged</div>
      <ul className="flex flex-col gap-2.5">
        {rs.map((r, i) => (
          <li key={r.feature} className="text-[14px]">
            <div className="flex justify-between gap-3"><span className="text-ink truncate" title={r.label ?? r.feature}>{r.label ?? humanCode(r.feature)}</span>
              <span className="text-muted tabular shrink-0">+{(r.contribution ?? 0).toFixed(2)}</span></div>
            <div className="h-1.5 rounded-full bg-tile dark:bg-hairline mt-1.5 overflow-hidden" aria-hidden>
              <motion.div className="h-full rounded-full bg-sky"
                          initial={reduce ? false : { width: 0 }} animate={{ width: `${(100 * Math.abs(r.contribution ?? 0)) / max}%` }}
                          transition={{ duration: 0.7, ease: EASE, delay: reduce ? 0 : 0.2 + i * 0.06 }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabTile({ lab }: { lab: PatientLab }) {
  const v = typeof lab.latest === "number" ? fmtNumber(lab.latest) : lab.latest ?? "—";
  const ch = lab.change_pct_12m;
  return (
    <div className="rounded-tile bg-tile p-4 min-w-0 flex flex-col">
      <span className="text-[13px] text-muted truncate" title={lab.name}>{lab.name}</span>
      <div className="flex items-baseline gap-1.5 mt-2 min-w-0">
        <span className="text-[26px] leading-8 font-medium tracking-[-0.01em] text-ink tabular truncate">{v}</span>
        {lab.unit && <span className="text-[13px] text-muted">{lab.unit}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[13px]">
        <span className={`w-2 h-2 rounded-full shrink-0 ${lab.abnormal ? "bg-signal" : "bg-success"}`} aria-hidden />
        <span className="text-ink">{lab.abnormal ? "Abnormal" : "Normal"}</span>
        {ch !== null && ch !== undefined && Number.isFinite(ch) && <span className="text-muted tabular">{ch > 0 ? "+" : ""}{fmtNumber(ch)}% in 12 mo</span>}
      </div>
      <div className="text-[12px] text-muted mt-1">{shortDate(lab.latest_ts)}{lab.n > 1 ? `, ${lab.n} readings` : ""}</div>
    </div>
  );
}

/** Hb (sky) + weight (ink grey) over the window on two axes, and an event strip underneath. */
function Timeline({ p }: { p: PatientWidgetT }) {
  const mode = useThemeMode();
  const { hb, weight } = p.timeline.series;
  const start = new Date(p.timeline.window.start).getTime(), end = new Date(p.timeline.window.end).getTime();
  const C = CORE[mode];
  const option = useMemo(() => {
    const k = ink();
    const pts = (xs: { ts: string; value: number | null }[]) => xs.filter((x) => x.value !== null).map((x) => [new Date(x.ts).getTime(), x.value as number]);
    const H = pts(hb), W = pts(weight);
    /** Three even steps that always land on whole numbers, so tick labels never collide. */
    const range = (xs: number[][], lo: number, hi: number, pad: number) => {
      const v = xs.map((x) => x[1]);
      const min = Math.floor(Math.min(lo, ...v) - pad);
      const interval = Math.max(1, Math.ceil((Math.ceil(Math.max(hi, ...v) + pad) - min) / 3));
      return { min, max: min + interval * 3, interval };
    };
    const line = (name: string, data: number[][], c: string, yAxisIndex: number, width: number) => ({
      name, type: "line", data, yAxisIndex, symbol: "circle", symbolSize: 7, showSymbol: true, lineStyle: { width, color: c }, itemStyle: { color: c, borderColor: k.surface, borderWidth: 2 },
    });
    const b = base();
    const hbR = range(H, 10, 15, 0.5);
    const wR = W.length ? range(W, Infinity, -Infinity, 3) : { min: 40, max: 85, interval: 15 };
    return {
      ...b, legend: { show: false }, grid: { left: 2, right: 2, top: 10, bottom: 2, containLabel: true },
      tooltip: { ...(b.tooltip as object), trigger: "axis",
        formatter: (ps: any[]) => `<div style="font-weight:600;margin-bottom:2px">${shortDate(new Date(ps[0].value[0]).toISOString())}</div>` + ps.map((q) => `<div>${q.marker}${q.seriesName} <b>${fmtNumber(q.value[1])}</b></div>`).join("") },
      xAxis: { ...(b.xAxis as object), type: "time", min: start, max: end, axisLabel: { color: k.muted, fontSize: 11, hideOverlap: true, formatter: { month: "{MMM}", year: "{yyyy}" } }, splitNumber: 4 },
      yAxis: [
        { ...(b.yAxis as object), type: "value", ...hbR, axisLabel: { color: k.muted, fontSize: 11 } },
        { ...(b.yAxis as object), type: "value", ...wR, splitLine: { show: false }, axisLabel: { color: k.muted, fontSize: 11 } },
      ],
      series: [line("Hb (g/dL)", H, C[0], 0, 2.25), line("Weight (kg)", W, C[2], 1, 1.5)],
    } as any;
  }, [hb, weight, mode, start, end, C]);
  const latest = (xs: { value: number | null }[]) => [...xs].reverse().find((x) => x.value !== null)?.value ?? null;
  const events = p.timeline.events.filter((e) => e.event_type !== "VITAL" || e.highlight || e.is_abnormal);
  const lh = latest(hb), lw = latest(weight);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-6">
        <Latest color={C[0]} label="Hb" value={lh !== null ? fmtNumber(lh) : "—"} unit="g/dL" />
        <Latest color={C[2]} label="Weight" value={lw !== null ? fmtNumber(lw) : "—"} unit="kg" />
      </div>
      {hb.length + weight.length > 0
        ? <EChart option={option} height={140} ariaLabel={`Haemoglobin and weight over the last ${p.timeline.window.months} months`} />
        : <div className="h-[140px] grid place-items-center text-[14px] text-muted rounded-tile bg-tile">No Hb or weight readings</div>}
      <EventStrip events={events} start={start} end={end} />
    </div>
  );
}

function Latest({ color, label, value, unit }: { color: string; label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-[13px] text-muted"><span className="w-2 h-2 rounded-full" style={{ background: color }} aria-hidden />{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5"><span className="text-[22px] leading-7 font-medium text-ink tabular">{value}</span><span className="text-[13px] text-muted">{unit}</span></div>
    </div>
  );
}

/** Events as grey dots on a thin track; abnormal or key events in signal (the only colour that means something here). */
function EventStrip({ events, start, end }: { events: PatientTimelineEvent[]; start: number; end: number }) {
  const span = Math.max(1, end - start);
  const key = events.filter((e) => e.highlight || e.is_abnormal).length;
  return (
    <div>
      <div className="relative h-6" role="list" aria-label={`${events.length} events in the window, ${key} abnormal or key`}>
        <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-tile dark:bg-hairline" aria-hidden />
        {events.map((e, i) => {
          const x = ((new Date(e.ts).getTime() - start) / span) * 100;
          if (!Number.isFinite(x)) return null;
          const strong = e.highlight || e.is_abnormal;
          return (
            <span key={i} role="listitem" title={`${shortDate(e.ts)}: ${e.label ?? humanCode(e.event_type)}${e.value_num !== null && e.value_num !== undefined ? ` ${fmtNumber(e.value_num)}${e.unit ? ` ${e.unit}` : ""}` : e.value_text ? ` ${e.value_text}` : ""}`}
                  className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full ring-2 ring-surface ${strong ? "w-3 h-3 bg-signal" : "w-2.5 h-2.5 bg-faint"}`}
                  style={{ left: `${Math.max(2, Math.min(98, x))}%` }} />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[13px] text-muted">
        <span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-faint" aria-hidden />Clinical event</span>
        <span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-signal" aria-hidden />Abnormal or key</span>
      </div>
    </div>
  );
}
