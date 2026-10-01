import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { CameraControls, Html } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import type { BodyState } from "@/views/case/types";
import { useCaseUI } from "@/views/case/store";
import { BodyModel, type OrganInfo } from "./BodyModel";
import { Pathology } from "./Pathology";
import { shared } from "./organMaterial";
import { labelOf } from "./util";

const HOME = { pos: [0.36, 1.31, 0.86] as const, target: [0.02, 1.17, 0.03] as const };
const FAR = { pos: [0.0, 1.0, 3.6] as const, target: [0.0, 0.92, 0.0] as const };
const SCAN_FROM = 1.82, SCAN_TO = -0.05, SCAN_S = 2.8;

/** Clock + the intro "scan" that sweeps head -> feet, turning skin to glass and revealing the organs. */
function Director({ reducedMotion, controls }: { reducedMotion: boolean; controls: React.RefObject<CameraControls> }) {
  const start = useRef<number | null>(null);
  const flown = useRef(false);
  useFrame((state, dt) => {
    if (!reducedMotion) shared.uTime.value += Math.min(dt, 0.1);
    const ui = useCaseUI.getState();
    if (ui.introDone) { shared.uScanY.value = SCAN_TO - 1; return; }
    if (reducedMotion) {
      shared.uScanY.value = SCAN_TO - 1;
      controls.current?.setLookAt(...HOME.pos, ...HOME.target, false);
      ui.set({ introDone: true });
      return;
    }
    if (start.current === null) start.current = state.clock.elapsedTime;
    const k = Math.min(1, (state.clock.elapsedTime - start.current) / SCAN_S);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    shared.uScanY.value = SCAN_FROM + (SCAN_TO - SCAN_FROM) * e;
    if (k > 0.55 && !flown.current) {
      flown.current = true;
      controls.current?.setLookAt(...HOME.pos, ...HOME.target, true);
    }
    if (k >= 1) ui.set({ introDone: true });
  });
  return null;
}

/** Fly the camera to the clicked organ, back home when cleared. */
function CameraRig({ organs, controls }: { organs: Record<string, OrganInfo>; controls: React.RefObject<CameraControls> }) {
  const selected = useCaseUI((s) => s.selectedOrgan);
  const introDone = useCaseUI((s) => s.introDone);
  const { camera } = useThree();
  useEffect(() => {
    const c = controls.current;
    if (!c || !introDone) return;
    const o = selected ? organs[selected] : null;
    if (!o) { c.setLookAt(...HOME.pos, ...HOME.target, true); return; }
    const size = o.box.getSize(new THREE.Vector3()).length();
    const target = new THREE.Vector3();
    c.getTarget(target);
    const dir = camera.position.clone().sub(target).normalize();
    if (dir.z < 0.35) dir.set(0.35, 0.25, 1).normalize();   // keep a front-ish view so labels read
    const dist = Math.min(0.9, Math.max(0.22, size * 2.4));
    const p = o.center.clone().add(dir.multiplyScalar(dist));
    c.setLookAt(p.x, p.y, p.z, o.center.x, o.center.y, o.center.z, true);
  }, [selected, introDone, organs, camera, controls]);
  return null;
}

/** Floating labels for the most affected organs + whatever is hovered/focused. */
function OrganLabels({ organs, state }: { organs: Record<string, OrganInfo>; state: BodyState }) {
  const hovered = useCaseUI((s) => s.hoveredOrgan);
  const focus = useCaseUI((s) => s.focusOrgans);
  const selected = useCaseUI((s) => s.selectedOrgan);
  const introDone = useCaseUI((s) => s.introDone);
  const labels = useCaseUI((s) => s.layers.organs);
  if (!introDone || !labels) return null;
  const top = Object.entries(state.organScores).filter(([id, s]) => s >= 0.3 && organs[id] && id !== "skin" && id !== "vessels")
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
  const ids = Array.from(new Set([...top, ...(focus ?? []), ...(hovered ? [hovered] : []), ...(selected ? [selected] : [])]))
    .filter((id) => organs[id] && id !== "skin" && id !== "muscles");
  return (
    <>
      {ids.map((id) => {
        const o = organs[id];
        const s = state.organScores[id] ?? 0;
        const strong = hovered === id || selected === id || (focus ?? []).includes(id);
        const side = o.center.x >= 0 ? 1 : -1;
        return (
          <Html key={id} position={o.center} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <div className={`case-label ${strong ? "is-strong" : ""}`} style={{ transform: `translate(${side > 0 ? "18px" : "calc(-100% - 18px)"}, -50%)` }}>
              <span className="case-label-line" style={{ [side > 0 ? "left" : "right"]: -18 } as React.CSSProperties} />
              <span className="font-semibold">{labelOf(id)}</span>
              {s > 0 && <span className="tabular opacity-80">{Math.round(100 * s)}</span>}
            </div>
          </Html>
        );
      })}
    </>
  );
}

/** Software renderers (headless CI, VMs) get no post-processing and DPR 1 so the view stays responsive. */
function useQuality() {
  const [hi, setHi] = useState(true);
  useEffect(() => {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      const r = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
      if (/swiftshader|llvmpipe|software/i.test(r)) setHi(false);
    } catch { /* keep high */ }
  }, []);
  return hi;
}

export function BodyScene({ state, anchors, reducedMotion }: {
  state: BodyState; anchors: Record<string, [number, number, number]>; reducedMotion: boolean;
}) {
  const controls = useRef<CameraControls>(null);
  const [organs, setOrgans] = useState<Record<string, OrganInfo>>({});
  const onOrgans = useCallback((o: Record<string, OrganInfo>) => setOrgans(o), []);
  const hi = useQuality();
  const clearSel = useCaseUI((s) => s.set);
  return (
    <Canvas
      dpr={hi ? [1, 2] : 1} gl={{ antialias: true, alpha: true, powerPreference: "high-performance", preserveDrawingBuffer: true }}
      camera={{ position: [...FAR.pos], fov: 32, near: 0.01, far: 30 }}
      onPointerMissed={() => clearSel({ selectedOrgan: null })}
      onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.05; }}
      aria-label="Interactive 3D body"
    >
      <CameraControls ref={controls} makeDefault minDistance={0.12} maxDistance={4.5} dollySpeed={0.6} smoothTime={0.55}
                      onStart={() => undefined} />
      <Director reducedMotion={reducedMotion} controls={controls} />
      <Suspense fallback={<LoadingBody />}>
        <BodyModel state={state} anchors={anchors} reducedMotion={reducedMotion} onOrgans={onOrgans} />
        {organs.stomach && <Pathology state={state} anchors={anchors} organs={organs} />}
        <CameraRig organs={organs} controls={controls} />
        <OrganLabels organs={organs} state={state} />
      </Suspense>
      {hi && (
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur luminanceThreshold={0.82} luminanceSmoothing={0.2} intensity={0.85} radius={0.7} />
          <Vignette eskil={false} offset={0.25} darkness={0.55} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

function LoadingBody() {
  return <Html center><div className="text-xs text-fog animate-pulse whitespace-nowrap">Loading anatomy model…</div></Html>;
}
