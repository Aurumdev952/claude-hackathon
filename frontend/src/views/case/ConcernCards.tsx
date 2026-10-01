import { useMemo } from "react";
import { AlertTriangle, Target } from "lucide-react";
import { MetricCard, type StatusKind } from "@/components/ui";
import { labelOf } from "@/components/three/body/util";
import { monthYear } from "@/lib/format";
import type { CaseCondition, CaseData } from "./types";
import { useCaseUI } from "./store";
import { bodyStateAt } from "./bodyState";
import { organsIn } from "./SystemRail";

const CAT_LABEL: Record<string, string> = { diagnosis: "Dx", symptom: "Symptom", lab: "Lab", procedure: "Finding" };
const SHELL = new Set(["skin", "muscles", "skeleton"]);

export const concernStatus = (s: number): { status: StatusKind; label: string } =>
  s >= 0.7 ? { status: "critical", label: "Critical" } : s >= 0.35 ? { status: "suboptimal", label: "Suboptimal" } : { status: "optimal", label: "Optimal" };

/** Conditions linked to one organ, newest first (organ detail modal + condition lists). */
export function ConditionList({ conditions, onFocus }: { conditions: CaseCondition[]; onFocus?: (organs: string[] | null, label?: string | null) => void }) {
  const replayT = useCaseUI((s) => s.replayT);
  if (!conditions.length) return <div className="text-label text-fg-muted py-4">No organ-linked symptoms, diagnoses or abnormal labs on record</div>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-tile border border-border overflow-hidden">
      {[...conditions].sort((a, b) => Date.parse(b.last_ts) - Date.parse(a.last_ts)).map((c) => {
        const future = replayT !== null && Date.parse(c.first_ts) > replayT;
        return (
          <li key={`${c.category}-${c.concept_id}`} tabIndex={onFocus ? 0 : undefined}
              onMouseEnter={() => onFocus?.(c.organ_ids, c.label)} onMouseLeave={() => onFocus?.(null)}
              onFocus={() => onFocus?.(c.organ_ids, c.label)} onBlur={() => onFocus?.(null)}
              className={`flex items-center gap-2.5 px-3 py-2 text-[12.5px] bg-surface hover:bg-surface-2 focus:bg-surface-2 outline-none ${future ? "opacity-35" : ""}`}>
            <span className="w-[58px] shrink-0 text-center rounded-full bg-surface-2 border border-border text-fg-muted text-[10.5px] font-medium py-0.5">{CAT_LABEL[c.category]}</span>
            <span className="flex-1 min-w-0 truncate text-fg" title={c.label}>{c.label}{c.certainty === "PROVISIONAL" ? <span className="text-fg-muted"> (prov.)</span> : null}</span>
            {c.is_alarm && <AlertTriangle size={12} className="text-warning shrink-0" aria-label="abnormal / alarm" />}
            <span className="text-micro text-fg-muted tabular w-[26px] text-right">{c.count}×</span>
            <span className="text-micro text-fg-muted tabular w-[62px] text-right">{monthYear(c.last_ts)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** "Key areas of concern" (reference metric cards): the three most involved organs of the active system, score /100,
 * status chip and gradient range bar; values follow the replay playhead. Hover / focus highlights the organ on the body,
 * the chevron opens the organ's conditions. */
export function ConcernCards({ data, system }: { data: CaseData; system: string }) {
  const set = useCaseUI((s) => s.set);
  const replayT = useCaseUI((s) => s.replayT);
  const selected = useCaseUI((s) => s.selectedOrgan);
  const scores = useMemo(() => bodyStateAt(data, replayT).organScores, [data, replayT]);
  const now = useMemo(() => Object.fromEntries(data.organs.map((o) => [o.organ_id, o.score])) as Record<string, number>, [data]);
  const organs = useMemo(() => {
    const ids = organsIn(data, system);
    const pool = ids.some((id) => !SHELL.has(id)) ? ids.filter((id) => !SHELL.has(id)) : ids;
    // rank by the current score so cards stay in place while the replay changes their values
    return pool.sort((a, b) => (now[b] ?? 0) - (now[a] ?? 0) + (b === "stomach" ? 1e-6 : 0) - (a === "stomach" ? 1e-6 : 0)).slice(0, 3);
  }, [data, system, now]);
  const condsOf = (id: string) => data.conditions.filter((c) => c.organ_ids.includes(id));
  const focus = (o: string[] | null, label: string | null = null) => set({ focusOrgans: o, focusLabel: label });
  return (
    <div className={`grid gap-3 ${organs.length >= 3 ? "grid-cols-1 sm:grid-cols-3" : organs.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
      {organs.map((id) => {
        const s = scores[id] ?? 0;
        const st = concernStatus(s);
        const cs = condsOf(id);
        const label = labelOf(id);
        return (
          <div key={id} onMouseEnter={() => focus([id], label)} onMouseLeave={() => focus(null)}
               onFocus={() => focus([id], label)} onBlur={() => focus(null)}
               className={`rounded-card transition-shadow ${selected === id ? "ring-2 ring-warning/60" : ""}`}>
            <MetricCard label={label} value={Math.round(100 * s)} unit="/100" decimals={0} status={st} aside={`${cs.length} flag${cs.length === 1 ? "" : "s"}`}
                        range={{ min: 0, max: 100, showMinMax: false, height: 7, label: `${label} involvement` }}
                        detailLabel={`${label}: conditions`} className="!bg-surface-2/60 !shadow-none h-full"
                        detail={{ title: label, icon: <Target size={18} />, subtitle: `Involvement ${Math.round(100 * (now[id] ?? 0))}/100 · ${cs.length} linked condition${cs.length === 1 ? "" : "s"}`, size: "2xl",
                                  info: "Each condition's weight × recency × repeats; the organ score is the strongest of them.",
                                  children: <ConditionList conditions={cs} /> }} />
          </div>
        );
      })}
    </div>
  );
}
