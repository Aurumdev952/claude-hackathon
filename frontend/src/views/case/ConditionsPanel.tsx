import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { labelOf } from "@/components/three/body/util";
import { BandMark } from "@/views/doctor/BandMark";
import { itemEnter, stagger } from "@/lib/motion";
import type { CaseCondition, CaseData } from "./types";
import { useCaseUI } from "./store";
import { ConditionList, concernStatus } from "./ConcernCards";

/** Severity bar: thin track, one solid sky fill, value printed beside it (the status mark carries attention). */
function SevBar({ v }: { v: number }) {
  return (
    <div className="flex items-center gap-2 w-[110px] shrink-0" aria-label={`severity ${Math.round(100 * v)} of 100`}>
      <div className="h-1.5 flex-1 rounded-full bg-surface overflow-hidden">
        <div className="h-full rounded-full bg-sky" style={{ width: `${Math.max(4, 100 * v)}%` }} />
      </div>
      <span className="tabular text-micro text-muted w-6 text-right">{Math.round(100 * v)}</span>
    </div>
  );
}

/** Conditions grouped by organ (two-way linked with the 3D body); shown in the "Key areas of concern" detail modal. */
export function ConditionsPanel({ data }: { data: CaseData }) {
  const reduce = useReducedMotion();
  const set = useCaseUI((s) => s.set);
  const hovered = useCaseUI((s) => s.hoveredOrgan);
  const selected = useCaseUI((s) => s.selectedOrgan);
  const groups = useMemo(() => {
    const byOrgan = new Map<string, CaseCondition[]>();
    for (const c of data.conditions) {
      const primary = c.organ_ids[0];
      if (!byOrgan.has(primary)) byOrgan.set(primary, []);
      byOrgan.get(primary)!.push(c);
    }
    const score = Object.fromEntries(data.organs.map((o) => [o.organ_id, o.score]));
    return [...byOrgan.entries()].map(([organ, cs]) => ({ organ, score: score[organ] ?? 0, cs })).sort((a, b) => b.score - a.score);
  }, [data]);
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const active = selected ?? hovered;
  useEffect(() => {
    if (active && refs.current[active]) refs.current[active]!.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const [showOld, setShowOld] = useState(false);
  const scoped = selected ? groups.filter((g) => g.cs.some((c) => c.organ_ids.includes(selected))) : groups;
  // conditions that have decayed to ~0 (old, one-off) fold away so the list leads with what matters now
  const visibleGroups = showOld || selected ? scoped : scoped.filter((g) => g.score >= 0.05);
  const hiddenCount = scoped.length - visibleGroups.length;
  const focus = (organs: string[] | null, label: string | null = null) => set({ focusOrgans: organs, focusLabel: label });

  return (
    <section className="flex flex-col gap-3" aria-label="Conditions by organ">
      {selected && (
        <button className="self-start text-label text-ink underline underline-offset-4 decoration-hairline hover:decoration-ink" onClick={() => set({ selectedOrgan: null })}>Show all organs</button>
      )}
      {!groups.length && <div className="text-label text-muted">No organ-linked symptoms, diagnoses or abnormal labs on record</div>}
      <motion.div className="flex flex-col gap-2.5" variants={stagger(0.04)} initial={reduce ? false : "hidden"} animate="show">
        {visibleGroups.map((g) => {
          const st = concernStatus(g.score);
          return (
            <motion.div key={g.organ} variants={itemEnter} ref={(el: HTMLDivElement | null) => { refs.current[g.organ] = el; }}
                        className={`rounded-tile bg-tile transition-shadow p-2.5 ${active === g.organ ? "ring-2 ring-ink/15" : ""}`}>
              <button className="w-full flex items-center gap-3 px-2 py-1.5 text-left rounded-full focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                      onMouseEnter={() => focus([g.organ], labelOf(g.organ))} onMouseLeave={() => focus(null)}
                      onFocus={() => focus([g.organ], labelOf(g.organ))} onBlur={() => focus(null)}
                      onClick={() => set({ selectedOrgan: selected === g.organ ? null : g.organ })} aria-pressed={selected === g.organ}>
                <span className="text-[15px] font-semibold text-ink flex-1">{labelOf(g.organ)}</span>
                <BandMark level={st.level} label={st.label} />
                <SevBar v={g.score} />
              </button>
              <div className="mt-2"><ConditionList conditions={g.cs} onFocus={focus} /></div>
            </motion.div>
          );
        })}
      </motion.div>
      {hiddenCount > 0 && <button className="self-start text-label text-ink underline underline-offset-4 decoration-hairline hover:decoration-ink" onClick={() => setShowOld(true)}>Show {hiddenCount} older or resolved organ group{hiddenCount > 1 ? "s" : ""}</button>}
    </section>
  );
}
