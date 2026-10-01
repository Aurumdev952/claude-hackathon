import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, RotateCcw } from "lucide-react";
import { InfoHint, Seg } from "@/components/ui";
import { SERIES, STATUS } from "@/lib/viz";
import { monthYear } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { useWidth } from "@/views/doctor/Timeline";
import type { CaseData, ReplayEvent } from "./types";
import { useCaseUI } from "./store";

const MONTH = 30.44 * 86400_000;
const LANES = [
  { key: "SYMPTOM", label: "Symptoms" }, { key: "DIAGNOSIS", label: "Diagnoses" }, { key: "LAB", label: "Labs" },
  { key: "VITAL", label: "Vitals" }, { key: "DRUG", label: "Medicines" }, { key: "PROC", label: "Endoscopy" },
];
const laneOf = (e: ReplayEvent) => (["ENDOSCOPY", "PATHOLOGY", "STAGING"].includes(e.event_type) ? "PROC" : LANES.some((l) => l.key === e.event_type) ? e.event_type : null);
const ABOUT = "Press play to watch symptoms, labs and findings light up the body in the order they were recorded. Drag across the lanes to scrub; the organ scores, labels and vitals follow the playhead.";

/** Timeline replay (glass card over the stage): scrub or play through the window; the body re-renders each organ's state
 * at the playhead. */
