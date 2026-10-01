import { Skeleton as HSkeleton } from "@heroui/react";

const bone = "rounded-lg before:!duration-[1.6s] bg-fg/[0.06] dark:bg-fg/[0.08]";

export type SkeletonProps = {
  variant?: "chart" | "metric" | "list" | "text" | "card";
  /** Height in px (chart / card). */
  h?: number;
  rows?: number;
  className?: string;
  /** Screen-reader label. */
  label?: string;
};

/** Shimmer placeholders (HeroUI Skeleton) for chart / metric / list / text / card (plan §A2). */
export function Skeleton({ variant = "chart", h = 220, rows = 4, className = "", label = "Loading" }: SkeletonProps) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={`w-full ${className}`}>
      <span className="sr-only">{label}…</span>
      {variant === "chart" && (
        <div className="flex flex-col gap-3" style={{ height: h }} aria-hidden>
          <div className="flex-1 flex items-end gap-2 px-1">
            {[46, 62, 38, 74, 58, 86, 66, 92, 70, 80].map((p, i) => (
              <HSkeleton key={i} className={`${bone} flex-1 !rounded-md`} style={{ height: `${p}%` }} />
            ))}
          </div>
          <HSkeleton className={`${bone} h-2.5 w-full`} />
        </div>
      )}
      {variant === "metric" && (
        <div className="flex flex-col gap-2.5" aria-hidden>
          <HSkeleton className={`${bone} h-3 w-24`} />
          <HSkeleton className={`${bone} h-8 w-32`} />
          <HSkeleton className={`${bone} h-2 w-full`} />
        </div>
      )}
      {variant === "list" && (
        <div className="flex flex-col gap-2.5" aria-hidden>
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <HSkeleton className={`${bone} w-9 h-9 !rounded-full shrink-0`} />
              <div className="flex-1 flex flex-col gap-1.5">
                <HSkeleton className={`${bone} h-3`} style={{ width: `${70 - (i % 3) * 12}%` }} />
                <HSkeleton className={`${bone} h-2.5 w-2/5`} />
              </div>
            </div>
          ))}
        </div>
      )}
      {variant === "text" && (
        <div className="flex flex-col gap-2" aria-hidden>
          {Array.from({ length: rows }).map((_, i) => <HSkeleton key={i} className={`${bone} h-3`} style={{ width: `${92 - (i % 4) * 14}%` }} />)}
        </div>
      )}
      {variant === "card" && <HSkeleton className={`${bone} w-full !rounded-card`} style={{ height: h }} aria-hidden />}
    </div>
  );
}

/** Drop-in replacement for the old `Loading` (same props): a chart-shaped shimmer of height `h`. */
export function Loading({ h = 220, label = "Loading" }: { h?: number; label?: string }) {
  return <Skeleton variant="chart" h={h} label={label} />;
}
