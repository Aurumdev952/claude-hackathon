import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { DataTable } from "@/components/ui/Panel";
import { STATUS } from "@/lib/viz";
import { fmt } from "@/lib/format";
import { pval, usePalette } from "./kit";
import type { CoxRow } from "./types";

const TERM_LABEL: Record<string, string> = {
  eradicated: "H. pylori eradication", hiv: "HIV infection", age: "Age (per year)", male: "Male sex", atrophy_im: "Atrophy / intestinal metaplasia",
  hotspot: "Lives in a hotspot district", age_at_dx: "Age at diagnosis (per year)", hp_tested: "HP tested before diagnosis",
  stage_II: "Stage II vs I", stage_III: "Stage III vs I", stage_IV: "Stage IV vs I", tier_low: "Low-testing tier vs high", tier_medium: "Medium-testing tier vs high",
};
const MODELS = [
  { id: "eradication_ins4", term: "eradicated", title: "H. pylori eradication", sub: "H. pylori-positive patients → later gastric cancer · adjusted for age, sex, atrophy/IM, hotspot" },
  { id: "hiv_negative_control", term: "hiv", title: "HIV infection", sub: "Negative control · GI cohort → gastric cancer · adjusted for age, sex" },
];
const LO = 0.2, HI = 5, TICKS = [0.25, 0.5, 1, 2, 4];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(400);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const includes1 = (r: CoxRow) => r.lci <= 1 && r.uci >= 1;

