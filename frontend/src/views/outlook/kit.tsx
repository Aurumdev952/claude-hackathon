/** Small shared bits for the Outlook and the Follow-up programme views. */
import { type ReactNode, useEffect, useState } from "react";
import { InfoHint } from "@/components/ui";

/** Matches a max-width media query (narrow layouts move or drop decoration). */
export function useNarrow(px = 640) {
  const q = `(max-width: ${px - 1}px)`;
  const [n, setN] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const h = () => setN(m.matches);
    m.addEventListener?.("change", h);
    return () => m.removeEventListener?.("change", h);
  }, [q]);
  return n;
}

/** Quiet grey pill that labels an estimate's nature ("Associational, synthetic"), with the reasons behind ⓘ. */
export function NatureTag({ children, info, title }: { children: ReactNode; info?: ReactNode; title?: string }) {
  return (
    <span className="inline-flex items-center h-7 pl-3 pr-0.5 rounded-full bg-tile text-micro text-muted whitespace-nowrap">
      {children}
      {info ? <InfoHint content={info} title={title} size={13} label={`About: ${typeof children === "string" ? children : "this estimate"}`} className="!w-6 !h-6 !min-w-6" /> : <span className="w-2.5" />}
    </span>
  );
}

/** A count that may be suppressed (n < 5 -> "<5"). */
export function Count({ n, label, className = "" }: { n: number | null | undefined; label?: string | null; className?: string }) {
  if (n === null || n === undefined) return <span className={`tabular text-muted ${className}`} title="Fewer than 5: suppressed to protect privacy">{label ?? "<5"}</span>;
  return <span className={`tabular ${className}`}>{n.toLocaleString("en-GB")}</span>;
}

/** Thin labelled legend swatches for HTML legends. */
export function Swatch({ kind, color, label }: { kind: "line" | "dash" | "dot-line" | "band" | "dot"; color: string; label: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-micro text-muted whitespace-nowrap">
      {kind === "line" && <span className="inline-block w-4 border-t-2" style={{ borderColor: color }} aria-hidden />}
      {kind === "dash" && <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: color }} aria-hidden />}
      {kind === "dot-line" && <span className="inline-block w-4 border-t-2 border-dotted opacity-70" style={{ borderColor: color }} aria-hidden />}
      {kind === "band" && <span className="inline-block w-3.5 h-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />}
      {kind === "dot" && <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} aria-hidden />}
      {label}
    </span>
  );
}

export const pctFmt = (v: number | null | undefined, nd = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(100 * v).toFixed(nd)}%`);
