/** 3D "rate landscape" (SPEC §16.3 V3): x = year, z = age group, height = incidence. Lazy-loaded (React.lazy). */
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { Canvas, ThreeEvent, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";

export type Cell = { ai: number; yi: number };
export type LandscapeProps = {
  years: number[]; ages: string[];
  heights: number[][];            // [ai][yi], already mapped to 0..H world units
  colors: [number, number, number][][]; // [ai][yi] rgb 0..1
  refHeight: number | null;       // e.g. index = 100 plane
  refLabel?: string;
  zTicks: { h: number; label: string }[];
  youngFrom: number;              // first age index that is >= 50 (young band = ages before it)
  ridgeLabel?: string | null;
  hover: Cell | null; onHover: (c: Cell | null) => void; reducedMotion: boolean;
  /** Light stage (light theme): ink chrome on the grey tile instead of the dark lightbox chrome. */
  light?: boolean;
};

/** Scene chrome per stage. Light = ink lines and muted labels on the tile grey; dark = pale lines on the dark tile. The
 * under-50 band is marked in neutral ink (no third hue). */
const CHROME = {
  light: { wire: "#15171C", wireOp: 0.1, grid1: "#D6D8DF", grid2: "#E8E9EF", band: "#15171C", bandOp: 0.05, bandLine: 0.35, tick: "#6B7080", tickOp: 0.35,
           label: "text-[#6B7080]", year: "text-[#6B7080]", young: "text-[#15171C] font-semibold", cross: "#15171C", ref: "#15171C", refOp: 0.05, refLine: 0.3, refLabel: "text-[#4A4F5C]",
           sky: "#ffffff", ground: "#c9ccd6" },
  dark: { wire: "#F2F3F5", wireOp: 0.14, grid1: "#3E4450", grid2: "#262A33", band: "#F2F3F5", bandOp: 0.05, bandLine: 0.4, tick: "#8B909E", tickOp: 0.3,
          label: "text-[#8B909E]", year: "text-[#B4B8C2]", young: "text-[#F2F3F5] font-semibold", cross: "#ffffff", ref: "#F2F3F5", refOp: 0.06, refLine: 0.35, refLabel: "text-[#D7DAE0]",
          sky: "#dfe9f2", ground: "#1b2430" },
};
type Chrome = (typeof CHROME)["light"];

const W = 10, D = 7, U = 6;

/** Catmull-Rom upsampling of a grid along both axes. */
function upsample(g: number[][], u: number): number[][] {
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const row = (r: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < r.length - 1; i++) for (let s = 0; s < u; s++) {
      const t = s / u;
      const v = cr(r[Math.max(0, i - 1)], r[i], r[i + 1], r[Math.min(r.length - 1, i + 2)], t);
      out.push(Math.min(Math.max(r[i], r[i + 1]), Math.max(Math.min(r[i], r[i + 1]), v))); // no overshoot
    }
    out.push(r[r.length - 1]);
    return out;
  };
  const a = g.map(row);
  const cols = a[0].map((_, j) => row(a.map((r) => r[j])));
  return cols[0].map((_, i) => cols.map((c) => c[i]));
}

