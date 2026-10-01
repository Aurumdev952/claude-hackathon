import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { QuadraticBezierLine } from "@react-three/drei";
import type { BodyState } from "@/views/case/types";
import { shared } from "./organMaterial";
import { anchorFor, type OrganInfo } from "./BodyModel";

const blobVertex = /* glsl */ `
  uniform float uTime; uniform float uGrow; uniform float uSeed;
  varying vec3 vN; varying vec3 vV; varying float vNoise;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 p = position;
    float n = noise(normal * 3.0 + uSeed + uTime * 0.25) * 0.6 + noise(normal * 7.0 - uTime * 0.4) * 0.4;
    vNoise = n;
    p += normal * (n - 0.35) * 0.55 * length(position);
    p *= uGrow * (1.0 + 0.04 * sin(uTime * 3.2 + uSeed));
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const blobFragment = /* glsl */ `
  uniform vec3 uCore; uniform vec3 uHot; uniform float uOpacity;
  varying vec3 vN; varying vec3 vV; varying float vNoise;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
    vec3 col = mix(uCore, uHot, smoothstep(0.3, 0.8, vNoise)) * (0.6 + 0.6 * f) + uHot * f * 1.6;
    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function useBlobMaterial(core: string, hot: string, seed: number) {
  return useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uGrow: { value: 0 }, uSeed: { value: seed }, uCore: { value: new THREE.Color(core) },
                uHot: { value: new THREE.Color(hot) }, uOpacity: { value: 1 } },
    vertexShader: blobVertex, fragmentShader: blobFragment, transparent: true,
  }), [core, hot, seed]);
}

/** Irregular tumour mass; grows in when it first appears (diagnosis during replay). */
function Blob({ position, radius, core = "#5a140c", hot = "#ff7a3d", seed = 0, delay = 0 }: {
  position: THREE.Vector3; radius: number; core?: string; hot?: string; seed?: number; delay?: number;
}) {
  const mat = useBlobMaterial(core, hot, seed);
  // second pass drawn through all tissue (no depth test) at low opacity, so the lesion is never fully hidden
  const ghost = useMemo(() => {
    const m = mat.clone();
    m.uniforms = { ...mat.uniforms, uOpacity: { value: 0.32 } };
    m.depthTest = false; m.depthWrite = false;
    return m;
  }, [mat]);
  const geo = useMemo(() => new THREE.IcosahedronGeometry(radius, 5), [radius]);
  const born = useRef<number | null>(null);
  useFrame(() => {
    const t = shared.uTime.value;
    if (born.current === null) born.current = t;
    const k = Math.min(1, Math.max(0, (t - born.current - delay) / 0.9));
    mat.uniforms.uGrow.value = 1 - Math.pow(1 - k, 3);
  });
  return (
    <group position={position}>
      <mesh geometry={geo} material={mat} renderOrder={2} raycast={() => {}} />
      <mesh geometry={geo} material={ghost} renderOrder={12} raycast={() => {}} />
    </group>
  );
}

/** Perigastric lymph node stations sampled from the lymph_nodes mesh, nearest the stomach first. */
function useNodeStations(organs: Record<string, OrganInfo>, from: THREE.Vector3 | null) {
  return useMemo(() => {
    const ln = organs.lymph_nodes, st = organs.stomach;
    if (!ln || !st) return [];
    const pos = ln.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const cand: THREE.Vector3[] = [];
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i);
      ln.mesh.localToWorld(v);
      if (v.distanceTo(st.center) < 0.11) cand.push(v.clone());
    }
    if (!cand.length) return [];
    // farthest-point sampling -> 12 well-spread stations
    const picked: THREE.Vector3[] = [cand[0]];
    const dmin = cand.map((c) => c.distanceTo(cand[0]));
    while (picked.length < 12 && picked.length < cand.length) {
      let bi = 0;
      for (let i = 1; i < cand.length; i++) if (dmin[i] > dmin[bi]) bi = i;
      picked.push(cand[bi]);
      for (let i = 0; i < cand.length; i++) dmin[i] = Math.min(dmin[i], cand[i].distanceTo(cand[bi]));
    }
    const origin = from ?? st.center;
    return picked.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
  }, [organs, from]);
}

