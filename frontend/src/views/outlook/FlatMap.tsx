import { useMemo, useRef, useState, type ReactNode } from "react";
import { useGeo } from "@/api/hooks";
import { useThemeMode } from "@/components/charts/EChart";
import { Loading } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { ink } from "@/lib/viz";

type Feature = { properties: { district_code: string; name: string; province_code: string }; geometry: { type: "Polygon" | "MultiPolygon"; coordinates: any } };
export type FlatValue = { fill: string; tip: ReactNode; label: string };

const W = 1000;
/** Equirectangular projection with a cos(latitude) correction: fine at Rwanda's size (2 x 2 degrees near the equator). */
function project(features: Feature[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const rings = (f: Feature): number[][][] => (f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat());
  features.forEach((f) => rings(f).forEach((r) => r.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); })));
  const k = Math.cos(((y0 + y1) / 2) * (Math.PI / 180));
  const s = W / ((x1 - x0) * k);
  const H = (y1 - y0) * s;
  const pt = ([x, y]: number[]) => [((x - x0) * k * s).toFixed(1), ((y1 - y) * s).toFixed(1)];
  const paths = features.map((f) => ({
    code: f.properties.district_code, name: f.properties.name,
    d: rings(f).map((r) => `M${r.map((p) => pt(p).join(",")).join("L")}Z`).join(""),
  }));
  return { paths, H };
}

/** Flat district choropleth (SVG) for small map cards: hairline borders in the surface colour, hover tooltip, a native
 * <title> per district. The 3D GeoScene stays the hero map on the Overview and the Geo explorer. */
export function FlatMap({ values, ariaLabel, maxHeight = 320, highlight }: { values: Map<string, FlatValue>; ariaLabel: string; maxHeight?: number; highlight?: Set<string> }) {
  useThemeMode();
  const geo = useGeo();
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ code: string; x: number; y: number } | null>(null);
  const proj = useMemo(() => (geo.data ? project(geo.data.features as Feature[]) : null), [geo.data]);
  if (geo.error) return <ErrorNote error={geo.error} />;
  if (!proj) return <Loading h={maxHeight} />;
  const k = ink();
  const t = tip ? values.get(tip.code) : null;
  return (
    <div ref={box} className="relative" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${proj.H.toFixed(0)}`} className="w-full h-auto mx-auto block" style={{ maxHeight }} role="img" aria-label={ariaLabel}>
        {proj.paths.map((p) => {
          const v = values.get(p.code);
          return (
            <path key={p.code} d={p.d} fill={v?.fill ?? k.tile} stroke={k.surface} strokeWidth={highlight?.has(p.code) ? 0 : 2} strokeLinejoin="round"
                  onMouseMove={(e) => {
                    const r = box.current!.getBoundingClientRect();
                    setTip({ code: p.code, x: e.clientX - r.left, y: e.clientY - r.top });
                  }}>
              <title>{`${p.name}: ${v?.label ?? "no data"}`}</title>
            </path>
          );
        })}
        {highlight && proj.paths.filter((p) => highlight.has(p.code)).map((p) => (
          <path key={`h-${p.code}`} d={p.d} fill="none" stroke={k.primary} strokeWidth={3} strokeLinejoin="round" pointerEvents="none" />
        ))}
      </svg>
      {tip && t && (
        <div className="absolute z-20 pointer-events-none bg-surface shadow-float rounded-tile dark:border dark:border-hairline px-3.5 py-2.5 text-[13px] min-w-[150px]"
             style={{ left: Math.min(tip.x + 14, (box.current?.clientWidth ?? 300) - 190), top: Math.max(0, tip.y - 70) }} role="status">
          {t.tip}
        </div>
      )}
    </div>
  );
}
