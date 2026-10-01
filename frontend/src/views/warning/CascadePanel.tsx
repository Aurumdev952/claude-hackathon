import { useState } from "react";
import { CornerDownRight } from "lucide-react";
import { Filter } from "lucide-react";
import { Card, chartDetailTabs, DataTable, Loading, Seg, StatusChip } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt, int } from "@/lib/format";
import { alpha, Empty, usePalette } from "../trends/kit";
import { FunnelRow, PROVINCES, useFunnel } from "./api";

const STAGE_LABEL: Record<string, string> = {
  gi_flagged: "GI-flagged", hp_tested: "H. pylori tested", hp_positive: "H. pylori positive", eradicated: "Eradication treated",
  referred: "Referred for endoscopy", scoped: "Scoped", biopsied: "Biopsied", diagnosed: "Cancer diagnosed",
};
const ORDER: Record<string, string[]> = {
  hp: ["gi_flagged", "hp_tested", "hp_positive", "eradicated"],
  endoscopy: ["gi_flagged", "referred", "scoped", "biopsied", "diagnosed"],
};
const DROP_LABEL: Record<string, string> = {
  hp_tested: "never tested", hp_positive: "tested negative", eradicated: "positive, not treated",
  referred: "never referred", scoped: "referred, not scoped", biopsied: "scoped, no biopsy", diagnosed: "biopsied, not cancer",
};

/** Care cascade (SPEC §16.3 V4): two pathways from the same GI-flagged cohort, bars on one linear scale. */
export function CascadePanel() {
  const [prov, setProv] = useState("ALL");
  const q = useFunnel(prov);
  const pal = usePalette();
  const rows = q.data?.data ?? [];
  const path = (p: "hp" | "endoscopy") => ORDER[p].map((s) => rows.find((r) => r.pathway === p && r.stage === s)).filter(Boolean) as FunnelRow[];
  const method = "GI-flagged cohort (SPEC §8.7): adults with a qualifying dyspepsia/gastritis/PUD/anaemia encounter. Each step counts patients who ever reached it after cohort entry; % is relative to the previous step. A step can exceed 100% of the previous one when a later event is recorded without the earlier one (e.g. scoped without a recorded referral).";
  return (
    <Card
      title="Care cascade · GI-flagged cohort" icon={<Filter size={16} />}
      info={{ about: "Everyone flagged with a GI complaint, followed down two pathways. Bar length is on one scale, so the drop-offs are literal; the right-hand % is relative to the previous step.", method }}
      actions={<Seg label="Province" value={prov} onChange={setProv} options={[{ value: "ALL", label: "Rwanda" }, ...Object.entries(PROVINCES).map(([k, v]) => ({ value: k, label: v }))]} />}
      detail={{ tabs: chartDetailTabs({ table: <DataTable columns={[{ key: "pathway", label: "Pathway", fmt: (v) => (v === "hp" ? "H. pylori" : "Endoscopy") }, { key: "stage", label: "Step", fmt: (v) => STAGE_LABEL[v] ?? v },
        { key: "n", label: "Patients", num: true, fmt: int }, { key: "pct_of_prev", label: "% of previous", num: true, fmt: (v) => (v === null ? "—" : `${fmt(v, 1)}%`) }]} rows={rows} />, method }), defaultTab: "table" }}
      detailLabel="View as table"
    >
      {q.error ? <ErrorNote error={q.error} /> : q.isLoading ? <Loading h={260} /> : !rows.length ? <Empty h={200}>No cascade for this selection.</Empty> : (
        <div className={`grid gap-8 grid-cols-1 lg:grid-cols-2 transition-opacity ${q.isFetching ? "opacity-60" : ""}`}>
          <Funnel title="Endoscopy pathway" steps={path("endoscopy")} color={pal.series[0]} />
          <Funnel title="H. pylori pathway" steps={path("hp")} color={pal.series[1]} />
        </div>
      )}
    </Card>
  );
}

function Funnel({ title, steps, color }: { title: string; steps: FunnelRow[]; color: string }) {
  const n0 = steps[0]?.n ?? 1;
  const last = steps[steps.length - 1];
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-block w-3 h-3 rounded-[3px]" style={{ background: color }} aria-hidden />
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {last && <StatusChip status="info" className="ml-auto" title={`${fmt((100 * last.n) / n0, 1)}% of flagged patients reach "${STAGE_LABEL[last.stage].toLowerCase()}"`}
                             label={<span className="tabular">{fmt((100 * last.n) / n0, 1)}% reach {STAGE_LABEL[last.stage].toLowerCase()}</span>} />}
      </div>
      <ol className="flex flex-col">
        {steps.map((s, i) => {
          const w = Math.max(0.6, (100 * s.n) / n0);
          const prev = steps[i - 1];
          const lost = prev ? prev.n - s.n : 0;
          return (
            <li key={s.stage}>
              {prev && (
                <div className="flex items-center gap-1.5 pl-[132px] h-[18px] text-[10.5px] text-fg-muted tabular" aria-label={`${int(Math.max(0, lost))} ${DROP_LABEL[s.stage]}`}>
                  <CornerDownRight size={11} className="shrink-0 opacity-70" aria-hidden />
                  {lost >= 0
                    ? <span><b className="text-fg font-semibold">{int(lost)}</b> {DROP_LABEL[s.stage]} <span className="opacity-80">({fmt((100 * lost) / prev.n, 0)}%)</span></span>
                    : <span title="More than the previous step: recorded without it">+{int(-lost)} vs previous step</span>}
                </div>
              )}
              <div className="group flex items-center gap-3 rounded-md hover:bg-surface-2 px-1 -mx-1" title={`${STAGE_LABEL[s.stage]}: ${int(s.n)} patients · ${fmt((100 * s.n) / n0, 1)}% of flagged${s.pct_of_prev !== null ? ` · ${fmt(s.pct_of_prev, 1)}% of previous step` : ""}`}>
                <span className="w-[120px] shrink-0 text-[12px] text-fg-muted group-hover:text-fg leading-tight">{STAGE_LABEL[s.stage]}</span>
                <div className="flex-1 h-[22px] relative rounded-full bg-surface-2 overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 rounded-full transition-[width] duration-700" style={{ width: `${w}%`, background: i === 0 ? alpha(color, 0.55) : color }} />
                  <span className="absolute top-1/2 -translate-y-1/2 text-[12px] font-semibold tabular whitespace-nowrap"
                        style={w > 70 ? { right: `${100 - w}%`, marginRight: 8 } : { left: `${w}%`, marginLeft: 8 }}>
                    {int(s.n)}
                  </span>
                </div>
                <span className="w-[54px] shrink-0 text-right text-[11.5px] tabular text-fg-muted" title="% of previous step">{s.pct_of_prev === null ? "100%" : `${fmt(s.pct_of_prev, 0)}%`}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
