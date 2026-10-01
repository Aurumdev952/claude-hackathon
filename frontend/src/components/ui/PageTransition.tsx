import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { pageVariants } from "@/lib/motion";

/** Route fade / slide-up (plan §A2). Keyed by pathname only, so filter changes in the query string never replay it.
 * Enter-only (no exit hold), so lazy routes and e2e timings are unaffected. */
export function PageTransition({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { pathname } = useLocation();
  const reduce = useReducedMotion();
  const key = pathname.startsWith("/doctor/case/") ? "/doctor/case" : pathname;
  return (
    <motion.div key={key} className={className} variants={pageVariants} initial={reduce ? false : "initial"} animate="enter">
      {children}
    </motion.div>
  );
}
