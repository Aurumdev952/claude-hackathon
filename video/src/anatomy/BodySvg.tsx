import { useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, scoreColor } from "../theme";
import { ALIASES, ORGAN_BY_ID, ORGANS, SILHOUETTE, VIEWBOX, spline, type Shape } from "./shapes";

const BASE: Record<string, string> = { kidney_l: "#DCDFE5", kidney_r: "#DCDFE5", vessels: "#C3C7CF", small_intestine: "#D9DCE2", large_intestine: "#C9CCD4", brain: "#D4D7DE", lung_l: "#D9DCE2", lung_r: "#D9DCE2" };
const BASE_FILL = "#CDD0D8";
const SKIN = "#F1F2F5";
const SKIN_EDGE = "#DDE0E6";
/** Loops drawn inside the small intestine (texture of the coils, context only). */
const LOOPS = [
  spline([[-62, 740], [-30, 728], [0, 744], [30, 728], [64, 742]], false),
  spline([[-68, 782], [-34, 766], [0, 784], [36, 766], [72, 782]], false),
  spline([[-70, 824], [-34, 808], [0, 826], [36, 808], [74, 822]], false),
  spline([[-58, 864], [-26, 850], [4, 866], [34, 850], [58, 862]], false),
];

export type Callout = { label: string; value?: string; side?: "left" | "right" };

/** Resolve "kidneys"/"lungs"/"blood" aliases to drawable organ ids. */
export const expandOrgan = (id: string) => ALIASES[id] ?? [id];

/** Simplified anatomical figure (head to hips) with per-organ score colour, a highlighted organ with a pulse ring, an
 * optional callout line and an Hb blood-drop marker. Flat fills only: a 3px surface gap separates touching organs. */
export function BodySvg({ scores, highlight = null, height, callout, hb = null, dimOthers = true, pulse = true }: {
  scores: Record<string, number>; highlight?: string | string[] | null; height: number; callout?: Callout | null; hb?: number | null;
  dimOthers?: boolean; pulse?: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hl = (Array.isArray(highlight) ? highlight : highlight ? [highlight] : []).flatMap(expandOrgan);
  const extraR = callout && callout.side !== "left" ? 470 : 0;
  const extraL = callout && callout.side === "left" ? 470 : 0;
  const vb = { x: VIEWBOX.x - extraL, y: VIEWBOX.y, w: VIEWBOX.w + extraL + extraR, h: VIEWBOX.h };
  const width = (height * vb.w) / vb.h;
  const period = Math.round(fps * 1.3);
  const ph = (frame % period) / period;
  const ring = { grow: 4 + 26 * ph, op: 0.32 * (1 - ph) };

  const colour = (id: string) => {
    const s = scores[id] ?? 0;
    if (hl.includes(id)) return C.signal;
    return s >= 0.05 ? scoreColor(s) : BASE[id] ?? BASE_FILL;
  };
  const opacity = (id: string) => (hl.length && dimOthers && !hl.includes(id) ? ((scores[id] ?? 0) > 0 ? 0.6 : 0.75) : 1);

  const draw = (s: Shape, fill: string, key: string) => {
    if (s.kind === "fill") return <path key={key} d={s.d} fill={fill} stroke={C.surface} strokeWidth={3} strokeLinejoin="round" />;
    if (s.kind === "tube") return (
      <g key={key}>
        <path d={s.d} fill="none" stroke={C.surface} strokeWidth={s.width + 6} strokeLinecap="round" strokeLinejoin="round" />
        <path d={s.d} fill="none" stroke={fill} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
    return <g key={key}>{s.pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={s.r} fill={fill} stroke={C.surface} strokeWidth={2.5} />)}</g>;
  };
  const ringOf = (s: Shape, key: string) => {
    if (s.kind === "fill") return <path key={key} d={s.d} fill="none" stroke={C.signal} strokeOpacity={ring.op} strokeWidth={ring.grow} strokeLinejoin="round" />;
    if (s.kind === "tube") return <path key={key} d={s.d} fill="none" stroke={C.signal} strokeOpacity={ring.op} strokeWidth={s.width + ring.grow * 1.4} strokeLinecap="round" />;
    return <g key={key}>{s.pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={s.r + ring.grow * 0.5} fill="none" stroke={C.signal} strokeOpacity={ring.op} strokeWidth={3} />)}</g>;
  };

  const anchorId = hl[0];
  const anchor = anchorId ? ORGAN_BY_ID[anchorId]?.anchor : null;
  const showDrop = hb !== null && hl.includes("vessels");

  return (
    <svg width={width} height={height} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} style={{ overflow: "visible", fontFamily: FONT }}>
      <g>
        <path d={SILHOUETTE.torso} fill={SKIN} stroke={SKIN_EDGE} strokeWidth={2} />
        <path d={SILHOUETTE.head} fill={SKIN} stroke={SKIN_EDGE} strokeWidth={2} />
      </g>
      {pulse && hl.map((id) => ORGAN_BY_ID[id]?.shapes.map((s, i) => ringOf(s, `ring-${id}-${i}`)))}
      {ORGANS.map((o) => (
        <g key={o.id} opacity={opacity(o.id)}>
          {o.shapes.map((s, i) => draw(s, colour(o.id), `${o.id}-${i}`))}
          {o.id === "small_intestine" && LOOPS.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={hl.includes(o.id) ? "#FFFFFF" : C.surface} strokeOpacity={0.75} strokeWidth={3} strokeLinecap="round" />
          ))}
        </g>
      ))}
      {showDrop && <BloodDrop x={-6} y={918} hb={hb} strong={hl.includes("vessels")} />}
      {callout && anchor && <CalloutLine from={anchor} side={callout.side ?? "right"} label={callout.label} value={callout.value} />}
    </svg>
  );
}

