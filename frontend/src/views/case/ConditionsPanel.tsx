import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { labelOf } from "@/components/three/body/util";
import { StatusChip } from "@/components/ui";
import { itemEnter, stagger } from "@/lib/motion";
import type { CaseCondition, CaseData } from "./types";
import { useCaseUI } from "./store";
import { ConditionList, concernStatus } from "./ConcernCards";

/** Severity bar on the glow ramp of the 3D body, so the list and the organ glow read the same. Value also printed. */
function SevBar({ v }: { v: number }) {
  return (
    <div className="flex items-center gap-1.5 w-[96px] shrink-0" aria-label={`severity ${Math.round(100 * v)} of 100`}>
      <div className="h-1.5 flex-1 rounded-full bg-fg/[0.07] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.max(4, 100 * v)}%`, background: `linear-gradient(90deg,#f2a541,${v > 0.6 ? "#ff4b2b" : "#f07a3a"})` }} />
      </div>
      <span className="tabular text-micro text-fg-muted w-6 text-right">{Math.round(100 * v)}</span>
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
        <button className="self-start text-label text-accent hover:underline" onClick={() => set({ selectedOrgan: null })}>Show all organs</button>
      )}
      {!groups.length && <div className="text-label text-fg-muted">No organ-linked symptoms, diagnoses or abnormal labs on record</div>}
      <motion.div className="flex flex-col gap-3" variants={stagger(0.04)} initial={reduce ? false : "hidden"} animate="show">
        {visibleGroups.map((g) => {
          const st = concernStatus(g.score);
          return (
            <motion.div key={g.organ} variants={itemEnter} ref={(el: HTMLDivElement | null) => { refs.current[g.organ] = el; }}
                        className={`rounded-tile border transition-colors p-2 ${active === g.organ ? "border-warning/70 bg-warning/5" : "border-border bg-surface-2/50"}`}>
              <button className="w-full flex items-center gap-2 px-1.5 py-1 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      onMouseEnter={() => focus([g.organ], labelOf(g.organ))} onMouseLeave={() => focus(null)}
                      onFocus={() => focus([g.organ], labelOf(g.organ))} onBlur={() => focus(null)}
                      onClick={() => set({ selectedOrgan: selected === g.organ ? null : g.organ })} aria-pressed={selected === g.organ}>
                <span className="text-[14px] font-semibold text-fg flex-1">{labelOf(g.organ)}</span>
                <StatusChip status={st.status} label={st.label} />
                <SevBar v={g.score} />
              </button>
              <div className="mt-1.5"><ConditionList conditions={g.cs} onFocus={focus} /></div>
            </motion.div>
          );
        })}
      </motion.div>
      {hiddenCount > 0 && <button className="self-start text-label text-accent hover:underline" onClick={() => setShowOld(true)}>Show {hiddenCount} older / resolved organ group{hiddenCount > 1 ? "s" : ""}</button>}
    </section>
  );
}
