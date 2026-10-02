import { motion, useReducedMotion } from "framer-motion";
import { Microscope } from "lucide-react";
import { Card } from "@/components/ui";
import { date } from "@/lib/format";
import { SPRING_SOFT } from "@/lib/motion";
import type { CaseData, Tumour } from "./types";

const STAGES = ["I", "II", "III", "IV"];
const stageIndex = (g: string | null | undefined) => {
  if (!g) return -1;
  const m = /^(IV|III|II|I)/.exec(g.toUpperCase());
  return m ? STAGES.indexOf(m[1]) : -1;
};

/** Stage I to IV as four thin segments (design v3: one hue, no traffic-light ramp): segments up to the stage are filled
 * in ink, the rest stay grey (the stage pill on the tumour card is the one orange mark). Used in the section header of a diagnosed case. */
export function StageTrack({ stage, className = "" }: { stage: string | null | undefined; className?: string }) {
  const reduce = useReducedMotion();
  const i = stageIndex(stage);
  return (
    <div className={`w-full ${className}`} role="meter" aria-label="Stage at diagnosis" aria-valuemin={1} aria-valuemax={4} aria-valuenow={i >= 0 ? i + 1 : undefined}
         aria-valuetext={i >= 0 ? `Stage ${stage}` : "Not staged"}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-label font-normal text-muted">Stage at diagnosis</span>
        <span className="text-[14px] font-semibold text-ink">{i >= 0 ? `Stage ${stage}` : "Not staged"}</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {STAGES.map((s, k) => (
          <div key={s} className="h-1.5 rounded-full bg-tile dark:bg-hairline overflow-hidden" aria-hidden>
            {i >= 0 && k <= i && <motion.div className="h-full bg-ink rounded-full" initial={reduce ? false : { width: 0 }} animate={{ width: "100%" }}
                                            transition={{ ...SPRING_SOFT, delay: reduce ? 0 : 0.1 + k * 0.08 }} />}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1.5 text-micro text-muted mt-1">{STAGES.map((s) => <span key={s}>{s}</span>)}</div>
    </div>
  );
}

function Tile({ k, v, sub }: { k: string; v: string | null; sub: string }) {
  return (
    <div className="rounded-tile bg-tile px-3.5 py-3.5 min-w-0">
      <div className="text-label font-normal text-muted truncate">{sub}</div>
      <div className={`text-[28px] leading-9 font-medium tracking-[-0.01em] tabular mt-0.5 ${v ? "text-ink" : "text-muted"}`}>{v ?? `${k}?`}</div>
    </div>
  );
}

/** Tumour and spread card (diagnosed cases): T / N / M as grey tiles + the stage pill (the screen's one focused item);
 * site, histology and intent behind ⓘ. */
export function TumourCard({ data, className = "" }: { data: CaseData; className?: string }) {
  const t = data.tumour as Tumour;
  const histology = [t.lauren && `Lauren ${String(t.lauren).toLowerCase()}`, t.grade && `${String(t.grade).toLowerCase()} grade`].filter(Boolean).join(", ") || "not recorded";
  return (
    <Card title="Tumour" icon={<Microscope size={16} />} className={className}
          info={{ about: <>Site <b className="capitalize">{t.lesion_location ?? "not recorded"}</b>{t.lesion_size_mm ? `, ${t.lesion_size_mm} mm` : ""}. Histology {histology}. Intent {t.treatment_intent?.toLowerCase() ?? "not recorded"}.</>,
                  notes: `Diagnosed ${date((t.dx_date as string) ?? (data.header.dx_date as string) ?? (t.endo_date as string))}` }}
          actions={t.stage_group
            ? <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-signal-strong text-signal-on text-micro font-semibold"><span className="w-1.5 h-1.5 rounded-full bg-signal-on" aria-hidden />Stage {t.stage_group}</span>
            : <span className="inline-flex items-center h-7 px-3 rounded-full bg-tile text-micro text-muted">Not staged</span>}>
      <div className="grid grid-cols-3 gap-2">
        <Tile k="T" v={t.t_stage} sub="Tumour" />
        <Tile k="N" v={t.n_stage} sub="Nodes" />
        <Tile k="M" v={t.m_stage} sub="Metastasis" />
      </div>
    </Card>
  );
}
