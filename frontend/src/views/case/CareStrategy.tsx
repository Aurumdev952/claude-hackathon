import { useState } from "react";
import { Button } from "@heroui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDownRight, ArrowUpRight, BellRing, ClipboardList, FlaskConical, HeartPulse, Microscope, Minus, Pill, ScanSearch, ShieldPlus, Sparkles, Stethoscope, TrendingUp, Bug,
} from "lucide-react";
import { Card, DetailModal, PillTabs, Sparkline, StatusChip, useDetailModal } from "@/components/ui";
import { date, fmt } from "@/lib/format";
import { DIVERGING } from "@/lib/viz";
import { EASE, itemEnter, stagger } from "@/lib/motion";
import { AlertActions } from "@/views/doctor/AlertActions";
import { NotScored, SHAP_NOTE } from "@/views/doctor/RiskCard";
import type { CaseData, Measure } from "./types";
import { useCaseUI } from "./store";
import { MEASURE_ORGANS } from "./measureOrgans";

type TabKey = "alerts" | "reasons" | "vitals" | "meds";

/** List card used by every tab (reference "Customized care strategy" 2-column cards): icon tile + title + one line. */
function Item({ icon, tone = "accent", title, sub, right, children, onHover }: {
  icon: React.ReactNode; tone?: "accent" | "warning" | "danger" | "success" | "neutral"; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode;
  children?: React.ReactNode; onHover?: (on: boolean) => void;
}) {
  const T = { accent: "bg-accent-soft text-accent", warning: "bg-warning/15 text-tone-warning", danger: "bg-danger/10 text-tone-danger", success: "bg-success/10 text-tone-success", neutral: "bg-surface-2 text-fg-muted" }[tone];
  return (
    <motion.li variants={itemEnter} whileHover={{ y: -2 }} tabIndex={onHover ? 0 : undefined}
               onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)} onBlur={() => onHover?.(false)}
               className="rounded-tile bg-surface border border-border shadow-tile p-3 flex gap-3 min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 hover:shadow-card transition-shadow">
      <span className={`w-10 h-10 shrink-0 rounded-[12px] grid place-items-center ${T}`} aria-hidden>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[13px] font-semibold text-fg leading-snug">{title}</div>
          {right}
        </div>
        {sub && <div className="text-micro text-fg-muted mt-0.5 leading-snug line-clamp-2">{sub}</div>}
        {children}
      </div>
    </motion.li>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return <motion.ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" variants={stagger(0.04)} initial={reduce ? false : "hidden"} animate="show">{children}</motion.ul>;
}

