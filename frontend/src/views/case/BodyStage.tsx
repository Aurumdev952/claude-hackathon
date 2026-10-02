import { type ReactNode, Suspense, lazy, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Tooltip } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { Bone, ChevronLeft, Droplet, Hand, HeartPulse, Gauge, ScanLine, Shapes, Table2, Thermometer, Weight, Wind, BicepsFlexed } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AnimatedNumber, DetailModal, InfoHint, PortalContainerContext, useDetailModal, usePortalContainer } from "@/components/ui";
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
import { StageControls, useFullscreen } from "./StageControls";

const BodyScene = lazy(() => import("@/components/three/body/BodyScene").then((m) => ({ default: m.BodyScene })));

function useReducedMotion() {
  return useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
}

/** Left half of the case screen, the page's hero (design v3): the 3D body on a plain light stage (the dark imaging
 * lightbox in dark mode), overlay controls as round white buttons with a hairline, a white vitals strip and a quiet replay
 * bar at the bottom; `aside` (top right, under the layer bar) and `bottomLeft` are slots for floating cards. The organ table (accessible fallback) opens in a modal. */
export function BodyStage({ data, aside, bottomLeft }: { data: CaseData; aside?: ReactNode; bottomLeft?: ReactNode }) {
  const replayT = useCaseUI((s) => s.replayT);
  const state = useMemo(() => bodyStateAt(data, replayT), [data, replayT]);
  const anchors = useQuery({ queryKey: ["body-anchors"], queryFn: () => fetch("/models/body_anchors.json").then((r) => r.json()), staleTime: Infinity });
  const webgl = useMemo(detectWebGL, []);
  const reduced = useReducedMotion();
  const { theme } = useTheme();
  const light = theme === "light";
  const stage = useRef<HTMLDivElement>(null);
  const table = useDetailModal();
  const fullscreen = useFullscreen(stage);
  return (
    <PortalContainerContext.Provider value={fullscreen[0] ? stage.current ?? undefined : undefined}>
    <div ref={stage} className={`relative h-full min-h-[640px] rounded-hero overflow-hidden ${light ? "bg-surface" : "case-stage border border-hairline"}`}>
      {!webgl ? <div className="absolute inset-0 overflow-auto p-6 pt-24"><OrganTable data={data} state={state} /></div> : anchors.data ? (
        <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-label text-muted">Loading 3D view</div>}>
          <div className="absolute inset-0"><BodyScene state={state} anchors={anchors.data.anchors} reducedMotion={reduced} light={light} /></div>
        </Suspense>
      ) : null}

      {/* overlays sit above the organ labels (drei Html, z-index 0-20) so labels never cover the controls */}
      <div className="absolute inset-0 z-[25] pointer-events-none p-4 pb-1.5 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <PatientChip data={data} />
          <div className="flex-1" />
          <div className="shrink-0"><LayerBar onTable={table.open} data={data} state={state} /></div>
        </div>
        <div className="flex-1 min-h-0 flex items-start justify-between gap-3">
          <SystemRail data={data} className="pointer-events-auto" />
          {aside && <div className="pointer-events-auto">{aside}</div>}
        </div>
        <div className="flex items-end gap-3">
          {bottomLeft && <div className="pointer-events-auto">{bottomLeft}</div>}
          <div className="flex-1" />
          {webgl && <StageControls fullscreen={fullscreen} />}
        </div>
        {webgl && <VitalsStrip state={state} data={data} reduced={reduced} />}
        <div className="flex flex-col gap-1">
          <ReplayBar data={data} />
          <a href="/models/CREDITS.md" target="_blank" rel="noreferrer" className="self-end pointer-events-auto whitespace-nowrap text-[10px] leading-3 text-muted/80 hover:text-ink pr-3 max-w-full truncate">
            Anatomy: Z-Anatomy (CC BY-SA 4.0), BodyParts3D DBCLS (CC BY-SA 2.1 JP)
          </a>
        </div>
      </div>
      <FocusBanner />
      <DetailModal {...table.modalProps} title="Organ involvement" icon={<Table2 size={18} />} size="3xl" subtitle={replayT === null ? "Now, scores 0 to 100" : "At the replay date, scores 0 to 100"}
                   info="Glow = condition weight × recency × repeats, capped at 100. Same scores the 3D body shows.">
        <OrganTable data={data} state={state} />
      </DetailModal>
    </div>
    </PortalContainerContext.Provider>
  );
}

