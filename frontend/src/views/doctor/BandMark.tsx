/** Quiet status mark for lists (design v3 "orange discipline"): a small shape + sentence-case text, never a solid pill.
 * high = solid signal dot, medium = signal ring, low = small green dot, none = dashed grey ring. Text always present. */
export type MarkLevel = "high" | "medium" | "low" | "none";

export const levelOf = (band: string | null | undefined): MarkLevel =>
  band === "HIGH" ? "high" : band === "MEDIUM" ? "medium" : band === "LOW" ? "low" : "none";

const TEXT: Record<MarkLevel, string> = { high: "High", medium: "Medium", low: "Low", none: "Not scored" };

export function Dot({ level, className = "" }: { level: MarkLevel; className?: string }) {
  const shape = {
    high: "bg-signal",
    medium: "border-[1.5px] border-signal",
    low: "bg-success",
    none: "border border-dashed border-faint",
  }[level];
  return <span aria-hidden className={`inline-block w-[7px] h-[7px] rounded-full shrink-0 ${shape} ${className}`} />;
}

/** Dot + label ("● High"). `label` overrides the text (e.g. "Critical"). */
export function BandMark({ band, level, label, className = "", labelClassName = "" }: { band?: string | null; level?: MarkLevel; label?: string; className?: string; labelClassName?: string }) {
  const l = level ?? levelOf(band);
  return (
    <span className={`inline-flex items-center gap-1.5 text-micro whitespace-nowrap ${l === "high" ? "text-ink" : "text-muted"} ${className}`}>
      <Dot level={l} /><span className={labelClassName}>{label ?? TEXT[l]}</span>
    </span>
  );
}
