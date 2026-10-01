import { create } from "zustand";

type Sel = { district: string | null; select: (d: string | null) => void };
export const useGeoSelection = create<Sel>((set) => ({ district: null, select: (district) => set({ district }) }));
