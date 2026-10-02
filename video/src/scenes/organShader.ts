import * as THREE from "three";

/** A trimmed copy of the app's organ material (frontend/src/components/three/body/organMaterial.ts) for video: the same
 * light-stage look (steel-blue glass skin, x-ray skeleton, score rim) without the interactive uniforms. Every input is a
 * uniform set from the current frame, so the output is deterministic. */
export type VideoOrganUniforms = {
  uColor: { value: THREE.Color }; uGlow: { value: THREE.Color }; uScore: { value: number }; uDim: { value: number };
  uOpacity: { value: number }; uShell: { value: number }; uXray: { value: number }; uTime: { value: number }; uScanY: { value: number };
  uFocus: { value: number };
};

const vertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor; uniform vec3 uGlow;
  uniform float uScore; uniform float uDim; uniform float uOpacity; uniform float uShell; uniform float uXray;
  uniform float uTime; uniform float uScanY; uniform float uFocus;
  varying vec3 vWorld; varying vec3 vNormal; varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(vView);
    float ndv = abs(dot(n, v));
    float fres = pow(1.0 - ndv, 2.4);
    vec3 L1 = normalize(vec3(0.45, 0.85, 0.7));
    vec3 L2 = normalize(vec3(-0.6, 0.2, 0.4));
    float k1 = clamp((dot(n, L1) + 0.35) / 1.35, 0.0, 1.0);
    float k2 = clamp(dot(n, L2), 0.0, 1.0);
    float hemi = 0.5 + 0.5 * n.y;
    vec3 h = normalize(L1 + v);
    float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.22;
    vec3 lit = uColor * (0.36 + 0.7 * k1 + 0.18 * k2) * mix(vec3(0.78, 0.82, 0.9), vec3(1.0), hemi) + spec;

    // score: the organ takes the signal colour, with a rim that breathes slowly (no bloom, no halo)
    float beat = 0.8 + 0.2 * sin(uTime * 3.2);
    float g = uScore * (0.65 + 0.35 * uFocus) * beat;
    vec3 col = mix(lit, uGlow * (0.75 + 0.5 * k1), clamp(uScore * 0.85, 0.0, 0.85)) + uGlow * fres * g * 0.9;

    float alpha = uOpacity;
    if (uShell > 0.0) {
      vec3 rimCol = vec3(0.22, 0.36, 0.56);
      vec3 fillCol = mix(uColor, vec3(0.56, 0.67, 0.80), 0.75);
      alpha = mix(uOpacity, clamp(fres * 0.9 + 0.08, 0.0, 1.0) * uOpacity, uShell);
      col = mix(col, mix(fillCol, rimCol, fres), uShell * 0.9);
    }
    if (uXray > 0.0) {
      vec3 xr = vec3(0.16, 0.36, 0.72) * (fres * 1.3 + 0.08);
      col = mix(col, xr, uXray);
      alpha = mix(alpha, clamp(fres * 0.6 + 0.03, 0.0, 1.0), uXray);
    }
    // intro scan: below the plane the skin is solid and the organs are hidden
    float revealed = step(uScanY, vWorld.y);
    float edge = 1.0 - smoothstep(0.0, 0.01, abs(vWorld.y - uScanY));
    if (uShell > 0.5) {
      alpha = mix(1.0, alpha, revealed);
      col = mix(lit, col, revealed);
    } else if (revealed < 0.5) {
      discard;
    }
    col = mix(col, vec3(0.94, 0.35, 0.16), edge * 0.9);
    col *= 1.0 - 0.45 * uDim;
    alpha *= 1.0 - 0.5 * uDim;
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

export function makeVideoOrganMaterial(color: string, opts: { shell?: number; xray?: number; opacity?: number } = {}) {
  const u: VideoOrganUniforms = {
    uColor: { value: new THREE.Color(color) }, uGlow: { value: new THREE.Color("#F05A28") }, uScore: { value: 0 },
    uDim: { value: 0 }, uOpacity: { value: opts.opacity ?? 1 }, uShell: { value: opts.shell ?? 0 }, uXray: { value: opts.xray ?? 0 },
    uTime: { value: 0 }, uScanY: { value: 2.2 }, uFocus: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    vertexShader: vertex, fragmentShader: fragment,
    transparent: true, side: opts.shell ? THREE.FrontSide : THREE.DoubleSide, depthWrite: !opts.shell,
  });
  return { material, u };
}

/** Desaturated anatomical base colours (the app's ORGAN_COLORS). */
export const ORGAN_COLORS: Record<string, string> = {
  skin: "#c9a48c", muscles: "#8f463f", skeleton: "#ddd5c4", brain: "#cdb0a8", oesophagus: "#c4877a", stomach: "#d0907f",
  duodenum: "#c99a7a", small_intestine: "#d4a490", large_intestine: "#b98c78", liver: "#8c4b3f", gallbladder: "#6a8f5d",
  pancreas: "#d9b38c", spleen: "#7d3d48", lymph_nodes: "#c7cc8e", kidney_l: "#8e4a42", kidney_r: "#8e4a42", heart: "#a8443e",
  vessels: "#a33a3a", lung_l: "#c99aa0", lung_r: "#c99aa0",
};