function NodeMarker({ p, lit, i }: { p: THREE.Vector3; lit: boolean; i: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: lit ? "#ffb347" : "#9aa6a0", transparent: true, opacity: lit ? 0.95 : 0.3, depthTest: !lit }), [lit]);
  useFrame(() => {
    if (!ref.current) return;
    const t = shared.uTime.value;
    const s = lit ? 1 + 0.35 * Math.max(0, Math.sin(t * 3 - i * 0.6)) : 1;
    ref.current.scale.setScalar(s);
    if (lit) mat.color.setRGB(1.6, 0.75 + 0.3 * Math.sin(t * 3 - i * 0.6), 0.3);
  });
  return <mesh ref={ref} position={p} material={mat} renderOrder={lit ? 13 : 2} raycast={() => {}}><sphereGeometry args={[lit ? 0.0042 : 0.003, 16, 12]} /></mesh>;
}

/** Animated spread path (dashes flow from the primary tumour to the metastatic site). */
function SpreadArc({ from, to, color = "#ff7a3d" }: { from: THREE.Vector3; to: THREE.Vector3; color?: string }) {
  const ref = useRef<any>(null);
  const mid = useMemo(() => from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 0.02, 0.07)), [from, to]);
  useFrame((_, dt) => { if (ref.current?.material) ref.current.material.dashOffset -= dt * 0.6; });
  return <QuadraticBezierLine ref={ref} start={from} end={to} mid={mid} color={color} lineWidth={2} dashed dashScale={60} dashSize={1} gapSize={1.2} transparent opacity={0.9} />;
}

const MET_LAYOUT: Record<string, [number, number, number][]> = {
  liver: [[0, 0, 0], [0.014, -0.01, 0.006], [-0.012, 0.008, 0.01]],
  peritoneum: [[-0.04, 0.01, 0], [-0.015, -0.012, 0.004], [0.012, 0.006, 0.002], [0.035, -0.006, 0], [0.002, 0.02, 0.003], [0.052, 0.014, -0.004]],
};
const MET_ANCHOR: Record<string, string> = { liver: "liver_metastasis", peritoneum: "peritoneum" };

/** Tumour + spread layer: primary lesion at the endoscopy location, lit nodal stations (N), metastases (M1). */
export function Pathology({ state, anchors, organs }: {
  state: BodyState; anchors: Record<string, [number, number, number]>; organs: Record<string, OrganInfo>;
}) {
  const les = state.lesion;
  const pos = useMemo(() => (les ? anchorFor(les.region, anchors, organs) : null), [les?.region, anchors, organs]);   // eslint-disable-line
  const stations = useNodeStations(organs, pos);
  if (!les || !pos || les.suspected) return null;
  const litCount = les.nodes === 0 ? 0 : les.nodes === 1 ? 3 : les.nodes === 2 ? 6 : 10;
  // radius from the endoscopic size when recorded (a 54 mm mass -> ~2.3 cm radius), else from the T stage
  const r = les.region === "diffuse" ? 0.008
    : les.sizeMm ? Math.min(0.03, Math.max(0.006, (les.sizeMm / 2000) * 0.85)) : 0.006 + 0.0028 * les.level;
  return (
    <group>
      {les.region === "diffuse"
        ? [0, 1, 2].map((i) => <Blob key={i} position={pos.clone().add(new THREE.Vector3((i - 1) * 0.022, (i % 2) * 0.012, 0.004))} radius={r} seed={i * 3.1} delay={i * 0.15} />)
        : <Blob position={pos} radius={r} seed={1.7} />}
      {stations.map((p, i) => <NodeMarker key={i} p={p} lit={i < litCount} i={i} />)}
      {les.mets.map((site) => {
        const a = anchors[MET_ANCHOR[site]];
        if (!a) return null;
        const c = new THREE.Vector3(...a);
        return (
          <group key={site}>
            <SpreadArc from={pos} to={c} />
            {(MET_LAYOUT[site] ?? [[0, 0, 0]]).map((o, i) => (
              <Blob key={i} position={c.clone().add(new THREE.Vector3(...o))} radius={site === "liver" ? 0.007 - i * 0.0012 : 0.0035} seed={i * 5.3 + 2} delay={0.4 + i * 0.12} core="#4a1010" hot="#ff9a5a" />
            ))}
          </group>
        );
      })}
    </group>
  );
}
