import { type CSSProperties, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cardEnter, stagger } from "@/lib/motion";
import { MotionScopeContext } from "./motionScope";

type Bp = "base" | "sm" | "md" | "lg" | "xl" | "2xl";
/** Column span: a number (all breakpoints from md up; full width below md) or per-breakpoint spans. */
export type Span = number | Partial<Record<Bp, number>>;

/* Literal class lookup tables so Tailwind's content scan sees every class. */
const COL: Record<Bp, string[]> = {
  "base": ["col-span-1", "col-span-2", "col-span-3", "col-span-4", "col-span-5", "col-span-6", "col-span-7", "col-span-8", "col-span-9", "col-span-10", "col-span-11", "col-span-12"],
  "sm": ["sm:col-span-1", "sm:col-span-2", "sm:col-span-3", "sm:col-span-4", "sm:col-span-5", "sm:col-span-6", "sm:col-span-7", "sm:col-span-8", "sm:col-span-9", "sm:col-span-10", "sm:col-span-11", "sm:col-span-12"],
  "md": ["md:col-span-1", "md:col-span-2", "md:col-span-3", "md:col-span-4", "md:col-span-5", "md:col-span-6", "md:col-span-7", "md:col-span-8", "md:col-span-9", "md:col-span-10", "md:col-span-11", "md:col-span-12"],
  "lg": ["lg:col-span-1", "lg:col-span-2", "lg:col-span-3", "lg:col-span-4", "lg:col-span-5", "lg:col-span-6", "lg:col-span-7", "lg:col-span-8", "lg:col-span-9", "lg:col-span-10", "lg:col-span-11", "lg:col-span-12"],
  "xl": ["xl:col-span-1", "xl:col-span-2", "xl:col-span-3", "xl:col-span-4", "xl:col-span-5", "xl:col-span-6", "xl:col-span-7", "xl:col-span-8", "xl:col-span-9", "xl:col-span-10", "xl:col-span-11", "xl:col-span-12"],
  "2xl": ["2xl:col-span-1", "2xl:col-span-2", "2xl:col-span-3", "2xl:col-span-4", "2xl:col-span-5", "2xl:col-span-6", "2xl:col-span-7", "2xl:col-span-8", "2xl:col-span-9", "2xl:col-span-10", "2xl:col-span-11", "2xl:col-span-12"],
};
const ROW: Record<Bp, string[]> = {
  "base": ["row-span-1", "row-span-2", "row-span-3", "row-span-4", "row-span-5", "row-span-6"],
  "sm": ["sm:row-span-1", "sm:row-span-2", "sm:row-span-3", "sm:row-span-4", "sm:row-span-5", "sm:row-span-6"],
  "md": ["md:row-span-1", "md:row-span-2", "md:row-span-3", "md:row-span-4", "md:row-span-5", "md:row-span-6"],
  "lg": ["lg:row-span-1", "lg:row-span-2", "lg:row-span-3", "lg:row-span-4", "lg:row-span-5", "lg:row-span-6"],
  "xl": ["xl:row-span-1", "xl:row-span-2", "xl:row-span-3", "xl:row-span-4", "xl:row-span-5", "xl:row-span-6"],
  "2xl": ["2xl:row-span-1", "2xl:row-span-2", "2xl:row-span-3", "2xl:row-span-4", "2xl:row-span-5", "2xl:row-span-6"],
};

export function spanClasses(span: Span | undefined, rowSpan?: Span): string {
  const out: string[] = [];
  const s: Partial<Record<Bp, number>> = span === undefined ? { base: 12 } : typeof span === "number" ? { base: 12, md: span } : { base: 12, ...span };
  (Object.keys(s) as Bp[]).forEach((bp) => { const n = s[bp]; if (n) out.push(COL[bp][Math.max(1, Math.min(12, n)) - 1]); });
  if (rowSpan !== undefined) {
    const r: Partial<Record<Bp, number>> = typeof rowSpan === "number" ? { base: rowSpan } : rowSpan;
    (Object.keys(r) as Bp[]).forEach((bp) => { const n = r[bp]; if (n) out.push(ROW[bp][Math.max(1, Math.min(6, n)) - 1]); });
  }
  return out.join(" ");
}

export type BentoGridProps = {
  children: ReactNode;
  className?: string;
  /** Seconds between children entrances. */
  step?: number;
  as?: "div" | "section" | "ul";
  role?: string;
  "aria-label"?: string;
  style?: CSSProperties;
};

/** 12-column bento grid (plan §A2) with a staggered entrance for its GridItems / Cards. */
export function BentoGrid({ children, className = "", step = 0.06, as = "div", role, style, ...rest }: BentoGridProps) {
  const reduce = useReducedMotion();
  const M = motion[as] as typeof motion.div;
  return (
    <MotionScopeContext.Provider value="grid">
      <M className={`grid grid-cols-12 gap-4 min-w-0 ${className}`} variants={stagger(step)} initial={reduce ? false : "hidden"} animate="show"
         role={role} aria-label={rest["aria-label"]} style={style}>
        {children}
      </M>
    </MotionScopeContext.Provider>
  );
}

export type GridItemProps = {
  span?: Span;
  rowSpan?: Span;
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "section";
  role?: string;
  "aria-label"?: string;
};

/** One bento cell; animates as part of the grid's stagger, and children (Cards) skip their own entrance. */
export function GridItem({ span, rowSpan, children, className = "", as = "div", role, ...rest }: GridItemProps) {
  const M = motion[as] as typeof motion.div;
  return (
    <M variants={cardEnter} className={`min-w-0 flex flex-col [&>*]:flex-1 ${spanClasses(span, rowSpan)} ${className}`} role={role} aria-label={rest["aria-label"]}>
      <MotionScopeContext.Provider value="item">{children}</MotionScopeContext.Provider>
    </M>
  );
}

/** Plain (non-animated) helper for computing span classes on custom elements. */
export const gridSpan = (span?: Span, rowSpan?: Span) => spanClasses(span, rowSpan);
