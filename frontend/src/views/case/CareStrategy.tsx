import { useState } from "react";
import { Button } from "@heroui/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDownRight, ArrowUpRight, BellRing, ClipboardList, FlaskConical, HeartPulse, Microscope, Minus, Pill, ScanSearch, ShieldPlus, Sparkles, Stethoscope, TrendingUp, Bug,
} from "lucide-react";
import { Card, DetailModal, PillTabs, Sparkline, useDetailModal } from "@/components/ui";
import { date, fmt } from "@/lib/format";
import { EASE, itemEnter, stagger } from "@/lib/motion";
import { AlertActions } from "@/views/doctor/AlertActions";
import { BandMark } from "@/views/doctor/BandMark";
import { NotScored, SHAP_NOTE, Track } from "@/views/doctor/RiskCard";
import type { CaseData, Measure } from "./types";
import { useCaseUI } from "./store";
import { MEASURE_ORGANS } from "./measureOrgans";

type TabKey = "alerts" | "reasons" | "vitals" | "meds";

/** Tile used by every tab (reference grey nested tile): white icon circle + title + one muted line. `tone` is kept for
 * call-site compatibility; status is carried by text (a small dot + label in `right`), not by tinted icons. */
function Item({ icon, title, sub, right, children, onHover }: {
  icon: React.ReactNode; tone?: "accent" | "warning" | "danger" | "success" | "neutral"; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode;
  children?: React.ReactNode; onHover?: (on: boolean) => void;
}) {
  return (
    <motion.li variants={itemEnter} tabIndex={onHover ? 0 : undefined}
               onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)} onBlur={() => onHover?.(false)}
               className={`rounded-tile bg-tile p-4 flex gap-3.5 min-w-0 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal ${onHover ? "hover:bg-tile-hover transition-colors" : ""}`}>
      <span className="w-9 h-9 shrink-0 rounded-full bg-surface text-ink grid place-items-center [&_svg]:w-4 [&_svg]:h-4" aria-hidden>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[14px] font-semibold text-ink leading-5">{title}</div>
          {right}
        </div>
        {sub && <div className="text-micro font-normal text-muted mt-0.5 leading-snug line-clamp-2">{sub}</div>}
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
  if (!data.risk) return <div className="py-4"><NotScored /></div>;
  const rs = data.risk.top_reasons ?? [];
  const max = Math.max(0.01, ...rs.map((r) => Math.abs(r.contribution)));
  if (!rs.length) return <div className="text-label text-muted py-4">No positive contributions above baseline</div>;
  return (
    <Grid>
      {rs.map((r, i) => (
        <Item key={r.feature} icon={<TrendingUp />} title={r.label}
              right={<span className="text-micro tabular text-muted shrink-0 pt-0.5">+{r.contribution.toFixed(2)}</span>}>
          <div className="mt-3"><Track value={Math.abs(r.contribution) / max} delay={0.1 + i * 0.05} /></div>
        </Item>
      ))}
    </Grid>
  );
}

