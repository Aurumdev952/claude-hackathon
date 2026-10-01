import { type ReactNode, Suspense, lazy, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Tooltip } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { Bone, ChevronLeft, Droplet, Hand, HeartPulse, Gauge, ScanLine, Shapes, Table2, Thermometer, Weight, Wind, BicepsFlexed } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AnimatedNumber, DetailModal, InfoHint, useDetailModal } from "@/components/ui";
import { date, signed } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { detectWebGL, labelOf } from "@/components/three/body/util";
import { PatientAvatar } from "@/views/doctor/PatientAvatar";
import type { BodyState, CaseData } from "./types";
import { useCaseUI, type Layers } from "./store";
import { bodyStateAt } from "./bodyState";
import { PHYSIOLOGY_NOTES } from "./measureOrgans";
import { ReplayBar } from "./ReplayBar";
import { SystemRail } from "./SystemRail";
import { StageControls } from "./StageControls";

const BodyScene = lazy(() => import("@/components/three/body/BodyScene").then((m) => ({ default: m.BodyScene })));

function useReducedMotion() {
  return useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
}

/** White "ClyHealth" stage in light mode, the dark imaging lightbox in dark mode. */
const LIGHT_STAGE = "radial-gradient(62% 52% at 50% 42%, #FFFFFF 0%, #F1F5FB 52%, #E4EBF6 100%)";

/** Left half of the case screen: the 3D body with a system rail, layer bar, vitals tiles, zoom controls, replay and a
 * slot for the floating insights card. The organ table (accessible fallback) opens in a modal. */
export function BodyStage({ data, bottomLeft }: { data: CaseData; bottomLeft?: ReactNode }) {
  const replayT = useCaseUI((s) => s.replayT);
  const state = useMemo(() => bodyStateAt(data, replayT), [data, replayT]);
  const anchors = useQuery({ queryKey: ["body-anchors"], queryFn: () => fetch("/models/body_anchors.json").then((r) => r.json()), staleTime: Infinity });
  const webgl = useMemo(detectWebGL, []);
  const reduced = useReducedMotion();
  const { theme } = useTheme();
  const light = theme === "light";
  const stage = useRef<HTMLDivElement>(null);
  const table = useDetailModal();
  return (
    <div ref={stage} className={`relative h-full min-h-[640px] rounded-card overflow-hidden border border-border shadow-card ${light ? "" : "case-stage"}`}
         style={light ? { background: LIGHT_STAGE } : undefined}>
      {light && <div className="absolute inset-0 pointer-events-none" aria-hidden
                     style={{ background: "radial-gradient(40% 30% at 50% 100%, rgb(var(--accent) / 0.10), transparent 70%), radial-gradient(30% 25% at 90% 8%, rgb(139 124 246 / 0.10), transparent 70%)" }} />}
      {!webgl ? <div className="absolute inset-0 overflow-auto p-5 pt-20"><OrganTable data={data} state={state} /></div> : anchors.data ? (
        <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-label text-fg-muted">Loading 3D view…</div>}>
          <div className="absolute inset-0"><BodyScene state={state} anchors={anchors.data.anchors} reducedMotion={reduced} light={light} /></div>
        </Suspense>
      ) : null}

      <div className="absolute inset-0 pointer-events-none p-3 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <PatientChip data={data} />
          <div className="flex-1" />
          <LayerBar onTable={table.open} data={data} state={state} />
        </div>
        <div className="flex-1 min-h-0 flex items-start justify-between gap-3">
          <SystemRail data={data} className="pointer-events-auto" />
          {webgl && <VitalsTiles state={state} data={data} reduced={reduced} />}
        </div>
        <div className="flex items-end gap-3">
          <div className="pointer-events-auto">{bottomLeft}</div>
          <div className="flex-1" />
          {webgl && <StageControls stage={stage} />}
        </div>
        <ReplayBar data={data} />
      </div>
      <FocusBanner />
      <a href="/models/CREDITS.md" target="_blank" rel="noreferrer" className="absolute bottom-[3px] right-4 whitespace-nowrap text-[9px] text-fg-muted/70 hover:text-fg z-10">
        Anatomy: Z-Anatomy (CC BY-SA 4.0) · BodyParts3D, DBCLS (CC BY-SA 2.1 JP)
      </a>
      <DetailModal {...table.modalProps} title="Organ involvement" icon={<Table2 size={18} />} size="3xl"
                   info="Glow = condition weight × recency × repeats, capped at 100. Same scores the 3D body shows.">
        <OrganTable data={data} state={state} />
      </DetailModal>
    </div>
  );
}