function Reasons({ data }: { data: CaseData }) {
  const reduce = useReducedMotion();
  if (!data.risk) return <div className="py-4"><NotScored /></div>;
  const rs = data.risk.top_reasons ?? [];
  const max = Math.max(0.01, ...rs.map((r) => Math.abs(r.contribution)));
  if (!rs.length) return <div className="text-label text-fg-muted py-4">No positive contributions above baseline</div>;
  return (
    <Grid>
      {rs.map((r, i) => (
        <Item key={r.feature} icon={<TrendingUp size={17} />} tone="warning" title={r.label}
              right={<span className="text-micro font-semibold tabular text-tone-warning shrink-0">+{r.contribution.toFixed(2)}</span>}>
          <div className="h-1.5 rounded-full bg-fg/[0.06] mt-2 overflow-hidden" aria-hidden>
            <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${DIVERGING.pos}88, ${DIVERGING.pos})` }}
                        initial={reduce ? false : { width: 0 }} animate={{ width: `${(100 * Math.abs(r.contribution)) / max}%` }} transition={{ duration: 0.7, ease: EASE, delay: 0.1 + i * 0.05 }} />
          </div>
        </Item>
      ))}
    </Grid>
  );
}

function Trend({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return null;
  const Icon = Math.abs(pct) < 2 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className="inline-flex items-center gap-0.5 text-micro text-fg-muted tabular" title="Change over the last 12 months"><Icon size={11} aria-hidden />{pct > 0 ? "+" : ""}{pct.toFixed(0)}%</span>;
}

function Measures({ data }: { data: CaseData }) {
  const set = useCaseUI((s) => s.set);
  const rows: Measure[] = [...data.labs, ...data.vitals].sort((a, b) => Number(b.abnormal) - Number(a.abnormal));
  if (!rows.length) return <div className="text-label text-fg-muted py-4">None recorded</div>;
  return (
    <Grid>
      {rows.map((m) => {
        const val = typeof m.latest === "number" ? fmt(m.latest, m.latest >= 100 ? 0 : 1) : String(m.latest).replace(/_/g, " ").toLowerCase();
        const isLab = data.labs.includes(m);
        return (
          <Item key={m.concept_id} icon={isLab ? <FlaskConical size={17} /> : <HeartPulse size={17} />} tone={m.abnormal ? "warning" : isLab ? "success" : "accent"}
                title={m.name} onHover={(on) => set(on ? { focusOrgans: MEASURE_ORGANS[m.concept_id] ?? null, focusLabel: m.name } : { focusOrgans: null, focusLabel: null })}
                right={m.abnormal ? <StatusChip status="suboptimal" label="Abnormal" /> : undefined}
                sub={`${date(m.latest_ts)} · ${m.n} reading${m.n === 1 ? "" : "s"}`}>
            <div className="flex items-end justify-between gap-2 mt-1.5">
              <div className="flex items-baseline gap-1 min-w-0">
                <span className={`text-[18px] leading-6 font-semibold tabular capitalize ${m.abnormal ? "text-tone-warning" : "text-fg"}`}>{val}</span>
                {m.unit && <span className="text-micro text-fg-muted">{m.unit}</span>}
                <Trend pct={m.change_pct_12m} />
              </div>
              {m.series.length > 1 && <div className="w-[84px] shrink-0"><Sparkline values={m.series.map((p) => p.value)} height={24} /></div>}
            </div>
          </Item>
        );
      })}
    </Grid>
  );
}

function Meds({ data }: { data: CaseData }) {
  const recent = useDetailModal();
  const md = data.medications;
  const items = [
    { k: "PPI courses", v: md.ppi_courses_24m, sub: "last 24 months", icon: <Pill size={17} />, warn: md.ppi_courses_24m >= 3 },
    { k: "H. pylori eradication", v: md.eradication_courses, sub: "courses", icon: <ShieldPlus size={17} />, warn: false },
    { k: "Iron therapy", v: md.iron, sub: "courses", icon: <Stethoscope size={17} />, warn: false },
    { k: "Antimalarials", v: md.antimalarial, sub: "courses", icon: <Bug size={17} />, warn: false },
    { k: "Anthelminthics", v: md.anthelminthic, sub: "courses", icon: <ClipboardList size={17} />, warn: false },
  ];
  return (
    <>
      <Grid>
        {items.map((it) => (
          <Item key={it.k} icon={it.icon} tone={it.warn ? "warning" : "accent"} title={it.k} sub={it.sub}
                right={<span className={`text-[20px] leading-6 font-semibold tabular ${it.warn ? "text-tone-warning" : "text-fg"}`}>{it.v}</span>} />
        ))}
        <Item icon={<Microscope size={17} />} tone={data.endoscopies.length ? "danger" : "neutral"} title="Endoscopy"
              sub={data.endoscopies.length ? data.endoscopies.map((e) => `${date(e.ts)} · ${e.impression}${e.location ? ` · ${e.location.toLowerCase()}` : ""}${e.size_mm ? ` · ${e.size_mm} mm` : ""}`).join("; ") : "Never scoped"}
              right={<span className="text-[20px] leading-6 font-semibold tabular text-fg">{data.endoscopies.length}</span>} />
      </Grid>
      {md.recent.length > 0 && (
        <Button size="sm" radius="full" variant="flat" className="mt-3 bg-surface-2 border border-border text-fg" startContent={<ScanSearch size={14} aria-hidden />} onPress={recent.open}>
          Recent courses · {md.recent.length}
        </Button>
      )}
      <DetailModal {...recent.modalProps} title="Recent medicine courses" icon={<Pill size={18} />} size="2xl">
        <ul className="flex flex-col divide-y divide-border rounded-tile border border-border overflow-hidden">
          {[...md.recent].reverse().map((r, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2 text-[13px] bg-surface">
              <span className="tabular text-fg-muted w-[96px] shrink-0">{date(r.ts)}</span>
              <span className="flex-1 text-fg">{r.label}</span>
              <span className="text-micro text-fg-muted">{r.days ? `${r.days} d` : "—"}</span>
              <StatusChip status="neutral" icon={false} label={r.course_type.replace(/_/g, " ").toLowerCase()} className="capitalize" />
            </li>
          ))}
        </ul>
      </DetailModal>
    </>
  );
}

/** "Care strategy" card (reference "Customized care strategy"): pill tabs Alerts · Why flagged · Vitals & labs · Medicines
 * over a two-column list of cards. */
export function CareStrategy({ data, className = "" }: { data: CaseData; className?: string }) {
  const newAlerts = data.alerts.filter((a) => a.status === "NEW").length;
  const [tab, setTab] = useState<TabKey>(newAlerts ? "alerts" : data.risk ? "reasons" : "vitals");
  const abnormal = [...data.labs, ...data.vitals].filter((m) => m.abnormal).length;
  return (
    <Card title="Care strategy" icon={<Sparkles size={16} />} className={className}
          info={{ about: "What to act on for this patient: open alerts and their suggested actions, the reasons the models flagged them, measurements, and medicines.", notes: SHAP_NOTE }}
          actions={
            <PillTabs ariaLabel="Care strategy" size="sm" selectedKey={tab} onSelectionChange={setTab} panelClassName="hidden"
                      items={[
                        { key: "alerts", label: "Alerts", icon: <BellRing size={13} aria-hidden />, count: data.alerts.length },
                        { key: "reasons", label: "Why flagged", count: data.risk?.top_reasons?.length || undefined },
                        { key: "vitals", label: "Vitals & labs", count: abnormal || undefined },
                        { key: "meds", label: "Medicines" },
                      ]} />
          }>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: EASE }}>
          {tab === "alerts" && <AlertActions alerts={data.alerts} columns={2} />}
          {tab === "reasons" && <Reasons data={data} />}
          {tab === "vitals" && <Measures data={data} />}
          {tab === "meds" && <Meds data={data} />}
        </motion.div>
      </AnimatePresence>
    </Card>
  );
}