function Trend({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return null;
  const Icon = Math.abs(pct) < 2 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className="inline-flex items-center gap-0.5 text-micro text-muted tabular" title="Change over the last 12 months"><Icon size={11} aria-hidden />{pct > 0 ? "+" : ""}{pct.toFixed(0)}%</span>;
}

function Measures({ data }: { data: CaseData }) {
  const set = useCaseUI((s) => s.set);
  const rows: Measure[] = [...data.labs, ...data.vitals].sort((a, b) => Number(b.abnormal) - Number(a.abnormal));
  if (!rows.length) return <div className="text-label text-muted py-4">None recorded</div>;
  return (
    <Grid>
      {rows.map((m) => {
        const val = typeof m.latest === "number" ? fmt(m.latest, m.latest >= 100 ? 0 : 1) : ((t) => t.charAt(0).toUpperCase() + t.slice(1))(String(m.latest).replace(/_/g, " ").toLowerCase());
        const isLab = data.labs.includes(m);
        return (
          <Item key={m.concept_id} icon={isLab ? <FlaskConical /> : <HeartPulse />}
                title={m.name} onHover={(on) => set(on ? { focusOrgans: MEASURE_ORGANS[m.concept_id] ?? null, focusLabel: m.name } : { focusOrgans: null, focusLabel: null })}
                right={m.abnormal ? <BandMark level="high" label="Abnormal" className="pt-0.5" /> : undefined}
                sub={<span className="flex gap-3"><span>{date(m.latest_ts)}</span><span>{m.n} reading{m.n === 1 ? "" : "s"}</span></span>}>
            <div className="flex items-end justify-between gap-2 mt-2">
              <div className="flex items-baseline gap-1 min-w-0">
                <span className="text-[22px] leading-7 font-medium tracking-[-0.01em] tabular text-ink">{val}</span>
                {m.unit && <span className="text-micro text-muted">{m.unit}</span>}
                <Trend pct={m.change_pct_12m} />
              </div>
              {m.series.length > 1 && <div className="w-[84px] shrink-0"><Sparkline values={m.series.map((p) => p.value)} height={24} area={false} /></div>}
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
    { k: "PPI courses", v: md.ppi_courses_24m, sub: "Last 24 months", icon: <Pill />, warn: md.ppi_courses_24m >= 3 },
    { k: "H. pylori eradication", v: md.eradication_courses, sub: "Courses", icon: <ShieldPlus />, warn: false },
    { k: "Iron therapy", v: md.iron, sub: "Courses", icon: <Stethoscope />, warn: false },
    { k: "Antimalarials", v: md.antimalarial, sub: "Courses", icon: <Bug />, warn: false },
    { k: "Anthelminthics", v: md.anthelminthic, sub: "Courses", icon: <ClipboardList />, warn: false },
  ];
  const num = (v: number) => <span className="text-[22px] leading-6 font-medium tabular text-ink">{v}</span>;
  return (
    <>
      <Grid>
        {items.map((it) => (
          <Item key={it.k} icon={it.icon} title={it.k}
                sub={it.warn ? <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-signal" aria-hidden />{it.sub}, repeated without a diagnosis</span> : it.sub}
                right={num(it.v)} />
        ))}
        <Item icon={<Microscope />} title="Endoscopy"
              sub={data.endoscopies.length ? data.endoscopies.map((e) => [date(e.ts), e.impression, e.location?.toLowerCase(), e.size_mm ? `${e.size_mm} mm` : null].filter(Boolean).join(", ")).join("; ") : "Never scoped"}
              right={num(data.endoscopies.length)} />
      </Grid>
      {md.recent.length > 0 && (
        <Button size="sm" radius="full" variant="flat" className="mt-3 h-9 px-4 bg-tile text-ink text-[13px] font-medium data-[hover=true]:bg-tile-hover" startContent={<ScanSearch size={14} aria-hidden />} onPress={recent.open}>
          Recent courses <span className="text-muted tabular">{md.recent.length}</span>
        </Button>
      )}
      <DetailModal {...recent.modalProps} title="Recent medicine courses" icon={<Pill size={18} />} size="2xl">
        <ul className="flex flex-col divide-y divide-hairline">
          {[...md.recent].reverse().map((r, i) => (
            <li key={i} className="flex items-center gap-3 py-2.5 text-[14px]">
              <span className="tabular text-muted w-[104px] shrink-0">{date(r.ts)}</span>
              <span className="flex-1 text-ink">{r.label}</span>
              <span className="text-micro text-muted tabular">{r.days ? `${r.days} days` : "—"}</span>
              <span className="rounded-full bg-tile px-2.5 py-0.5 text-micro text-muted">{((t) => t.charAt(0).toUpperCase() + t.slice(1))(r.course_type.replace(/_/g, " ").toLowerCase())}</span>
            </li>
          ))}
        </ul>
      </DetailModal>
    </>
  );
}

/** "Care strategy" card (reference "Customized care strategy"): tabs on a grey track (Alerts, Why flagged, Vitals and labs,
 * Medicines) over a two-column grid of grey tiles. */
export function CareStrategy({ data, className = "" }: { data: CaseData; className?: string }) {
  const newAlerts = data.alerts.filter((a) => a.status === "NEW").length;
  const [tab, setTab] = useState<TabKey>(newAlerts ? "alerts" : data.risk ? "reasons" : "vitals");
  const abnormal = [...data.labs, ...data.vitals].filter((m) => m.abnormal).length;
  return (
    <Card title="Care strategy" icon={<Sparkles size={16} />} className={className}
          info={{ about: "What to act on for this patient: open alerts and their suggested actions, the reasons the models flagged them, measurements, and medicines.", notes: SHAP_NOTE }}>
      <div className="-mt-1 mb-4 max-w-full overflow-x-auto scrollbar-none">
        <PillTabs ariaLabel="Care strategy" size="sm" variant="glass" selectedKey={tab} onSelectionChange={setTab} panelClassName="hidden"
                  items={[
                    { key: "alerts", label: "Alerts", icon: <BellRing size={13} aria-hidden />, count: data.alerts.length },
                    { key: "reasons", label: "Why flagged", count: data.risk?.top_reasons?.length || undefined },
                    { key: "vitals", label: "Vitals and labs", count: abnormal || undefined },
                    { key: "meds", label: "Medicines" },
                  ]} />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16, ease: EASE }}>
          {tab === "alerts" && <AlertActions alerts={data.alerts} columns={2} variant="tiles" />}
          {tab === "reasons" && <Reasons data={data} />}
          {tab === "vitals" && <Measures data={data} />}
          {tab === "meds" && <Meds data={data} />}
        </motion.div>
      </AnimatePresence>
    </Card>
  );
}
