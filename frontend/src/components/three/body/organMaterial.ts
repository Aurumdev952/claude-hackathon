import * as THREE from "three";

/** Uniforms shared by every body material (one object, so the intro scan and the clock drive all meshes at once). */
export const shared = {
  uTime: { value: 0 },
  /** world Y of the intro scan plane: above it the body is "revealed" (skin -> glass shell, organs visible) */
  uScanY: { value: 2.2 },
};

export type OrganUniforms = {
  uColor: { value: THREE.Color }; uGlow: { value: THREE.Color }; uScore: { value: number }; uFlash: { value: number };
  uHover: { value: number }; uDim: { value: number }; uOpacity: { value: number }; uXray: { value: number }; uShell: { value: number };
  uPulse: { value: number }; uCenter: { value: THREE.Vector3 }; uScale: { value: THREE.Vector3 };
  uLesionPos: { value: THREE.Vector3 }; uLesionR: { value: number }; uLesionAmt: { value: number }; uSuspect: { value: number };
  uFlow: { value: number }; uFlowSpeed: { value: number }; uBlood: { value: THREE.Color }; uRim: { value: THREE.Color }; uHeat: { value: number };
  uTime: { value: number }; uScanY: { value: number };
};

const vertex = /* glsl */ `
  uniform vec3 uCenter;
  uniform vec3 uScale;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // animated deformation about the organ centre (heart beat, breathing, body thinning)
    wp.xyz = uCenter + (wp.xyz - uCenter) * uScale;
    vWorld = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor; uniform vec3 uGlow; uniform vec3 uBlood; uniform vec3 uRim;
  uniform float uScore; uniform float uFlash; uniform float uHover; uniform float uDim; uniform float uOpacity;
  uniform float uXray; uniform float uShell; uniform float uPulse; uniform float uTime; uniform float uScanY;
  uniform vec3 uLesionPos; uniform float uLesionR; uniform float uLesionAmt; uniform float uSuspect;
  uniform float uFlow; uniform float uFlowSpeed; uniform float uHeat;
  varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(vView);
    float ndv = abs(dot(n, v));
    float fres = pow(1.0 - ndv, 2.4);

    // soft "museum" lighting: wrapped key light + cool fill + hemisphere ambient + a small specular
    vec3 L1 = normalize(vec3(0.45, 0.85, 0.7));
    vec3 L2 = normalize(vec3(-0.6, 0.2, 0.4));
    float k1 = clamp((dot(n, L1) + 0.35) / 1.35, 0.0, 1.0);
    float k2 = clamp(dot(n, L2), 0.0, 1.0);
    float hemi = 0.5 + 0.5 * n.y;
    vec3 h = normalize(L1 + v);
    float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.25;
    vec3 base = uColor;

    // blood flow along vessels: travelling bands, colour follows haemoglobin
    if (uFlow > 0.5) {
      float band = smoothstep(0.55, 1.0, sin(vWorld.y * 70.0 + vWorld.x * 20.0 - uTime * uFlowSpeed * 6.0));
      base = mix(uBlood * 0.75, uBlood * 1.5, band);
    }
    vec3 lit = base * (0.22 + 0.7 * k1 + 0.18 * k2) * mix(vec3(0.75, 0.8, 0.9), vec3(1.0), hemi) + spec;

    // severity glow: pulsing fresnel rim + inner emissive; flash spikes when a replayed event lands
    float beat = 0.72 + 0.28 * sin(uTime * 2.4 + vWorld.y * 8.0);
    float g = uScore * beat + uFlash * 1.4;
    vec3 col = lit + uGlow * (fres * 2.2 + 0.28) * g;

    // tumour infiltration / suspected zone on the organ wall (stomach only)
    if (uLesionAmt > 0.0) {
      float d = distance(vWorld, uLesionPos);
      float wob = noise(vWorld * 140.0 + uTime * 0.15) * 0.45 + noise(vWorld * 40.0) * 0.55;
      float r = uLesionR * (0.75 + 0.5 * wob);
      float m = (1.0 - smoothstep(r * 0.55, r, d)) * uLesionAmt;
      if (uSuspect > 0.5) {
        // concentric "searching" rings that close in on the suspected region
        float rings = smoothstep(0.82, 1.0, sin(d * 420.0 + uTime * 3.0)) * (1.0 - smoothstep(r * 0.4, r * 1.4, d));
        col = mix(col, uGlow * 1.8, rings * uLesionAmt * 0.8 + m * 0.25);
      } else {
        vec3 lesion = mix(vec3(0.55, 0.12, 0.08), vec3(1.6, 0.45, 0.2), wob) * (0.85 + 0.35 * sin(uTime * 3.2));
        col = mix(col, lesion, m);
      }
    }

    // fever: warm rim on the skin
    col += vec3(1.0, 0.45, 0.2) * uHeat * fres * 0.9;
    // hover / focus: a crisp cool rim (keeps the organ's own glow colour readable underneath)
    col += uRim * uHover * smoothstep(0.35, 1.0, fres) * 1.4;

    float alpha = uOpacity;
    if (uShell > 0.0) {
      // glass shell: mostly rim, faintly filled
      alpha = mix(uOpacity, clamp(fres * 0.65 + 0.025, 0.0, 1.0) * uOpacity, uShell);
      col = mix(col, mix(uColor * 0.6, vec3(0.8, 0.9, 1.0), fres) + uGlow * g * fres, uShell * 0.85);
    }
    if (uXray > 0.0) {
      vec3 xr = vec3(0.55, 0.78, 1.0) * (fres * 1.3 + 0.08) + uGlow * g * (fres * 2.0 + 0.4);
      col = mix(col, xr, uXray);
      alpha = mix(alpha, clamp(fres * 0.85 + 0.06 + g * 0.35, 0.0, 1.0), uXray);
    }

    // intro scan: below the plane the skin is solid and the inside is hidden; a bright line marks the plane
    float revealed = step(uScanY, vWorld.y);
    float edge = 1.0 - smoothstep(0.0, 0.012, abs(vWorld.y - uScanY));
    if (uShell > 0.5) {
      alpha = mix(1.0, alpha, revealed);
      col = mix(lit, col, revealed);
    } else if (uShell < 0.01 && revealed < 0.5) {
      discard;
    }
    col += vec3(0.45, 0.8, 1.0) * edge * 2.5;

    // dim everything that is not in focus
    col *= 1.0 - 0.62 * uDim;
    alpha *= 1.0 - 0.55 * uDim;
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function makeOrganMaterial(color: string, opts: { shell?: number; opacity?: number; flow?: boolean } = {}) {
  const uniforms: OrganUniforms = {
    uColor: { value: new THREE.Color(color) }, uGlow: { value: new THREE.Color("#ff6a3a") }, uScore: { value: 0 }, uFlash: { value: 0 },
    uHover: { value: 0 }, uDim: { value: 0 }, uOpacity: { value: opts.opacity ?? 1 }, uXray: { value: 0 }, uShell: { value: opts.shell ?? 0 },
    uPulse: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uScale: { value: new THREE.Vector3(1, 1, 1) },
    uLesionPos: { value: new THREE.Vector3() }, uLesionR: { value: 0.02 }, uLesionAmt: { value: 0 }, uSuspect: { value: 0 },
    uFlow: { value: opts.flow ? 1 : 0 }, uFlowSpeed: { value: 1.2 }, uBlood: { value: new THREE.Color("#b3261e") },
    uRim: { value: new THREE.Color("#8fd3ff") }, uHeat: { value: 0 },
    uTime: shared.uTime, uScanY: shared.uScanY,
  };
  const m = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: vertex, fragmentShader: fragment,
    transparent: true, side: opts.shell ? THREE.FrontSide : THREE.DoubleSide,
    depthWrite: !opts.shell,
  });
  return { material: m, u: uniforms };
}

/** Desaturated anatomical base colours, tuned to sit on the dark "lightbox" stage. */
export const ORGAN_COLORS: Record<string, string> = {
  skin: "#c9a48c", muscles: "#8f463f", skeleton: "#ddd5c4", brain: "#cdb0a8", oesophagus: "#c4877a", stomach: "#d0907f",
  duodenum: "#c99a7a", small_intestine: "#d4a490", large_intestine: "#b98c78", liver: "#8c4b3f", gallbladder: "#6a8f5d",
  pancreas: "#d9b38c", spleen: "#7d3d48", lymph_nodes: "#c7cc8e", kidney_l: "#8e4a42", kidney_r: "#8e4a42", heart: "#a8443e",
  vessels: "#a33a3a", lung_l: "#c99aa0", lung_r: "#c99aa0",
};

/** Glow colour for a severity in 0..1: warm amber -> hot laterite (sequential, one hue family). */
export function glowColor(s: number, out = new THREE.Color()) {
  const a = new THREE.Color("#f2a541"), b = new THREE.Color("#ff4b2b");
  return out.copy(a).lerp(b, Math.min(1, Math.max(0, s)));
}

/** Blood colour from haemoglobin (g/dL): deep red when normal, washed-out pink when anaemic. */
export function bloodColor(hb: number | null, out = new THREE.Color()) {
  const t = hb === null ? 0 : Math.min(1, Math.max(0, (12.5 - hb) / 5.5));
  return out.copy(new THREE.Color("#b3261e")).lerp(new THREE.Color("#e9a3a0"), t);
}
