import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { ink, mode } from "@/lib/viz";

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

/** Shared chart chrome: recessive grid/axes, text in ink tokens (never series colour), rounded crosshair tooltip.
 * Animations are switched off when the user prefers reduced motion. */
export function base(): EChartsOption {
  const k = ink();
  const reduce = prefersReducedMotion();
  const dark = mode() === "dark";
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: '"Inter Variable", Inter, system-ui, sans-serif', color: k.secondary, fontSize: 11 },
    grid: { left: 44, right: 16, top: 28, bottom: 32, containLabel: false },
    tooltip: {
      trigger: "axis", backgroundColor: k.surface, borderColor: k.border, borderWidth: 1, padding: [8, 12],
      textStyle: { color: k.primary, fontSize: 12, fontFamily: '"Inter Variable", Inter, system-ui, sans-serif' },
      axisPointer: { type: "line", lineStyle: { color: k.axis, type: "dashed" } },
      extraCssText: `box-shadow: ${dark ? "0 16px 40px rgba(0,0,0,.55)" : "0 12px 32px rgba(16,24,40,.14)"}; border-radius: 12px;`,
    },
    legend: { top: 0, right: 0, textStyle: { color: k.secondary, fontSize: 11 }, icon: "roundRect", itemWidth: 10, itemHeight: 4 },
    xAxis: { axisLine: { lineStyle: { color: k.axis } }, axisTick: { show: false }, axisLabel: { color: k.muted }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: k.muted }, splitLine: { lineStyle: { color: k.grid } },
             nameTextStyle: { color: k.muted, fontSize: 10, align: "left" } },
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
