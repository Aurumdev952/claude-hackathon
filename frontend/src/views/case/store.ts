import { create } from "zustand";

export type Layers = { skin: boolean; muscles: boolean; skeleton: boolean; organs: boolean };

/** Shared UI state of the Case Analysis view: two-way hover between panels and the 3D body, layers and replay. */
type CaseUI = {
  hoveredOrgan: string | null;
  selectedOrgan: string | null;
  /** organs of the condition / measure row under the pointer (panel -> body highlight) */
  focusOrgans: string[] | null;
  focusLabel: string | null;
  layers: Layers;
  xray: boolean;
  replayT: number | null;      // epoch ms of the replay playhead; null = "now" (current state)
  playing: boolean;
  speed: number;               // simulated months per real second
  introDone: boolean;
  set: (p: Partial<Omit<CaseUI, "set" | "toggleLayer" | "reset">>) => void;
  toggleLayer: (k: keyof Layers) => void;
  reset: () => void;
};

const initial = {
  hoveredOrgan: null, selectedOrgan: null, focusOrgans: null, focusLabel: null,
  layers: { skin: true, muscles: false, skeleton: true, organs: true }, xray: false,
  replayT: null, playing: false, speed: 1.5, introDone: false,
};

export const useCaseUI = create<CaseUI>((set) => ({
  ...initial,
  set: (p) => set(p),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  reset: () => set(initial),
}));

/** Organs to emphasise right now: panel hover wins over 3D hover, which wins over the clicked organ. */
export function useEmphasis(): string[] | null {
  return useCaseUI((s) => s.focusOrgans ?? (s.hoveredOrgan ? [s.hoveredOrgan] : s.selectedOrgan ? [s.selectedOrgan] : null));
}
