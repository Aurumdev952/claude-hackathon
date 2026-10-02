import { Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { BodySvg, drawableScores } from "../anatomy/BodySvg";
import { CountUp } from "../charts/CountUp";
import { LineDraw } from "../charts/LineDraw";
import { Waterfall } from "../charts/Waterfall";
import { finite } from "../charts/scale";
import { ensureFonts } from "../fonts";
import { progressAt, rise } from "../lib/anim";
import { dayNum, fmtDate, fmtNum, sentence } from "../lib/format";
import type { PatientVideoProps } from "../props";
import { BodyTurntable3D } from "../scenes/BodyTurntable3D";
import { BandPill, Card, SceneFrame, SyntheticPill, useLayout, type SceneDef } from "../scenes/Frame";
import { C, FONT, R, T, scoreColor } from "../theme";
import { organGroups, patientScenes, type OrganGroup } from "./patientScenes";

ensureFonts();

type SP = { p: PatientVideoProps; scenes: SceneDef[]; index: number };

/** Patient case summary (1920x1080, 30 fps): display ID only, no names. Scenes without data are skipped. */
export function PatientCaseSummary(p: PatientVideoProps & { force2d?: boolean }) {
  const scenes = patientScenes(p);
  const groups = organGroups(p);
  let from = 0;
  return (
    <>
      {scenes.map((s, index) => {
        const start = from;
        from += s.duration;
        const sp = { p, scenes, index };
        const body = s.id === "title" ? <TitleScene {...sp} />
          : s.id === "body" ? <BodyScene {...sp} force2d={!!p.force2d} />
          : s.id === "risk" ? <RiskScene {...sp} />
          : s.id === "reasons" ? <ReasonsScene {...sp} />
          : s.id === "timeline" ? <TimelineScene {...sp} />
          : s.id.startsWith("organ-") ? <OrganScene {...sp} group={groups[Number(s.id.slice(6))]} />
          : s.id === "care" ? <CareScene {...sp} />
          : s.id === "journey" ? <JourneyScene {...sp} />
          : <SummaryScene {...sp} />;
        return <Sequence key={s.id} from={start} durationInFrames={s.duration} name={s.title}>{body}</Sequence>;
      })}
    </>
  );
}

const ctx = (p: PatientVideoProps) => `Case summary for ${p.display_id}`;
const pct = (v: number | null | undefined) => (finite(v) ? v * 100 : null);

// ------------------------------------------------------------------------------------------------ 1. title
function TitleScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const scores = drawableScores(p.organs);
  const a = progressAt(frame, 4, 26), b = progressAt(frame, 14, 26), c = progressAt(frame, 26, 26), d = progressAt(frame, 40, 30);
  const openAlerts = p.alerts?.length ?? 0;
  const top = p.risk.top_reasons[0]?.label ?? null;
  return (
    <SceneFrame title="" context="Case summary" index={index} scenes={scenes} hideTitle>
      <Card pad={0} style={{ position: "absolute", left: 0, top: -110, width: L.contentW, height: L.contentH + 110, borderRadius: R.hero, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 72, top: 80, width: 1040 }}>
          <div style={{ ...T.title, color: C.muted, ...rise(a) }}>Patient case summary</div>
          <div style={{ ...T.hero, color: C.ink, marginTop: 18, ...rise(b) }}>{p.display_id}</div>
          <div style={{ ...T.title, fontWeight: 500, color: C.ink2, marginTop: 24, ...rise(c) }}>{p.facility}</div>
          <div style={{ ...T.body, color: C.muted, marginTop: 6, ...rise(c) }}>Record as of {fmtDate(p.sim_date)}</div>
          <div style={{ display: "flex", gap: 16, marginTop: 40, alignItems: "center", ...rise(d) }}>
            <BandPill band={p.risk.band} size="lg" />
            <SyntheticPill onWhite />
          </div>
        </div>
        <div style={{ position: "absolute", right: 90, top: 30, opacity: progressAt(frame, 10, 40) }}>
          <BodySvg scores={Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v * progressAt(frame, 30, 60)]))} height={600} pulse={false} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 170, borderTop: `1px solid ${C.hairline}`, display: "flex", ...rise(progressAt(frame, 54, 30)) }}>
          {(p.risk.ensemble_prob === null && p.tumour ? [
            { k: "Stage at diagnosis", v: <span>{p.tumour.stage_group && p.tumour.stage_group !== "Unknown" ? (/^[IV]+[ABC]?$/.test(p.tumour.stage_group) ? `Stage ${p.tumour.stage_group}` : p.tumour.stage_group) : "Not staged"}</span> },
            { k: "Diagnosed", v: <span style={{ ...T.title, fontWeight: 600 }}>{fmtDate(p.tumour.dx_date)}</span>, wide: false },
            { k: "Open alerts", v: <CountUp value={openAlerts} delay={60} duration={30} /> },
            { k: "Tumour site", v: <span style={{ ...T.title, fontWeight: 600 }}>{p.tumour.lesion_location ? sentence(p.tumour.lesion_location) : "Not recorded"}</span>, wide: true },
          ] : [
            { k: "Ensemble probability", v: <CountUp value={pct(p.risk.ensemble_prob)} delay={60} duration={45} decimals={0} suffix="%" /> },
            { k: "Tier 1 points", v: <CountUp value={p.risk.t1_score} delay={60} duration={45} /> },
            { k: "Open alerts", v: <CountUp value={openAlerts} delay={60} duration={30} /> },
            { k: "Leading reason", v: <span style={{ ...T.title, fontWeight: 600 }}>{top ?? "None recorded"}</span>, wide: true },
          ]).map((x, i) => (
            <div key={i} style={{ flex: x.wide ? 2.2 : 1, padding: "34px 44px", borderLeft: i ? `1px solid ${C.hairline}` : undefined }}>
              <div style={{ ...T.label, color: C.muted }}>{x.k}</div>
              <div style={{ ...(x.wide ? T.title : T.metric), fontSize: x.wide ? 30 : 60, lineHeight: x.wide ? "38px" : "70px", color: C.ink, marginTop: 10 }}>{x.v}</div>
            </div>
          ))}
        </div>
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 2. 3D intro
function ScoreList({ groups, delay }: { groups: OrganGroup[]; delay: number }) {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      {groups.map((g, i) => {
        const pp = progressAt(frame, delay + i * 8, 30);
        return (
          <div key={g.label} style={rise(pp, 14)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 20 }}>
              <span style={{ ...T.label, fontSize: 26, color: C.ink }}>{g.label}</span>
              <span style={{ ...T.title, color: C.ink }}>{fmtNum(g.score * 100 * pp)}</span>
            </div>
            <div style={{ height: 10, borderRadius: 5, background: C.tile, marginTop: 10 }}>
              <div style={{ height: 10, borderRadius: 5, width: `${g.score * 100 * pp}%`, background: scoreColor(g.score) }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BodyScene({ p, scenes, index, force2d }: SP & { force2d: boolean }) {
  const L = useLayout();
  const groups = organGroups(p);
  const scores = drawableScores(p.organs);
  const stageW = 980;
  return (
    <SceneFrame title="Where the findings sit" subtitle="Organs coloured by how strongly the record points at them, 0 to 100"
                context={ctx(p)} index={index} scenes={scenes}>
      <Card pad={0} style={{ position: "absolute", left: 0, top: 0, width: stageW, height: L.contentH, overflow: "hidden" }}>
        <BodyTurntable3D scores={scores} focus={groups[0]?.ids ?? []} width={stageW} height={L.contentH} force2d={force2d} />
      </Card>
      <Card style={{ position: "absolute", left: stageW + 32, top: 0, width: L.contentW - stageW - 32, height: L.contentH }} pad={48}>
        <div style={{ ...T.label, color: C.muted, marginBottom: 30 }}>Organ scores</div>
        {groups.length ? <ScoreList groups={groups} delay={50} /> : <div style={{ ...T.body, color: C.muted }}>No organ findings in the record.</div>}
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 3. risk scores
function RiskScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const r = p.risk;
  const cards = [
    { k: "Tier 1 points", v: r.t1_score, suffix: "", d: 0, note: r.t1_band ? `Points band: ${sentence(r.t1_band)}` : "Checklist score" },
    { k: "Tier 2 probability", v: pct(r.t2_prob), suffix: "%", d: 0, note: "Gradient-boosted model" },
    { k: "Ensemble probability", v: pct(r.ensemble_prob), suffix: "%", d: 0, note: "Used for the band" },
  ];
  const w = (L.contentW - 3 * 28) / 4;
  const scaleW = L.contentW - 96;
  const hi = r.thresholds?.high ?? null, med = r.thresholds?.medium ?? null;
  const prob = r.ensemble_prob ?? 0;
  const maxP = Math.max(1, prob);
  const sx = (v: number) => (v / maxP) * scaleW;
  const mp = progressAt(frame, 70, 50);
  return (
    <SceneFrame title="Risk scores" subtitle="Three models agree on how urgent this record is" context={ctx(p)} index={index} scenes={scenes}>
      <div style={{ display: "flex", gap: 28 }}>
        {cards.map((c, i) => (
          <Card key={c.k} style={{ width: w, height: 340, display: "flex", flexDirection: "column", justifyContent: "space-between", ...rise(progressAt(frame, i * 8, 24)) }}>
            <div style={{ ...T.label, color: C.muted }}>{c.k}</div>
            <CountUp value={c.v} delay={10 + i * 8} duration={50} decimals={c.d} suffix={c.suffix} style={{ ...T.hero, fontSize: 104, lineHeight: "108px", color: C.ink }} />
            <div style={{ ...T.micro, color: C.muted }}>{c.note}</div>
          </Card>
        ))}
        <Card style={{ width: w, height: 340, display: "flex", flexDirection: "column", justifyContent: "space-between", ...rise(progressAt(frame, 24, 24)) }}>
          <div style={{ ...T.label, color: C.muted }}>Risk band</div>
          <div style={{ opacity: progressAt(frame, 56, 16), transform: `scale(${0.9 + 0.1 * progressAt(frame, 56, 16)})`, transformOrigin: "left center" }}>
            <BandPill band={r.band} size="lg" />
          </div>
          <div style={{ ...T.micro, color: C.muted }}>{hi !== null ? `High from ${fmtNum(hi * 100)}%` : "Band from the ensemble"}</div>
        </Card>
      </div>
      <Card style={{ marginTop: 28, height: L.contentH - 368, ...rise(progressAt(frame, 40, 24)) }} pad={48}>
        <div style={{ ...T.label, color: C.muted }}>Ensemble probability against the band cut-offs</div>
        <div style={{ position: "relative", marginTop: 130, height: 24, width: scaleW }}>
          <div style={{ position: "absolute", inset: 0, borderRadius: 12, background: C.tile }} />
          {med !== null && hi !== null && <div style={{ position: "absolute", left: sx(med), width: sx(hi) - sx(med), top: 0, bottom: 0, background: C.signalSoft }} />}
          {hi !== null && <div style={{ position: "absolute", left: sx(hi), right: 0, top: 0, bottom: 0, borderRadius: "0 12px 12px 0", background: "#F8C9B5" }} />}
          {[med, hi].map((t, i) => t !== null && (
            <div key={i} style={{ position: "absolute", left: sx(t), top: -10, height: 44, borderLeft: `2px solid ${C.surface}` }}>
              <div style={{ position: "absolute", top: -34, left: 0, transform: "translateX(-50%)", ...T.micro, color: C.muted, whiteSpace: "nowrap" }}>{fmtNum(t * 100)}%</div>
            </div>
          ))}
          {[["Low", 0, med], ["Medium", med, hi], ["High", hi, maxP]].map(([label, a, b]) => a !== null && b !== null && (
            <div key={label as string} style={{ position: "absolute", top: 40, left: sx(a as number), width: sx(b as number) - sx(a as number), textAlign: "center", ...T.label,
                                                 color: label === "High" ? C.signalText : C.muted, whiteSpace: "nowrap" }}>{label}</div>
          ))}
          <div style={{ position: "absolute", left: sx(prob * mp) - 14, top: -6, width: 36, height: 36, borderRadius: 18, background: C.signal, border: `4px solid ${C.surface}` }} />
          <div style={{ position: "absolute", left: sx(prob * mp), top: -78, transform: "translateX(-50%)", ...T.h1, color: C.ink, whiteSpace: "nowrap", opacity: mp }}>
            {fmtNum(prob * 100 * mp)}%
          </div>
        </div>
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 4. why flagged
function ReasonsScene({ p, scenes, index }: SP) {
  const L = useLayout();
  const items = p.risk.top_reasons.slice(0, 6).map((r) => ({ label: r.label, value: r.direction === "down" ? -Math.abs(r.value) : Math.abs(r.value) }));
  return (
    <SceneFrame title="Why the record was flagged" subtitle="Each factor's push on the tier 2 model, adding up from left to right (SHAP, log-odds)"
                context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH }} pad={56}>
        <Waterfall items={items} width={L.contentW - 112} rowHeight={Math.min(100, (L.contentH - 112) / (items.length + 1))} labelWidth={880}
                   delay={14} stagger={18} total={items.reduce((a, b) => a + b.value, 0)} totalLabel="Combined push" />
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 5. timeline
const LANES: { key: string; label: string; types: string[] }[] = [
  { key: "sym", label: "Symptoms", types: ["Symptom"] },
  { key: "dx", label: "Diagnoses", types: ["Diagnosis"] },
  { key: "lab", label: "Labs and vitals", types: ["Lab", "Vital sign"] },
  { key: "proc", label: "Orders and procedures", types: ["Order", "Procedure", "Referral"] },
  { key: "drug", label: "Medicines", types: ["Medicine"] },
  { key: "visit", label: "Visits", types: ["Visit"] },
];

function TimelineScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  // the axis covers the last 24 months, or less when the record is younger (no empty half-sweep)
  const end = dayNum(p.sim_date);
  const first = Math.min(...p.timeline.map((e) => dayNum(e.date)));
  const start = Math.max(end - 730, Math.floor((first - 30) / 30.44) * 30.44);
  const span = end - start;
  const months = Math.round(span / 30.44);
  const left = 340, plotW = L.contentW - 96 - left - 20;
  const lanes = LANES.filter((l) => p.timeline.some((e) => l.types.includes(e.type)));
  const laneH = Math.min(84, (L.contentH - 200) / Math.max(1, lanes.length));
  const sweep = progressAt(frame, 16, 200, (t) => t);
  const sweepDay = start + span * sweep;
  const x = (d: number) => left + ((d - start) / span) * plotW;
  const shown = p.timeline.filter((e) => dayNum(e.date) <= sweepDay);
  const latest = [...p.timeline].reverse().find((e) => e.abnormal) ?? null;
  const done = progressAt(frame, 220, 24);
  const ticks = Array.from({ length: 9 }, (_, i) => start + (i * span) / 8);
  return (
    <SceneFrame title={months >= 23 ? "24 months of record" : `The record over ${months} months`} subtitle="Each dot is one entry; orange dots are abnormal results and alarm findings"
                context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: L.contentH, position: "relative" }} pad={48}>
        <div style={{ position: "absolute", left: 48, top: 30 }}>
          <span style={{ ...T.metric, fontSize: 56, color: C.ink }}>{shown.length}</span>
          <span style={{ ...T.label, color: C.muted, marginLeft: 10 }}>entries</span>
        </div>
        <svg width={L.contentW - 96} height={L.contentH - 96} style={{ overflow: "visible", fontFamily: FONT }}>
          {ticks.map((d, i) => (
            <g key={i}>
              <line x1={x(d)} x2={x(d)} y1={70} y2={70 + lanes.length * laneH} stroke={C.grid} />
              <text x={x(d)} y={70 + lanes.length * laneH + 34} textAnchor="middle" fontSize={20} fill={C.muted}>
                {fmtDate(new Date(d * 86400000).toISOString(), false)}
              </text>
            </g>
          ))}
          {lanes.map((l, i) => (
            <g key={l.key} transform={`translate(0 ${70 + i * laneH})`}>
              <text x={0} y={laneH / 2 + 8} fontSize={24} fontWeight={500} fill={C.ink2}>{l.label}</text>
              <line x1={left} x2={left + plotW} y1={laneH / 2} y2={laneH / 2} stroke={C.hairline} strokeWidth={2} />
              {p.timeline.filter((e) => l.types.includes(e.type)).sort((a, b) => Number(!!a.abnormal) - Number(!!b.abnormal)).map((e, k) => {
                const dd = dayNum(e.date);
                if (dd > sweepDay || dd < start) return null;
                const age = (sweepDay - dd) / span;
                const pop = Math.min(1, age * 40);
                return <circle key={k} cx={x(dd)} cy={laneH / 2} r={(e.abnormal ? 11 : 8) * (0.6 + 0.4 * pop)} fill={e.abnormal ? C.signal : C.sky}
                               stroke={C.surface} strokeWidth={3} />;
              })}
            </g>
          ))}
          <line x1={x(sweepDay)} x2={x(sweepDay)} y1={56} y2={70 + lanes.length * laneH + 8} stroke={C.ink} strokeWidth={2} opacity={1 - done} />
          {latest && (() => {
            const lane = lanes.findIndex((l) => l.types.includes(latest.type));
            if (lane < 0) return null;
            const cx = x(dayNum(latest.date)), cy = 70 + lane * laneH + laneH / 2;
            return (
              <g opacity={progressAt(frame, 220, 18)}>
                <circle cx={cx} cy={cy} r={20} fill="none" stroke={C.ink} strokeWidth={2} />
                <line x1={cx} x2={cx} y1={cy - 20} y2={40} stroke={C.ink} strokeOpacity={0.5} strokeWidth={1.5} />
                <text x={cx - 14} y={34} textAnchor="end" fontSize={24} fontWeight={600} fill={C.ink}>Latest alarm: {latest.label}, {fmtDate(latest.date)}</text>
              </g>
            );
          })()}
        </svg>
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 6. organ by organ
function OrganScene({ p, scenes, index, group }: SP & { group: OrganGroup }) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const scores = drawableScores(p.organs);
  const conditions = group.organs.flatMap((o) => o.conditions).filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i)
    .sort((a, b) => b.severity - a.severity).slice(0, 5);
  const lab = group.organs.flatMap((o) => o.labs).find((l) => l.series.length >= 2) ?? group.organs.flatMap((o) => o.labs)[0] ?? null;
  const hbLab = p.organs.find((o) => o.id === "vessels")?.labs.find((l) => l.name.toLowerCase().startsWith("haemoglobin"));
  const hb = hbLab?.series.length ? hbLab.series[hbLab.series.length - 1].value : null;
  const bodyW = 820;
  const rightW = L.contentW - bodyW - 32;
  const isStomach = group.ids.includes("stomach");
  const groupNo = Number(scenes[index].id.slice(6)) + 1;
  const shownConds = lab ? conditions.slice(0, 3) : conditions;
  const findingsH = 44 * 2 + 44 + Math.max(1, shownConds.length) * 62 + (isStomach && p.tumour ? 52 : 0);
  const labVals = lab ? [...lab.series.map((s) => s.value), ...(lab.low !== null ? [lab.low] : [])] : [];
  const labMin = labVals.length ? Math.floor(Math.min(...labVals) * 0.85) : undefined;
  const rows = Math.max(1, Math.floor((L.contentH - findingsH - 28 - 88 - 40) / 56));
  const entries = p.timeline.filter((e) => e.organ_ids.some((o) => group.ids.includes(o))).slice(-rows).reverse();
  const nGroups = scenes.filter((s) => s.id.startsWith("organ-")).length;
  return (
    <SceneFrame title={group.label} subtitle={`Organ ${groupNo} of ${nGroups} with findings, score ${fmtNum(group.score * 100)} out of 100`}
                context={ctx(p)} index={index} scenes={scenes}>
      <Card pad={0} style={{ position: "absolute", left: 0, top: 0, width: bodyW, height: L.contentH, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        <div style={{ marginLeft: -40 }}>
          <BodySvg scores={scores} highlight={group.ids} height={L.contentH - 40} hb={hb}
                   callout={{ label: `${fmtNum(group.score * 100 * progressAt(frame, 10, 40))}`, value: "organ score" }} />
        </div>
      </Card>
      <Card style={{ position: "absolute", left: bodyW + 32, top: 0, width: rightW, height: findingsH, ...rise(progressAt(frame, 12, 24)) }} pad={44}>
        <div style={{ ...T.label, color: C.muted, marginBottom: 14 }}>{isStomach && p.tumour ? "Diagnosis and findings" : "Findings"}</div>
        {isStomach && p.tumour && (
          <div style={{ ...T.title, color: C.ink, marginBottom: 10 }}>
            Gastric cancer{p.tumour.stage_group && p.tumour.stage_group !== "Unknown" ? `, stage ${p.tumour.stage_group}` : ""}
            <span style={{ ...T.label, color: C.muted, marginLeft: 14 }}>{fmtDate(p.tumour.dx_date)}</span>
          </div>
        )}
        {shownConds.map((c, i) => (
          <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 20, height: 62, borderTop: i ? `1px solid ${C.hairline}` : undefined,
                                     ...rise(progressAt(frame, 20 + i * 8, 20), 10) }}>
            <span style={{ width: 12, height: 12, borderRadius: 6, background: scoreColor(c.severity), flex: "0 0 auto" }} />
            <span style={{ ...T.body, color: C.ink, flex: 1 }}>{c.name}</span>
            <span style={{ ...T.label, color: C.muted }}>{fmtDate(c.date)}</span>
          </div>
        ))}
        {!conditions.length && <div style={{ ...T.body, color: C.muted }}>No conditions mapped to this organ.</div>}
      </Card>
      <Card style={{ position: "absolute", left: bodyW + 32, top: findingsH + 28, width: rightW, height: L.contentH - findingsH - 28, ...rise(progressAt(frame, 40, 24)) }} pad={44}>
        {lab ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ ...T.label, color: C.muted }}>{lab.name}{lab.unit ? `, ${lab.unit}` : ""}</div>
              {lab.low !== null && lab.high !== null && <div style={{ ...T.micro, color: C.muted }}>Shaded: normal range {fmtNum(lab.low, lab.low % 1 ? 1 : 0)} to {fmtNum(lab.high, lab.high % 1 ? 1 : 0)}</div>}
            </div>
            <div style={{ marginTop: 18 }}>
              <LineDraw width={rightW - 88} height={Math.max(120, L.contentH - findingsH - 28 - 88 - 60)} delay={50} duration={60} decimals={1} yMin={labMin}
                        data={lab.series.map((s) => ({ x: dayNum(s.date), y: s.value, lo: lab.low, hi: lab.high }))}
                        xFormat={(d) => fmtDate(new Date(d * 86400000).toISOString(), false)} />
            </div>
          </>
        ) : (
          <>
            <div style={{ ...T.label, color: C.muted, marginBottom: 8 }}>Recent entries for {group.ids.length > 1 ? "these organs" : "this organ"}</div>
            {entries.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 20, height: 56, borderTop: i ? `1px solid ${C.hairline}` : undefined, ...rise(progressAt(frame, 46 + i * 6, 18), 8) }}>
                <span style={{ ...T.label, color: C.muted, width: 170 }}>{fmtDate(e.date)}</span>
                <span style={{ ...T.body, fontSize: 26, color: C.ink, flex: 1 }}>{e.label}</span>
                <span style={{ ...T.micro, color: e.abnormal ? C.signalText : C.muted }}>{e.abnormal ? "Abnormal" : e.type}</span>
              </div>
            ))}
            {!entries.length && <div style={{ ...T.body, color: C.muted }}>No other entries in the last 24 months.</div>}
          </>
        )}
      </Card>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 7. care plan
