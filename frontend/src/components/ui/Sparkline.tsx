import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/motion";

/** Lightweight SVG sparkline in the data hue (sky): a 2px line, a flat 8% area (no gradient) and an end dot, with a
 * draw-in animation (no ECharts dependency). */
export function Sparkline({ values, color = "rgb(var(--sky))", height = 36, area = true, className = "" }: {
  values: (number | null | undefined)[]; color?: string; height?: number; area?: boolean; className?: string;
}) {
  const reduce = useReducedMotion();
  const v = values.map((x) => (x === null || x === undefined ? NaN : x));
  const fin = v.filter((x) => Number.isFinite(x));
  if (fin.length < 2) return <div style={{ height }} className={className} />;
  // the end dot is HTML so it stays round under preserveAspectRatio="none"
  const min = Math.min(...fin), max = Math.max(...fin), w = 100, pad = 4;
  const pts = v.map((x, i) => (Number.isFinite(x) ? [(i / (v.length - 1)) * w, height - pad - ((x - min) / (max - min || 1)) * (height - pad * 2)] : null))
    .filter((p): p is number[] => p !== null);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  const fill = `${line} L${pts[pts.length - 1][0]},${height} L${pts[0][0]},${height} Z`;
  const last = pts[pts.length - 1];
  return (
    <motion.div className={`w-full ${className}`} style={{ height, position: "relative" }} aria-hidden
                initial={reduce ? false : { clipPath: "inset(-4px 100% -4px -4px)" }} animate={{ clipPath: "inset(-4px -4px -4px -4px)" }} transition={{ duration: 0.9, ease: EASE }}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full h-full overflow-visible">
        {area && <path d={fill} fill={color} fillOpacity={0.08} />}
        <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span className="absolute w-2 h-2 -ml-1 -mt-1 rounded-full ring-2 ring-surface" style={{ left: `${last[0]}%`, top: last[1], background: color }} />
    </motion.div>
  );
}
