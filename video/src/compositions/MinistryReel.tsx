import { Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { BarGrow } from "../charts/BarGrow";
import { Choropleth, RampLegend } from "../charts/Choropleth";
import { CountUp } from "../charts/CountUp";
import { DotMatrix } from "../charts/DotMatrix";
import { FanChart } from "../charts/FanChart";
import { Funnel } from "../charts/Funnel";
import { KpiCard } from "../charts/KpiCard";
import { LineDraw } from "../charts/LineDraw";
import { StackedBars } from "../charts/StackedBars";
import { finite } from "../charts/scale";
import { ensureFonts } from "../fonts";
import { progressAt, rise } from "../lib/anim";
import { fmtDate, fmtNum } from "../lib/format";
import type { MinistryReelProps } from "../props";
import { Card, SceneFrame, SyntheticPill, useLayout, type SceneDef } from "../scenes/Frame";
import { C, R, T } from "../theme";
import { ministryScenes } from "./ministryScenes";

ensureFonts();

type SP = { p: MinistryReelProps; scenes: SceneDef[]; index: number };

/** Ministry reel: aggregates only (suppressed cells arrive as null and render as "<5"). 16:9 and 9:16 share the scenes;
 * each scene stacks its blocks when the frame is vertical. */
export function MinistryReel(p: MinistryReelProps) {
  const scenes = ministryScenes(p);
  let from = 0;
  return (
    <>
      {scenes.map((s, index) => {
        const start = from;
        from += s.duration;
        const sp = { p, scenes, index };
        const el = s.id === "title" ? <TitleScene {...sp} /> : s.id === "kpis" ? <KpiScene {...sp} /> : s.id === "asr" ? <AsrScene {...sp} />
          : s.id === "map" ? <MapScene {...sp} /> : s.id === "young" ? <YoungScene {...sp} /> : s.id === "cascade" ? <CascadeScene {...sp} />
          : s.id === "stage" ? <StageScene {...sp} /> : s.id === "care" ? <CareScene {...sp} /> : s.id === "forecast" ? <ForecastScene {...sp} />
          : s.id === "models" ? <ModelScene {...sp} /> : <MessagesScene {...sp} />;
        return <Sequence key={s.id} from={start} durationInFrames={s.duration} name={s.title}>{el}</Sequence>;
      })}
    </>
  );
}

const SEX: Record<string, string> = { ALL: "all sexes", M: "men", F: "women" };
const AGE: Record<string, string> = { ALL: "all ages", "<50": "under 50", "50-64": "aged 50 to 64", "65+": "aged 65 and over" };
const DEF: Record<string, string> = { CONFIRMED_PROBABLE: "confirmed and probable cases", CONFIRMED: "confirmed cases" };
const filterText = (p: MinistryReelProps) => `${SEX[p.filters.sex] ?? p.filters.sex}, ${AGE[p.filters.age] ?? p.filters.age}, ${DEF[p.filters.def] ?? p.filters.def}`;
const ctx = (p: MinistryReelProps) => `National surveillance, ${p.period.from} to ${p.period.to}`;

function allValues(p: MinistryReelProps): number[] {
  const v = p.districts.flatMap((d) => Object.values(d.values_by_year)).concat(Object.values(p.smoothed?.values ?? {}));
  return v.filter(finite);
}

// ------------------------------------------------------------------------------------------------ title
function TitleScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const vals = allValues(p);
  const dom: [number, number] = [Math.min(...vals, 0), Math.max(...vals, 1)];
  const mapW = L.vertical ? L.contentW - 120 : 760;
  return (
    <SceneFrame title="" context="National surveillance" index={index} scenes={scenes} hideTitle>
      <Card pad={0} style={{ position: "absolute", left: 0, top: L.vertical ? -150 : -110, width: L.contentW, height: L.contentH + (L.vertical ? 150 : 110), borderRadius: R.hero, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 72, top: 80, right: L.vertical ? 72 : 900 }}>
          <div style={{ ...T.title, color: C.muted, ...rise(progressAt(frame, 4, 26)) }}>Gastric cancer surveillance</div>
          <div style={{ ...T.hero, fontSize: L.vertical ? 112 : 124, color: C.ink, marginTop: 20, ...rise(progressAt(frame, 12, 26)) }}>
            {p.period.from} to {p.period.to}
          </div>
          <div style={{ ...T.title, fontWeight: 500, color: C.ink2, marginTop: 26, ...rise(progressAt(frame, 22, 26)) }}>Rwanda, {filterText(p)}</div>
          {p.sim_date && <div style={{ ...T.body, color: C.muted, marginTop: 6, ...rise(progressAt(frame, 22, 26)) }}>Data as of {fmtDate(p.sim_date)}</div>}
          <div style={{ marginTop: 40, ...rise(progressAt(frame, 32, 26)) }}><SyntheticPill onWhite /></div>
        </div>
        {p.geo && (
          <div style={{ position: "absolute", right: L.vertical ? 60 : 90, bottom: L.vertical ? 90 : 70, opacity: progressAt(frame, 16, 40) }}>
            <Choropleth geo={p.geo} values={p.smoothed?.values ?? {}} domain={dom} width={mapW} height={mapW * 0.86} />
          </div>
        )}
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ KPIs
function KpiScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const cols = L.vertical ? 2 : 3;
  const ks = p.kpis.slice(0, 6);
  const rows = Math.ceil(ks.length / cols);
  const gap = 28;
  const w = (L.contentW - gap * (cols - 1)) / cols;
  const h = Math.min(L.vertical ? 380 : 330, (L.contentH - gap * (rows - 1)) / rows);
  return (
    <SceneFrame title="Key figures" subtitle={`Latest year in the period, with the change on the year before`} context={ctx(p)} index={index} scenes={scenes}>
      <div style={{ display: "flex", flexWrap: "wrap", gap }}>
        {ks.map((k, i) => (
          <KpiCard key={k.label} label={k.label} value={k.value} unit={k.unit} delta={k.delta} deltaLabel={k.delta_label} higherIsBetter={k.higher_is_better}
                   spark={k.spark} decimals={k.decimals ?? 0} delay={i * 8} width={w} height={h} nullLabel="<5" />
        ))}
      </div>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ national ASR
function AsrScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const jp = p.joinpoint;
  const fitted = jp?.fitted ?? [];
  const annotation = jp?.year
    ? { x: jp.year, title: `Trend changes in ${jp.year}`, sub: `${fmtNum(jp.apc_before, 1)}% then ${fmtNum(jp.apc_after, 1)}% a year`, side: "left" as const }
    : finite(jp?.aapc ?? jp?.apc_before) && fitted.length
      ? { x: fitted[fitted.length - 1].year, y: fitted[fitted.length - 1].value ?? undefined, title: `${(jp!.aapc ?? jp!.apc_before)! >= 0 ? "+" : ""}${fmtNum(jp!.aapc ?? jp!.apc_before, 1)}% a year`, sub: "Average annual change (fitted trend)", side: "left" as const }
      : null;
  return (
    <SceneFrame title="National incidence" subtitle="Age-standardised rate per 100,000, with the 95% confidence band and the fitted trend"
                context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH }} pad={48}>
        <LineDraw width={L.contentW - 96} height={L.contentH - 96} delay={10} duration={130} decimals={1}
                  data={p.national_asr.map((d) => ({ x: d.year, y: d.value, lo: d.lo, hi: d.hi }))}
                  context={fitted.map((f) => ({ x: f.year, y: f.value }))} annotation={annotation} />
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ choropleth
function MapScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const L = useLayout();
  const years = [...new Set(p.districts.flatMap((d) => Object.entries(d.values_by_year).filter(([, v]) => v !== null).map(([y]) => y)))].sort();
  const yearPhase = years.length ? Math.min(durationInFrames * 0.55, years.length * 40) : 0;
  const per = years.length ? yearPhase / years.length : 0;
  const yi = Math.min(years.length - 1, Math.floor(Math.max(0, frame - 10) / Math.max(1, per)));
  const inSmoothed = !years.length || (frame >= 10 + yearPhase && !!p.smoothed);
  const values: Record<string, number | null> = inSmoothed && p.smoothed ? p.smoothed.values
    : Object.fromEntries(p.districts.map((d) => [d.code, d.values_by_year[years[Math.max(0, yi)]] ?? null]));
  const pooledVals = p.districts.flatMap((d) => Object.values(d.values_by_year)).filter(finite);
  const smoothVals = Object.values(p.smoothed?.values ?? {}).filter(finite);
  const domVals = inSmoothed ? smoothVals : pooledVals;
  const dom: [number, number] = domVals.length ? [Math.min(...domVals), Math.max(...domVals)] : [0, 1];
  const names = Object.fromEntries(p.districts.map((d) => [d.code, d.name]));
  const mapW = L.vertical ? L.contentW - 96 : 1060;
  const mapH = L.vertical ? mapW * 0.86 : L.contentH - 96;
  const hotFrom = inSmoothed ? 10 + yearPhase + 20 : Infinity;
  const yearLabel = inSmoothed ? (p.smoothed?.label.replace(/^Smoothed rate, /, "") ?? "").replace("-", "–") : `${Number(years[yi]) - 2}–${years[yi]}`;
  const ranked = Object.entries(values).filter(([, v]) => finite(v)).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, L.vertical ? 3 : 5);
  return (
    <SceneFrame title="Rates by district" subtitle={inSmoothed ? "Smoothed rate per 100,000; outlined districts form a high-rate cluster" : p.map_label ?? "Rate per 100,000"}
                context={ctx(p)} index={index} scenes={scenes}>
      <Card pad={48} style={{ position: "absolute", left: 0, top: 0, width: L.vertical ? L.contentW : mapW + 96, height: L.vertical ? mapH + 96 : L.contentH }}>
        <Choropleth geo={p.geo!} values={values} domain={dom} width={mapW} height={mapH} hotspots={p.hotspots} hotspotsFrom={hotFrom}
                    names={names} labelCodes={frame >= hotFrom ? p.hotspots : []} />
      </Card>
      <Card pad={48} style={L.vertical ? { position: "absolute", left: 0, top: mapH + 96 + 28, width: L.contentW, height: L.contentH - mapH - 124 }
        : { position: "absolute", left: mapW + 96 + 28, top: 0, right: 0, height: L.contentH }}>
        <div style={{ ...T.label, color: C.muted }}>{inSmoothed ? "Smoothed, pooled period" : "3-year period"}</div>
        <div style={{ ...T.display, color: C.ink, marginTop: 6 }}>{yearLabel}</div>
        <div style={{ marginTop: 28 }}><RampLegend domain={dom} unit="per 100,000" width={L.vertical ? 420 : 460} /></div>
        <div style={{ ...T.label, color: C.muted, marginTop: 40 }}>Highest rates</div>
        {ranked.map(([code, v]) => (
          <div key={code} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.hairline}`, ...T.body, fontSize: 26 }}>
            <span style={{ color: C.ink, display: "flex", alignItems: "center", gap: 12 }}>
              {p.hotspots.includes(code) && inSmoothed && <span style={{ width: 10, height: 10, borderRadius: 5, background: C.signal }} />}{names[code] ?? code}
            </span>
            <span style={{ color: C.ink2, fontWeight: 600 }}>{fmtNum(v, 1)}</span>
          </div>
        ))}
        {!ranked.length && <div style={{ ...T.body, color: C.muted, marginTop: 10 }}>All districts below 5 cases in this period.</div>}
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ young onset
function YoungScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const data = p.young_onset.map((d, i) => ({ label: String(d.year), value: d.value, highlight: i === p.young_onset.length - 1 && finite(d.value) }));
  return (
    <SceneFrame title="Young-onset cases" subtitle={p.young_onset_label ?? "Rate in under-50s"} context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH }} pad={48}>
        <BarGrow data={data} width={L.contentW - 96} height={L.contentH - 96} delay={10} stagger={5} decimals={1} />
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ cascade
function CascadeScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const steps = p.cascade.map((c) => ({ label: c.step, n: c.n }));
  return (
    <SceneFrame title="Care cascade" subtitle="Patients with stomach complaints, from first flag to diagnosis; the orange bar is the largest drop"
                context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH }} pad={56}>
        <Funnel steps={steps} width={L.contentW - 112} delay={10} stagger={14} rowHeight={Math.min(L.vertical ? 150 : 112, (L.contentH - 112) / steps.length)}
                labelWidth={L.vertical ? 0 : 400} />
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ stage shift
const STAGE_COLORS = ["#BFE1F4", "#7DC3EA", "#3593CC", C.signal];
function StageScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const pooled = (p.stage_mix_label ?? "").includes("3-year");
  const rows = p.stage_mix.map((r) => ({ label: pooled ? `${r.year - 2}–${String(r.year).slice(2)}` : String(r.year), values: [r.I, r.II, r.III, r.IV] }));
  return (
    <SceneFrame title="Stage at diagnosis" subtitle={p.stage_mix_label ?? "Share of staged cases"} context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH }} pad={48}>
        <StackedBars rows={rows} keys={["Stage I", "Stage II", "Stage III", "Stage IV"]} colors={STAGE_COLORS} width={L.contentW - 96}
                     height={L.contentH - 96} delay={10} stagger={6} />
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ care coordination
function CareScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const care = p.care!;
  const half = L.vertical ? L.contentH / 2 - 14 : L.contentH;
  const w = L.vertical ? L.contentW : (L.contentW - 28) / 2;
  return (
    <SceneFrame title="Care coordination" subtitle="Follow-up plans approved by doctors and how many were completed" context={ctx(p)} index={index} scenes={scenes}>
      <div style={{ display: "flex", flexDirection: L.vertical ? "column" : "row", gap: 28 }}>
        <Card style={{ width: w, height: half }} pad={44}>
          <div style={{ ...T.label, color: C.muted, marginBottom: 24 }}>Plans and tasks</div>
          <Funnel steps={care.funnel.map((f) => ({ label: f.step, n: f.n }))} width={w - 88} delay={10} rowHeight={Math.min(96, (half - 140) / Math.max(1, care.funnel.length))} labelWidth={L.vertical ? 0 : 260} />
        </Card>
        {care.adherence.length > 0 && (
          <Card style={{ width: w, height: half }} pad={44}>
            <div style={{ ...T.label, color: C.muted, marginBottom: 12 }}>{care.adherence_label ?? "Adherence"}</div>
            <BarGrow data={care.adherence.map((a) => ({ label: a.group, value: a.value }))} width={w - 88} height={half - 140} delay={30} unit="%" />
          </Card>
        )}
      </div>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ forecast
function ForecastScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const f = p.forecast!;
  const end = f.forecast[f.forecast.length - 1];
  return (
    <SceneFrame title={`Outlook to ${end.year}`}
                subtitle={`${f.metric === "cases" ? "New cases per year" : "Age-standardised rate per 100,000"}${f.source ? `, ${f.source.replace(/\s*\(ext_\w+\)/, "")}` : ""}; shaded fans are the 80% and 95% prediction intervals`}
                context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH }} pad={48}>
        <FanChart history={f.history} forecast={f.forecast} width={L.contentW - 96} height={L.contentH - 96} delay={10} decimals={f.metric === "cases" ? 0 : 1} />
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ models
function ModelScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const m = p.models!;
  const tiles = [
    { k: "Discrimination (AUROC)", v: m.auroc, d: 2, note: "1.00 is perfect ranking, 0.50 is chance" },
    { k: "Precision-recall (AUPRC)", v: m.auprc, d: 2, note: "Rare outcome: compare with the base rate" },
    { k: "Sensitivity at 90% specificity", v: finite(m.sens_at_spec90) ? m.sens_at_spec90 * 100 : null, d: 0, suffix: "%", note: "Cancers caught when 1 in 10 healthy patients is flagged" },
  ];
  const ppv = Math.round((m.ppv ?? 0) * 100);
  const leftW = L.vertical ? L.contentW : 820;
  const dotSpace = L.vertical ? Math.min(L.contentW - 96, L.contentH - 3 * 248 - 330) : Math.min(L.contentW - leftW - 28 - 96, L.contentH - 96 - 190 - (finite(m.lead_time_days) ? 56 : 0));
  const dot = Math.floor(dotSpace / 10 / 1.3);
  return (
    <SceneFrame title="How well the model finds cases" subtitle={`${m.name ?? "Active model"}, held-out test period`} context={ctx(p)} index={index} scenes={scenes}>
      <div style={{ display: "flex", flexDirection: "column", gap: 28, width: leftW }}>
        {tiles.map((t, i) => (
          <Card key={t.k} style={{ height: L.vertical ? 220 : (L.contentH - 56) / 3, display: "flex", alignItems: "center", justifyContent: "space-between", ...rise(progressAt(frame, i * 8, 24)) }} pad={40}>
            <div>
              <div style={{ ...T.label, color: C.muted }}>{t.k}</div>
              <div style={{ ...T.micro, color: C.muted, marginTop: 6, maxWidth: 440 }}>{t.note}</div>
            </div>
            <CountUp value={t.v} delay={10 + i * 8} duration={45} decimals={t.d} suffix={t.suffix ?? ""} style={{ ...T.metric, color: C.ink }} />
          </Card>
        ))}
      </div>
      {m.ppv !== null && (
        <Card style={L.vertical ? { position: "absolute", left: 0, right: 0, top: 3 * 248, bottom: 0 } : { position: "absolute", left: leftW + 28, right: 0, top: 0, height: L.contentH }} pad={48}>
          <div style={{ ...T.label, color: C.muted }}>For every 100 patients in the top 2% of risk scores</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 6 }}>
            <CountUp value={ppv} delay={30} duration={50} style={{ ...T.display, color: C.ink }} />
            <span style={{ ...T.title, color: C.ink2, fontWeight: 500 }}>were diagnosed with gastric cancer</span>
          </div>
          <div style={{ marginTop: 34 }}>
            <DotMatrix k={ppv} delay={30} duration={60} size={dot} gap={Math.round(dot * 0.3)} />
          </div>
          {finite(m.lead_time_days) && <div style={{ ...T.label, color: C.muted, marginTop: 28 }}>Median warning before diagnosis: {fmtNum(m.lead_time_days)} days</div>}
        </Card>
      )}
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ closing messages
function MessagesScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  return (
    <SceneFrame title="Three things to take away" subtitle="Picked by fixed rules: the largest changes in this period" context={ctx(p)} index={index} scenes={scenes}>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {p.messages.slice(0, 3).map((m, i) => {
          const pp = progressAt(frame, 10 + i * 50, 30);
          return (
            <Card key={i} style={{ display: "flex", gap: 36, alignItems: "center", minHeight: L.vertical ? 300 : (L.contentH - 56) / 3, ...rise(pp) }} pad={48}>
              <div style={{ ...T.display, color: i === 0 ? C.signal : C.faint, width: 80, flex: "0 0 auto" }}>{i + 1}</div>
              <div style={{ ...T.title, fontSize: L.vertical ? 40 : 38, lineHeight: L.vertical ? "52px" : "50px", fontWeight: 500, color: C.ink }}>{m}</div>
            </Card>
          );
        })}
      </div>
    </SceneFrame>
  );
}
