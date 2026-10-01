import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { SPRING_SOFT } from "@/lib/motion";

export type FloatingGlassCardProps = {
  open?: boolean;
  /** Big number in front of the title ("3 New insights"). */
  count?: number;
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  cta?: { label: ReactNode; onPress: () => void; icon?: ReactNode };
  onDismiss?: () => void;
  dismissLabel?: string;
  position?: "bottom-left" | "bottom-right" | "none";
  /** Landmark role and accessible name. */
  role?: string;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
};

const POS = { "bottom-left": "fixed left-5 bottom-5 z-40", "bottom-right": "fixed right-5 bottom-5 z-40", none: "" } as const;

/** Floating frosted card (plan §A2, reference "3 New insights"): gradient CTA + Dismiss, springs in and out. */
export function FloatingGlassCard({ open = true, count, title, body, icon, cta, onDismiss, dismissLabel = "Dismiss", position = "bottom-left", role, ariaLabel, className = "", children }: FloatingGlassCardProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.aside role={role} aria-label={ariaLabel}
                      initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.97 }}
                      transition={SPRING_SOFT}
                      className={`${POS[position]} w-[300px] max-w-[calc(100vw-2.5rem)] rounded-[20px] glass shadow-float p-4 ${className}`}>
          <div className="flex items-start gap-3">
            {icon && <span className="w-9 h-9 shrink-0 rounded-tile bg-accent-soft text-accent grid place-items-center" aria-hidden>{icon}</span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                {count !== undefined && <span className="text-[34px] leading-none font-semibold tracking-tight text-fg tabular">{count}</span>}
                <span className="text-title text-fg">{title}</span>
              </div>
              {body && <div className="text-label text-fg-muted mt-1.5 leading-snug">{body}</div>}
            </div>
            {onDismiss && (
              <button type="button" onClick={onDismiss} aria-label={ariaLabel ? `Close ${ariaLabel}` : "Close"}
                      className="w-7 h-7 -mt-1 -mr-1 grid place-items-center rounded-full text-fg-muted hover:text-fg hover:bg-fg/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                <X size={15} aria-hidden />
              </button>
            )}
          </div>
          {children}
          {(cta || onDismiss) && (
            <div className="flex flex-col gap-2 mt-3.5">
              {cta && (
                <motion.button type="button" onClick={cta.onPress} whileHover={{ y: -1 }} whileTap={{ scale: 0.98 }}
                               className="w-full h-10 rounded-[12px] bg-cta-gradient text-white text-[13px] font-semibold flex items-center justify-between px-4 shadow-[0_8px_20px_-8px_rgb(var(--accent)/0.7)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2">
                  <span>{cta.label}</span>{cta.icon}
                </motion.button>
              )}
              {onDismiss && (
                <button type="button" onClick={onDismiss}
                        className="w-full h-9 rounded-[12px] bg-fg/5 hover:bg-fg/10 text-fg text-[13px] font-medium flex items-center justify-between px-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                  <span>{dismissLabel}</span><X size={14} aria-hidden />
                </button>
              )}
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
