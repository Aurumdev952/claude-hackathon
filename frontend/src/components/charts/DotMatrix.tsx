import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/motion";

export type DotMatrixProps = {
  /** One value per column (counts, oldest first). null = no data (drawn as an empty baseline dot). */
  values: (number | null | undefined)[];
  /** Column labels (years, months, weeks …) for the tooltip and the hidden table. */
  labels?: string[];
  /** Accessible name; the chart is role="img". */
  ariaLabel: string;
  /** Dots per full column (default 8). */
  rows?: number;
  /** Value that fills a column (default max of values). */
  max?: number;
  /** Column to emphasise (default the last one); null for none. */
  highlight?: number | null;
  /** Emphasis hue: sky (data, default) or signal (attention, e.g. a rising count). */
  tone?: "sky" | "signal";
  /** Number formatter for tooltip / table. */
  format?: (n: number) => string;
  /** Unit shown after the value in the tooltip and table header ("cases"). */
  unit?: string;
  /** Axis captions under the matrix: true = first / middle / last label, or custom nodes. */
  ticks?: boolean | ReactNode[];
  /** Maximum height of the dot area in px (default 132). Dots size to fill the width, then shrink to fit this height. */
  height?: number;
  className?: string;
};

/** Dot-matrix columns (the reference "Training" card): each column is a stack of circles whose count encodes the value,
 * tinted by level in the data hue, with the latest column emphasised. Hover/focus a column for its value; a hidden table
 * carries the same numbers for screen readers. */
export function DotMatrix({ values, labels, ariaLabel, rows = 8, max, highlight, tone = "sky", format = (n) => n.toLocaleString("en-US"),
  unit, ticks = true, height = 132, className = "" }: DotMatrixProps) {
  const reduce = useReducedMotion();
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [values.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = values.length;
  const fin = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const top = max ?? Math.max(1, ...fin);
  const hi = highlight === undefined ? n - 1 : highlight;
  if (!n) return <div style={{ height }} className={className} />;
  // pixel size of one column step: fill the width, but never exceed the height budget
  const px = width ? Math.min(width / n, (height + 4) / rows) : 0;
  const drawnW = px * n, drawnH = px * rows;

  // geometry in viewBox units: dot diameter 10, gap 4
  const D = 10, G = 4, step = D + G;
  const W = n * step - G, H = rows * step - G;
  const hueVar = tone === "signal" ? "--signal" : "--sky";
  const col = (v: number | null | undefined) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { full: 0, frac: 0, level: 0 };
    const x = Math.max(0, Math.min(1, v / top)) * rows;
    const full = Math.floor(x);
    return { full, frac: x - full, level: v / top };
  };
  const label = (i: number) => labels?.[i] ?? String(i + 1);
  const tickNodes: ReactNode[] | null = Array.isArray(ticks) ? ticks : ticks && labels?.length
    ? [labels[0], n > 2 ? labels[Math.floor((n - 1) / 2)] : null, labels[n - 1]].filter((x) => x !== null) : null;

  return (
    <div ref={box} className={`relative w-full ${className}`}>
      <div className="relative" style={{ width: drawnW || "100%", height: drawnH || height }} role="img" aria-label={ariaLabel} aria-describedby={`${id}-t`}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMax meet" className="w-full h-full overflow-visible" aria-hidden>
          {values.map((v, i) => {
            const c = col(v);
            const emph = i === hi || i === hover;
            // tint by level: low columns pale, high columns stronger; the emphasised column at full strength
            const a = emph ? 1 : 0.35 + 0.45 * Math.min(1, c.level);
            const cx = i * step + D / 2;
            const dots: ReactNode[] = [];
            // baseline dot so empty columns keep the grid legible
            if (c.full === 0 && c.frac < 0.5) dots.push(<circle key="b" cx={cx} cy={H - D / 2} r={D / 2} fill="rgb(var(--sky-soft))" />);
            for (let r = 0; r < c.full; r++) dots.push(<circle key={r} cx={cx} cy={H - D / 2 - r * step} r={D / 2} fill={`rgb(var(${hueVar}) / ${a})`} />);
            if (c.frac >= 0.5 && c.full < rows) dots.push(<circle key="f" cx={cx} cy={H - D / 2 - c.full * step} r={D / 2} fill={`rgb(var(${hueVar}) / ${Math.max(0.22, a * 0.45)})`} />);
            return (
              <motion.g key={i} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
                        transition={{ duration: 0.35, ease: EASE, delay: reduce ? 0 : Math.min(i * 0.025, 0.6) }}>
                {dots}
              </motion.g>
            );
          })}
        </svg>
        {/* hit targets (taller and wider than the dots) + tooltip */}
        <div className="absolute inset-0 flex" onMouseLeave={() => setHover(null)}>
          {values.map((v, i) => (
            <div key={i} className="flex-1 h-full" onMouseEnter={() => setHover(i)} aria-hidden />
          ))}
        </div>
        {hover !== null && (
          <div className="absolute z-10 -translate-x-1/2 -translate-y-full pointer-events-none rounded-[12px] bg-surface shadow-float dark:border dark:border-hairline px-3 py-1.5 text-micro text-muted whitespace-nowrap"
               style={{ left: `${((hover + 0.5) / n) * 100}%`, top: -6 }} role="status">
            <span className="text-ink">{label(hover)}</span>{" "}
            <span className="text-ink font-semibold tabular">{typeof values[hover] === "number" ? format(values[hover] as number) : "no data"}</span>
            {unit && typeof values[hover] === "number" ? ` ${unit}` : ""}
          </div>
        )}
      </div>
      {tickNodes && tickNodes.length > 0 && (
        <div className="flex justify-between mt-3 text-micro text-muted tabular" style={{ width: drawnW || "100%" }} aria-hidden>
          {tickNodes.map((t, i) => <span key={i}>{t}</span>)}
        </div>
      )}
      <table id={`${id}-t`} className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead><tr><th scope="col">Period</th><th scope="col">{unit ? `Value (${unit})` : "Value"}</th></tr></thead>
        <tbody>
          {values.map((v, i) => <tr key={i}><th scope="row">{label(i)}</th><td>{typeof v === "number" ? format(v) : "no data"}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
