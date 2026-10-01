import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { FONT_STACK, ink, mode } from "@/lib/viz";

export function useThemeMode() {
  const [m, setM] = useState(mode());
  useEffect(() => {
    const obs = new MutationObserver(() => setM(mode()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return m;
}

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Shared chart chrome (design v3): dotted split lines, no axis lines or ticks, muted 12px Urbanist labels, a white
 * tooltip card (radius 16, the one soft shadow). Text wears ink tokens, never a series colour. Animations are switched
 * off when the user prefers reduced motion. */
export function base(): EChartsOption {
  const k = ink();
  const reduce = prefersReducedMotion();
  const dark = mode() === "dark";
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: FONT_STACK, color: k.secondary, fontSize: 12 },
    grid: { left: 44, right: 16, top: 28, bottom: 32, containLabel: false },
    tooltip: {
      trigger: "axis", backgroundColor: k.surface, borderColor: dark ? k.border : "transparent", borderWidth: dark ? 1 : 0, padding: [10, 14],
      textStyle: { color: k.primary, fontSize: 13, fontFamily: FONT_STACK },
      axisPointer: { type: "line", lineStyle: { color: k.axis, type: [2, 3], width: 1 } },
      extraCssText: `box-shadow: ${dark ? "0 16px 48px rgba(0,0,0,.5)" : "0 16px 48px rgba(21,23,28,.12)"}; border-radius: 16px;`,
    },
    legend: { top: 0, right: 0, textStyle: { color: k.secondary, fontSize: 12, fontFamily: FONT_STACK }, icon: "circle", itemWidth: 8, itemHeight: 8, itemGap: 16 },
    xAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: k.muted, fontSize: 12, fontFamily: FONT_STACK, margin: 12 },
             splitLine: { show: false }, nameTextStyle: { color: k.muted, fontSize: 12 } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: k.muted, fontSize: 12, fontFamily: FONT_STACK },
             splitLine: { lineStyle: { color: k.grid, type: [1, 4], width: 1 } },
             nameTextStyle: { color: k.muted, fontSize: 12, align: "left" } },
    animation: !reduce,
    animationDuration: reduce ? 0 : 700,
    animationEasing: "cubicOut",
    animationDurationUpdate: reduce ? 0 : 400,
  };
}

export function EChart({ option, height = 260, onEvents, ariaLabel }: { option: EChartsOption; height?: number; onEvents?: Record<string, (e: any) => void>; ariaLabel: string }) {
  const m = useThemeMode();
  return (
    <div role="img" aria-label={ariaLabel}>
      <ReactECharts key={m} option={option} style={{ height }} notMerge lazyUpdate onEvents={onEvents} opts={{ renderer: "canvas" }} />
    </div>
  );
}

export function Sparkline({ values, color, height = 28 }: { values: (number | null)[]; color: string; height?: number }) {
  const v = values.map((x) => (x === null ? NaN : x));
  const fin = v.filter((x) => Number.isFinite(x));
  if (fin.length < 2) return <div style={{ height }} />;
  const min = Math.min(...fin), max = Math.max(...fin), w = 100;
  const pts = v.map((x, i) => (Number.isFinite(x) ? `${(i / (v.length - 1)) * w},${height - 3 - ((x - min) / (max - min || 1)) * (height - 6)}` : null)).filter(Boolean);
  const last = pts[pts.length - 1]!.split(",");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.4} fill={color} />
    </svg>
  );
}