function BloodDrop({ x, y, hb, strong }: { x: number; y: number; hb: number | null; strong: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M0,-30 C14,-10 22,2 22,12 A22,22 0 0 1 -22,12 C-22,2 -14,-10 0,-30Z" fill={strong ? C.signal : "#C9CCD4"} stroke={C.surface} strokeWidth={3} />
      {hb !== null && <text x={34} y={14} textAnchor="start" fontSize={26} fontWeight={600} fill={C.ink} stroke={C.surface} strokeWidth={6} paintOrder="stroke">Hb {hb.toFixed(1)}</text>}
    </g>
  );
}

function CalloutLine({ from, side, label, value }: { from: [number, number]; side: "left" | "right"; label: string; value?: string }) {
  const dir = side === "right" ? 1 : -1;
  const elbowX = dir * 250;
  const endX = dir * 330;
  const y = from[1];
  return (
    <g>
      <circle cx={from[0]} cy={from[1]} r={7} fill={C.ink} stroke={C.surface} strokeWidth={3} />
      <path d={`M${from[0]},${from[1]} L${elbowX},${y} L${endX},${y}`} fill="none" stroke={C.ink} strokeWidth={2} />
      <circle cx={endX} cy={y} r={5} fill={C.ink} />
      <text x={endX + dir * 16} y={y - 4} textAnchor={side === "right" ? "start" : "end"} fontSize={34} fontWeight={600} fill={C.ink}>{label}</text>
      {value && <text x={endX + dir * 16} y={y + 34} textAnchor={side === "right" ? "start" : "end"} fontSize={26} fontWeight={500} fill={C.muted}>{value}</text>}
    </g>
  );
}

/** Organ scores keyed by drawable ids ("kidneys" -> kidney_l + kidney_r ...). */
export function drawableScores(organs: { id: string; score: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of organs) for (const id of expandOrgan(o.id)) out[id] = Math.max(out[id] ?? 0, o.score);
  return out;
}