const TIP = { content: "bg-ink text-ink-on text-[12px] font-medium px-2.5 py-1 rounded-full" };

function PatientChip({ data }: { data: CaseData }) {
  const h = data.header;
  const portal = usePortalContainer();
  return (
    <div className="overlay-surface rounded-full pl-1.5 pr-2 py-1.5 flex items-center gap-2.5 pointer-events-auto min-w-0 overflow-hidden">
      <Tooltip content="Doctor workspace" placement="bottom" portalContainer={portal} delay={250} closeDelay={0} classNames={TIP}>
        <Link to="/doctor" aria-label="Doctor workspace" className="w-9 h-9 shrink-0 rounded-full grid place-items-center text-ink hover:bg-tile focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
          <ChevronLeft size={18} aria-hidden />
        </Link>
      </Tooltip>
      <PatientAvatar name={h.name} size="sm" />
      <div className="min-w-0 flex-1 leading-tight pr-1 overflow-hidden">
        <h1 className="text-[15px] leading-5 font-semibold text-ink truncate">{h.name}</h1>
        <div className="text-micro font-normal text-muted tabular truncate [&>span]:mr-2.5">
          <span>{h.sex === "M" ? "Male" : "Female"}</span><span>{h.age} years</span><span>{h.display_id}</span>
        </div>
      </div>
      <InfoHint title={h.name} label="About this patient" size={14}
                about={<>{h.district_name ?? h.district_code}{h.province ? `, ${h.province}` : ""}. Home facility {String(h.home_facility_name ?? "—").replace(" (Synthetic)", "")}.</>}
                notes={[h.is_case ? `Gastric cancer, ${String(h.case_status).toLowerCase()}, diagnosed ${date(h.dx_date as string)}.` : null, h.death_date ? `Died ${date(h.death_date)}.` : null].filter(Boolean).join(" ") || undefined} />
    </div>
  );
}

const LAYER_ICON: Record<keyof Layers, ReactNode> = {
  skin: <Hand size={16} aria-hidden />, muscles: <BicepsFlexed size={16} aria-hidden />, skeleton: <Bone size={16} aria-hidden />, organs: <Shapes size={16} aria-hidden />,
};

/** Toggle inside the layer bar: pressed = grey fill with an ink icon (quiet), unpressed = muted icon. */
function IconToggle({ label, pressed, onPress, children }: { label: string; pressed?: boolean; onPress: () => void; children: ReactNode }) {
  const portal = usePortalContainer();
  return (
    <Tooltip content={label} placement="bottom" portalContainer={portal} delay={250} closeDelay={0} classNames={TIP}>
      <button type="button" onClick={onPress} aria-label={label} aria-pressed={pressed}
              className={`w-9 h-9 rounded-full grid place-items-center transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal
                          ${pressed ? "bg-tile-hover text-ink" : "text-muted hover:text-ink hover:bg-tile"}`}>
        {children}
      </button>
    </Tooltip>
  );
}

function LayerBar({ onTable, data, state }: { onTable: () => void; data: CaseData; state: BodyState }) {
  const { layers, toggleLayer, xray, set } = useCaseUI();
  return (
    <div className="overlay-surface rounded-full p-1.5 flex items-center gap-0.5 pointer-events-auto" role="group" aria-label="Body layers">
      {(["skin", "muscles", "skeleton", "organs"] as const).map((k) => (
        <IconToggle key={k} label={k.charAt(0).toUpperCase() + k.slice(1)} pressed={layers[k]} onPress={() => toggleLayer(k)}>{LAYER_ICON[k]}</IconToggle>
      ))}
      <span className="w-px h-5 bg-hairline mx-1" aria-hidden />
      <IconToggle label="X-ray" pressed={xray} onPress={() => set({ xray: !xray })}><ScanLine size={16} aria-hidden /></IconToggle>
      <IconToggle label="View as table" onPress={onTable}><Table2 size={16} aria-hidden /></IconToggle>
      <InfoHint content={<Legend data={data} state={state} />} title="Legend" label="Legend" size={16} className="!w-9 !h-9 !min-w-9" />
    </div>
  );
}

