import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { date, fmt, monthYear } from "@/lib/format";
import type { CaseCondition, CaseData, Measure } from "./types";
import { useCaseUI } from "./store";
import { MEASURE_ORGANS } from "./measureOrgans";
import { labelOf } from "@/components/three/body/util";

const CAT_LABEL: Record<string, string> = { diagnosis: "Dx", symptom: "Symptom", lab: "Lab", procedure: "Finding" };

/** Severity bar: glow ramp of the 3D body, so the list and the organ glow read the same. Value also printed. */
function SevBar({ v }: { v: number }) {
  return (
    <div className="flex items-center gap-1.5 w-[72px] shrink-0" aria-label={`severity ${Math.round(100 * v)} of 100`}>
      <div className="h-1.5 flex-1 rounded-full bg-ridge2 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.max(4, 100 * v)}%`, background: `linear-gradient(90deg,#f2a541,${v > 0.6 ? "#ff4b2b" : "#f07a3a"})` }} />
      </div>
      <span className="tabular text-[10px] text-fog w-5 text-right">{Math.round(100 * v)}</span>
    </div>
  );
}

/** Conditions grouped by organ (two-way linked with the 3D body), then vitals & labs, medicines and endoscopy. */
export function ConditionsPanel({ data }: { data: CaseData }) {
  const set = useCaseUI((s) => s.set);
  const hovered = useCaseUI((s) => s.hoveredOrgan);
  const selected = useCaseUI((s) => s.selectedOrgan);
  const replayT = useCaseUI((s) => s.replayT);
  const groups = useMemo(() => {
    const byOrgan = new Map<string, CaseCondition[]>();
    for (const c of data.conditions) {
      const primary = c.organ_ids[0];
      if (!byOrgan.has(primary)) byOrgan.set(primary, []);
      byOrgan.get(primary)!.push(c);
    }
    const score = Object.fromEntries(data.organs.map((o) => [o.organ_id, o.score]));
    return [...byOrgan.entries()].map(([organ, cs]) => ({ organ, score: score[organ] ?? 0, cs }))
      .sort((a, b) => b.score - a.score);
  }, [data]);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const active = selected ?? hovered;
  useEffect(() => {
    if (active && refs.current[active]) refs.current[active]!.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const [showOld, setShowOld] = useState(false);
  const scoped = selected ? groups.filter((g) => g.cs.some((c) => c.organ_ids.includes(selected))) : groups;
  // conditions that have decayed to ~0 (old, one-off) fold away so the list leads with what matters now
  const visibleGroups = showOld || selected ? scoped : scoped.filter((g) => g.score >= 0.05);
  const hiddenCount = scoped.length - visibleGroups.length;
  const focus = (organs: string[] | null, label: string | null = null) => set({ focusOrgans: organs, focusLabel: label });

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <section className="panel p-3" aria-label="Conditions by organ">
        <div className="flex items-center justify-between mb-2">
          <h2 className="panel-title">Conditions by organ</h2>
          {selected && <button className="text-[11px] text-kivu hover:underline" onClick={() => set({ selectedOrgan: null })}>Show all organs</button>}
        </div>
        {!groups.length && <div className="text-xs text-fog">No organ-linked symptoms, diagnoses or abnormal labs on record.</div>}
        <div className="flex flex-col gap-2">
          {visibleGroups.map((g) => (
            <div key={g.organ} ref={(el) => { refs.current[g.organ] = el; }}
                 className={`rounded-lg border transition ${active === g.organ ? "border-sorghum/70 bg-sorghum/10" : "border-line/50"}`}>
              <button className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
                      onMouseEnter={() => focus([g.organ], labelOf(g.organ))} onMouseLeave={() => focus(null)}
                      onFocus={() => focus([g.organ], labelOf(g.organ))} onBlur={() => focus(null)}
                      onClick={() => set({ selectedOrgan: selected === g.organ ? null : g.organ })} aria-pressed={selected === g.organ}>
                <span className="text-[13px] font-semibold flex-1">{labelOf(g.organ)}</span>
                <SevBar v={g.score} />
              </button>
              <ul className="pb-1.5">
                {g.cs.map((c) => {
                  const future = replayT !== null && Date.parse(c.first_ts) > replayT;
                  return (
                    <li key={`${c.category}-${c.concept_id}`}>
                      <div tabIndex={0} className={`flex items-center gap-2 px-2.5 py-1 text-xs hover:bg-ridge2/60 focus:bg-ridge2/60 outline-none ${future ? "opacity-35" : ""}`}
                           onMouseEnter={() => focus(c.organ_ids, c.label)} onMouseLeave={() => focus(null)}
                           onFocus={() => focus(c.organ_ids, c.label)} onBlur={() => focus(null)}
                           title={`${c.label}: ${c.count}x, ${date(c.first_ts)} - ${date(c.last_ts)}`}>
                        <span className="chip bg-ridge2 text-fog !px-1.5 !py-0 !text-[9.5px] w-[50px] justify-center">{CAT_LABEL[c.category]}</span>
                        <span className="flex-1 truncate">{c.label}{c.certainty === "PROVISIONAL" ? <span className="text-fog"> (prov.)</span> : null}</span>
                        {c.is_alarm && <AlertTriangle size={11} className="text-sorghum shrink-0" aria-label="abnormal / alarm" />}
                        <span className="text-[10px] text-fog tabular w-[22px] text-right">{c.count}×</span>
                        <span className="text-[10px] text-fog tabular w-[58px] text-right">{monthYear(c.last_ts)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {hiddenCount > 0 && <button className="text-[11px] text-kivu hover:underline self-start" onClick={() => setShowOld(true)}>Show {hiddenCount} older / resolved organ group{hiddenCount > 1 ? "s" : ""}</button>}
        </div>
      </section>

      <section className="panel p-3" aria-label="Vitals and labs">
        <h2 className="panel-title mb-2">Vitals & labs</h2>
        <MeasureTable rows={data.vitals} onFocus={focus} />
        <div className="h-2" />
        <MeasureTable rows={data.labs} onFocus={focus} />
      </section>

      <section className="panel p-3 text-xs" aria-label="Medicines and endoscopy">
        <h2 className="panel-title mb-2">Medicines & procedures</h2>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Kv k="PPI courses (24 m)" v={data.medications.ppi_courses_24m} warn={data.medications.ppi_courses_24m >= 3} />
          <Kv k="H. pylori eradication" v={data.medications.eradication_courses} />
          <Kv k="Iron therapy" v={data.medications.iron} />
          <Kv k="Antimalarials" v={data.medications.antimalarial} />
          <Kv k="Anthelminthics" v={data.medications.anthelminthic} />
        </div>
        <div className="mt-2.5">
          <div className="text-[10px] uppercase tracking-wider text-fog mb-1">Endoscopy</div>
          {data.endoscopies.length ? data.endoscopies.map((e, i) => (
            <div key={i} className="flex gap-2"><span className="tabular text-fog w-[84px]">{date(e.ts)}</span>
              <span className="flex-1">{e.impression}{e.location ? ` · ${e.location.toLowerCase()}` : ""}{e.size_mm ? ` · ${e.size_mm} mm` : ""}</span></div>
          )) : <div className="text-fog">Never scoped.</div>}
        </div>
      </section>
    </div>
  );
}

function Kv({ k, v, warn }: { k: string; v: number; warn?: boolean }) {
  return <div className="flex justify-between gap-2"><span className="text-fog">{k}</span><span className={`tabular font-semibold ${warn ? "text-sorghum" : ""}`}>{v}</span></div>;
}

function MeasureTable({ rows, onFocus }: { rows: Measure[]; onFocus: (o: string[] | null, l?: string | null) => void }) {
  if (!rows.length) return <div className="text-xs text-fog">None recorded.</div>;
  return (
    <table className="w-full text-xs tabular">
      <tbody>
        {rows.map((m) => (
          <tr key={m.concept_id} tabIndex={0} className="hover:bg-ridge2/60 focus:bg-ridge2/60 outline-none"
              onMouseEnter={() => onFocus(MEASURE_ORGANS[m.concept_id] ?? null, m.name)} onMouseLeave={() => onFocus(null)}
              onFocus={() => onFocus(MEASURE_ORGANS[m.concept_id] ?? null, m.name)} onBlur={() => onFocus(null)}>
            <td className="py-1 pr-2 whitespace-nowrap">{m.name}</td>
            <td className={`py-1 pr-1 text-right font-semibold whitespace-nowrap ${m.abnormal ? "text-sorghum" : ""}`}>
              {typeof m.latest === "number" ? fmt(m.latest, m.latest >= 100 ? 0 : 1) : String(m.latest).replace(/_/g, " ").toLowerCase()}
              {m.unit ? <span className="text-fog font-normal"> {m.unit}</span> : null}
              {m.abnormal && <AlertTriangle size={10} className="inline ml-1 -mt-0.5" aria-label="abnormal" />}
            </td>
            <td className="py-1 w-[64px]">{m.series.length > 1 ? <Spark s={m.series} /> : null}</td>
            <td className="py-1 pl-1 text-right text-[10px] text-fog whitespace-nowrap w-[52px]"><Trend pct={m.change_pct_12m ?? null} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Trend({ pct }: { pct: number | null }) {
  if (pct === null) return <span>—</span>;
  const Icon = Math.abs(pct) < 2 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className="inline-flex items-center gap-0.5" title="change over the last 12 months"><Icon size={11} />{pct > 0 ? "+" : ""}{pct.toFixed(0)}%</span>;
}

/** 64x18 sparkline; abnormal points marked. Single series -> no legend (row label names it). */
function Spark({ s }: { s: { ts: string; value: number; abnormal: boolean }[] }) {
  const W = 64, H = 18;
  const xs = s.map((p) => Date.parse(p.ts)), ys = s.map((p) => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = (t: number) => 2 + ((t - x0) / Math.max(1, x1 - x0)) * (W - 4);
  const Y = (v: number) => H - 2 - ((v - y0) / Math.max(1e-9, y1 - y0)) * (H - 4);
  const d = s.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
  return (
    <svg width={W} height={H} aria-hidden className="block">
      <path d={d} fill="none" stroke="rgb(var(--fog))" strokeWidth={1.25} />
      {s.map((p, i) => p.abnormal ? <circle key={i} cx={X(xs[i])} cy={Y(p.value)} r={1.8} fill="#f2a541" /> : null)}
      <circle cx={X(xs[xs.length - 1])} cy={Y(ys[ys.length - 1])} r={2.2} fill="rgb(var(--mist))" />
    </svg>
  );
}
