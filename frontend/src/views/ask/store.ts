import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ChartSpec =
  | { type: "kpi"; value: string; title?: string }
  | { type: "line"; x: string; y: string | null; title?: string }
  | { type: "bar"; x: string; y: string; title?: string }
  | { type: "choropleth"; geo: string; value: string; title?: string }
  | { type: "table"; title?: string };

export type AskResult = {
  answer: string; sql: string | null; columns: string[]; rows: unknown[][]; chart: ChartSpec | null; caveats: string[];
  validated_numbers: boolean; source?: string; refused?: boolean; suggestions?: string[]; error?: string; latency_ms?: number;
};
export type Turn = {
  id: string; question: string; askedAt: number; role: string; status: "pending" | "done" | "failed";
  result?: AskResult; runId?: number | null; simTime?: string | null; error?: string; provider?: string;
};

type S = { turns: Turn[]; add: (t: Turn) => void; patch: (id: string, p: Partial<Turn>) => void; clear: () => void };

/** Conversation history lives for the browser session (sessionStorage), so a reload keeps it but a new tab starts clean. */
export const useAsk = create<S>()(persist((set) => ({
  turns: [],
  add: (t) => set((s) => ({ turns: [...s.turns, t].slice(-40) })),
  patch: (id, p) => set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...p } : t)) })),
  clear: () => set({ turns: [] }),
}), {
  name: "es-ask", storage: createJSONStorage(() => sessionStorage),
  // a reload mid-request leaves nothing to resolve the pending turn: mark it failed
  onRehydrateStorage: () => (st) => { st?.turns.forEach((t) => { if (t.status === "pending") { t.status = "failed"; t.error = "Interrupted by a page reload"; } }); },
}));
