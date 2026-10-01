/** 3D "journey helix" (SPEC §16.3 V4): one ring per month before diagnosis, one dot per recorded event of ~200 sample cases.
 * Rings narrow toward diagnosis, so the clustering of events in the last months reads as a vortex. Lazy-loaded. */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, ThreeEvent } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import type { JourneyRow } from "./api";

export type HelixProps = {
  events: JourneyRow[]; kindColor: Record<string, string>; hidden: Set<string>;
  hoverCase: number | null; onHover: (e: JourneyRow | null) => void; reducedMotion: boolean;
  /** Light stage (light theme): ink rings and labels on the grey tile. */
  light?: boolean;
};

const CHROME = {
  light: { dim: "#F5F6F9", major: "#6B7080", minor: "#A3A8B5", majorOp: 0.5, minorOp: 0.35, axis: "#6B7080", strong: "text-[#15171C]", muted: "text-[#6B7080]", path: "#15171C" },
  dark: { dim: "#1b2430", major: "#b4c0c8", minor: "#56677a", majorOp: 0.55, minorOp: 0.32, axis: "#8696a2", strong: "text-[#F2F3F5]", muted: "text-[#8B909E]", path: "#ffffff" },
};

const HH = 8, R0 = 0.7, R1 = 4.2, TWIST = 0.13;
export const ringY = (m: number) => ((Math.abs(m) - 1) / 23) * HH;
export const ringR = (m: number) => R0 + ((Math.abs(m) - 1) / 23) * (R1 - R0);

function layout(events: JourneyRow[]) {
  const cases = Array.from(new Set(events.map((e) => e.case_index))).sort((a, b) => a - b);
  const slot = new Map(cases.map((c, i) => [c, i]));
  const stack = new Map<string, number>();
  return events.map((e) => {
    const k = `${e.case_index}|${e.month_before}`;
    const j = stack.get(k) ?? 0;
    stack.set(k, j + 1);
    const th = ((slot.get(e.case_index) ?? 0) / cases.length) * Math.PI * 2 + Math.abs(e.month_before) * TWIST;
    const r = ringR(e.month_before) + j * 0.07;
    const y = ringY(e.month_before) + (j % 3) * 0.05;
    return new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
  });
}

function Dots(p: HelixProps & { pos: THREE.Vector3[] }) {
  const { events, pos, kindColor, hidden, hoverCase, onHover } = p;
  const ref = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => new THREE.IcosahedronGeometry(0.036, 1), []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Color();
    events.forEach((e, i) => {
      const hide = hidden.has(e.kind);
      const on = hoverCase === null || e.case_index === hoverCase;
      const k = hide ? 0 : (e.is_abnormal ? 1.55 : 1) * (hoverCase !== null && on ? 1.5 : 1);
      s.set(k, k, k);
      m.compose(pos[i], q, s);
      mesh.setMatrixAt(i, m);
      c.set(kindColor[e.kind] ?? "#8696a2");
      if (!on) c.lerp(new THREE.Color(p.light ? CHROME.light.dim : CHROME.dark.dim), 0.78);
      mesh.setColorAt(i, c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [events, pos, kindColor, hidden, hoverCase, p.light]);
  useEffect(() => () => geo.dispose(), [geo]);
  const pick = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const id = e.instanceId;
    if (id === undefined) return;
    if (hidden.has(events[id].kind)) return;
    onHover(events[id]);
  };
  return (
    <instancedMesh ref={ref} args={[geo, undefined, events.length]} onPointerMove={pick} onPointerOut={() => onHover(null)}>
      <meshLambertMaterial />
    </instancedMesh>
  );
}

function Rings({ counts, light }: { counts: Map<number, number>; light?: boolean }) {
  const c = light ? CHROME.light : CHROME.dark;
  const circle = (m: number) => {
    const r = ringR(m), y = ringY(m);
    return Array.from({ length: 97 }, (_, i) => { const t = (i / 96) * Math.PI * 2; return [Math.cos(t) * r, y, Math.sin(t) * r] as [number, number, number]; });
  };
  const months = Array.from({ length: 24 }, (_, i) => -(i + 1));
  return (
    <group>
      {months.map((m) => {
        const major = m === -1 || Math.abs(m) % 6 === 0;
        return <Line key={m} points={circle(m)} color={major ? c.major : c.minor} lineWidth={major ? 1 : 0.6} transparent opacity={major ? c.majorOp : c.minorOp} />;
      })}
      <Line points={[[0, -0.4, 0], [0, HH + 0.4, 0]]} color={c.axis} lineWidth={0.8} transparent opacity={0.35} />
      {[-1, -3, -6, -12, -18, -24].map((m) => (
        <Html key={m} position={[ringR(m) + 0.25, ringY(m), 0]} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="whitespace-nowrap text-[10.5px] tabular leading-tight" style={{ transform: "translateY(-50%)" }}>
            <span className={`${c.strong} font-semibold`}>{m === -1 ? "Last month" : `${Math.abs(m)} months before`}</span>
            <span className={`${c.muted} ml-2`}>{counts.get(m) ?? 0} events</span>
          </div>
        </Html>
      ))}
      <Html position={[0, -0.55, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
        <div className="whitespace-nowrap rounded-full bg-[rgb(var(--ink))] text-[rgb(var(--on-ink))] text-[12px] leading-none px-3 py-2">Diagnosis</div>
      </Html>
    </group>
  );
}

function CasePath({ events, pos, hoverCase, light }: { events: JourneyRow[]; pos: THREE.Vector3[]; hoverCase: number; light?: boolean }) {
  const pts = events.map((e, i) => ({ e, p: pos[i] })).filter((x) => x.e.case_index === hoverCase).sort((a, b) => a.e.month_before - b.e.month_before).map((x) => x.p);
  if (pts.length < 2) return null;
  return <Line points={[...pts, new THREE.Vector3(0, -0.4, 0)]} color={light ? CHROME.light.path : CHROME.dark.path} lineWidth={1.6} transparent opacity={0.85} />;
}

export function HelixScene(p: HelixProps) {
  const pos = useMemo(() => layout(p.events), [p.events]);
  const counts = useMemo(() => {
    const c = new Map<number, number>();
    p.events.forEach((e) => { if (!p.hidden.has(e.kind)) c.set(e.month_before, (c.get(e.month_before) ?? 0) + 1); });
    return c;
  }, [p.events, p.hidden]);
  return (
    <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
            camera={{ position: [11, 10.4, 14.6], fov: 32, near: 0.1, far: 100 }}
            onPointerMissed={() => p.onHover(null)} aria-label="3D journey helix of pre-diagnostic events">
      <ambientLight intensity={0.85} />
      <directionalLight position={[4, 10, 6]} intensity={1.1} />
      <OrbitControls makeDefault target={[0, HH * 0.47, 0]} enableDamping={!p.reducedMotion} dampingFactor={0.12} minDistance={5} maxDistance={26} rotateSpeed={0.7} />
      <Rings counts={counts} light={p.light} />
      <Dots {...p} pos={pos} />
      {p.hoverCase !== null && <CasePath events={p.events} pos={pos} hoverCase={p.hoverCase} light={p.light} />}
    </Canvas>
  );
}