function FocusBanner() {
  const label = useCaseUI((s) => s.focusLabel);
  const hovered = useCaseUI((s) => s.hoveredOrgan);
  const text = label ?? (hovered ? labelOf(hovered) : null);
  return (
    <div className="absolute top-[76px] left-1/2 -translate-x-1/2 z-30 pointer-events-none" role="status">
      <AnimatePresence>
        {text && (
          <motion.div key={text} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}
                      className="overlay-surface rounded-full px-4 h-9 text-[13px] font-semibold text-ink whitespace-nowrap inline-flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-signal" aria-hidden />{text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Vitals driving the 3D body as one white stats strip (reference "63.71 km / 298 min / 9277 kCal"); values count during
 * the replay. An out-of-range value gets a small signal dot and says so in its title. */
function VitalsStrip({ state, data, reduced }: { state: BodyState; data: CaseData; reduced: boolean }) {
  const male = data.header.sex === "M";
  const beat = state.pulse ? `${(60 / Math.min(160, Math.max(40, state.pulse))).toFixed(2)}s` : "0.85s";
  const atHead = useCaseUI((s) => s.replayT !== null);
  const wc = state.weightChangePct;
  const rows: { k: string; icon: ReactNode; v: ReactNode; unit: string; abn: boolean }[] = [
    { k: "Pulse", icon: <HeartPulse size={15} className={reduced ? "" : "beat"} style={{ ["--beat" as string]: beat }} aria-hidden />, v: <AnimatedNumber value={state.pulse} decimals={0} duration={0.4} />, unit: "bpm", abn: state.pulse !== null && (state.pulse > 100 || state.pulse < 50) },
    { k: "Breathing", icon: <Wind size={15} aria-hidden />, v: <AnimatedNumber value={state.rr} decimals={0} duration={0.4} />, unit: "/min", abn: state.rr !== null && state.rr > 22 },
    { k: "Systolic", icon: <Gauge size={15} aria-hidden />, v: <AnimatedNumber value={state.sbp} decimals={0} duration={0.4} />, unit: "mmHg", abn: state.sbp !== null && (state.sbp >= 140 || state.sbp < 90) },
    { k: "Temp", icon: <Thermometer size={15} aria-hidden />, v: <AnimatedNumber value={state.temp} decimals={1} duration={0.4} />, unit: "°C", abn: state.temp !== null && state.temp >= 37.5 },
    { k: "Hb", icon: <Droplet size={15} aria-hidden />, v: <AnimatedNumber value={state.hb} decimals={1} duration={0.4} />, unit: "g/dL", abn: state.hb !== null && state.hb < (male ? 13 : 12) },
    { k: "Weight", icon: <Weight size={15} aria-hidden />, v: <span className="tabular">{signed(wc, 1)}</span>, unit: "%", abn: (wc ?? 0) <= -5 },
  ];
  return (
    <section className="overlay-surface rounded-[20px] px-2 py-2 pointer-events-auto grid grid-cols-3 sm:grid-cols-6 gap-0.5"
             aria-label={atHead ? "Vitals at the replay date" : "Latest vitals"}>
      {rows.map((r) => (
        <div key={r.k} className="flex items-center gap-2 min-w-0 px-2 py-1" title={r.abn ? `${r.k}: out of range` : r.k}>
          <span className="hidden 2xl:grid w-8 h-8 shrink-0 rounded-full bg-tile text-ink place-items-center" aria-hidden>{r.icon}</span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1 whitespace-nowrap">
              <span className="text-[17px] leading-6 font-semibold text-ink tabular">{r.v}</span>
              <span className="text-micro text-muted">{r.unit}</span>
            </div>
            <div className="flex items-center gap-1.5 text-micro text-muted whitespace-nowrap">
              {r.abn && <span className="w-1.5 h-1.5 rounded-full bg-signal shrink-0" aria-hidden />}
              <span className="truncate">{r.k}</span>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function Legend({ data, state }: { data: CaseData; state: BodyState }) {
  const t = data.tumour;
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <div className="text-label text-muted mb-1.5">Organ involvement</div>
        <div className="h-2 rounded-full" style={{ background: "linear-gradient(90deg, rgb(var(--fg) / 0.08), #f2a541 45%, #ff4b2b)" }} aria-hidden />
        <div className="flex justify-between text-micro text-muted mt-1 tabular"><span>0</span><span>50</span><span>100</span></div>
        <p className="text-muted text-[13px] mt-1.5">Glow = condition weight × recency × repeats. Labels show the score.</p>
      </div>
      {(t || state.lesion?.suspected) && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          {t ? (
            <>
              <Key swatch="radial-gradient(circle,#ff7a3d,#5a140c)" label={`Primary tumour: ${t.lesion_location ?? "site unknown"}, ${t.t_stage ?? "T?"}`} />
              <Key swatch="#ffb347" round label={`Lit node stations: ${t.n_stage ?? "N?"}`} />
              {t.spread.metastasis_sites.length > 0 && <Key swatch="repeating-linear-gradient(90deg,#ff7a3d 0 4px,transparent 4px 7px)" label={`Spread: ${t.spread.metastasis_sites.join(", ")}`} />}
            </>
          ) : <Key swatch="repeating-radial-gradient(circle,#f2a541 0 1px,transparent 1px 3px)" round label={`Suspected region: ${state.lesion!.region}`} />}
        </div>
      )}
      {data.surgery && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <Key swatch="repeating-linear-gradient(90deg,#8fb8d8 0 3px,transparent 3px 6px)" label={`Stomach removed: gastrectomy ${date(data.surgery.date)}${state.resected ? "" : " (later in the replay)"}`} />
          {!!state.recoveryMonths && <span className="text-muted">Recovery: {Math.round(state.recoveryMonths)} months since surgery; earlier findings fade as the patient recovers.</span>}
        </div>
      )}
      <div>
        <div className="text-label text-muted mb-1.5">What the animations mean</div>
        <ul className="list-disc pl-4 text-[13px] text-ink/90 leading-snug flex flex-col gap-0.5">{PHYSIOLOGY_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
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
    <div className="bg-surface rounded-tile">
      <table className="w-full text-[13px] tabular">
        <caption className="sr-only">Organ involvement {replay ? "at the replay date" : "now"}, 0 to 100</caption>
        <thead><tr className="text-muted text-micro"><th className="text-left font-medium py-2 px-3 bg-tile rounded-l-full">Organ</th><th className="text-right font-medium py-2 w-16 bg-tile">Score</th><th className="text-left font-medium py-2 pl-5 pr-3 bg-tile rounded-r-full">Linked conditions</th></tr></thead>
        <tbody>
          {rows.map(([id, s]) => (
            <tr key={id} className="border-b border-hairline last:border-b-0">
              <td className="py-2.5 px-3 text-ink font-medium">{labelOf(id)}</td><td className="text-right font-semibold text-ink">{Math.round(100 * s)}</td>
              <td className="pl-5 pr-3 text-muted">{conds(id).join(", ") || "—"}</td>
            </tr>
          ))}
          {data.tumour && state.lesion && !state.lesion.suspected && (
            <tr><td className="py-2.5 px-3 text-ink font-medium">Tumour</td><td className="text-right">—</td>
              <td className="pl-5 pr-3 text-muted">{[data.tumour.lesion_location, data.tumour.t_stage, data.tumour.n_stage, data.tumour.m_stage, data.tumour.stage_group && `stage ${data.tumour.stage_group}`].filter(Boolean).join(", ")}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