export function ReplayBar({ data }: { data: CaseData }) {
  const t0 = Date.parse(data.window.start), t1 = Date.parse(data.window.end);
  const { theme } = useTheme();
  const pal = SERIES[theme];
  const LANE_COLOR: Record<string, string> = { SYMPTOM: pal[1], DIAGNOSIS: pal[2], LAB: pal[3], VITAL: pal[0], DRUG: pal[4], PROC: pal[7] };

  const { replayT, playing, speed, set } = useCaseUI();
  const raf = useRef<number>();
  useEffect(() => {
    if (!playing) return;
    // position follows the wall clock since Play, so replay speed does not depend on the frame rate
    const started = performance.now();
    const base = useCaseUI.getState().replayT ?? t0;
    let lastPush = 0;
    const tick = (now: number) => {
      const cur = base + ((now - started) / 1000) * speed * MONTH;
      if (cur >= t1) { set({ replayT: t1, playing: false }); return; }
      if (now - lastPush >= 33) { set({ replayT: cur }); lastPush = now; }   // ~30 store updates/s is plenty for the panels
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current!);
  }, [playing, speed, t0, t1, set]);

  const ev = useMemo(() => data.events.filter((e) => laneOf(e) && (e.event_type !== "LAB" || e.is_abnormal || e.organ_ids.length)), [data.events]);
  // drawn in real pixels (no viewBox scaling) so the 10-11px labels stay readable at any width
  const [box, W] = useWidth<HTMLDivElement>(600);
  const left = 78, laneH = 12, H = LANES.length * laneH + 16;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - 6);
  const head = replayT ?? t1;
  const years: number[] = [];
  for (let y = new Date(t0).getFullYear() + 1; y <= new Date(t1).getFullYear(); y++) years.push(y);
  const recent = ev.filter((e) => Date.parse(e.ts) <= head && e.event_type !== "VITAL").slice(-2).reverse();

  const play = () => {
    if (playing) return set({ playing: false });
    const start = replayT === null || replayT >= t1 - MONTH / 4 ? t0 : replayT;
    set({ replayT: start, playing: true, selectedOrgan: null });
  };
  return (
    <div className="glass rounded-[18px] shadow-float px-3 pt-2.5 pb-2 flex flex-col gap-1.5 pointer-events-auto" aria-label="Timeline replay">
      <div className="flex items-center gap-2 flex-wrap">
        <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={play} aria-label={playing ? "Pause replay" : "Play replay"}
                       className="h-8 pl-2.5 pr-3.5 rounded-full bg-signal-strong text-signal-on text-[12px] font-semibold inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2">
          {playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
          {playing ? "Pause" : replayT === null ? `Replay ${data.window.months} months` : "Play"}
        </motion.button>
        <Seg label="Replay speed" value={String(speed)} onChange={(v) => set({ speed: Number(v) })}
             options={[0.75, 1.5, 4].map((s) => ({ value: String(s), label: `${s}×`, title: `${s} months per second` }))} />
        <button type="button" className="h-7 px-2.5 rounded-full inline-flex items-center gap-1 text-[11.5px] font-medium text-fg-muted hover:text-fg hover:bg-fg/5 disabled:opacity-40 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                onClick={() => set({ replayT: null, playing: false })} disabled={replayT === null} aria-label="Back to current state">
          <RotateCcw size={12} aria-hidden /> Now
        </button>
        <div className="flex-1" />
        <div className="tabular text-[12.5px] font-semibold text-fg" aria-live="polite">{replayT === null ? "Current state" : monthYear(new Date(head).toISOString())}</div>
        <InfoHint content={ABOUT} size={13} title="Timeline replay" label="About the replay" placement="top-end" />
      </div>
      <div className="relative" ref={box}>
        <svg width={W} height={H} className="block" aria-hidden>
          {LANES.map((l, i) => (
            <g key={l.key}>
              <line x1={left} x2={W - 6} y1={i * laneH + laneH / 2 + 1} y2={i * laneH + laneH / 2 + 1} stroke="rgb(var(--fg))" strokeOpacity={0.07} />
              <circle cx={4} cy={i * laneH + laneH / 2 + 1} r={2.8} fill={LANE_COLOR[l.key]} />
              <text x={11} y={i * laneH + laneH / 2 + 4.5} fontSize={10} fill="rgb(var(--fg-muted))">{l.label}</text>
            </g>
          ))}
          {years.map((y) => {
            const xx = x(Date.parse(`${y}-01-01T00:00:00`));
            return <g key={y}><line x1={xx} x2={xx} y1={0} y2={H - 13} stroke="rgb(var(--fg))" strokeOpacity={0.12} strokeDasharray="2 3" />
              <text x={xx + 3} y={H - 2} fontSize={10} fill="rgb(var(--fg-muted))">{y}</text></g>;
          })}
          <rect x={left} y={0} width={Math.max(0, x(head) - left)} height={H - 13} rx={3} fill="rgb(var(--accent))" opacity={0.07} />
          {ev.map((e, i) => {
            const lane = LANES.findIndex((l) => l.key === laneOf(e));
            const t = Date.parse(e.ts);
            const past = t <= head;
            return <circle key={i} cx={x(t)} cy={lane * laneH + laneH / 2 + 1} r={e.is_abnormal || e.event_type === "DIAGNOSIS" ? 3.1 : 2.2}
                           fill={LANE_COLOR[laneOf(e)!]} opacity={past ? 0.95 : 0.22}
                           stroke={e.is_abnormal ? "rgb(var(--surface))" : "none"} strokeWidth={e.is_abnormal ? 1 : 0} />;
          })}
          <line x1={x(head)} x2={x(head)} y1={0} y2={H - 13} stroke={STATUS.warning} strokeWidth={2} />
          <circle cx={x(head)} cy={2} r={4} fill={STATUS.warning} stroke="rgb(var(--surface))" strokeWidth={1.5} />
        </svg>
        <input type="range" min={t0} max={t1} step={86400_000} value={head} aria-label="Replay date"
               aria-valuetext={monthYear(new Date(head).toISOString())}
               onChange={(e) => set({ replayT: Number(e.target.value), playing: false })}
               className="absolute inset-y-0 h-full opacity-0 cursor-ew-resize" style={{ left: left, width: Math.max(10, W - left - 6) }} />
      </div>
      <AnimatePresence initial={false}>
        {replayT !== null && recent.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      className="flex gap-3 text-[11px] text-fg-muted overflow-hidden">
            {recent.map((e, i) => (
              <span key={`${e.ts}-${i}`} className="truncate" style={{ opacity: 1 - i * 0.35 }}>
                <span className="tabular mr-1">{new Date(e.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}</span>
                <span style={{ color: LANE_COLOR[laneOf(e)!] }} aria-hidden>●</span> <span className="text-fg">{e.label ?? e.value_text}</span>{e.value_num !== null && e.unit ? ` ${e.value_num} ${e.unit}` : ""}
              </span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
