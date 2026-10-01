import { Fragment, useState } from "react";
import { Seg } from "@/components/ui/Panel";
import { fmt, int } from "@/lib/format";
import { usePalette } from "../quality/kit";
import { PROVINCE, TIER_LABEL } from "../quality/types";
import { TIER_META, type Subgroup } from "./types";

const VARS: { key: string; label: string; order: string[]; name: (v: string) => string }[] = [
  { key: "sex", label: "Sex", order: ["F", "M"], name: (v) => (v === "F" ? "Female" : v === "M" ? "Male" : v) },
  { key: "age_band", label: "Age band", order: ["<50", "50-64", "65+"], name: (v) => (v === "<50" ? "Under 50" : v === "65+" ? "65 and over" : v.replace("-", "–")) },
  { key: "province", label: "Province", order: ["KGL", "NOR", "SOU", "EAS", "WES", "unknown"], name: (v) => PROVINCE[v] ?? v },
  { key: "facility_tier", label: "Home facility tier", order: ["low", "medium", "high", "unknown"], name: (v) => TIER_LABEL[v] ?? v },
];

/** Subgroup performance (SPEC §13.8): AUROC as a dot on a 0.5–1 scale against the overall AUROC, sensitivity at the HIGH threshold as a bar. */
export function SubgroupTable({ rows, models, overall }: { rows: Subgroup[]; models: { model_id: string; tier: number }[]; overall: Record<string, number | null | undefined> }) {
  const { series: S } = usePalette();
  const avail = models.filter((m) => rows.some((r) => r.model_id === m.model_id));
  const [sel, setSel] = useState<string>(() => (avail.find((m) => m.tier === 0) ?? avail.find((m) => m.tier === 2) ?? avail[0])?.model_id ?? "");
  const cur = avail.find((m) => m.model_id === sel) ?? avail[0];
  if (!cur) return <div className="text-xs text-fog">No subgroup metrics in this run.</div>;
  const c = S[TIER_META[cur.tier].slot];
  const mine = rows.filter((r) => r.model_id === cur.model_id);
  const ov = overall[cur.model_id] ?? null;
  const ax = (v: number) => `${Math.max(0, Math.min(1, (v - 0.5) / 0.5)) * 100}%`;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Seg label="Model" value={cur.model_id} onChange={setSel} options={avail.map((m) => ({ value: m.model_id, label: TIER_META[m.tier].short }))} />
        <span className="flex-1" />
        <span className="text-[10px] text-fog flex items-center gap-1.5"><span className="inline-block w-px h-3 bg-mist" aria-hidden />overall AUROC {fmt(ov, 3)}</span>
      </div>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="text-fog text-[10px] uppercase tracking-wider">
            <th className="text-left font-semibold py-1 pr-2">Subgroup</th>
            <th className="text-right font-semibold py-1 px-2 whitespace-nowrap">Cases / n</th>
            <th className="text-left font-semibold py-1 px-2 w-[32%]"><div className="flex justify-between whitespace-nowrap"><span>AUROC</span><span className="normal-case tracking-normal">0.5 → 1</span></div></th>
            <th className="text-left font-semibold py-1 pl-2 w-[24%] whitespace-nowrap">Sens. at HIGH</th>
            <th className="text-right font-semibold py-1 pl-2">PPV</th>
          </tr>
        </thead>
        <tbody>
          {VARS.map((v) => {
            const g = mine.filter((r) => r.subgroup_var === v.key)
              .sort((a, b) => (v.order.indexOf(a.subgroup_value) + 1 || 99) - (v.order.indexOf(b.subgroup_value) + 1 || 99));
            if (!g.length) return null;
            return (
              <Fragment key={v.key}>
                <tr><td colSpan={5} className="pt-2.5 pb-1 text-[10px] uppercase tracking-[0.12em] text-fog font-semibold border-b border-line/50">{v.label}</td></tr>
                {g.map((r) => (
                  <tr key={r.subgroup_value} className="border-b border-line/30 hover:bg-ridge2/40" title={`${v.name(r.subgroup_value)}: AUROC ${fmt(r.auroc, 3)}, sensitivity ${fmt(100 * r.sens, 0)}%`}>
                    <td className="py-1.5 pr-2 whitespace-nowrap">{v.name(r.subgroup_value)}{r.n_pos < 20 && <span className="text-fog text-[10px] ml-1.5">few cases</span>}</td>
                    <td className="py-1.5 px-2 text-right text-fog whitespace-nowrap">{int(r.n_pos)} / {int(r.n)}</td>
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1 h-3">
                          <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
                          {ov !== null && <div className="absolute top-0 bottom-0 w-px bg-mist/70" style={{ left: ax(ov) }} />}
                          <div className="absolute top-1/2 w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 ring-2 ring-ridge" style={{ left: ax(r.auroc), background: c }} />
                        </div>
                        <span className="w-10 text-right">{fmt(r.auroc, 3)}</span>
                      </div>
                    </td>
                    <td className="py-1.5 pl-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-ridge2"><div className="h-full rounded-r-[4px]" style={{ width: `${100 * r.sens}%`, background: c }} /></div>
                        <span className="w-8 text-right">{fmt(100 * r.sens, 0)}%</span>
                      </div>
                    </td>
                    <td className="py-1.5 pl-2 text-right">{r.ppv === null ? "—" : `${fmt(100 * r.ppv, 1)}%`}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
