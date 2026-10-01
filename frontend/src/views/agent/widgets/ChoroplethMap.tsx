import { useMemo, useState } from "react";
import type { ChartSpec, Row } from "@agent/widgets";
import { useGeo, useProvGeo } from "@/api/hooks";
import { useThemeMode } from "@/components/charts/EChart";
import { seqColor } from "@/lib/viz";
import { asNum, cellText, colLabel } from "./format";

type Choro = Extract<ChartSpec, { type: "choropleth" }>;
type Feat = { properties: { district_code?: string; province_code?: string; name: string }; geometry: { type: string; coordinates: any } };

/** LISA quadrants (and any other categorical codes): fixed meaning, always with a text legend. */
const CATEGORY: Record<string, { label: string; color: string }> = {
  HH: { label: "High–High (hotspot)", color: "#EF4444" },
  HL: { label: "High–Low", color: "#F59E0B" },
  LH: { label: "Low–High", color: "#93B4F5" },
  LL: { label: "Low–Low (cold spot)", color: "#3F6FE8" },
  NS: { label: "Not significant", color: "" },
};
const EXTRA = ["#1baf7a", "#e87ba4", "#4a3aa7", "#eda100"];

/** District / province choropleth (SVG from the app's GeoJSON) beside a ranked list; sequential ramp = magnitude. */
export function ChoroplethMap({ spec, large = false }: { spec: Choro; large?: boolean }) {
  const gd = useGeo(), gp = useProvGeo();
  const g = spec.level === "province" ? gp : gd;
  useThemeMode();
  const [hover, setHover] = useState<{ name: string; row?: Row; x: number; y: number } | null>(null);
  const byCode = useMemo(() => new Map(spec.data.map((r) => [String(r[spec.geoKey] ?? ""), r])), [spec]);
  const categorical = spec.categorical ?? spec.data.every((r) => typeof r[spec.valueKey] === "string");
  const nums = spec.data.map((r) => asNum(r[spec.valueKey])).filter((v): v is number => v !== null);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const t = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 1) * 0.75 + 0.2;
  const cats = categorical ? [...new Set(spec.data.map((r) => String(r[spec.valueKey] ?? "NS")))] : [];
  const catColor = (c: string) => CATEGORY[c]?.color || (c === "NS" ? "" : EXTRA[cats.filter((x) => !CATEGORY[x]).indexOf(c) % EXTRA.length]);
  const fill = (r: Row | undefined) => {
    if (!r) return "rgb(var(--surface-2))";
    if (categorical) return catColor(String(r[spec.valueKey] ?? "NS")) || "rgb(var(--fg-muted) / 0.16)";
    const v = asNum(r[spec.valueKey]);
    return v === null ? "rgb(var(--fg-muted) / 0.16)" : seqColor(t(v));
  };
  const nameOf = (r: Row) => String((spec.labelKey ? r[spec.labelKey] : null) ?? r.name ?? r[spec.geoKey] ?? "");

  const shapes = useMemo(() => {
    const feats: Feat[] = g.data?.features ?? [];
    if (!feats.length) return null;
    let minX = 99, maxX = -99, minY = 99, maxY = -99;
    const rings = (f: Feat): number[][][] => (f.geometry.type === "Polygon" ? f.geometry.coordinates : f.geometry.coordinates.flat());
    feats.forEach((f) => rings(f).forEach((ring) => ring.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); })));
    const kx = Math.cos((((minY + maxY) / 2) * Math.PI) / 180), W = 320, s = W / ((maxX - minX) * kx), H = (maxY - minY) * s;
    return {
      W, H,
      paths: feats.map((f) => ({
        code: String(spec.level === "province" ? f.properties.province_code : f.properties.district_code ?? f.properties.province_code),
        name: f.properties.name,
        d: rings(f).map((ring) => "M" + ring.map(([x, y]) => `${((x - minX) * kx * s).toFixed(1)},${((maxY - y) * s).toFixed(1)}`).join("L") + "Z").join(""),
      })),
    };
  }, [g.data, spec.level]);

  const ranked = useMemo(() => (categorical ? spec.data : [...spec.data].sort((a, b) => (asNum(b[spec.valueKey]) ?? -Infinity) - (asNum(a[spec.valueKey]) ?? -Infinity))), [spec, categorical]);
  const label = colLabel(spec.valueKey);

  return (
    <div className={`grid gap-5 items-start ${large ? "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]" : "sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"}`}>
      <div className="relative">
        {shapes ? (
          <svg viewBox={`0 0 ${shapes.W} ${shapes.H}`} className="w-full h-auto" role="img" aria-label={`Map of ${label} by ${spec.level}`}>
            {shapes.paths.map((p) => {
              const r = byCode.get(p.code);
              return (
                <path key={p.code} d={p.d} fill={fill(r)} stroke="rgb(var(--surface))" strokeWidth={0.9} strokeLinejoin="round"
                      className="transition-opacity duration-150" opacity={hover && hover.name !== p.name ? 0.55 : 1}
                      onMouseMove={(e) => { const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setHover({ name: r ? nameOf(r) || p.name : p.name, row: r, x: e.clientX - b.left, y: e.clientY - b.top }); }}
                      onMouseLeave={() => setHover(null)} />
              );
            })}
          </svg>
        ) : <div className="h-48 rounded-tile bg-surface-2 animate-pulse" aria-label="Loading map" />}
        {hover && (
          <div className="absolute z-20 pointer-events-none rounded-tile bg-surface border border-border shadow-float px-3 py-2 text-xs whitespace-nowrap"
               style={{ left: Math.min(hover.x + 12, 220), top: hover.y + 12 }}>
            <div className="font-semibold text-fg">{hover.name}</div>
            <div className="text-fg-muted tabular">{hover.row ? `${label} ${cellText(hover.row, spec.valueKey, undefined, spec.unit)}${categorical && CATEGORY[String(hover.row[spec.valueKey])] ? ` · ${CATEGORY[String(hover.row[spec.valueKey])].label}` : ""}` : "Not in result"}</div>
          </div>
        )}
      </div>
      <div className="min-w-0">
        <ol className="flex flex-col gap-1 text-[12.5px]" aria-label={`Ranked ${spec.level === "province" ? "provinces" : "districts"}`}>
          {ranked.slice(0, large ? 30 : 8).map((r, i) => (
            <li key={`${r[spec.geoKey]}-${i}`} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1 hover:bg-surface-2 transition-colors">
              {!categorical && <span className="w-4 text-right text-fg-muted tabular text-micro">{i + 1}</span>}
              <span className="w-2.5 h-2.5 rounded-[4px] shrink-0 border border-border" style={{ background: fill(r) }} aria-hidden />
              <span className="flex-1 truncate text-fg">{nameOf(r)}</span>
              <span className="tabular font-semibold text-fg">{cellText(r, spec.valueKey, undefined, spec.unit)}</span>
            </li>
          ))}
          {ranked.length > (large ? 30 : 8) && <li className="text-micro text-fg-muted px-2">+{ranked.length - (large ? 30 : 8)} more in the table</li>}
        </ol>
        <div className="mt-3 px-2" aria-label="Colour legend">
          {categorical ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-micro text-fg-muted">
              {cats.map((c) => (
                <li key={c} className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-[4px] border border-border" style={{ background: catColor(c) || "rgb(var(--fg-muted) / 0.16)" }} aria-hidden />
                  {CATEGORY[c]?.label ?? c}
                </li>
              ))}
            </ul>
          ) : nums.length > 0 && (
            <div className="flex items-center gap-2 text-micro text-fg-muted tabular">
              <span>{cellText({ v: lo }, "v", undefined, spec.unit)}</span>
              <span className="flex-1 h-1.5 rounded-full" style={{ background: `linear-gradient(90deg, ${[0.2, 0.4, 0.6, 0.8, 0.95].map((x) => seqColor(x)).join(",")})` }} />
              <span>{cellText({ v: hi }, "v", undefined, spec.unit)}</span>
            </div>
          )}
          <p className="text-micro text-fg-muted mt-1">{label}{spec.unit ? ` · ${spec.unit}` : ""} · blank = not in result</p>
        </div>
      </div>
    </div>
  );
}
