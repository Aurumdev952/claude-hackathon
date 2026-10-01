import { Tooltip } from "@heroui/react";
import { motion } from "framer-motion";
import { Bean, Bone, Brain, Hand, HeartPulse, PersonStanding, Shield, Soup, Wind, type LucideIcon } from "lucide-react";
import { SPRING } from "@/lib/motion";
import type { CaseData } from "./types";
import { useCaseUI } from "./store";

export type SystemKey = "digestive" | "circulatory" | "respiratory" | "lymphatic" | "urinary" | "nervous" | "musculoskeletal" | "integument";
export const SYSTEMS: { key: SystemKey; label: string; icon: LucideIcon }[] = [
  { key: "digestive", label: "Digestive", icon: Soup },
  { key: "circulatory", label: "Circulatory", icon: HeartPulse },
  { key: "respiratory", label: "Respiratory", icon: Wind },
  { key: "lymphatic", label: "Lymphatic", icon: Shield },
  { key: "urinary", label: "Urinary", icon: Bean },
  { key: "nervous", label: "Nervous", icon: Brain },
  { key: "musculoskeletal", label: "Musculoskeletal", icon: Bone },
  { key: "integument", label: "Skin", icon: Hand },
];
export const systemMeta = (k: string) => SYSTEMS.find((s) => s.key === k) ?? SYSTEMS[0];

/** "Whole body" shells never lead a system view. */
const SHELL = new Set(["skin", "muscles", "skeleton"]);

export function organsIn(data: CaseData, system: string): string[] {
  return Object.entries(data.body_map.organs).filter(([, o]) => o.system === system).map(([id]) => id);
}

/** Current organ scores (0..1) from the case payload. */
export const scoresOf = (data: CaseData) => Object.fromEntries(data.organs.map((o) => [o.organ_id, o.score])) as Record<string, number>;

/** The most involved organ (ties prefer the stomach, the organ this product is about). */
export function topOrgan(data: CaseData, scores = scoresOf(data), among?: string[]): string | null {
  const ids = among ?? Object.keys(scores).filter((id) => !SHELL.has(id));
  let best: string | null = null, bs = -1;
  for (const id of ids) {
    const s = (scores[id] ?? 0) + (id === "stomach" ? 1e-6 : 0);
    if (s > bs) { bs = s; best = id; }
  }
  return best;
}

export function defaultSystem(data: CaseData): SystemKey {
  const o = topOrgan(data);
  return ((o && data.body_map.organs[o]?.system) as SystemKey) || "digestive";
}

/** The system shown in the right column: the one picked in the rail, else the system of the most involved organ. */
export function useActiveSystem(data: CaseData): SystemKey {
  const picked = useCaseUI((s) => s.system);
  return (picked as SystemKey) ?? defaultSystem(data);
}

/** Thin vertical rail of body-system icons on the stage edge (reference left rail). Picking a system flies the camera to
 * its most involved organ and re-scopes the right column; a dot marks systems with involved organs. */
export function SystemRail({ data, className = "" }: { data: CaseData; className?: string }) {
  const active = useActiveSystem(data);
  const set = useCaseUI((s) => s.set);
  const scores = scoresOf(data);
  const pick = (k: SystemKey | null) => {
    if (k === null) return set({ system: null, selectedOrgan: null });
    const cands = organsIn(data, k).filter((o) => !SHELL.has(o));
    set({ system: k, selectedOrgan: cands.length ? topOrgan(data, scores, cands) : null });
  };
  const item = (key: string, label: string, Icon: LucideIcon, on: boolean, dot: boolean, onPress: () => void) => (
    <li key={key}>
      <Tooltip content={label} placement="right" delay={200} closeDelay={0} offset={10}
               classNames={{ content: "bg-fg text-bg text-xs font-medium px-2.5 py-1 rounded-lg shadow-float" }}>
        <button type="button" onClick={onPress} aria-label={label} aria-pressed={on}
                className="group relative w-9 h-9 grid place-items-center rounded-[11px] transition-colors hover:bg-fg/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          {on && <motion.span layoutId="system-rail-active" className="absolute inset-0 rounded-[11px] bg-nav shadow-[0_6px_16px_-6px_rgb(var(--nav)/0.6)]" transition={SPRING} aria-hidden />}
          <Icon size={17} className={`relative transition-colors ${on ? "text-nav-fg" : "text-fg-muted group-hover:text-fg"}`} aria-hidden />
          {dot && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-serious ring-2 ring-surface" aria-hidden />}
        </button>
      </Tooltip>
    </li>
  );
  return (
    <nav aria-label="Body systems" className={`glass rounded-[16px] shadow-tile p-1 ${className}`}>
      <ul className="flex flex-col items-center gap-0.5">
        {item("all", "Whole body", PersonStanding, false, false, () => pick(null))}
        <li aria-hidden className="w-5 h-px bg-border my-0.5" />
        {SYSTEMS.map((s) => {
          const organs = organsIn(data, s.key);
          const involved = organs.some((o) => (scores[o] ?? 0) >= 0.3);
          return item(s.key, `${s.label} system`, s.icon, active === s.key, involved, () => pick(s.key));
        })}
      </ul>
    </nav>
  );
}