function Surface({ heights, colors, onHover, c }: { heights: number[][]; colors: [number, number, number][][]; onHover: (c: Cell | null) => void; c: Chrome }) {
  const na = heights.length, ny = heights[0].length;
  const geo = useMemo(() => {
    const hs = upsample(heights, U);
    const cs = [0, 1, 2].map((k) => upsample(colors.map((r) => r.map((c) => c[k])), U));
    const ra = hs.length, ry = hs[0].length;
    const pos = new Float32Array(ra * ry * 3), col = new Float32Array(ra * ry * 3);
    const tmp = new THREE.Color();
    for (let a = 0; a < ra; a++) for (let y = 0; y < ry; y++) {
      const i = a * ry + y;
      pos[3 * i] = (y / (ry - 1)) * W - W / 2;
      pos[3 * i + 1] = Math.max(0, hs[a][y]);
      pos[3 * i + 2] = (a / (ra - 1)) * D - D / 2;
      tmp.setRGB(cs[0][a][y], cs[1][a][y], cs[2][a][y], THREE.SRGBColorSpace); // vertex colours live in linear space
      col[3 * i] = tmp.r; col[3 * i + 1] = tmp.g; col[3 * i + 2] = tmp.b;
    }
    const idx: number[] = [];
    for (let a = 0; a < ra - 1; a++) for (let y = 0; y < ry - 1; y++) {
      const i = a * ry + y;
      idx.push(i, i + 1, i + ry, i + 1, i + ry + 1, i + ry);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return { g, hs };
  }, [heights, colors]);
  useEffect(() => () => geo.g.dispose(), [geo]);

  // Wire grid at the data rows/columns, following the smoothed surface.
  const wire = useMemo(() => {
    const pts: number[] = [];
    const { hs } = geo;
    const ra = hs.length, ry = hs[0].length;
    const P = (a: number, y: number) => [(y / (ry - 1)) * W - W / 2, Math.max(0, hs[a][y]) + 0.012, (a / (ra - 1)) * D - D / 2];
    for (let ai = 0; ai < na; ai++) { const a = ai * U; for (let y = 0; y < ry - 1; y++) pts.push(...P(a, y), ...P(a, y + 1)); }
    for (let yi = 0; yi < ny; yi++) { const y = yi * U; for (let a = 0; a < ra - 1; a++) pts.push(...P(a, y), ...P(a + 1, y)); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [geo, na, ny]);
  useEffect(() => () => wire.dispose(), [wire]);

  const pick = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const yi = Math.round(((e.point.x + W / 2) / W) * (ny - 1));
    const ai = Math.round(((e.point.z + D / 2) / D) * (na - 1));
    onHover({ ai: Math.max(0, Math.min(na - 1, ai)), yi: Math.max(0, Math.min(ny - 1, yi)) });
  };
  return (
    <group>
      <mesh geometry={geo.g} onPointerMove={pick} onPointerOut={() => onHover(null)}>
        <meshStandardMaterial vertexColors roughness={0.82} metalness={0.02} side={THREE.DoubleSide} flatShading={false} />
      </mesh>
      <lineSegments geometry={wire}>
        <lineBasicMaterial color={c.wire} transparent opacity={c.wireOp} depthWrite={false} />
      </lineSegments>
    </group>
  );
}

const lab = "whitespace-nowrap text-[10.5px] tabular select-none pointer-events-none";

function Frame({ years, ages, zTicks, youngFrom, H, c }: { years: number[]; ages: string[]; zTicks: LandscapeProps["zTicks"]; youngFrom: number; H: number; c: Chrome }) {
  const ny = years.length, na = ages.length;
  const xs = (yi: number) => (yi / (ny - 1)) * W - W / 2;
  const zs = (ai: number) => (ai / (na - 1)) * D - D / 2;
  const youngEnd = zs(Math.max(0, youngFrom - 1)) + (D / (na - 1)) * 0.5;
  return (
    <group>
      {/* floor grid */}
      <gridHelper args={[Math.max(W, D) + 2, 24, c.grid1, c.grid2]} position={[0, -0.002, 0]} scale={[(W + 1) / (Math.max(W, D) + 2), 1, (D + 1) / (Math.max(W, D) + 2)]} />
      {/* under-50 band on the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, (-D / 2 - 0.3 + youngEnd) / 2]}>
        <planeGeometry args={[W + 0.6, youngEnd + D / 2 + 0.3]} />
        <meshBasicMaterial color={c.band} transparent opacity={c.bandOp} depthWrite={false} />
      </mesh>
      <Line points={[[-W / 2 - 0.3, 0.004, youngEnd], [W / 2 + 0.3, 0.004, youngEnd]]} color={c.band} lineWidth={1} transparent opacity={c.bandLine} />
      {/* back wall z ticks */}
      {zTicks.map((t) => (
        <group key={t.label}>
          <Line points={[[-W / 2, t.h, -D / 2 - 0.02], [W / 2, t.h, -D / 2 - 0.02]]} color={c.tick} lineWidth={0.6} transparent opacity={c.tickOp} />
          <Html position={[-W / 2 - 0.15, t.h, -D / 2]} center style={{ transform: "translateX(-60%)" }} zIndexRange={[5, 0]}><span className={`${lab} ${c.label}`}>{t.label}</span></Html>
        </group>
      ))}
      <Line points={[[-W / 2, 0, -D / 2], [-W / 2, H, -D / 2]]} color={c.tick} lineWidth={0.8} transparent opacity={c.tickOp + 0.15} />
      {/* year labels (front edge) */}
      {years.map((y, i) => (
        <Html key={y} position={[xs(i), 0, D / 2 + 0.45]} center zIndexRange={[5, 0]}><span className={`${lab} ${c.year}`}>{i % (ny > 9 ? 2 : 1) === 0 || i === ny - 1 ? y : ""}</span></Html>
      ))}
      {/* age labels (right edge) */}
      {ages.map((a, i) => (
        <Html key={a} position={[W / 2 + 0.35, 0, zs(i)]} center style={{ transform: "translateX(40%)" }} zIndexRange={[5, 0]}>
          <span className={`${lab} ${i < youngFrom ? c.young : c.label}`}>{a}</span>
        </Html>
      ))}
      <Html position={[W / 2 + 0.35, 0, (-D / 2 + youngEnd) / 2]} center style={{ transform: "translateX(calc(40% + 46px))" }} zIndexRange={[5, 0]}>
        <span className={`${lab} ${c.young} text-[11px] border-l border-current/40 pl-1.5`}>Under 50</span>
      </Html>
    </group>
  );
}

function Crosshair({ hover, heights, years, ages, c }: { hover: Cell; heights: number[][]; years: number[]; ages: string[]; c: Chrome }) {
  const ny = years.length, na = ages.length;
  const xs = (yi: number) => (yi / (ny - 1)) * W - W / 2;
  const zs = (ai: number) => (ai / (na - 1)) * D - D / 2;
  const lift = 0.03;
  const alongAge = heights.map((r, ai) => [xs(hover.yi), Math.max(0, r[hover.yi]) + lift, zs(ai)] as [number, number, number]);
  const alongYear = heights[hover.ai].map((h, yi) => [xs(yi), Math.max(0, h) + lift, zs(hover.ai)] as [number, number, number]);
  const p: [number, number, number] = [xs(hover.yi), Math.max(0, heights[hover.ai][hover.yi]), zs(hover.ai)];
  return (
    <group>
      <Line points={alongAge} color={c.cross} lineWidth={1.6} transparent opacity={0.85} />
      <Line points={alongYear} color={c.cross} lineWidth={1.6} transparent opacity={0.85} />
      <Line points={[[p[0], 0, p[2]], p]} color={c.cross} lineWidth={1} transparent opacity={0.5} dashed dashSize={0.06} gapSize={0.05} />
      <mesh position={p}><sphereGeometry args={[0.07, 16, 16]} /><meshBasicMaterial color={c.cross} /></mesh>
    </group>
  );
}

function RefPlane({ h, label, c }: { h: number; label?: string; c: Chrome }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, h, 0]}>
        <planeGeometry args={[W, D]} />
        <meshBasicMaterial color={c.ref} transparent opacity={c.refOp} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={[[-W / 2, h, -D / 2], [W / 2, h, -D / 2], [W / 2, h, D / 2], [-W / 2, h, D / 2], [-W / 2, h, -D / 2]]} color={c.ref} lineWidth={1} transparent opacity={c.refLine} />
      {label && <Html position={[W / 2, h, -D / 2]} center style={{ transform: "translate(58%, -50%)" }} zIndexRange={[5, 0]}><span className={`${lab} ${c.refLabel}`}>{label}</span></Html>}
    </group>
  );
}

