import type { ReactNode } from "react";
import { useHref, useNavigate } from "react-router-dom";
import { HeroUIProvider } from "@heroui/react";
import { MotionConfig, useReducedMotion } from "framer-motion";

/** HeroUI + Framer Motion context. Must sit inside <BrowserRouter> so HeroUI links / tabs with `href` use client routing.
 * Reduced motion: Framer animations respect the OS setting, and HeroUI's own CSS animations are disabled. */
export function Providers({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  return (
    <HeroUIProvider navigate={(path) => navigate(path)} useHref={useHref} locale="en-GB" reducedMotion="user" disableAnimation={!!reduce}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </HeroUIProvider>
  );
}