function PatientChip({ data }: { data: CaseData }) {
  const h = data.header;
  return (
    <div className="glass rounded-full shadow-tile pl-1 pr-2 py-1 flex items-center gap-2 pointer-events-auto min-w-0">
      <Tooltip content="Doctor workspace" placement="bottom" delay={250} closeDelay={0} classNames={{ content: "bg-fg text-bg text-xs font-medium px-2.5 py-1 rounded-lg" }}>
        <Link to="/doctor" aria-label="Doctor workspace" className="w-8 h-8 shrink-0 rounded-full grid place-items-center text-fg-muted hover:text-fg hover:bg-fg/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
          <ChevronLeft size={17} aria-hidden />
        </Link>
      </Tooltip>
      <PatientAvatar name={h.name} id={h.patient_id} size="sm" />
      <div className="min-w-0 leading-tight">
        <h1 className="text-[13.5px] font-semibold text-fg truncate">{h.name}</h1>
        <div className="text-micro text-fg-muted tabular truncate">{h.sex === "M" ? "Male" : "Female"} · {h.age} y · {h.display_id}</div>
      </div>
      <InfoHint title={h.name} label="About this patient" size={14}
                about={<>{h.district_name ?? h.district_code}{h.province ? `, ${h.province}` : ""}. Home facility {String(h.home_facility_name ?? "—").replace(" (Synthetic)", "")}.</>}
                notes={[h.is_case ? `Gastric cancer, ${String(h.case_status).toLowerCase()} · diagnosed ${date(h.dx_date as string)}` : null, h.death_date ? `Died ${date(h.death_date)}` : null].filter(Boolean).join(" · ") || undefined} />
    </div>
  );
}

const LAYER_ICON: Record<keyof Layers, ReactNode> = {
  skin: <Hand size={15} aria-hidden />, muscles: <BicepsFlexed size={15} aria-hidden />, skeleton: <Bone size={15} aria-hidden />, organs: <Shapes size={15} aria-hidden />,
};

function IconToggle({ label, pressed, onPress, children }: { label: string; pressed?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label} placement="bottom" delay={250} closeDelay={0} classNames={{ content: "bg-fg text-bg text-xs font-medium px-2.5 py-1 rounded-lg" }}>
      <button type="button" onClick={onPress} aria-label={label} aria-pressed={pressed}
              className={`relative w-8 h-8 rounded-full grid place-items-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
                          ${pressed ? "text-white" : "text-fg-muted hover:text-fg hover:bg-fg/5"}`}>
        {pressed && <motion.span layoutId={`layer-${label}`} className="absolute inset-0 rounded-full bg-accent" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} aria-hidden />}
        <span className="relative">{children}</span>
      </button>
    </Tooltip>
  );
}

function LayerBar({ onTable, data, state }: { onTable: () => void; data: CaseData; state: BodyState }) {
  const { layers, toggleLayer, xray, set } = useCaseUI();
  return (
    <div className="glass rounded-full shadow-tile p-1 flex items-center gap-0.5 pointer-events-auto" role="group" aria-label="Body layers">
      {(["skin", "muscles", "skeleton", "organs"] as const).map((k) => (
        <IconToggle key={k} label={k.charAt(0).toUpperCase() + k.slice(1)} pressed={layers[k]} onPress={() => toggleLayer(k)}>{LAYER_ICON[k]}</IconToggle>
      ))}
      <span className="w-px h-5 bg-border mx-0.5" aria-hidden />
      <IconToggle label="X-ray" pressed={xray} onPress={() => set({ xray: !xray })}><ScanLine size={15} aria-hidden /></IconToggle>
      <IconToggle label="View as table" onPress={onTable}><Table2 size={15} aria-hidden /></IconToggle>
      <InfoHint content={<Legend data={data} state={state} />} title="Legend" label="Legend" size={15} className="!w-8 !h-8 !min-w-8" />
    </div>
  );
}