function Rig({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera } = useThree();
  useEffect(() => { camera.lookAt(0, 0.9, 0); }, [camera]);
  return <OrbitControls makeDefault target={[0, 0.9, 0]} enableDamping={!reducedMotion} dampingFactor={0.12} minDistance={6} maxDistance={24}
                        maxPolarAngle={Math.PI * 0.47} minPolarAngle={0.15} rotateSpeed={0.7} />;
}

export function LandscapeScene(p: LandscapeProps) {
  const c = p.light ? CHROME.light : CHROME.dark;
  const H = Math.max(3.2, ...p.zTicks.map((t) => t.h));
  const [ridgePos, setRidgePos] = useState<[number, number, number] | null>(null);
  useEffect(() => {
    // anchor the ridge callout above the highest young cell in the last third of years
    const ny = p.years.length, na = p.ages.length;
    let best = { h: -1, ai: 0, yi: 0 };
    for (let ai = 0; ai < Math.min(p.youngFrom, na); ai++) for (let yi = Math.floor(ny * 0.6); yi < ny; yi++) {
      if (p.heights[ai][yi] > best.h) best = { h: p.heights[ai][yi], ai, yi };
    }
    setRidgePos(best.h >= 0 ? [(best.yi / (ny - 1)) * W - W / 2, best.h + 0.35, (best.ai / (na - 1)) * D - D / 2] : null);
  }, [p.heights, p.years.length, p.ages.length, p.youngFrom]);
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
            camera={{ position: [9.6, 8.4, 14.2], fov: 32, near: 0.1, far: 100 }}
            onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.05; }}
            onPointerMissed={() => p.onHover(null)} aria-label="3D rate landscape: year by age group by incidence">
      <hemisphereLight args={[c.sky, c.ground, 0.9]} />
      <directionalLight position={[-6, 10, 6]} intensity={1.6} />
      <directionalLight position={[8, 4, -6]} intensity={0.35} color="#8fb4d9" />
      <Rig reducedMotion={p.reducedMotion} />
      <Frame years={p.years} ages={p.ages} zTicks={p.zTicks} youngFrom={p.youngFrom} H={H} c={c} />
      <Surface heights={p.heights} colors={p.colors} onHover={p.onHover} c={c} />
      {p.refHeight !== null && <RefPlane h={p.refHeight} label={p.refLabel} c={c} />}
      {p.hover && <Crosshair hover={p.hover} heights={p.heights} years={p.years} ages={p.ages} c={c} />}
      {p.ridgeLabel && ridgePos && !p.hover && (
        <Html position={ridgePos} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
          <div className="whitespace-nowrap rounded-full bg-[rgb(var(--surface))] text-[rgb(var(--ink))] text-[12px] leading-none px-3 py-2" style={{ transform: "translateY(-120%)" }}>{p.ridgeLabel}</div>
        </Html>
      )}
    </Canvas>
  );
}
