import { useMemo } from "react";
import { Button } from "@heroui/react";
import { AlertTriangle, ArrowUpRight, Target } from "lucide-react";
import { AnimatedNumber, DetailModal, useDetailModal, type StatusKind } from "@/components/ui";
import { BandMark, type MarkLevel } from "@/views/doctor/BandMark";
import { Track } from "@/views/doctor/RiskCard";
import { labelOf } from "@/components/three/body/util";
import { date, monthYear } from "@/lib/format";
import type { CaseCondition, CaseData } from "./types";
import { useCaseUI } from "./store";
import { bodyStateAt } from "./bodyState";
import { organsIn } from "./SystemRail";

const CAT_LABEL: Record<string, string> = { diagnosis: "Dx", symptom: "Symptom", lab: "Lab", procedure: "Finding" };
const SHELL = new Set(["skin", "muscles", "skeleton"]);

export const concernStatus = (s: number): { status: StatusKind; label: string; level: MarkLevel } =>
  s >= 0.7 ? { status: "critical", label: "Critical", level: "high" } : s >= 0.35 ? { status: "suboptimal", label: "Elevated", level: "medium" } : { status: "optimal", label: "Low", level: "low" };

/** Conditions linked to one organ, newest first (organ detail modal + condition lists). */
export function ConditionList({ conditions, onFocus }: { conditions: CaseCondition[]; onFocus?: (organs: string[] | null, label?: string | null) => void }) {
  const replayT = useCaseUI((s) => s.replayT);
  if (!conditions.length) return <div className="text-label text-muted py-4">No organ-linked symptoms, diagnoses or abnormal labs on record</div>;
  return (
    <ul className="flex flex-col divide-y divide-hairline rounded-tile bg-surface overflow-hidden">
      {[...conditions].sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts)).map((c) => {
        const future = replayT !== null && Date.parse(c.first_ts) > replayT;
        return (
          <li key={`${c.category}-${c.concept_id}`} tabIndex={onFocus ? 0 : undefined}
              onMouseEnter={() => onFocus?.(c.organ_ids, c.label)} onMouseLeave={() => onFocus?.(null)}
              onFocus={() => onFocus?.(c.organ_ids, c.label)} onBlur={() => onFocus?.(null)}
              className={`flex items-center gap-3 px-3.5 py-2.5 text-[13px] bg-surface hover:bg-tile focus:bg-tile outline-none ${future ? "opacity-35" : ""}`}>
            <span className="w-[64px] shrink-0 text-center rounded-full bg-tile text-muted text-[11.5px] font-medium py-0.5">{CAT_LABEL[c.category]}</span>
            <span className="flex-1 min-w-0 truncate text-ink" title={c.label}>{c.label}{c.certainty === "PROVISIONAL" ? <span className="text-muted"> (provisional)</span> : null}</span>
            {c.is_alarm && <AlertTriangle size={13} className="text-signal shrink-0" aria-label="Alarm sign" />}
            <span className="text-micro text-muted tabular w-[28px] text-right">{c.count}×</span>
            <span className="text-micro text-muted tabular w-[64px] text-right">{monthYear(c.last_ts)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** One concern (reference "Prady Lhambel 89%" tile): grey tile, organ name + round open button, a big score /100, status as
 * dot + text, a thin sky track (one hue for every tile; the status dot carries attention). Hover / focus lights the organ on the body. */
function ConcernTile({ id, score, now, conditions, selected, onFocus, removed }: {
  id: string; score: number; now: number; conditions: CaseCondition[]; selected: boolean; onFocus: (o: string[] | null, label?: string | null) => void;
  /** v3 post-gastrectomy: the organ was resected (shown ghosted on the body) */
  removed?: string | null;
}) {
  const label = labelOf(id);
  const st: { status: StatusKind | string; label: string; level: MarkLevel } = removed ? { status: "optimal", label: `Removed ${removed}`, level: "none" } : concernStatus(score);
  const d = useDetailModal();
  return (
    <div onMouseEnter={() => onFocus([id], label)} onMouseLeave={() => onFocus(null)} onFocus={() => onFocus([id], label)} onBlur={() => onFocus(null)}
         className={`rounded-tile bg-tile p-4 pb-5 min-w-0 flex flex-col transition-shadow ${selected ? "ring-2 ring-ink/15" : ""}`}>
      <div className="flex items-center gap-2 min-w-0">
        <h3 className="flex-1 min-w-0 truncate text-[15px] leading-5 font-semibold text-ink">{label}</h3>
        <Button isIconOnly size="sm" radius="full" variant="light" aria-label={`${label}: conditions`} onPress={d.open}
                className="min-w-8 w-8 h-8 bg-surface text-ink data-[hover=true]:bg-surface/70 -mr-1">
          <ArrowUpRight size={15} aria-hidden />
        </Button>
      </div>
      <div className="flex items-baseline gap-1 mt-4">
        <AnimatedNumber value={Math.round(100 * score)} decimals={0} className="text-metric text-ink" />
        <span className="text-label font-normal text-muted">/100</span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1 mb-4">
        <BandMark level={st.level} label={st.label} />
        <span className="text-micro text-muted">{conditions.length} flag{conditions.length === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-auto"><Track value={score} label={`${label} involvement`} delay={0} /></div>
      <DetailModal {...d.modalProps} title={label} icon={<Target size={18} />} size="2xl"
                   subtitle={`Involvement ${Math.round(100 * now)} of 100, ${conditions.length} linked condition${conditions.length === 1 ? "" : "s"}`}
                   info="Each condition's weight × recency × repeats; the organ score is the strongest of them.">
        <ConditionList conditions={conditions} />
      </DetailModal>
    </div>
  );
}

/** "Key areas of concern": the three most involved organs of the active system; values follow the replay playhead. */
export function ConcernCards({ data, system }: { data: CaseData; system: string }) {
  const set = useCaseUI((s) => s.set);
  const replayT = useCaseUI((s) => s.replayT);
  const selected = useCaseUI((s) => s.selectedOrgan);
  const state = useMemo(() => bodyStateAt(data, replayT), [data, replayT]);
  const scores = state.organScores;
  const removedOn = data.surgery && (state.resected ?? 0) > 0.5 ? date(data.surgery.date) : null;
  const now = useMemo(() => Object.fromEntries(data.organs.map((o) => [o.organ_id, o.score])) as Record<string, number>, [data]);
  const organs = useMemo(() => {
    const ids = organsIn(data, system);
    const pool = ids.some((id) => !SHELL.has(id)) ? ids.filter((id) => !SHELL.has(id)) : ids;
    // rank by the current score so cards stay in place while the replay changes their values
    return pool.sort((a, b) => (now[b] ?? 0) - (now[a] ?? 0) + (b === "stomach" ? 1e-6 : 0) - (a === "stomach" ? 1e-6 : 0)).slice(0, 3);
  }, [data, system, now]);
  const focus = (o: string[] | null, label: string | null = null) => set({ focusOrgans: o, focusLabel: label });
  return (
    <div className={`grid gap-2.5 ${organs.length >= 3 ? "grid-cols-1 sm:grid-cols-3" : organs.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
      {organs.map((id) => (
        <ConcernTile key={id} id={id} score={scores[id] ?? 0} now={now[id] ?? 0} conditions={data.conditions.filter((c) => c.organ_ids.includes(id))}
                     selected={selected === id} onFocus={focus} removed={id === "stomach" ? removedOn : null} />
      ))}
    </div>
  );
}