/** INS-4 + INS-8: the eradication hazard ratio shown beside the HIV negative control, forest style on a log scale. */
export function CoxForest({ rows, covariates, hivShapRank }: { rows: CoxRow[]; covariates: boolean; hivShapRank?: number | null }) {
  const { ink: k } = usePalette();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ r: CoxRow; y: number } | null>(null);
  const x = (v: number) => 8 + ((Math.log(Math.max(LO, Math.min(HI, v))) - Math.log(LO)) / (Math.log(HI) - Math.log(LO))) * (w - 16);
  type Line = { r: CoxRow; main: boolean; title: string; sub?: string };
  const lines: Line[] = [];
  MODELS.forEach((m) => {
    const main = rows.find((r) => r.model_id === m.id && r.term === m.term);
    if (main) lines.push({ r: main, main: true, title: m.title, sub: m.sub });
    if (covariates) rows.filter((r) => r.model_id === m.id && r.term !== m.term).forEach((r) => lines.push({ r, main: false, title: TERM_LABEL[r.term] ?? r.term }));
  });
  const H = (l: Line) => (l.main ? 58 : 24);
  let acc = 22;
  const ys = lines.map((l) => { const y = acc + H(l) / 2; acc += H(l); return y; });
  const total = acc + 26;
  if (!lines.length) return <div className="text-xs text-fog">Cox models not available in this run.</div>;
  return (
    <div className="relative">
      <div className="grid gap-x-3" style={{ gridTemplateColumns: "minmax(140px, 1fr) minmax(180px, 1.5fr) auto" }}>
        {/* label column */}
        <div className="relative" style={{ height: total }}>
          {lines.map((l, i) => (
            <div key={i} className="absolute left-0 right-0 -translate-y-1/2" style={{ top: ys[i] }}>
              {l.main ? (<>
                <div className="text-sm font-semibold leading-tight">{l.title}</div>
                <div className="text-[10px] text-fog leading-snug line-clamp-2">{l.sub}</div>
              </>) : <div className="text-[11px] text-fog pl-3 truncate">{l.title}</div>}
            </div>
          ))}
        </div>
        {/* plot column */}
        <div ref={ref} className="relative" style={{ height: total }}>
          <svg width={w} height={total} className="block overflow-visible" role="img" aria-label="Forest plot of hazard ratios on a log scale">
            <text x={x(1) - 6} y={11} fontSize={10} fill={k.muted} textAnchor="end">← lower hazard</text>
            <text x={x(1) + 6} y={11} fontSize={10} fill={k.muted}>higher hazard →</text>
            {TICKS.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={18} y2={total - 22} stroke={k.grid} />)}
            <line x1={x(1)} x2={x(1)} y1={16} y2={total - 20} stroke={k.secondary} strokeWidth={1.25} />
            <line x1={0} x2={w} y1={total - 20} y2={total - 20} stroke={k.axis} />
            {TICKS.map((t) => <text key={t} x={x(t)} y={total - 6} fontSize={10} fill={k.muted} textAnchor="middle" className="tabular">{t}</text>)}
            {lines.map((l, i) => {
              const y = ys[i], c = l.main ? k.primary : k.muted, s = l.main ? 11 : 7;
              const clippedL = l.r.lci < LO, clippedR = l.r.uci > HI;
              return (
                <g key={i} onMouseEnter={() => setHover({ r: l.r, y })} onMouseLeave={() => setHover(null)}>
                  <rect x={0} y={y - H(l) / 2} width={w} height={H(l)} fill="transparent" />
                  {i > 0 && l.main && <line x1={0} x2={w} y1={y - H(l) / 2} y2={y - H(l) / 2} stroke={k.grid} />}
                  <line x1={x(l.r.lci)} x2={x(l.r.uci)} y1={y} y2={y} stroke={c} strokeWidth={l.main ? 2 : 1.25} strokeLinecap="round" />
                  {!clippedL && <line x1={x(l.r.lci)} x2={x(l.r.lci)} y1={y - (l.main ? 6 : 3)} y2={y + (l.main ? 6 : 3)} stroke={c} strokeWidth={l.main ? 2 : 1.25} />}
                  {!clippedR && <line x1={x(l.r.uci)} x2={x(l.r.uci)} y1={y - (l.main ? 6 : 3)} y2={y + (l.main ? 6 : 3)} stroke={c} strokeWidth={l.main ? 2 : 1.25} />}
                  {clippedR && <path d={`M${x(HI) - 5},${y - 4} L${x(HI)},${y} L${x(HI) - 5},${y + 4}`} fill="none" stroke={c} strokeWidth={1.25} />}
                  {clippedL && <path d={`M${x(LO) + 5},${y - 4} L${x(LO)},${y} L${x(LO) + 5},${y + 4}`} fill="none" stroke={c} strokeWidth={1.25} />}
                  <rect x={x(l.r.hr) - s / 2} y={y - s / 2} width={s} height={s} rx={2} fill={c} stroke={k.surface} strokeWidth={2} />
                </g>
              );
            })}
          </svg>
          {hover && (
            <div className="absolute z-20 panel bg-ridge px-3 py-2 text-xs pointer-events-none whitespace-nowrap"
                 style={{ left: Math.min(x(hover.r.hr) + 12, w - 150), top: hover.y + 10 }}>
              <div className="font-semibold">{TERM_LABEL[hover.r.term] ?? hover.r.term}</div>
              <div className="tabular">HR {fmt(hover.r.hr, 2)} <span className="text-fog">95% CI {fmt(hover.r.lci, 2)}–{fmt(hover.r.uci, 2)}</span></div>
              <div className="text-fog tabular">{pval(hover.r.p)} · {includes1(hover.r) ? "CI includes 1" : "CI excludes 1"}</div>
            </div>
          )}
        </div>
        {/* value column */}
        <div className="relative min-w-[118px]" style={{ height: total }}>
          <div className="absolute top-0 right-0 whitespace-nowrap text-[10px] uppercase tracking-wider text-fog">HR (95% CI)</div>
          {lines.map((l, i) => (
            <div key={i} className={`absolute right-0 -translate-y-1/2 text-right tabular whitespace-nowrap ${l.main ? "text-sm font-semibold" : "text-[11px] text-fog"}`} style={{ top: ys[i] }}>
              {fmt(l.r.hr, 2)}<span className={`${l.main ? "text-fog font-normal text-xs" : ""}`}> ({fmt(l.r.lci, 2)}–{fmt(l.r.uci, 2)})</span>
            </div>
          ))}
        </div>
      </div>
      <Readings rows={rows} hivShapRank={hivShapRank} />
    </div>
  );
}

