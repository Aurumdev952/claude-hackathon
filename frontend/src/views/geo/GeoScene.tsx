import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { AmbientLight, DirectionalLight, FlyToInterpolator, LightingEffect, MapView, WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import { ArcLayer, GeoJsonLayer, IconLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { HexagonLayer } from "@deck.gl/aggregation-layers";
import type { MapRow } from "@/api/types";
import { useThemeMode } from "@/components/charts/EChart";
import type { Facility } from "./data";
import { isLowCoverage, lisaRgb, numeric, rampColors, rampRgb, theme, tFor, tierRgb, type MetricDef, type RGB, type RGBA } from "./model";
import { hexToRgb } from "@/lib/viz";

export const BOUNDS: [[number, number], [number, number]] = [[28.86, -2.84], [30.9, -1.05]];
export const MAX_H = 30000; // metres of extrusion at the top of the domain (~1/6 of the country's width)

export type Arc = { from: [number, number]; to: [number, number]; fromCode: string; toId: number; n: number; fromName: string; toName: string };
export type HoverInfo =
  | { kind: "district"; code: string; x: number; y: number }
  | { kind: "facility"; fac: Facility; endo: boolean; x: number; y: number }
  | { kind: "hex"; count: number; x: number; y: number }
  | { kind: "arc"; arc: Arc; x: number; y: number };

export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The one orchestrated motion (SPEC §16.1): extrusions rise from 0 on first load. */
export function useRise(ready: boolean, token = 0) {
  const [v, setV] = useState(reducedMotion() ? 1 : 0);
  useEffect(() => {
    if (!ready) return;
    if (reducedMotion()) { setV(1); return; }
    let raf = 0; const t0 = performance.now(), dur = 1700;
    const step = (t: number) => {
      const x = Math.min(1, (t - t0) / dur);
      setV(1 - Math.pow(1 - x, 3));
      if (x < 1) raf = requestAnimationFrame(step);
    };
    setV(0); raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ready, token]);
  return v;
}

const ENDO_ICON = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><path fill='#fff' fill-rule='evenodd' d='M32 2 L62 32 L32 62 L2 32 Z M32 21 A11 11 0 1 0 32.01 21 Z'/></svg>");

function fitView(w: number, h: number, mini: boolean): MapViewState {
  const vp = new WebMercatorViewport({ width: Math.max(w, 200), height: Math.max(h, 200) });
  const pad = mini ? { top: 10, bottom: 10, left: 6, right: 6 } : { top: 90, bottom: 96, left: Math.min(250, w * 0.2), right: 24 };
  const { longitude, latitude, zoom } = vp.fitBounds(BOUNDS, { padding: pad });
  return { longitude: longitude + 0.03, latitude: latitude - (mini ? 0.12 : 0.2), zoom: zoom + (mini ? -0.02 : 0.12), pitch: mini ? 46 : 48, bearing: mini ? -14 : -12 };
}

function ringOf(geom: any): [number, number][] {
  if (!geom) return [];
  return geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates.reduce((a: any, p: any) => (p[0].length > a.length ? p[0] : a), []);
}

export type SceneProps = {
  variant?: "full" | "mini";
  districts: any; provinces: any;
  rows: MapRow[]; metric: MetricDef; domain: { lo: number; hi: number; hMax: number };
  facilities?: Facility[]; endoIds?: Set<number>; showFacilities?: boolean;
  hexPoints?: { lon: number; lat: number }[] | null; arcs?: Arc[] | null;
  selected?: string | null; highlight?: string | null; labels?: number;
  onSelect?: (code: string | null) => void; onHover?: (h: HoverInfo | null) => void;
  focusOffsetPx?: number; resetToken?: number; riseToken?: number; animate?: boolean;
};

export function GeoScene(p: SceneProps) {
  const { variant = "full", rows, metric, domain } = p;
  const mini = variant === "mini";
  const tm = useThemeMode();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [vs, setVs] = useState<MapViewState | null>(null);
  const home = useMemo(() => (size ? fitView(size.w, size.h, mini) : null), [size, mini]);
  const rise = useRise(!!size && rows.length > 0, p.riseToken);
  const motion = p.animate !== false && !reducedMotion();

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (home) setVs((v) => (v && p.selected ? v : home)); }, [home]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (home && p.resetToken) setVs({ ...home, transitionDuration: motion ? 1100 : 0, transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }) } as MapViewState); }, [p.resetToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const byCode = useMemo(() => new Map(rows.map((r) => [r.geo_code, r])), [rows]);
  const heightKey = metric.height;
  const heightOf = (code: string) => {
    if (p.hexPoints) return 0;
    const r = byCode.get(code);
    if (!r || r.suppressed) return 0;
    const v = numeric(r, heightKey);
    if (v === null) return 0;
    return Math.max(0, Math.min(1.12, v / (domain.hMax || 1))) * MAX_H;
  };

  // Fly to the selected district, leaving room for the side panel.
  useEffect(() => {
    if (!home || mini) return;
    if (!p.selected) { setVs((v) => (v ? { ...home, transitionDuration: motion ? 1000 : 0, transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }) } as MapViewState : home)); return; }
    const f = p.districts?.features?.find((x: any) => x.properties.district_code === p.selected);
    if (!f) return;
    const [lon, lat] = f.properties.centroid as [number, number];
    const zoom = home.zoom + 0.55;
    const degPerPx = 360 / (512 * Math.pow(2, zoom));
    setVs({ longitude: lon + (p.focusOffsetPx ?? 0) * 0.5 * degPerPx, latitude: lat - 0.1, zoom, pitch: 50, bearing: home.bearing,
            transitionDuration: motion ? 1300 : 0, transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }) } as MapViewState);
  }, [p.selected, home]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = theme();
  const lighting = useMemo(() => new LightingEffect({
    ambient: new AmbientLight({ color: [255, 255, 255], intensity: tm === "dark" ? 1.08 : 1.05 }),
    key: new DirectionalLight({ color: [255, 246, 236], intensity: tm === "dark" ? 1.05 : 0.8, direction: [-2, -5, -7] }),
    fill: new DirectionalLight({ color: [200, 220, 240], intensity: 0.35, direction: [4, 3, -2] }),
  }), [tm]);

  const colorOf = (code: string): RGBA => {
    const r = byCode.get(code);
    if (p.hexPoints) return [...t.land, mini ? 255 : 140] as RGBA;
    if (!r || r.suppressed) return [...t.suppressed, 255] as RGBA;
    let c: RGB;
    if (metric.ramp === "cat") c = lisaRgb(r.lisa_quadrant);
    else {
      const v = numeric(r, metric.key as keyof MapRow);
      if (v === null) return [...t.suppressed, 255] as RGBA;
      c = rampRgb(metric.ramp, tFor(metric, v, domain));
    }
    if (isLowCoverage(r)) c = c.map((x, i) => Math.round(x * 0.35 + t.land[i] * 0.65)) as RGB;
    return [...c, 255] as RGBA;
  };

  const updateKey = `${metric.key}|${domain.lo}|${domain.hi}|${domain.hMax}|${tm}|${!!p.hexPoints}|${rows.map((r) => r.geo_code + (r.asr ?? "") + (r.coverage_flag ?? "")).join(",").length}|${rows[0]?.period ?? ""}`;
  const dataKey = rows.map((r) => `${r.geo_code}:${r.asr}:${r.crude_rate}`).join("|");
  const trans = motion ? { getElevation: { duration: 900, easing: (x: number) => 1 - Math.pow(1 - x, 3) }, getFillColor: { duration: 700 } } : {};

  const layers: any[] = [];
  if (!mini) {
    const lines: { path: [number, number][] }[] = [];
    for (let lo = 28.5; lo <= 31.25; lo += 0.25) lines.push({ path: [[lo, -3.2], [lo, -0.7]] });
    for (let la = -3.2; la <= -0.7; la += 0.25) lines.push({ path: [[28.5, la], [31.25, la]] });
    layers.push(new PathLayer({ id: "graticule", data: lines, getPath: (d: any) => d.path, getColor: t.grid, widthUnits: "pixels", getWidth: 1, updateTriggers: { getColor: tm } }));
    const ticks = [29, 29.5, 30, 30.5].map((lo) => ({ pos: [lo, -2.98], text: `${lo.toFixed(1)}°E` }))
      .concat([-1.5, -2.0, -2.5].map((la) => ({ pos: [28.66, la], text: `${Math.abs(la).toFixed(1)}°S` })));
    layers.push(new TextLayer({ id: "graticule-labels", data: ticks, getPosition: (d: any) => d.pos, getText: (d: any) => d.text, getSize: 10, getColor: t.muted,
      fontFamily: '"Public Sans Variable", system-ui, sans-serif', characterSet: "0123456789.°ES", updateTriggers: { getColor: tm } }));
  }
  layers.push(new GeoJsonLayer({ id: "halo", data: p.provinces, filled: false, stroked: true, getLineColor: t.halo, lineWidthUnits: "pixels", getLineWidth: mini ? 5 : 9, updateTriggers: { getLineColor: tm } }));
  layers.push(new GeoJsonLayer({ id: "plinth", data: p.provinces, filled: true, stroked: true, getFillColor: [...t.landBase, 255], getLineColor: t.outline, lineWidthUnits: "pixels", getLineWidth: 1.2, updateTriggers: { getFillColor: tm, getLineColor: tm } }));
  layers.push(new GeoJsonLayer({
    id: "districts", data: p.districts, extruded: true, wireframe: true, filled: true, stroked: false, pickable: !!(p.onSelect || p.onHover),
    getElevation: (f: any) => heightOf(f.properties.district_code), elevationScale: rise,
    getFillColor: (f: any) => colorOf(f.properties.district_code), getLineColor: t.edge,
    material: { ambient: 0.62, diffuse: 0.5, shininess: 14, specularColor: [40, 44, 50] },
    autoHighlight: !mini, highlightColor: tm === "dark" ? [255, 255, 255, 46] : [27, 36, 48, 30],
    transitions: trans,
    updateTriggers: { getElevation: [updateKey, dataKey], getFillColor: [updateKey, dataKey], getLineColor: tm },
  }));
  // Outline rings for the selected district and the INS-1b highlight, lifted to the top of the extrusion.
  const rings = [p.selected && { code: p.selected, c: t.label }, p.highlight && p.highlight !== p.selected && { code: p.highlight, c: t.focus }].filter(Boolean) as { code: string; c: RGBA }[];
  if (rings.length && p.districts) {
    const data = rings.map((r) => {
      const f = p.districts.features.find((x: any) => x.properties.district_code === r.code);
      const z = heightOf(r.code) * rise + 120;
      return { path: ringOf(f?.geometry).map(([x, y]) => [x, y, z]), c: r.c };
    });
    layers.push(new PathLayer({ id: "rings", data, getPath: (d: any) => d.path, getColor: (d: any) => d.c, widthUnits: "pixels", getWidth: 2.4, jointRounded: true, updateTriggers: { getPath: [rise, updateKey, dataKey, p.selected, p.highlight], getColor: tm } }));
  }
  if (p.hexPoints) {
    const ramp = rampColors("heat").slice(1).map((h) => hexToRgb(h));
    layers.push(new HexagonLayer({
      id: "hex", data: p.hexPoints, getPosition: (d: any) => [d.lon, d.lat], radius: 3000, coverage: 0.86, extruded: true, gpuAggregation: false,
      elevationRange: [0, 26000], elevationScale: rise, colorRange: ramp as any, pickable: true, upperPercentile: 100,
      material: { ambient: 0.6, diffuse: 0.5, shininess: 12, specularColor: [50, 50, 50] },
      transitions: motion ? { elevationScale: 600 } : undefined, updateTriggers: { colorRange: tm },
    } as any));
  }
  const fz = (code: string) => heightOf(code) * rise + 250;
  if (p.arcs && p.arcs.length) {
    const nMax = Math.max(...p.arcs.map((a) => a.n), 1);
    layers.push(new ArcLayer({
      id: "arcs", data: p.arcs, pickable: true, greatCircle: false,
      getSourcePosition: (a: Arc) => [a.from[0], a.from[1], fz(a.fromCode)], getTargetPosition: (a: Arc) => [a.to[0], a.to[1], 400],
      getSourceColor: [...hexToRgb(tm === "dark" ? "#3987e5" : "#2a78d6"), 210] as RGBA, getTargetColor: tm === "dark" ? [230, 236, 238, 235] : [27, 36, 48, 220],
      getWidth: (a: Arc) => 1 + 6 * Math.sqrt(a.n / nMax), widthUnits: "pixels", getHeight: 0.55, getTilt: 0,
      updateTriggers: { getSourcePosition: [rise, updateKey, dataKey], getSourceColor: tm, getTargetColor: tm },
    }));
  }
  if (p.facilities && p.showFacilities) {
    const vmax = Math.max(...p.facilities.map((f) => f.n_dyspepsia), 1);
    const nonEndo = p.facilities.filter((f) => !p.endoIds?.has(f.location_id));
    const endo = p.facilities.filter((f) => p.endoIds?.has(f.location_id));
    layers.push(new ScatterplotLayer({
      id: "facilities", data: nonEndo, pickable: true, stroked: true, filled: true, radiusUnits: "pixels", lineWidthUnits: "pixels",
      getPosition: (f: Facility) => [f.lon, f.lat, fz(f.district_code)], getRadius: (f: Facility) => 1.8 + 6 * Math.sqrt(f.n_dyspepsia / vmax),
      getFillColor: [...t.ring.slice(0, 3), 150] as RGBA, getLineColor: (f: Facility) => [...tierRgb(f.tier), 235] as RGBA, getLineWidth: 1.5,
      updateTriggers: { getPosition: [rise, updateKey, dataKey], getFillColor: tm, getLineColor: tm },
    }));
    layers.push(new IconLayer({
      id: "endoscopy", data: endo, pickable: true, sizeUnits: "pixels", getSize: 20, billboard: true,
      getIcon: () => ({ url: ENDO_ICON, width: 64, height: 64, mask: true, anchorY: 32 }),
      getPosition: (f: Facility) => [f.lon, f.lat, fz(f.district_code) + 300], getColor: (f: Facility) => [...tierRgb(f.tier), 255] as RGBA,
      updateTriggers: { getPosition: [rise, updateKey, dataKey], getColor: tm },
    }));
  }
  // Selective direct labels: top N by the active metric + selection + highlight (never a label on every district).
  const nLab = p.labels ?? (mini ? 3 : 5);
  const labelCodes = useMemo(() => {
    const k = (metric.key === "lisa_quadrant" ? "asr" : metric.key) as keyof MapRow;
    const top = rows.filter((r) => !r.suppressed && !isLowCoverage(r) && numeric(r, k) !== null).sort((a, b) => (numeric(b, k) ?? 0) - (numeric(a, k) ?? 0)).slice(0, nLab).map((r) => r.geo_code);
    return Array.from(new Set([...top, p.selected, p.highlight].filter(Boolean) as string[]));
  }, [rows, metric.key, nLab, p.selected, p.highlight]);
  if (p.districts && !p.hexPoints && vs && size) {
    // Greedy screen-space collision filter (priority = order in labelCodes: selection/highlight first, then rank).
    const vp = new WebMercatorViewport({ ...vs, width: size.w, height: size.h });
    const order = [p.selected, p.highlight, ...labelCodes].filter((c, i, a) => c && a.indexOf(c) === i) as string[];
    const placed: [number, number, number, number][] = [];
    const feats: any[] = [];
    for (const code of order) {
      const f = p.districts.features.find((x: any) => x.properties.district_code === code);
      if (!f) continue;
      const [sx, sy] = vp.project([f.properties.centroid[0], f.properties.centroid[1], heightOf(code) * rise + 600]);
      const w = f.properties.name.length * 7 + 12, h = 20;
      const box: [number, number, number, number] = [sx - w / 2, sy - 10 - h, sx + w / 2, sy - 10];
      if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push(box); feats.push(f);
    }
    layers.push(new TextLayer({
      id: "labels", data: feats, getText: (f: any) => f.properties.name, getPosition: (f: any) => [f.properties.centroid[0], f.properties.centroid[1], heightOf(f.properties.district_code) * rise + 600] as [number, number, number],
      getSize: mini ? 11 : 12, getColor: t.label, background: true, getBackgroundColor: t.labelBg, backgroundPadding: [5, 3, 5, 3],
      fontFamily: '"Public Sans Variable", system-ui, sans-serif', fontWeight: 600, getPixelOffset: [0, -10], characterSet: "auto",
      getTextAnchor: "middle", getAlignmentBaseline: "bottom", parameters: { depthCompare: "always" } as any,
      updateTriggers: { getPosition: [rise, updateKey, dataKey], getColor: tm, getBackgroundColor: tm },
    }));
  }

  const miniHover = useRef<string | null>(null);
  const onHover = (info: PickingInfo) => {
    if (mini) { miniHover.current = (info.object as any)?.properties?.district_code ?? null; return; }
    if (!p.onHover) return;
    const o: any = info.object;
    if (!o) return p.onHover(null);
    const id = info.layer?.id;
    if (id === "districts") p.onHover({ kind: "district", code: o.properties.district_code, x: info.x, y: info.y });
    else if (id === "facilities" || id === "endoscopy") p.onHover({ kind: "facility", fac: o, endo: id === "endoscopy", x: info.x, y: info.y });
    else if (id === "hex") p.onHover({ kind: "hex", count: o.count ?? o.elevationValue ?? 0, x: info.x, y: info.y });
    else if (id === "arcs") p.onHover({ kind: "arc", arc: o, x: info.x, y: info.y });
    else p.onHover(null);
  };

  return (
    <div ref={box} className="absolute inset-0" onClick={mini ? () => p.onSelect?.(miniHover.current) : undefined}>
      {size && vs && (
        <DeckGL
          views={new MapView({ repeat: false })}
          viewState={vs}
          onViewStateChange={({ viewState }) => setVs(viewState as MapViewState)}
          controller={mini ? false : { dragRotate: true, scrollZoom: true, doubleClickZoom: true, keyboard: true }}
          layers={layers}
          effects={[lighting]}
          onHover={onHover}
          onClick={mini ? undefined : (info: PickingInfo) => {
            const o: any = info.object;
            if (o && info.layer?.id === "districts") p.onSelect?.(o.properties.district_code);
          }}
          getCursor={({ isHovering, isDragging }) => (isDragging ? "grabbing" : isHovering || mini ? "pointer" : "grab")}
          useDevicePixels={mini ? 1 : true}
          style={{ position: "absolute", inset: "0" }}
        />
      )}
    </div>
  );
}