function FocusBanner() {
  const label = useCaseUI((s) => s.focusLabel);
  const hovered = useCaseUI((s) => s.hoveredOrgan);
  const text = label ?? (hovered ? labelOf(hovered) : null);
  return (
    <div className="absolute top-[64px] left-1/2 -translate-x-1/2 z-10 pointer-events-none" role="status">
      <AnimatePresence>
        {text && (
          <motion.div key={text} initial={{ opacity: 0, y: -6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4 }}
                      className="glass rounded-full shadow-float px-3.5 py-1.5 text-[12.5px] font-semibold text-fg whitespace-nowrap inline-flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-warning animate-pulse" aria-hidden />{text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Vitals driving the 3D body as glass micro tiles on the stage edge (values count during the replay). */
function VitalsTiles({ state, data, reduced }: { state: BodyState; data: CaseData; reduced: boolean }) {
  const male = data.header.sex === "M";
  const beat = state.pulse ? `${(60 / Math.min(160, Math.max(40, state.pulse))).toFixed(2)}s` : "0.85s";
  const atHead = useCaseUI((s) => s.replayT !== null);
  const rows = [
    { k: "Pulse", icon: <HeartPulse size={13} className={reduced ? "" : "beat"} style={{ ["--beat" as string]: beat }} aria-hidden />, v: state.pulse, unit: "bpm", nd: 0, abn: state.pulse !== null && (state.pulse > 100 || state.pulse < 50) },
    { k: "Resp. rate", icon: <Wind size={13} aria-hidden />, v: state.rr, unit: "/min", nd: 0, abn: state.rr !== null && state.rr > 22 },
    { k: "Systolic BP", icon: <Gauge size={13} aria-hidden />, v: state.sbp, unit: "mmHg", nd: 0, abn: state.sbp !== null && (state.sbp >= 140 || state.sbp < 90) },
    { k: "Temp", icon: <Thermometer size={13} aria-hidden />, v: state.temp, unit: "°C", nd: 1, abn: state.temp !== null && state.temp >= 37.5 },
    { k: "Haemoglobin", icon: <Droplet size={13} aria-hidden />, v: state.hb, unit: "g/dL", nd: 1, abn: state.hb !== null && state.hb < (male ? 13 : 12) },
  ];
  return (
    <section className="flex flex-col gap-1.5 pointer-events-auto" aria-label="Vitals driving the 3D body">
      <div className="text-micro font-medium text-fg-muted text-right pr-1">{atHead ? "At playhead" : "Latest"}</div>
      {rows.map((r) => (
        <div key={r.k} className={`glass rounded-tile shadow-tile px-2.5 py-1.5 w-[112px] ${r.abn ? "!border-warning/70" : ""}`} title={r.k}>
          <div className={`flex items-center gap-1.5 text-micro ${r.abn ? "text-tone-warning" : "text-fg-muted"}`}>{r.icon}<span className="truncate">{r.k}</span></div>
          <div className="flex items-baseline gap-1">
            <AnimatedNumber value={r.v} decimals={r.nd} duration={0.4} className={`text-[16px] leading-5 font-semibold ${r.abn ? "text-tone-warning" : "text-fg"}`} />
            <span className="text-[10px] text-fg-muted">{r.unit}</span>
          </div>
        </div>
      ))}
      <div className={`glass rounded-tile shadow-tile px-2.5 py-1.5 w-[112px] ${(state.weightChangePct ?? 0) <= -5 ? "!border-warning/70" : ""}`} title="Weight change over the window">
        <div className="flex items-center gap-1.5 text-micro text-fg-muted"><Weight size={13} aria-hidden /><span>Weight</span></div>
        <div className={`text-[16px] leading-5 font-semibold tabular ${(state.weightChangePct ?? 0) <= -5 ? "text-tone-warning" : "text-fg"}`}>{signed(state.weightChangePct, 1, "%")}</div>
      </div>
    </section>
  );
}

function Legend({ data, state }: { data: CaseData; state: BodyState }) {
  const t = data.tumour;
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <div className="text-micro font-semibold uppercase tracking-wide text-fg-muted mb-1">Organ involvement</div>
        <div className="h-2 rounded-full" style={{ background: "linear-gradient(90deg, rgb(var(--fg) / 0.08), #f2a541 45%, #ff4b2b)" }} aria-hidden />
        <div className="flex justify-between text-micro text-fg-muted mt-0.5 tabular"><span>0</span><span>50</span><span>100</span></div>
        <p className="text-fg-muted text-[12px] mt-1">Glow = condition weight × recency × repeats. Labels show the score.</p>
      </div>
      {(t || state.lesion?.suspected) && (
        <div className="flex flex-col gap-1 text-[12px]">
          {t ? (
            <>
              <Key swatch="radial-gradient(circle,#ff7a3d,#5a140c)" label={`Primary tumour · ${t.lesion_location ?? "site unknown"} · ${t.t_stage ?? "T?"}`} />
              <Key swatch="#ffb347" round label={`Lit node stations · ${t.n_stage ?? "N?"}`} />
              {t.spread.metastasis_sites.length > 0 && <Key swatch="repeating-linear-gradient(90deg,#ff7a3d 0 4px,transparent 4px 7px)" label={`Spread · ${t.spread.metastasis_sites.join(", ")}`} />}
            </>
          ) : <Key swatch="repeating-radial-gradient(circle,#f2a541 0 1px,transparent 1px 3px)" round label={`Suspected region · ${state.lesion!.region}`} />}
        </div>
      )}
      <div>
        <div className="text-micro font-semibold uppercase tracking-wide text-fg-muted mb-1">What the animations mean</div>
        <ul className="list-disc pl-4 text-[12px] text-fg/90 leading-snug">{PHYSIOLOGY_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
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
  const replay = useCaseUI((s) => s.replayT !== null);
  return (
    <div className="rounded-tile border border-border overflow-hidden bg-surface">
      <table className="w-full text-[12.5px] tabular">
        <caption className="text-left text-label text-fg-muted px-3 py-2 bg-surface-2 border-b border-border">Organ involvement {replay ? "at the replay date" : "now"} (0-100)</caption>
        <thead><tr className="text-fg-muted text-micro uppercase tracking-wide"><th className="text-left py-2 px-3">Organ</th><th className="text-right py-2 w-16">Score</th><th className="text-left py-2 pl-4 pr-3">Linked conditions</th></tr></thead>
        <tbody>
          {rows.map(([id, s]) => (
            <tr key={id} className="border-t border-border">
              <td className="py-2 px-3 text-fg font-medium">{labelOf(id)}</td><td className="text-right font-semibold text-fg">{Math.round(100 * s)}</td>
              <td className="pl-4 pr-3 text-fg-muted">{conds(id).join(", ") || "—"}</td>
            </tr>
          ))}
          {data.tumour && state.lesion && !state.lesion.suspected && (
            <tr className="border-t border-border"><td className="py-2 px-3 text-fg font-medium">Tumour</td><td className="text-right">—</td>
              <td className="pl-4 pr-3 text-fg-muted">{[data.tumour.lesion_location, data.tumour.t_stage, data.tumour.n_stage, data.tumour.m_stage, data.tumour.stage_group && `stage ${data.tumour.stage_group}`].filter(Boolean).join(" · ")}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
