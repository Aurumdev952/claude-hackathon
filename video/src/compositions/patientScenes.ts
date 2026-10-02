import type { PatientVideoProps } from "../props";
import type { SceneDef } from "../scenes/Frame";

export const FPS = 30;
const HIDDEN = new Set(["skin", "muscles", "skeleton"]);

export type OrganGroup = { ids: string[]; label: string; score: number; organs: PatientVideoProps["organs"] };

const joinLabels = (xs: string[]) => {
  const l = xs.map((x, i) => (i ? x.toLowerCase() : x));
  return l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
};

/** Organs with a score, in score order, merged when they carry the same score and the same leading condition (one
 * finding such as melaena maps to several bowel segments), at most five groups. */
export function organGroups(p: PatientVideoProps): OrganGroup[] {
  const groups: OrganGroup[] = [];
  for (const o of p.organs.filter((x) => x.score > 0.01 && !HIDDEN.has(x.id)).sort((a, b) => b.score - a.score)) {
    const g = groups.find((x) => Math.abs(x.score - o.score) < 1e-3 && x.organs[0].conditions[0]?.name === o.conditions[0]?.name);
    if (g) { g.ids.push(o.id); g.organs.push(o); g.label = joinLabels(g.organs.map((x) => x.label)); }
    else groups.push({ ids: [o.id], label: o.label, score: o.score, organs: [o] });
  }
  return groups.slice(0, 5);
}

/** Scenes with data, in order, with their durations in frames (calculateMetadata sums them). */
export function patientScenes(p: PatientVideoProps): SceneDef[] {
  const s: SceneDef[] = [
    { id: "title", title: "Case", duration: 150 },
    { id: "body", title: "Body overview", duration: 120 },
  ];
  if (p.risk.t1_score !== null || p.risk.ensemble_prob !== null) s.push({ id: "risk", title: "Risk scores", duration: 210 });
  if (p.risk.top_reasons.length) s.push({ id: "reasons", title: "Why flagged", duration: 240 });
  if (p.timeline.length) s.push({ id: "timeline", title: "24-month record", duration: 300 });
  organGroups(p).forEach((g, i) => s.push({ id: `organ-${i}`, title: g.label, duration: 210 }));
  if (p.care?.plans.length) s.push({ id: "care", title: "Care plan", duration: 210 });
  if (p.journey?.phases.length) s.push({ id: "journey", title: "Recovery journey", duration: 240 });
  s.push({ id: "summary", title: "Summary", duration: 210 });
  return s;
}
