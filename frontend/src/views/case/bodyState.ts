import type { BodyState, CaseData, ReplayEvent } from "./types";

const MONTH = 30.44 * 86400_000;
const SCORED = new Set(["DIAGNOSIS", "SYMPTOM", "LAB", "ENDOSCOPY", "PATHOLOGY", "STAGING"]);
const FLASH_MS = 45 * 86400_000;
export const VITAL = { weight: 3000, sbp: 3003, pulse: 3005, temp: 3006, rr: 3007 } as const;
export const HB = 3100;

const ts = (s: string) => new Date(s).getTime();

/** Severity per (category, concept), same formula as the API's build_case so "now" and the end of a replay agree:
 *  weight x exp(-months since last / 12) x (1 + 0.15 ln count) x 1.2 if any abnormal, capped at 1. */
export function scoreAt(events: ReplayEvent[], t: number) {
  const agg = new Map<string, { w: number; last: number; n: number; alarm: boolean; organs: string[] }>();
  for (const e of events) {
    const et = ts(e.ts);
    if (et > t) break;
    if (!SCORED.has(e.event_type) || !e.organ_ids.length) continue;
    if (e.event_type === "LAB" && !e.is_abnormal) continue;
    const k = `${e.event_type === "DIAGNOSIS" || e.event_type === "SYMPTOM" || e.event_type === "LAB" ? e.event_type : "PROC"}:${e.concept_id}`;
    const a = agg.get(k) ?? { w: e.weight || 0.3, last: et, n: 0, alarm: false, organs: e.organ_ids };
    a.n += 1; a.last = et; a.alarm = a.alarm || e.is_abnormal;
    agg.set(k, a);
  }
  const organs: Record<string, number> = {};
  for (const a of agg.values()) {
    const ms = Math.max(0, (t - a.last) / MONTH);
    const sev = Math.min(1, a.w * Math.exp(-ms / 12) * (1 + 0.15 * Math.log1p(a.n - 1)) * (a.alarm ? 1.2 : 1));
    for (const o of a.organs) organs[o] = Math.max(organs[o] ?? 0, sev);
  }
  return organs;
}

function latestBefore(events: ReplayEvent[], type: string, concept: number, t: number): number | null {
  let v: number | null = null;
  for (const e of events) {
    if (ts(e.ts) > t) break;
    if (e.event_type === type && e.concept_id === concept && e.value_num !== null) v = e.value_num;
  }
  return v;
}

function firstValue(events: ReplayEvent[], type: string, concept: number): number | null {
  const e = events.find((x) => x.event_type === type && x.concept_id === concept && x.value_num !== null);
  return e?.value_num ?? null;
}

/** Body state at time t (epoch ms), or the current state when t is null. */
export function bodyStateAt(c: CaseData, t: number | null): BodyState {
  const end = ts(c.window.end);
  const at = t ?? end;
  const ev = c.events;
  let organScores: Record<string, number>;
  if (t === null) {
    organScores = Object.fromEntries(c.organs.map((o) => [o.organ_id, o.score]));
  } else {
    organScores = scoreAt(ev, at);
  }
  const flashes: Record<string, number> = {};
  if (t !== null) {
    for (const e of ev) {
      const et = ts(e.ts);
      if (et > at) break;
      if (at - et > FLASH_MS || !e.organ_ids.length || e.event_type === "VISIT") continue;
      const f = (1 - (at - et) / FLASH_MS) * Math.max(0.35, e.weight);
      for (const o of e.organ_ids) flashes[o] = Math.max(flashes[o] ?? 0, f);
    }
  }
  const vital = (concept: number) => (t === null ? c.vitals.find((v) => v.concept_id === concept)?.latest as number ?? null : latestBefore(ev, "VITAL", concept, at));
  const hb = t === null ? (c.labs.find((l) => l.concept_id === HB)?.latest as number ?? null) : latestBefore(ev, "LAB", HB, at);
  const w0 = firstValue(ev, "VITAL", VITAL.weight);
  const w = vital(VITAL.weight);
  const weightChangePct = w0 && w ? (100 * (w - w0)) / w0 : null;

  let lesion: BodyState["lesion"] = null;
  const tm = c.tumour;
  const dxAt = tm ? ts((tm.endo_date as string) ?? (c.header.dx_date as string) ?? c.window.end) : Infinity;
  if (tm && at >= dxAt) {
    lesion = { region: tm.spread.region, level: tm.spread.t_level, nodes: tm.spread.lymph_node_groups, mets: tm.spread.metastasis_sites, suspected: false, sizeMm: tm.lesion_size_mm };
  } else if (c.suspected || tm) {
    // before diagnosis (or never diagnosed): a hazy "suspected zone" whose strength follows the stomach score
    const s = organScores.stomach ?? 0;
    if (s > 0.15) lesion = { region: c.suspected?.region ?? tm?.spread.region ?? "body", level: s, nodes: 0, mets: [], suspected: true, sizeMm: null };
  }
  // post-gastrectomy (v3): after the operation the resected stomach is ghosted, the tumour is gone and organ glow from the
  // pre-operative picture decays during recovery (half-life about 4 months; findings after surgery keep their own score).
  let resected = 0;
  let recoveryMonths: number | null = null;
  const sx = c.surgery ? ts(c.surgery.date.length <= 10 ? `${c.surgery.date}T12:00:00` : c.surgery.date) : NaN;
  if (Number.isFinite(sx) && at >= sx) {
    recoveryMonths = (at - sx) / MONTH;
    resected = Math.min(1, (at - sx) / (5 * 86400_000));
    const decay = 0.3 + 0.7 * Math.exp(-recoveryMonths / 6);
    const fresh = t === null ? {} : scoreAt(ev.filter((e) => ts(e.ts) >= sx), at);
    for (const o of Object.keys(organScores)) organScores[o] = Math.max(organScores[o] * decay, fresh[o] ?? 0);
    organScores.stomach = 0;
    if (lesion && !lesion.suspected) lesion = null;
  }
  return { organScores, flashes, pulse: vital(VITAL.pulse), rr: vital(VITAL.rr), sbp: vital(VITAL.sbp), temp: vital(VITAL.temp), hb, weightChangePct, lesion,
           resected, recoveryMonths };
}

export const windowMs = (c: CaseData) => [ts(c.window.start), ts(c.window.end)] as const;
