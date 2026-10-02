import { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, scoreColor } from "../theme";
import { finite } from "./scale";

type Geo = { features: { properties: { code: string; name: string }; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown } }[] };

/** Equirectangular projection fitted to the box (Rwanda sits at ~2°S, so cos(lat) scaling is enough). */
function project(geo: Geo, width: number, height: number, pad = 8) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const rings: { code: string; rings: number[][][] }[] = geo.features.map((f) => {
    const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
    const rs = polys.flat();
    for (const r of rs) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { code: f.properties.code, rings: rs };
  });
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const s = Math.min((width - 2 * pad) / ((x1 - x0) * k), (height - 2 * pad) / (y1 - y0));
  const ox = (width - (x1 - x0) * k * s) / 2, oy = (height - (y1 - y0) * s) / 2;
  const P = (x: number, y: number) => [ox + (x - x0) * k * s, oy + (y1 - y) * s];
  const paths: Record<string, string> = {};
  const centroids: Record<string, [number, number]> = {};
  for (const { code, rings: rs } of rings) {
    paths[code] = rs.map((r) => `M${r.map(([x, y]) => P(x, y).map((v) => v.toFixed(1)).join(",")).join("L")}Z`).join("");
    // area-weighted centroid of the largest ring (good enough for a pulse marker)
    const big = rs.reduce((a, b) => (b.length > a.length ? b : a), rs[0]);
    let cx = 0, cy = 0;
    for (const [x, y] of big) { const [px, py] = P(x, y); cx += px; cy += py; }
    centroids[code] = [cx / big.length, cy / big.length];
  }
  return { paths, centroids };
}

/** District map filled by value on the one-hue signal ramp (fixed domain across years, so colour change is real change).
 * Suppressed / missing districts stay a neutral grey. Hotspots get a pulsing ring once `hotspotsFrom` is reached. */
export function Choropleth({ geo, values, domain, width, height, hotspots = [], hotspotsFrom = Infinity, names, labelCodes = [] }: {
  geo: Geo; values: Record<string, number | null>; domain: [number, number]; width: number; height: number;
  hotspots?: string[]; hotspotsFrom?: number; names?: Record<string, string>; labelCodes?: string[];
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { paths, centroids } = useMemo(() => project(geo, width, height), [geo, width, height]);
  const [lo, hi] = domain;
  const period = Math.round(fps * 1.4);
  const ph = (Math.max(0, frame - hotspotsFrom) % period) / period;
  return (
    <svg width={width} height={height} style={{ overflow: "visible", fontFamily: FONT }}>
      {Object.entries(paths).map(([code, d]) => {
        const v = values[code];
        const fill = finite(v) ? scoreColor((v - lo) / (hi - lo || 1)) : "#E6E8ED";
        return <path key={code} d={d} fill={fill} stroke={C.surface} strokeWidth={2} strokeLinejoin="round" />;
      })}
      {frame >= hotspotsFrom && hotspots.filter((c) => paths[c]).map((c) => (
        <g key={c}>
          <path d={paths[c]} fill="none" stroke={C.ink} strokeWidth={3} strokeLinejoin="round" />
          <circle cx={centroids[c][0]} cy={centroids[c][1]} r={10 + 34 * ph} fill="none" stroke={C.signal} strokeOpacity={0.7 * (1 - ph)} strokeWidth={4} />
          <circle cx={centroids[c][0]} cy={centroids[c][1]} r={8} fill={C.signal} stroke={C.surface} strokeWidth={3} />
        </g>
      ))}
      {labelCodes.filter((c) => centroids[c] && names?.[c]).map((c) => (
        <text key={`l-${c}`} x={centroids[c][0]} y={centroids[c][1] - 22} textAnchor="middle" fontSize={22} fontWeight={600} fill={C.ink}
              stroke={C.surface} strokeWidth={5} paintOrder="stroke">{names?.[c]}</text>
      ))}
    </svg>
  );
}

/** Legend for the sequential ramp (stepped swatches, not a gradient). */
export function RampLegend({ domain, unit, width = 360 }: { domain: [number, number]; unit: string; width?: number }) {
  const steps = 5;
  const sw = width / steps;
  return (
    <div style={{ fontFamily: FONT }}>
      <svg width={width} height={22}>
        {Array.from({ length: steps }, (_, i) => <rect key={i} x={i * sw + 1} y={0} width={sw - 2} height={18} rx={4} fill={scoreColor(i / (steps - 1))} />)}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: C.muted, marginTop: 6, width }}>
        <span>{Math.round(domain[0])}</span><span>{unit}</span><span>{Math.round(domain[1])}</span>
      </div>
    </div>
  );
}
