import { useEffect, useMemo, useState } from "react";
import { ThreeCanvas } from "@remotion/three";
import { continueRender, delayRender, Easing, getRemotionEnvironment, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { BodySvg } from "../anatomy/BodySvg";
import { makeVideoOrganMaterial, ORGAN_COLORS, type VideoOrganUniforms } from "./organShader";

export const MODEL_PATH = "models/body.meshopt.glb";
const SHELLS = new Set(["skin", "muscles"]);

let cache: Promise<THREE.Group> | null = null;
function loadBody(): Promise<THREE.Group> {
  if (!cache) {
    cache = (async () => {
      await MeshoptDecoder.ready;
      const res = await fetch(staticFile(MODEL_PATH));
      if (!res.ok) throw new Error(`body model ${res.status}`);
      const buf = await res.arrayBuffer();
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(buf, "");
      return gltf.scene as THREE.Group;
    })();
    cache.catch(() => { cache = null; });
  }
  return cache;
}

export function webglAvailable(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

type Organ = { id: string; u: VideoOrganUniforms };

/** The anatomy model on the light stage. Pure function of the frame: rotation, scan line and score colours. */
function Body({ scene, scores, focus }: { scene: THREE.Group; scores: Record<string, number>; focus: string[] }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { camera } = useThree();
  const organs = useMemo(() => {
    const root = scene.clone(true);
    const out: Organ[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const id = mesh.name in ORGAN_COLORS ? mesh.name : mesh.parent?.name ?? mesh.name;
      if (id === "muscles") { mesh.visible = false; return; }
      const { material, u } = makeVideoOrganMaterial(ORGAN_COLORS[id] ?? "#999999", {
        shell: SHELLS.has(id) ? 1 : 0, xray: id === "skeleton" ? 0.85 : 0,
      });
      mesh.material = material;
      mesh.renderOrder = id === "skin" ? 4 : id === "skeleton" ? 2 : 1;
      out.push({ id, u });
    });
    return { root, out };
  }, [scene]);

  const t = frame / fps;
  // scan head -> hips in the first 45% of the shot, then a slow 300-degree turn that settles facing the camera
  const scanY = interpolate(frame, [0, durationInFrames * 0.45], [1.82, 0.0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const rot = interpolate(frame, [0, durationInFrames - 1], [-Math.PI * 1.65, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const reveal = interpolate(frame, [durationInFrames * 0.35, durationInFrames * 0.75], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  for (const o of organs.out) {
    o.u.uTime.value = t;
    o.u.uScanY.value = scanY;
    o.u.uScore.value = (scores[o.id] ?? 0) * reveal;
    const isFocus = focus.includes(o.id);
    o.u.uFocus.value = isFocus ? 1 : 0;
    o.u.uDim.value = focus.length && !isFocus && !SHELLS.has(o.id) && o.id !== "skeleton" && (scores[o.id] ?? 0) === 0 ? 0.35 * reveal : 0;
  }
  organs.root.rotation.y = rot;
  camera.position.set(0, 1.32, 1.8);
  camera.lookAt(0, 1.3, 0);
  return <primitive object={organs.root} />;
}

/** About 4 s of turntable on the real GLB with organ colour by score. Falls back to the 2D body when WebGL or the model
 * is unavailable (or when `force2d` is set), so a render never fails on the 3D shot. */
export function BodyTurntable3D({ scores, focus = [], width, height, force2d = false }: {
  scores: Record<string, number>; focus?: string[]; width: number; height: number; force2d?: boolean;
}) {
  const [scene, setScene] = useState<THREE.Group | null>(null);
  const [failed, setFailed] = useState(() => force2d || !webglAvailable());
  const [handle] = useState(() => (failed || !getRemotionEnvironment().isRendering ? null : delayRender("Loading 3D body model", { timeoutInMilliseconds: 60_000 })));
  useEffect(() => {
    if (failed) return;
    let alive = true;
    const release = () => { if (handle !== null) continueRender(handle); };
    loadBody().then((s) => { if (alive) setScene(s); release(); })
      .catch((e) => { console.warn("3D body unavailable, using the 2D body", e); if (alive) setFailed(true); release(); });
    return () => { alive = false; };
  }, [failed, handle]);

  if (failed) return <Fallback2D scores={scores} focus={focus} width={width} height={height} />;
  if (!scene) return null;
  return (
    <ThreeCanvas width={width} height={height} camera={{ fov: 30, near: 0.01, far: 30, position: [0, 1.32, 1.8] }}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.05; }}>
      <Body scene={scene} scores={scores} focus={focus} />
    </ThreeCanvas>
  );
}

function Fallback2D({ scores, focus, width, height }: { scores: Record<string, number>; focus: string[]; width: number; height: number }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const reveal = interpolate(frame, [0, durationInFrames * 0.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const s = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v * reveal]));
  return (
    <div style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <BodySvg scores={s} highlight={focus[0] ?? null} height={height * 0.94} />
    </div>
  );
}
