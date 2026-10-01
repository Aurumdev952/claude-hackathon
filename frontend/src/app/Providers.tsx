import type { ReactNode } from "react";
import { useHref, useNavigate } from "react-router-dom";
import { HeroUIProvider } from "@heroui/react";
import { MotionConfig, MotionGlobalConfig, useReducedMotion } from "framer-motion";

/** HeroUI + Framer Motion context. Must sit inside <BrowserRouter> so HeroUI links / tabs with `href` use client routing.
 * Reduced motion: every Framer animation (ours and HeroUI's) jumps straight to its end state, and HeroUI's own CSS
 * animations are disabled; CSS keyframes are neutralised in styles.css. */
export function Providers({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  // set during render so the very first frame is already static
  MotionGlobalConfig.skipAnimations = !!reduce;
  return (
    <HeroUIProvider navigate={(path) => navigate(path)} useHref={useHref} locale="en-GB" reducedMotion="user" disableAnimation={!!reduce}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </HeroUIProvider>
  );
}
