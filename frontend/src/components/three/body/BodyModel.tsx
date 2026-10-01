import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import type { BodyState } from "@/views/case/types";
import { useCaseUI } from "@/views/case/store";
import { ORGAN_COLORS, bloodColor, glowColor, makeOrganMaterial, shared, type OrganUniforms } from "./organMaterial";

export const MODEL_URL = "/models/body.meshopt.glb";
const SHELLS = new Set(["skin", "muscles"]);
const ORDER: Record<string, number> = { skeleton: 2, skin: 4, muscles: 3 };
const damp = THREE.MathUtils.damp;

export type OrganInfo = { id: string; mesh: THREE.Mesh; center: THREE.Vector3; box: THREE.Box3; u: OrganUniforms };

/** The anatomy model: every node is an organ id from config/body_map.yaml. Materials are custom shaders driven per
 *  frame from the BodyState (glow, flashes, lesion, vitals) and the UI state (hover, focus, layers, x-ray). */
export function BodyModel({ state, anchors, reducedMotion, onOrgans }: {
  state: BodyState; anchors: Record<string, [number, number, number]>; reducedMotion: boolean;
  onOrgans?: (o: Record<string, OrganInfo>) => void;
}) {
  const gltf = useGLTF(MODEL_URL, false, true);
  const organs = useMemo(() => {
    const out: Record<string, OrganInfo> = {};
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const id = mesh.name in ORGAN_COLORS ? mesh.name : mesh.parent?.name ?? mesh.name;
      const { material, u } = makeOrganMaterial(ORGAN_COLORS[id] ?? "#999999", {
        // skeleton is a "ghost" (glassy rims) so the ribs never hide the stomach
        shell: SHELLS.has(id) ? 1 : id === "skeleton" ? 0.75 : 0, opacity: id === "skin" ? 1 : id === "muscles" ? 0.9 : 1, flow: id === "vessels",
      });
      mesh.material = material;
      mesh.renderOrder = ORDER[id] ?? 1;
      mesh.userData.organId = id;
      if (SHELLS.has(id) || id === "skeleton") mesh.raycast = () => {};   // pick organs through the shells
      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      u.uCenter.value.copy(center);
      if (id === "skin" || id === "muscles") u.uCenter.value.set(0, center.y, -0.01);
      out[id] = { id, mesh, center, box, u };
    });
    return out;
  }, [gltf]);

  useEffect(() => { onOrgans?.(organs); }, [organs, onOrgans]);

  const st = useRef(state);
  st.current = state;

  useFrame((_, dt) => {
    const s = st.current;
    const ui = useCaseUI.getState();
    const t = shared.uTime.value;
    const emph = ui.focusOrgans ?? (ui.hoveredOrgan ? [ui.hoveredOrgan] : ui.selectedOrgan ? [ui.selectedOrgan] : null);
    const lesionPos = s.lesion ? anchorFor(s.lesion.region, anchors, organs) : null;
    for (const o of Object.values(organs)) {
      const u = o.u;
      const id = o.id;
      const score = s.organScores[id] ?? 0;
      u.uScore.value = damp(u.uScore.value, score, 4, dt);
      u.uFlash.value = damp(u.uFlash.value, s.flashes[id] ?? 0, 10, dt);
      glowColor(score, u.uGlow.value);
      const focused = emph ? emph.includes(id) : false;
      u.uHover.value = damp(u.uHover.value, focused ? 1 : 0, 10, dt);
      const dim = emph && !focused && !SHELLS.has(id) && id !== "skeleton" ? 1 : 0;
      u.uDim.value = damp(u.uDim.value, dim, 8, dt);
      u.uXray.value = damp(u.uXray.value, ui.xray && !SHELLS.has(id) ? 1 : 0, 6, dt);

      // layer visibility (fade, then hide so hidden layers don't cost fill-rate)
      const visible = id === "skin" ? ui.layers.skin : id === "muscles" ? ui.layers.muscles : id === "skeleton" ? ui.layers.skeleton : ui.layers.organs;
      const targetOp = visible ? (id === "muscles" ? 0.9 : 1) : 0;
      u.uOpacity.value = damp(u.uOpacity.value, targetOp, 7, dt);
      o.mesh.visible = u.uOpacity.value > 0.01;

      // physiology
      const sc = u.uScale.value;
      if (id === "heart" && !reducedMotion) {
        const bpm = clamp(s.pulse ?? 72, 40, 160);
        const p = (t * bpm / 60) % 1;
        const k = 1 + 0.07 * Math.exp(-(((p - 0.06) / 0.045) ** 2)) + 0.04 * Math.exp(-(((p - 0.3) / 0.06) ** 2));
        sc.setScalar(k);
      } else if ((id === "lung_l" || id === "lung_r") && !reducedMotion) {
        const rr = clamp(s.rr ?? 16, 8, 40);
        const b = 0.5 - 0.5 * Math.cos((2 * Math.PI * t * rr) / 60);
        sc.set(1 + 0.035 * b, 1 + 0.02 * b, 1 + 0.05 * b);
      } else if (id === "skin" || id === "muscles") {
        // weight loss thins the silhouette (half the % change, floored at -12%)
        const w = s.weightChangePct ?? 0;
        const k = 1 + clamp(w, -24, 10) / 200;
        sc.set(damp(sc.x, k, 3, dt), 1, damp(sc.z, k, 3, dt));
      } else {
        sc.setScalar(1);
      }
      if (id === "vessels") {
        bloodColor(s.hb, u.uBlood.value);
        u.uFlowSpeed.value = reducedMotion ? 0 : clamp(s.pulse ?? 72, 40, 160) / 60;
      }
      if (id === "skin") u.uHeat.value = damp(u.uHeat.value, s.temp !== null && s.temp >= 37.5 ? clamp((s.temp - 37.2) / 1.6, 0, 1) : 0, 3, dt);
      if (id === "stomach") {
        if (s.lesion && lesionPos) {
          u.uLesionPos.value.copy(lesionPos);
          const diffuse = s.lesion.region === "diffuse";
          const r = s.lesion.suspected ? 0.035 : diffuse ? 0.09
            : s.lesion.sizeMm ? Math.min(0.055, 0.012 + s.lesion.sizeMm / 1400) : 0.012 + 0.006 * s.lesion.level;
          u.uLesionR.value = damp(u.uLesionR.value, r, 4, dt);
          u.uLesionAmt.value = damp(u.uLesionAmt.value, s.lesion.suspected ? Math.min(1, 0.4 + s.lesion.level) : 1, 4, dt);
          u.uSuspect.value = s.lesion.suspected ? 1 : 0;
        } else {
          u.uLesionAmt.value = damp(u.uLesionAmt.value, 0, 4, dt);
        }
      }
    }
  });

  const set = useCaseUI((s) => s.set);
  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const id = (e.object as THREE.Mesh).userData.organId as string;
    if (id) { set({ hoveredOrgan: id }); document.body.style.cursor = "pointer"; }
  };
  const onOut = () => { set({ hoveredOrgan: null }); document.body.style.cursor = ""; };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const id = (e.object as THREE.Mesh).userData.organId as string;
    if (id) set({ selectedOrgan: useCaseUI.getState().selectedOrgan === id ? null : id });
  };
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  return <primitive object={gltf.scene} onPointerOver={onOver} onPointerOut={onOut} onClick={onClick} />;
}

export function anchorFor(region: string, anchors: Record<string, [number, number, number]>, organs: Record<string, OrganInfo>) {
  const a = anchors[`stomach_${region}`];
  if (a) return new THREE.Vector3(...a);
  return organs.stomach?.center.clone() ?? null;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

useGLTF.preload(MODEL_URL, false, true);
