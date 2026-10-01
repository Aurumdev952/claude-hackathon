import { Suspense, lazy, useMemo, useState } from "react";
import { Bone, Crosshair, Eye, HeartPulse, Layers, ScanLine, Table2, Wind } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fmt, signed } from "@/lib/format";
import { detectWebGL, labelOf } from "@/components/three/body/util";
import type { BodyState, CaseData } from "./types";
import { useCaseUI } from "./store";
import { bodyStateAt } from "./bodyState";
import { PHYSIOLOGY_NOTES } from "./measureOrgans";
import { ReplayBar } from "./ReplayBar";

const BodyScene = lazy(() => import("@/components/three/body/BodyScene").then((m) => ({ default: m.BodyScene })));

function useReducedMotion() {
  return useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
}

/** Centre column: the 3D body with layer controls, a live vitals HUD, legend, replay bar and a table fallback. */
export function BodyStage({ data }: { data: CaseData }) {
  const replayT = useCaseUI((s) => s.replayT);
  const state = useMemo(() => bodyStateAt(data, replayT), [data, replayT]);
  const anchors = useQuery({ queryKey: ["body-anchors"], queryFn: () => fetch("/models/body_anchors.json").then((r) => r.json()), staleTime: Infinity });
  const webgl = useMemo(detectWebGL, []);
  const [table, setTable] = useState(!webgl);
  const reduced = useReducedMotion();
  return (
    <div className="flex flex-col gap-2 min-h-0 h-full">
      <div className="relative flex-1 min-h-[420px] rounded-xl overflow-hidden case-stage border border-line/60">
        {table ? <OrganTable data={data} state={state} /> : anchors.data ? (
          <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-xs text-fog">Loading 3D view…</div>}>
            <div className="absolute inset-0"><BodyScene state={state} anchors={anchors.data.anchors} reducedMotion={reduced} /></div>
          </Suspense>
        ) : null}
        <Toolbar table={table} setTable={setTable} webgl={webgl} />
        {!table && <VitalsHud state={state} data={data} reduced={reduced} />}
        {!table && <Legend data={data} state={state} />}
        <FocusBanner />
        <a href="/models/CREDITS.md" target="_blank" rel="noreferrer" className="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9.5px] text-[#8696a2] hover:text-[#e6ecee] z-10">
          Anatomy: Z-Anatomy (CC BY-SA 4.0) · BodyParts3D, DBCLS (CC BY-SA 2.1 JP)
        </a>
      </div>
      <ReplayBar data={data} />
    </div>
  );
}

function Toolbar({ table, setTable, webgl }: { table: boolean; setTable: (v: boolean) => void; webgl: boolean }) {
  const { layers, toggleLayer, xray, set, selectedOrgan } = useCaseUI();
  return (
    <div className="absolute top-3 left-3 right-3 flex items-start gap-2 z-10 pointer-events-none">
      <div className="hud p-1 flex gap-0.5 pointer-events-auto" role="group" aria-label="Body layers">
        <span className="px-1.5 py-1 text-[#8696a2]"><Layers size={13} aria-hidden /></span>
        {(["skin", "muscles", "skeleton", "organs"] as const).map((k) => (
          <button key={k} className="hud-btn capitalize" aria-pressed={layers[k]} onClick={() => toggleLayer(k)} disabled={table}>
            {k === "skeleton" ? <Bone size={12} /> : null}{k}
          </button>
        ))}
        <span className="w-px bg-white/10 mx-1" />
        <button className="hud-btn" aria-pressed={xray} onClick={() => set({ xray: !xray })} disabled={table}><ScanLine size={12} /> X-ray</button>
      </div>
      <div className="flex-1" />
      <div className="hud p-1 flex gap-0.5 pointer-events-auto">
        {selectedOrgan && <button className="hud-btn" onClick={() => set({ selectedOrgan: null })}><Crosshair size={12} /> Reset view</button>}
        <button className="hud-btn" aria-pressed={table} onClick={() => setTable(!table)} disabled={!webgl} title={webgl ? "" : "WebGL is not available in this browser"}>
          {table ? <><Eye size={12} /> 3D view</> : <><Table2 size={12} /> View as table</>}
        </button>
      </div>
    </div>
  );
}

