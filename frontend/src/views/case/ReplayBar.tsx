import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { SERIES } from "@/lib/viz";
import { monthYear } from "@/lib/format";
import type { CaseData, ReplayEvent } from "./types";
import { useCaseUI } from "./store";

const MONTH = 30.44 * 86400_000;
const LANES = [
  { key: "SYMPTOM", label: "Symptoms" }, { key: "DIAGNOSIS", label: "Diagnoses" }, { key: "LAB", label: "Labs" },
  { key: "VITAL", label: "Vitals" }, { key: "DRUG", label: "Medicines" }, { key: "PROC", label: "Endoscopy / path" },
];
// stage is always dark, so the dark categorical palette applies; fixed order, one hue per lane
const LANE_COLOR: Record<string, string> = { SYMPTOM: SERIES.dark[1], DIAGNOSIS: SERIES.dark[2], LAB: SERIES.dark[3], VITAL: SERIES.dark[0], DRUG: SERIES.dark[4], PROC: SERIES.dark[7] };
const laneOf = (e: ReplayEvent) => (["ENDOSCOPY", "PATHOLOGY", "STAGING"].includes(e.event_type) ? "PROC" : LANES.some((l) => l.key === e.event_type) ? e.event_type : null);

/** Timeline replay: scrub or play through the window; the body re-renders each organ's state at the playhead. */
export function ReplayBar({ data }: { data: CaseData }) {
  const t0 = Date.parse(data.window.start), t1 = Date.parse(data.window.end);

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
  // draw in real pixels (no viewBox scaling) so 10-11px labels stay readable at any width
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(900);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const left = 112, laneH = 15, H = LANES.length * laneH + 20;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - 8);
  const head = replayT ?? t1;
  const years: number[] = [];
  for (let y = new Date(t0).getFullYear() + 1; y <= new Date(t1).getFullYear(); y++) years.push(y);
  const recent = ev.filter((e) => Date.parse(e.ts) <= head && e.event_type !== "VITAL").slice(-3).reverse();

  const play = () => {
    if (playing) return set({ playing: false });
    const start = replayT === null || replayT >= t1 - MONTH / 4 ? t0 : replayT;
    set({ replayT: start, playing: true, selectedOrgan: null });
  };
  return (
    <div className="hud p-2.5 flex flex-col gap-1.5" aria-label="Timeline replay">
      <div className="flex items-center gap-2">
        <button className="hud-btn !bg-kivu/40 !text-white" onClick={play} aria-label={playing ? "Pause replay" : "Play replay"}>
          {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? "Pause" : replayT === null ? "Replay last " + data.window.months + " months" : "Play"}
        </button>
        <div className="flex rounded-md overflow-hidden border border-white/10" role="group" aria-label="Replay speed">
          {[0.75, 1.5, 4].map((s) => <button key={s} className="hud-btn !rounded-none" aria-pressed={speed === s} onClick={() => set({ speed: s })}>{s} mo/s</button>)}
        </div>
        <button className="hud-btn" onClick={() => set({ replayT: null, playing: false })} disabled={replayT === null} aria-label="Back to current state">
          <RotateCcw size={12} /> Now
        </button>
        <div className="flex-1" />
        <div className="tabular text-[12px] font-semibold" aria-live="polite">{replayT === null ? "Current state" : monthYear(new Date(head).toISOString())}</div>
      </div>
      <div className="relative" ref={box}>
        <svg width={W} height={H} className="block" aria-hidden>
          {LANES.map((l, i) => (
            <g key={l.key}>
              <line x1={left} x2={W - 8} y1={i * laneH + laneH / 2 + 2} y2={i * laneH + laneH / 2 + 2} stroke="#e6ecee" strokeOpacity={0.08} />
              <circle cx={8} cy={i * laneH + laneH / 2 + 2} r={3} fill={LANE_COLOR[l.key]} />
              <text x={16} y={i * laneH + laneH / 2 + 5.5} fontSize={11} fill="#b4c0c8">{l.label}</text>
            </g>
          ))}
          {years.map((y) => {
            const xx = x(Date.parse(`${y}-01-01T00:00:00`));
            return <g key={y}><line x1={xx} x2={xx} y1={0} y2={H - 14} stroke="#e6ecee" strokeOpacity={0.14} strokeDasharray="2 3" />
              <text x={xx + 3} y={H - 3} fontSize={10.5} fill="#8696a2">{y}</text></g>;
          })}
          <rect x={left} y={0} width={Math.max(0, x(head) - left)} height={H - 14} fill="#3e7ca8" opacity={0.08} />
          {ev.map((e, i) => {
            const lane = LANES.findIndex((l) => l.key === laneOf(e));
            const t = Date.parse(e.ts);
            const past = t <= head;
            return <circle key={i} cx={x(t)} cy={lane * laneH + laneH / 2 + 2} r={e.is_abnormal || e.event_type === "DIAGNOSIS" ? 3.4 : 2.4}
                           fill={LANE_COLOR[laneOf(e)!]} opacity={past ? 0.95 : 0.25}
                           stroke={e.is_abnormal ? "#e6ecee" : "none"} strokeWidth={e.is_abnormal ? 1 : 0} />;
          })}
          <line x1={x(head)} x2={x(head)} y1={0} y2={H - 14} stroke="#f2a541" strokeWidth={2} />
          <circle cx={x(head)} cy={2} r={4} fill="#f2a541" />
        </svg>
        <input type="range" min={t0} max={t1} step={86400_000} value={head} aria-label="Replay date"
               aria-valuetext={monthYear(new Date(head).toISOString())}
               onChange={(e) => set({ replayT: Number(e.target.value), playing: false })}
               className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize" style={{ marginLeft: `${(left / W) * 100}%`, width: `${((W - left - 8) / W) * 100}%` }} />
      </div>
      <div className="flex gap-3 text-[11px] text-[#b4c0c8] min-h-[16px] overflow-hidden">
        {replayT !== null && recent.map((e, i) => (
          <span key={i} className="truncate" style={{ opacity: 1 - i * 0.28 }}>
            <span className="tabular text-[#8696a2] mr-1">{new Date(e.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}</span>
            <span style={{ color: LANE_COLOR[laneOf(e)!] }}>●</span> {e.label ?? e.value_text}{e.value_num !== null && e.unit ? ` ${e.value_num} ${e.unit}` : ""}
          </span>
        ))}
        {replayT === null && <span>Press replay to watch symptoms, labs and findings light up the body in the order they were recorded.</span>}
      </div>
    </div>
  );
}
