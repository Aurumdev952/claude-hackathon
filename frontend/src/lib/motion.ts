/** Motion primitives (plan §A2). Every animated component goes through these so the feel stays consistent; Framer's
 * MotionConfig reducedMotion="user" (Providers) turns transforms off for users who prefer reduced motion. */
import type { TargetAndTransition, Transition, Variants } from "framer-motion";
import { useReducedMotion } from "framer-motion";
export { useReducedMotion };

/** Apple-like ease-out (fast start, long settle). */
export const EASE = [0.22, 1, 0.36, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;
/** Default UI spring (tabs, markers, modals). */
export const SPRING: Transition = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 };
/** Softer spring for large surfaces (modals, floating cards). */
export const SPRING_SOFT: Transition = { type: "spring", stiffness: 240, damping: 28, mass: 0.9 };

/** Default stagger between cards on page load (design v3: one page-load moment, 40 ms apart). */
export const CARD_STAGGER = 0.04;
/** Container variants that stagger their children's `hidden -> show` transition. */
export const stagger = (step = CARD_STAGGER, delay = 0.02): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step, delayChildren: delay } },
});

/** Card entrance: a plain fade (no slide, no scale), the page's one load moment. */
export const cardEnter: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.45, ease: EASE } },
};
/** Smaller entrance for list rows / chips: fade only. */
export const itemEnter: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE } },
};
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE } },
};
/** Route transition: a short fade (the cards inside carry the staggered moment). */
export const pageVariants: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.25, ease: EASE } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_IN_OUT } },
};
/** v2 hover lift, retired in v3 (cards no longer move on hover). Kept as a no-op so old imports compile. */
export const hoverLift = {} as const;
export const tapPress = { scale: 0.99 } as const;

/** Modal content (HeroUI `motionProps`): quick fade + scale from 0.98. */
export const modalMotion = {
  variants: {
    initial: { opacity: 0, scale: 0.98 },
    enter: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: EASE } },
    exit: { opacity: 0, scale: 0.98, transition: { duration: 0.14, ease: EASE_IN_OUT } },
  },
} as const;

/** Hover / tap gesture props that switch off under prefers-reduced-motion (gestures would otherwise still jump).
 * Design v3 retires hover lift: a vertical `y` in the hover target is dropped, so surfaces never float on hover. */
export function useGesture(hover: TargetAndTransition, tap?: TargetAndTransition) {
  const reduce = useReducedMotion();
  if (reduce) return {};
  const { y: _lift, ...rest } = hover as TargetAndTransition & { y?: unknown };
  const h = Object.keys(rest).length ? rest : undefined;
  return { ...(h ? { whileHover: h } : {}), ...(tap ? { whileTap: tap } : {}) };
}
