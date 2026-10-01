import { create } from "zustand";

type Live = { runId: number | null; simTime: string | null; lastRefresh: number | null; connected: boolean;
  toasts: { id: string; text: string; tone: "info" | "alert" }[];
  update: (p: Partial<Omit<Live, "update" | "toast" | "dismiss">>) => void; toast: (text: string, tone?: "info" | "alert") => void; dismiss: (id: string) => void };

export const useLive = create<Live>((set) => ({
  runId: null, simTime: null, lastRefresh: null, connected: false, toasts: [],
  update: (p) => set(p),
  toast: (text, tone = "info") => set((s) => ({ toasts: [...s.toasts.slice(-3), { id: Math.random().toString(36).slice(2), text, tone }] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