const TASK_TONE = (s: string) => {
  const x = s.toUpperCase();
  if (x === "COMPLETED") return { dot: C.success, text: C.successText, label: "Done" };
  if (x === "OVERDUE" || x === "ESCALATED") return { dot: C.signal, text: C.signalText, label: sentence(x) };
  if (x === "DECLINED" || x === "CANCELLED") return { dot: C.faint, text: C.muted, label: sentence(x) };
  return { dot: C.sky, text: C.ink2, label: sentence(x) };
};

function CareScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const plans = (p.care?.plans ?? []).slice(0, 2);
  return (
    <SceneFrame title="Care plan and follow-up" subtitle="What was agreed and where each step stands" context={ctx(p)} index={index} scenes={scenes}>
      <div style={{ display: "flex", gap: 28, height: L.contentH }}>
        {plans.map((pl, pi) => {
          const tasks = pl.tasks.slice(0, 7);
          const done = tasks.filter((t) => t.status.toUpperCase() === "COMPLETED").length;
          return (
            <Card key={pi} style={{ flex: 1, ...rise(progressAt(frame, pi * 10, 24)) }} pad={48}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ ...T.title, color: C.ink }}>{sentence(pl.pathway)}</div>
                <div style={{ ...T.label, color: C.muted }}>{done} of {pl.tasks.length} done</div>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: C.tile, margin: "18px 0 24px" }}>
                <div style={{ height: 8, borderRadius: 4, background: C.sky, width: `${(100 * done * progressAt(frame, 30, 40)) / Math.max(1, pl.tasks.length)}%` }} />
              </div>
              {tasks.map((t, i) => {
                const tone = TASK_TONE(t.status);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 18, padding: "14px 0", borderTop: `1px solid ${C.hairline}`, ...rise(progressAt(frame, 24 + i * 8, 20), 10) }}>
                    <span style={{ width: 14, height: 14, borderRadius: 7, background: tone.dot, flex: "0 0 auto" }} />
                    <span style={{ ...T.body, fontSize: 26, color: C.ink, flex: 1 }}>{t.title}</span>
                    <span style={{ ...T.label, color: tone.text }}>{tone.label}</span>
                    <span style={{ ...T.micro, color: C.muted, width: 170, textAlign: "right" }}>{t.completed ? fmtDate(t.completed) : t.due ? `due ${fmtDate(t.due)}` : ""}</span>
                  </div>
                );
              })}
            </Card>
          );
        })}
      </div>
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 8. recovery journey
function JourneyScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const j = p.journey!;
  const phases = j.phases.filter((ph) => ph.start);
  // the phases as a stepper (the app's journey track): done in ink, the current phase in signal orange, upcoming as
  // hollow dots. Up to 12 phases fit one row at 1920 px; a Gantt of 9+ rows does not fit beside the recovery cards.
  const shown = phases.slice(-12);
  const W = L.contentW - 96;
  const step = shown.length > 1 ? W / (shown.length - 1) : 0;
  const series = Object.entries(j.recovery?.series ?? {}).filter(([, v]) => v.length >= 2).slice(0, 3);
  const NAMES: Record<string, string> = { weight: "Weight (kg)", hb: "Haemoglobin (g/dL)", b12: "Vitamin B12 (pg/mL)", albumin: "Albumin (g/dL)", ecog: "ECOG performance" };
  const chemo = j.recovery?.chemo;
  const units = series.length + (chemo && finite(chemo.planned) ? 0.8 : 0);
  const cardW = (L.contentW - 28 * (Math.ceil(units) - 1)) / Math.max(1, units);
  const state = (s: string) => { const u = s.toUpperCase(); return u === "DONE" ? "done" : u === "CURRENT" || u === "ACTIVE" ? "current" : u === "MISSED" ? "missed" : "upcoming"; };
  const line = progressAt(frame, 6, 40);
  return (
    <SceneFrame title="Recovery journey" subtitle="Treatment phases since diagnosis and how recovery is tracking" context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ height: series.length ? 330 : L.contentH }} pad={48}>
        <svg width={W} height={220} style={{ fontFamily: FONT, overflow: "visible" }}>
          <line x1={0} y1={70} x2={W} y2={70} stroke={C.tile} strokeWidth={6} strokeLinecap="round" />
          <line x1={0} y1={70} x2={W * line} y2={70} stroke={C.hairline} strokeWidth={6} strokeLinecap="round" />
          {shown.map((ph, i) => {
            const st = state(ph.status);
            const cx = shown.length > 1 ? i * step : W / 2;
            const pp = progressAt(frame, 10 + i * 6, 18);
            const anchor = i === 0 ? "start" : i === shown.length - 1 ? "end" : "middle";
            return (
              <g key={i} opacity={pp}>
                {st === "current" && <circle cx={cx} cy={70} r={22} fill={C.signalSoft} />}
                <circle cx={cx} cy={70} r={st === "current" ? 13 : 10} fill={st === "done" ? C.ink : st === "current" ? C.signal : C.surface}
                        stroke={st === "done" ? C.ink : st === "current" ? C.signal : C.faint} strokeWidth={3} strokeDasharray={st === "missed" ? "4 4" : undefined} />
                <text x={cx} y={124} textAnchor={anchor} fontSize={22} fontWeight={st === "current" ? 600 : 500}
                      fill={st === "upcoming" ? C.muted : C.ink}>{sentence(ph.phase)}</text>
                <text x={cx} y={156} textAnchor={anchor} fontSize={18} fill={C.muted}>{fmtDate(ph.start!)}</text>
                {st === "missed" && <text x={cx} y={184} textAnchor={anchor} fontSize={18} fill={C.signalText}>Missed</text>}
              </g>
            );
          })}
        </svg>
      </Card>
      {series.length > 0 && (
        <div style={{ display: "flex", gap: 28, marginTop: 28, height: L.contentH - 358 }}>
          {series.map(([k, v], i) => (
            <Card key={k} style={{ flex: 1, minWidth: 0, ...rise(progressAt(frame, 40 + i * 10, 24)) }} pad={36}>
              <div style={{ ...T.label, color: C.muted }}>{NAMES[k] ?? sentence(k)}</div>
              <div style={{ ...T.metric, fontSize: 52, color: C.ink, margin: "8px 0 4px" }}>{fmtNum(v[v.length - 1].value, 1)}</div>
              <LineDraw compact width={cardW - 72} height={L.contentH - 358 - 190} delay={50 + i * 10} duration={50}
                        yMin={Math.min(...v.map((s) => s.value)) * 0.97} data={v.map((s) => ({ x: dayNum(s.date), y: s.value }))} />
            </Card>
          ))}
          {chemo && finite(chemo.planned) && (
            <Card style={{ flex: 0.8, minWidth: 0 }} pad={36}>
              <div style={{ ...T.label, color: C.muted }}>Chemotherapy cycles</div>
              <div style={{ ...T.metric, fontSize: 52, color: C.ink, margin: "8px 0 16px" }}>{fmtNum(chemo.done)} of {fmtNum(chemo.planned)}</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {Array.from({ length: chemo.planned }, (_, i) => (
                  <span key={i} style={{ width: 26, height: 26, borderRadius: 13, background: i < (chemo.done ?? 0) ? C.sky : C.tile }} />
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </SceneFrame>
  );
}

// ------------------------------------------------------------------------------------------------ 9. summary
function SummaryScene({ p, scenes, index }: SP) {
  const frame = useCurrentFrame();
  const L = useLayout();
  const groups = organGroups(p).slice(0, 4);
  const reasons = p.risk.top_reasons.slice(0, 3);
  const leftW = 620;
  return (
    <SceneFrame title="Summary" subtitle={`${p.display_id} at ${p.facility}`} context={ctx(p)} index={index} scenes={scenes}>
      <Card style={{ position: "absolute", left: 0, top: 0, width: leftW, height: L.contentH, display: "flex", flexDirection: "column", justifyContent: "space-between", ...rise(progressAt(frame, 0, 24)) }} pad={52}>
        <div>
          <div style={{ ...T.label, color: C.muted }}>Risk band</div>
          <div style={{ marginTop: 18 }}><BandPill band={p.risk.band} size="lg" /></div>
        </div>
        {finite(p.risk.ensemble_prob) || !p.tumour ? (
          <div>
            <div style={{ ...T.label, color: C.muted }}>Ensemble probability</div>
            <div style={{ ...T.hero, color: C.ink, marginTop: 6 }}>{finite(p.risk.ensemble_prob) ? `${fmtNum(p.risk.ensemble_prob * 100)}%` : "–"}</div>
            <div style={{ display: "flex", gap: 40, marginTop: 26 }}>
              <div><div style={{ ...T.micro, color: C.muted }}>Tier 1 points</div><div style={{ ...T.title, color: C.ink }}>{fmtNum(p.risk.t1_score)}</div></div>
              <div><div style={{ ...T.micro, color: C.muted }}>Tier 2</div><div style={{ ...T.title, color: C.ink }}>{finite(p.risk.t2_prob) ? `${fmtNum(p.risk.t2_prob * 100)}%` : "–"}</div></div>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ ...T.label, color: C.muted }}>Stage at diagnosis</div>
            <div style={{ ...T.hero, color: C.ink, marginTop: 6 }}>{p.tumour.stage_group && p.tumour.stage_group !== "Unknown" ? (/^[IV]+[ABC]?$/.test(p.tumour.stage_group) ? `Stage ${p.tumour.stage_group}` : p.tumour.stage_group) : "–"}</div>
            <div style={{ ...T.label, color: C.muted, marginTop: 18 }}>Diagnosed {fmtDate(p.tumour.dx_date)}{p.tumour.lesion_location ? `, ${p.tumour.lesion_location}` : ""}</div>
          </div>
        )}
        <div style={{ ...T.micro, color: C.muted }}>Synthetic record generated for demonstration. Not a real patient.</div>
      </Card>
      <div style={{ position: "absolute", left: leftW + 28, top: 0, right: 0, height: L.contentH, display: "flex", flexDirection: "column", gap: 28 }}>
        <Card style={{ ...rise(progressAt(frame, 10, 24)) }} pad={44}>
          <div style={{ ...T.label, color: C.muted, marginBottom: 12 }}>{reasons.length ? "Main reasons" : "Organs with findings"}</div>
          {reasons.map((r, i) => (
            <div key={i} style={{ ...T.body, color: C.ink, padding: "8px 0", display: "flex", gap: 16, alignItems: "center" }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: r.direction === "up" ? C.signal : C.sky }} />{r.label}
            </div>
          ))}
          {groups.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
              {groups.map((g) => (
                <span key={g.label} style={{ ...T.label, background: C.tile, borderRadius: R.pill, padding: "8px 18px", color: C.ink2 }}>
                  {g.label} {fmtNum(g.score * 100)}
                </span>
              ))}
            </div>
          )}
        </Card>
        {!p.next_step && p.care?.plans[0] && (() => {
          const pl = p.care!.plans[0];
          const done = pl.tasks.filter((t) => t.status.toUpperCase() === "COMPLETED").length;
          const next = pl.tasks.find((t) => t.status.toUpperCase() !== "COMPLETED" && t.status.toUpperCase() !== "CANCELLED");
          return (
            <Card style={{ ...rise(progressAt(frame, 30, 24)) }} pad={44}>
              <div style={{ ...T.label, color: C.muted }}>{sentence(pl.pathway)}: {done} of {pl.tasks.length} steps done</div>
              {next && <div style={{ ...T.title, fontSize: 36, lineHeight: "46px", color: C.ink, marginTop: 10 }}>Next: {next.title}{next.due ? `, due ${fmtDate(next.due)}` : ""}</div>}
            </Card>
          );
        })()}
        {p.next_step && (
          <Card style={{ background: C.signalSoft, ...rise(progressAt(frame, 30, 24)) }} pad={44}>
            <div style={{ ...T.label, color: C.signalText }}>Suggested next step</div>
            <div style={{ ...T.title, fontSize: 36, lineHeight: "46px", color: C.ink, marginTop: 10 }}>{p.next_step}</div>
          </Card>
        )}
      </div>
    </SceneFrame>
  );
}
