import type { MinistryReelProps } from "../props";
import type { SceneDef } from "../scenes/Frame";

const has = (xs: { value?: number | null; n?: number | null }[]) => xs.some((x) => (x.value ?? x.n) !== null && (x.value ?? x.n) !== undefined);

/** Scenes with data, in order (null data -> scene skipped), with durations in frames at 30 fps. */
export function ministryScenes(p: MinistryReelProps): SceneDef[] {
  const s: SceneDef[] = [{ id: "title", title: "Period", duration: 120 }];
  if (p.kpis.length) s.push({ id: "kpis", title: "Key figures", duration: 210 });
  if (has(p.national_asr)) s.push({ id: "asr", title: "National trend", duration: 240 });
  if (p.geo && (p.districts.some((d) => Object.values(d.values_by_year).some((v) => v !== null)) || p.smoothed)) s.push({ id: "map", title: "Districts", duration: 300 });
  if (has(p.young_onset)) s.push({ id: "young", title: "Young onset", duration: 180 });
  if (has(p.cascade)) s.push({ id: "cascade", title: "Care cascade", duration: 210 });
  if (p.stage_mix.some((r) => r.IV !== null)) s.push({ id: "stage", title: "Stage shift", duration: 210 });
  if (p.care && (has(p.care.funnel) || has(p.care.adherence))) s.push({ id: "care", title: "Care coordination", duration: 210 });
  if (p.forecast?.forecast.length) s.push({ id: "forecast", title: "Forecast", duration: 240 });
  if (p.models && p.models.auroc !== null) s.push({ id: "models", title: "Model performance", duration: 210 });
  if (p.messages.length) s.push({ id: "messages", title: "Key messages", duration: 90 + 60 * p.messages.length });
  return s;
}
