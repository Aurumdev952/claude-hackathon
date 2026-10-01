import { useMemo, useState } from "react";
import type { ChartSpec, Row } from "@agent/widgets";
import { useGeo, useProvGeo } from "@/api/hooks";
import { useThemeMode } from "@/components/charts/EChart";
import { CATEGORICAL, seqColor, type Mode } from "@/lib/viz";
import { asNum, cellText, colLabel } from "./format";

type Choro = Extract<ChartSpec, { type: "choropleth" }>;
type Feat = { properties: { district_code?: string; province_code?: string; name: string }; geometry: { type: string; coordinates: any } };

/** LISA quadrants (and any other categorical codes): fixed meaning, always with a text legend. "High" quadrants wear the
 * signal family (attention), "low" quadrants the sky family (data), not significant stays grey. */
const CATEGORY_LABEL: Record<string, string> = { HH: "High–High (hotspot)", HL: "High–Low", LH: "Low–High", LL: "Low–Low (cold spot)", NS: "Not significant" };
const CATEGORY_COLOR: Record<Mode, Record<string, string>> = {
  light: { HH: "#F05A28", HL: "#F8A98A", LH: "#A9D7F2", LL: "#3593CC", NS: "" },
  dark: { HH: "#FF6D3A", HL: "#A8472A", LH: "#2F5F7C", LL: "#6CC0EC", NS: "" },
};

/** District / province choropleth (SVG from the app's GeoJSON) beside a ranked list; sequential ramp = magnitude. */
export function ChoroplethMap({ spec, large = false }: { spec: Choro; large?: boolean }) {
  const gd = useGeo(), gp = useProvGeo();
  const g = spec.level === "province" ? gp : gd;
  const mode = useThemeMode();
  const extra = CATEGORICAL[mode].slice(2);
  const [hover, setHover] = useState<{ name: string; row?: Row; x: number; y: number } | null>(null);
  const byCode = useMemo(() => new Map(spec.data.map((r) => [String(r[spec.geoKey] ?? ""), r])), [spec]);
  const categorical = spec.categorical ?? spec.data.every((r) => typeof r[spec.valueKey] === "string");
  const nums = spec.data.map((r) => asNum(r[spec.valueKey])).filter((v): v is number => v !== null);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const t = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 1) * 0.75 + 0.2;
  const LEGEND_ORDER = ["HH", "HL", "LH", "LL", "NS"];
  const rank = (c: string) => { const i = LEGEND_ORDER.indexOf(c); return i < 0 ? 4.5 : i; };
  const cats = categorical ? [...new Set(spec.data.map((r) => String(r[spec.valueKey] ?? "NS")))].sort((a, b) => rank(a) - rank(b)) : [];
  const catColor = (c: string) => CATEGORY_COLOR[mode][c] || (c === "NS" || c in CATEGORY_LABEL ? "" : extra[cats.filter((x) => !(x in CATEGORY_LABEL)).indexOf(c) % extra.length]);
  const fill = (r: Row | undefined) => {
    if (!r) return "rgb(var(--tile))";
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

  const CAT_ORDER = ["HH", "HL", "LH", "LL"];
  const catRank = (r: Row) => { const i = CAT_ORDER.indexOf(String(r[spec.valueKey])); return i < 0 ? (String(r[spec.valueKey]) === "NS" ? 99 : 50) : i; };
  const ranked = useMemo(() => (categorical ? [...spec.data].sort((a, b) => catRank(a) - catRank(b)) : [...spec.data].sort((a, b) => (asNum(b[spec.valueKey]) ?? -Infinity) - (asNum(a[spec.valueKey]) ?? -Infinity))), [spec, categorical]);
  const label = colLabel(spec.valueKey);

  return (
    <div className={`grid gap-6 items-start ${large ? "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]" : "sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"}`}>
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
        ) : <div className="h-48 rounded-tile bg-tile animate-pulse" aria-label="Loading map" />}
        {hover && (
          <div className="absolute z-20 pointer-events-none rounded-tile bg-surface shadow-float dark:border dark:border-hairline px-4 py-2.5 text-[13px] whitespace-nowrap"
               style={{ left: Math.min(hover.x + 12, 220), top: hover.y + 12 }}>
            <div className="font-semibold text-ink">{hover.name}</div>
            <div className="text-muted tabular">{hover.row ? `${label} ${cellText(hover.row, spec.valueKey, undefined, spec.unit)}` : "Not in the result"}</div>
            {hover.row && categorical && CATEGORY_LABEL[String(hover.row[spec.valueKey])] && <div className="text-muted">{CATEGORY_LABEL[String(hover.row[spec.valueKey])]}</div>}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <ol className="flex flex-col text-[14px]" aria-label={`Ranked ${spec.level === "province" ? "provinces" : "districts"}`}>
          {ranked.slice(0, large ? 30 : 8).map((r, i) => (
            <li key={`${r[spec.geoKey]}-${i}`} className="flex items-center gap-3 h-9 rounded-full px-3 hover:bg-tile transition-colors">
              {!categorical && <span className="w-4 text-right text-muted tabular text-[13px]">{i + 1}</span>}
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: fill(r) === "rgb(var(--tile))" ? "rgb(var(--faint))" : fill(r) }} aria-hidden />
              <span className="flex-1 truncate text-ink">{nameOf(r)}</span>
              <span className="tabular font-medium text-ink">{cellText(r, spec.valueKey, undefined, spec.unit)}</span>
            </li>
          ))}
          {ranked.length > (large ? 30 : 8) && <li className="text-[13px] text-muted px-3 pt-1">{ranked.length - (large ? 30 : 8)} more in the table</li>}
        </ol>
        <div className="mt-4 px-3" aria-label="Colour legend">
          {categorical ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted">
              {cats.map((c) => (
                <li key={c} className="inline-flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: catColor(c) || "rgb(var(--faint) / 0.5)" }} aria-hidden />
                  {CATEGORY_LABEL[c] ?? c}
                </li>
              ))}
            </ul>
          ) : nums.length > 0 && (
            <div className="flex items-center gap-2.5 text-[13px] text-muted tabular">
              <span>{cellText({ v: lo }, "v", undefined, spec.unit)}</span>
              <span className="flex-1 flex h-1.5 rounded-full overflow-hidden" aria-hidden>
                {[0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map((x) => <span key={x} className="flex-1" style={{ background: seqColor(x) }} />)}
              </span>
              <span>{cellText({ v: hi }, "v", undefined, spec.unit)}</span>
            </div>
          )}
          <p className="text-[13px] text-muted mt-2">{label}{spec.unit ? ` (${spec.unit})` : ""}. Grey areas are not in the result.</p>
        </div>
      </div>
    </div>
  );
}