function Readings({ rows, hivShapRank }: { rows: CoxRow[]; hivShapRank?: number | null }) {
  const er = rows.find((r) => r.model_id === "eradication_ins4" && r.term === "eradicated");
  const hiv = rows.find((r) => r.model_id === "hiv_negative_control" && r.term === "hiv");
  const hivOk = hiv ? includes1(hiv) : null;
  const shapOk = hivShapRank === null || hivShapRank === undefined ? null : hivShapRank > 30;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
      <div className="rounded-lg border border-line/60 bg-ridge2/40 p-2.5 text-xs leading-relaxed">
        <div className="panel-title mb-1">Reading · eradication</div>
        {er ? (
          <p>
            {er.uci < 1 ? <>H. pylori-positive patients who completed eradication therapy had about <b className="tabular">{fmt(100 * (1 - er.hr), 0)}% lower</b> hazard of later gastric cancer </>
              : er.lci > 1 ? <>Eradication was associated with a <b>higher</b> hazard </> : <>No clear difference in hazard with eradication </>}
            (HR {fmt(er.hr, 2)}, 95% CI {fmt(er.lci, 2)}–{fmt(er.uci, 2)}). This is an association in routine data, not a trial result.
          </p>
        ) : <p className="text-fog">Not available.</p>}
      </div>
      <div className="rounded-lg border border-line/60 bg-ridge2/40 p-2.5 text-xs leading-relaxed">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1"><span className="panel-title">Reading · negative control</span>
          {hivOk !== null && <Check ok={hivOk} label={hivOk ? "CI includes 1" : "CI excludes 1"} />}</div>
        {hiv ? (hivOk ? (
          <p>HIV has no known effect on gastric cancer, and the system agrees: HR {fmt(hiv.hr, 2)} with a CI ({fmt(hiv.lci, 2)}–{fmt(hiv.uci, 2)}) that includes 1. The method is not finding effects that aren't there.</p>
        ) : (
          <p>HIV should show <b>no</b> association, but this run estimates HR {fmt(hiv.hr, 2)} ({fmt(hiv.lci, 2)}–{fmt(hiv.uci, 2)}). A null exposure that looks protective points to residual bias in the cohort design (for example competing deaths or different follow-up among people living with HIV); read the eradication estimate with the same caution.</p>
        )) : <p className="text-fog">Not available.</p>}
        {shapOk !== null && (
          <p className="mt-1.5 flex items-center gap-2 text-fog">Risk model check: HIV ranks <b className="text-mist tabular">#{hivShapRank}</b> by SHAP importance <Check ok={shapOk} label={shapOk ? "rank > 30" : "rank ≤ 30"} /></p>
        )}
      </div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  const c = ok ? STATUS.good : STATUS.warning;
  const I = ok ? CheckCircle2 : AlertTriangle;
  return <span className="chip whitespace-nowrap" style={{ background: `${c}22`, color: c, boxShadow: `inset 0 0 0 1px ${c}55` }}><I size={11} aria-hidden />{label}</span>;
}

export function CoxTable({ rows }: { rows: CoxRow[] }) {
  return <DataTable rows={rows} columns={[
    { key: "model_id", label: "Model" }, { key: "term", label: "Term", fmt: (v) => TERM_LABEL[v] ?? v },
    { key: "hr", label: "HR", num: true, fmt: (v) => fmt(v, 2) },
    { key: "lci", label: "95% CI", num: true, fmt: (_, r) => `[${fmt(r.lci, 2)}–${fmt(r.uci, 2)}]` },
    { key: "p", label: "p", num: true, fmt: (v) => pval(v).replace("p = ", "").replace("p ", "") },
  ]} />;
}
