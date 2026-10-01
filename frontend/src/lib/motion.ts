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

/** Container variants that stagger their children's `hidden -> show` transition. */
export const stagger = (step = 0.05, delay = 0.02): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step, delayChildren: delay } },
});

/** Card entrance: fade up with a hint of scale. */
export const cardEnter: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.985 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: EASE } },
};
/** Smaller entrance for list rows / chips. */
export const itemEnter: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } },
};
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE } },
};
/** Route transition. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.15, ease: EASE_IN_OUT } },
};
/** Hover lift for clickable cards. */
export const hoverLift = { y: -3, transition: { type: "spring", stiffness: 420, damping: 30 } } as const;
export const tapPress = { scale: 0.985 } as const;

/** Modal content (HeroUI `motionProps`): spring scale-in from slightly below. */
export const modalMotion = {
  variants: {
    enter: { opacity: 1, y: 0, scale: 1, transition: { ...SPRING_SOFT } },
    exit: { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.16, ease: EASE_IN_OUT } },
  },
} as const;

/** Hover / tap gesture props that switch off under prefers-reduced-motion (gestures would otherwise still jump). */
export function useGesture(hover: TargetAndTransition, tap?: TargetAndTransition) {
  const reduce = useReducedMotion();
  return reduce ? {} : { whileHover: hover, ...(tap ? { whileTap: tap } : {}) };
}
