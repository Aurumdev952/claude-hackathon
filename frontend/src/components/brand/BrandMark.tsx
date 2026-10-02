import { useId } from "react";

/** The Early Signals mark: two stacked rising signal lines, secondary green (#98D59B) at the lower left to primary
 * green (#4F6F51) at the upper right (lifted on dark surfaces via --mark-from / --mark-to in styles.css). The geometry
 * is shared with the splash screen in index.html and with the favicon / PWA icons (scripts/pwa-icons.cjs), so keep the
 * three in step. */
export const MARK_VIEWBOX = "0 0 100 82";
export const MARK_PATHS = ["M6 45 L37 15 L50 28 L71 6 L94 29", "M6 76 L37 46 L50 58 L71 37 L94 60"] as const;
export const BRAND = { primary: "#4F6F51", secondary: "#98D59B" } as const;

export function BrandMark({ size = 28, className = "", title }: { size?: number; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox={MARK_VIEWBOX} width={size} height={(size * 82) / 100} className={className}
         role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={`es-mark-${id}`} gradientUnits="userSpaceOnUse" x1="4" y1="78" x2="96" y2="4">
          <stop offset="0" style={{ stopColor: `var(--mark-from, ${BRAND.secondary})` }} />
          <stop offset="1" style={{ stopColor: `var(--mark-to, ${BRAND.primary})` }} />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#es-mark-${id})`} strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round">
        {MARK_PATHS.map((d) => <path key={d} d={d} />)}
      </g>
    </svg>
  );
}

/** Mark + wordmark ("Early" regular, "Signals" semibold), as in the brand artwork. */
export function Logo({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 shrink-0" aria-label="Early Signals">
      <BrandMark size={34} />
      {wordmark && (
        <span className="hidden sm:block text-[19px] leading-6 tracking-[-0.01em] text-ink whitespace-nowrap" aria-hidden>
          <span className="font-normal">Early</span> <span className="font-semibold">Signals</span>
        </span>
      )}
    </div>
  );
}

/** App icon tile (phone notification previews): the mark on a white rounded square with a hairline edge. */
export function AppIcon({ size = 20 }: { size?: number }) {
  return (
    <span className="rounded-[6px] bg-white border border-hairline grid place-items-center shrink-0" aria-hidden
          style={{ width: size, height: size, ["--mark-from" as string]: BRAND.secondary, ["--mark-to" as string]: BRAND.primary }}>
      <BrandMark size={size * 0.72} />
    </span>
  );
}