function FocusBanner() {
  const label = useCaseUI((s) => s.focusLabel);
  const hovered = useCaseUI((s) => s.hoveredOrgan);
  const text = label ?? (hovered ? labelOf(hovered) : null);
  if (!text) return null;
  return <div className="absolute top-14 left-3 hud px-3 py-1.5 text-[12px] z-10 animate-rise pointer-events-none" role="status">{text}</div>;
}

function VitalsHud({ state, data, reduced }: { state: BodyState; data: CaseData; reduced: boolean }) {
  const male = data.header.sex === "M";
  const anaemic = state.hb !== null && state.hb < (male ? 13 : 12);
  const beat = state.pulse ? `${(60 / Math.min(160, Math.max(40, state.pulse))).toFixed(2)}s` : "0.85s";
  const rows = [
    { icon: <HeartPulse size={13} className={reduced ? "" : "beat"} style={{ ["--beat" as string]: beat }} />, k: "Pulse", v: state.pulse, unit: "bpm", nd: 0, abn: state.pulse !== null && (state.pulse > 100 || state.pulse < 50) },
    { icon: <Wind size={13} />, k: "Resp. rate", v: state.rr, unit: "/min", nd: 0, abn: state.rr !== null && state.rr > 22 },
    { icon: <span className="w-[13px] text-center">⊙</span>, k: "Systolic BP", v: state.sbp, unit: "mmHg", nd: 0, abn: state.sbp !== null && (state.sbp >= 140 || state.sbp < 90) },
    { icon: <span className="w-[13px] text-center">°</span>, k: "Temp", v: state.temp, unit: "°C", nd: 1, abn: state.temp !== null && state.temp >= 37.5 },
  ];
  return (
    <div className="absolute left-3 bottom-8 hud p-2.5 w-[196px] z-10" aria-label="Vitals driving the 3D body">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#8696a2] mb-1.5">Physiology {useCaseUI.getState().replayT !== null ? "at playhead" : "· latest"}</div>
      {rows.map((r) => (
        <div key={r.k} className="flex items-center gap-2 py-0.5">
          <span className={r.abn ? "text-[#f2a541]" : "text-[#b4c0c8]"}>{r.icon}</span>
          <span className="flex-1 text-[#b4c0c8]">{r.k}</span>
          <span className={`tabular font-semibold ${r.abn ? "text-[#f2a541]" : ""}`}>{r.v === null ? "—" : fmt(r.v, r.nd)}</span>
          <span className="text-[#8696a2] w-[34px]">{r.unit}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-[13px] h-[13px] rounded-full border border-white/30" style={{ background: anaemic ? "#e9a3a0" : "#b3261e" }} aria-hidden />
        <span className="flex-1 text-[#b4c0c8]">Haemoglobin</span>
        <span className={`tabular font-semibold ${anaemic ? "text-[#f2a541]" : ""}`}>{state.hb === null ? "—" : fmt(state.hb, 1)}</span>
        <span className="text-[#8696a2] w-[34px]">g/dL</span>
      </div>
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-[13px] text-center text-[#b4c0c8]">⇔</span>
        <span className="flex-1 text-[#b4c0c8] whitespace-nowrap">Weight change</span>
        <span className={`tabular font-semibold ${(state.weightChangePct ?? 0) <= -5 ? "text-[#f2a541]" : ""}`}>{signed(state.weightChangePct, 1, "%")}</span>
        <span className="w-[34px]" />
      </div>
    </div>
  );
}

function Legend({ data, state }: { data: CaseData; state: BodyState }) {
  const [open, setOpen] = useState(false);
  const t = data.tumour;
  return (
    <div className="absolute right-3 bottom-8 hud p-2.5 w-[210px] z-10">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#8696a2] mb-1.5">Organ involvement</div>
      <div className="h-2 rounded-full" style={{ background: "linear-gradient(90deg,#3a2d2b,#f2a541 45%,#ff4b2b)" }} aria-hidden />
      <div className="flex justify-between text-[10px] text-[#8696a2] mt-0.5 tabular"><span>0</span><span>50</span><span>100</span></div>
      <p className="text-[10px] text-[#b4c0c8] mt-1 leading-snug">Glow = condition weight × recency × repeats. Labels show the score.</p>
      <div className="mt-2 flex flex-col gap-1 text-[10.5px] text-[#b4c0c8]">
        {t ? (
          <>
            <Key swatch="radial-gradient(circle,#ff7a3d,#5a140c)" label={`Primary tumour · ${t.lesion_location ?? "site unknown"} · ${t.t_stage ?? "T?"}`} />
            <Key swatch="#ffb347" round label={`Lit node stations · ${t.n_stage ?? "N?"}`} />
            {t.spread.metastasis_sites.length > 0 && <Key swatch="repeating-linear-gradient(90deg,#ff7a3d 0 4px,transparent 4px 7px)" label={`Spread · ${t.spread.metastasis_sites.join(", ")}`} />}
          </>
        ) : state.lesion?.suspected ? (
          <Key swatch="repeating-radial-gradient(circle,#f2a541 0 1px,transparent 1px 3px)" round label={`Suspected region · ${state.lesion.region}`} />
        ) : null}
      </div>
      <button className="text-[10px] text-kivu mt-2 hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>What the animations mean</button>
      {open && <ul className="mt-1 text-[10px] text-[#b4c0c8] list-disc pl-3.5 leading-snug">{PHYSIOLOGY_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

function Key({ swatch, label, round }: { swatch: string; label: string; round?: boolean }) {
  return <div className="flex items-center gap-2"><span className={`w-3 h-3 shrink-0 ${round ? "rounded-full" : "rounded-sm"}`} style={{ background: swatch }} aria-hidden /><span>{label}</span></div>;
}

/** Accessible fallback (SPEC §16.5): the same organ scores as a table. */
function OrganTable({ data, state }: { data: CaseData; state: BodyState }) {
  const rows = Object.entries(state.organScores).sort((a, b) => b[1] - a[1]);
  const conds = (id: string) => data.conditions.filter((c) => c.organ_ids.includes(id)).map((c) => c.label);
  return (
    <div className="absolute inset-0 overflow-auto p-4 pt-16 text-[#e6ecee]">
      <table className="w-full text-xs tabular">
        <caption className="text-left text-[11px] text-[#8696a2] mb-2">Organ involvement {useCaseUI.getState().replayT !== null ? "at the replay date" : "now"} (0-100)</caption>
        <thead><tr className="text-[#8696a2]"><th className="text-left py-1">Organ</th><th className="text-right py-1 w-16">Score</th><th className="text-left py-1 pl-4">Linked conditions</th></tr></thead>
        <tbody>
          {rows.map(([id, s]) => (
            <tr key={id} className="border-t border-white/10">
              <td className="py-1.5">{labelOf(id)}</td><td className="text-right font-semibold">{Math.round(100 * s)}</td>
              <td className="pl-4 text-[#b4c0c8]">{conds(id).join(", ") || "—"}</td>
            </tr>
          ))}
          {data.tumour && state.lesion && !state.lesion.suspected && (
            <tr className="border-t border-white/10"><td className="py-1.5">Tumour</td><td className="text-right">—</td>
              <td className="pl-4 text-[#b4c0c8]">{[data.tumour.lesion_location, data.tumour.t_stage, data.tumour.n_stage, data.tumour.m_stage, data.tumour.stage_group && `stage ${data.tumour.stage_group}`].filter(Boolean).join(" · ")}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
