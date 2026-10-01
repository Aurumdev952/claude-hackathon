import { motion, useReducedMotion } from "framer-motion";
import { Microscope } from "lucide-react";
import { Card, StatusChip } from "@/components/ui";
import { date } from "@/lib/format";
import { SPRING_SOFT } from "@/lib/motion";
import type { CaseData, Tumour } from "./types";

const STAGES = ["I", "II", "III", "IV"];
const stageIndex = (g: string | null | undefined) => {
  if (!g) return -1;
  const m = /^(IV|III|II|I)/.exec(g.toUpperCase());
  return m ? STAGES.indexOf(m[1]) : -1;
};

/** Stage I–IV dot track (MedEx "severity" track) for the section header of a diagnosed case. */
export function StageTrack({ stage, className = "" }: { stage: string | null | undefined; className?: string }) {
  const reduce = useReducedMotion();
  const i = stageIndex(stage);
  const tone = i >= 3 ? "bg-danger" : i === 2 ? "bg-serious" : i === 1 ? "bg-warning" : "bg-success";
  return (
    <div className={`w-full ${className}`} role="meter" aria-label="Stage at diagnosis" aria-valuemin={1} aria-valuemax={4} aria-valuenow={i >= 0 ? i + 1 : undefined}
         aria-valuetext={i >= 0 ? `Stage ${stage}` : "Not staged"}>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="text-label text-fg-muted">Stage</span>
        <span className="text-label font-semibold text-fg">{i >= 0 ? `Stage ${stage}` : "Not staged"}</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 16 }).map((_, k) => {
          const on = i >= 0 && k < (i + 1) * 4;
          return <motion.span key={k} className={`h-2 flex-1 rounded-full ${on ? tone : "bg-fg/[0.08]"}`} aria-hidden
                              initial={reduce ? false : { scaleY: 0.2, opacity: 0 }} animate={{ scaleY: 1, opacity: 1 }} transition={{ ...SPRING_SOFT, delay: reduce ? 0 : k * 0.025 }} />;
        })}
      </div>
      <div className="flex justify-between text-micro text-fg-muted mt-0.5">{STAGES.map((s) => <span key={s}>{s}</span>)}</div>
    </div>
  );
}

function Tile({ k, v, sub, tone }: { k: string; v: string | null; sub: string; tone: string }) {
  return (
    <div className="rounded-tile bg-surface-2 border border-border/70 px-3 py-2 min-w-0">
      <div className="text-micro text-fg-muted">{sub}</div>
      <div className={`text-[24px] leading-8 font-semibold tracking-tight tabular ${v ? tone : "text-fg-muted"}`}>{v ?? `${k}?`}</div>
    </div>
  );
}

/** Tumour & spread card (diagnosed cases): T / N / M tiles + stage chip; site, histology and intent behind ⓘ. */
export function TumourCard({ data, className = "" }: { data: CaseData; className?: string }) {
  const t = data.tumour as Tumour;
  const i = stageIndex(t.stage_group);
  const histology = [t.lauren && `Lauren ${String(t.lauren).toLowerCase()}`, t.grade && `${String(t.grade).toLowerCase()} grade`].filter(Boolean).join(", ") || "not recorded";
  return (
    <Card title="Tumour" icon={<Microscope size={16} />} iconTone="danger" className={className} padding="sm" headerClassName="!mb-2.5"
          info={{ about: <>Site <b className="capitalize">{t.lesion_location ?? "not recorded"}</b>{t.lesion_size_mm ? ` · ${t.lesion_size_mm} mm` : ""}. Histology {histology}. Intent {t.treatment_intent?.toLowerCase() ?? "—"}.</>,
                  notes: `Diagnosed ${date((t.endo_date as string) ?? (data.header.dx_date as string))}` }}
          actions={<StatusChip status={i >= 3 ? "critical" : i === 2 ? "serious" : i >= 0 ? "warning" : "neutral"} size="md" label={t.stage_group ? `Stage ${t.stage_group}` : "Not staged"} />}>
      <div className="grid grid-cols-3 gap-2">
        <Tile k="T" v={t.t_stage} sub="Tumour" tone="text-tone-danger" />
        <Tile k="N" v={t.n_stage} sub="Nodes" tone="text-tone-serious" />
        <Tile k="M" v={t.m_stage} sub="Metastasis" tone={t.m_stage && t.m_stage !== "M0" ? "text-tone-danger" : "text-fg"} />
      </div>
    </Card>
  );
}
