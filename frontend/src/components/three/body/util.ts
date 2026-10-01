/** Lightweight helpers shared by the 3D scene and the panels (no three.js import, so panels don't pull the 3D chunk). */
export const labelOf = (id: string) => ({
  lung_l: "Left lung", lung_r: "Right lung", kidney_l: "Left kidney", kidney_r: "Right kidney", lymph_nodes: "Lymph nodes",
  small_intestine: "Small intestine", large_intestine: "Large intestine",
} as Record<string, string>)[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, " ");

export function detectWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}
