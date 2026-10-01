import { create } from "zustand";

export type Layers = { skin: boolean; muscles: boolean; skeleton: boolean; organs: boolean };

/** Shared UI state of the Case Analysis view: two-way hover between panels and the 3D body, layers, camera and replay. */
type CaseUI = {
  hoveredOrgan: string | null;
  selectedOrgan: string | null;
  /** organs of the condition / measure row under the pointer (panel -> body highlight) */
  focusOrgans: string[] | null;
  focusLabel: string | null;
  /** body system picked in the SystemRail (drives the right column); null = the system of the most involved organ */
  system: string | null;
  layers: Layers;
  xray: boolean;
  /** pending zoom request from the StageControls (+ = closer); BodyScene consumes it and resets it to 0 */
  zoomDelta: number;
  replayT: number | null;      // epoch ms of the replay playhead; null = "now" (current state)
  playing: boolean;
  speed: number;               // simulated months per real second
  introDone: boolean;
  set: (p: Partial<Omit<CaseUI, "set" | "toggleLayer" | "reset" | "zoom">>) => void;
  toggleLayer: (k: keyof Layers) => void;
  zoom: (d: number) => void;
  reset: () => void;
};

const initial = {
  hoveredOrgan: null, selectedOrgan: null, focusOrgans: null, focusLabel: null, system: null,
  layers: { skin: true, muscles: false, skeleton: true, organs: true }, xray: false, zoomDelta: 0,
  replayT: null, playing: false, speed: 1.5, introDone: false,
};

export const useCaseUI = create<CaseUI>((set) => ({
  ...initial,
  set: (p) => set(p),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  zoom: (d) => set((s) => ({ zoomDelta: s.zoomDelta + d })),
  reset: () => set(initial),
}));

/** Organs to emphasise right now: panel hover wins over 3D hover, which wins over the clicked organ. */
export function useEmphasis(): string[] | null {
  return useCaseUI((s) => s.focusOrgans ?? (s.hoveredOrgan ? [s.hoveredOrgan] : s.selectedOrgan ? [s.selectedOrgan] : null));
}
