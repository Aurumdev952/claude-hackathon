import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { EASE, useGesture } from "@/lib/motion";

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

/** Floating card ("3 new insights"), design v3: a flat white card with the one popover shadow, an outlined icon circle and
 * a solid signal CTA; fades in and out. (Name kept for compatibility: no glass, no blur, no gradient.) */
export function FloatingGlassCard({ open = true, count, title, body, icon, cta, onDismiss, dismissLabel = "Dismiss", position = "bottom-left", role, ariaLabel, className = "", children }: FloatingGlassCardProps) {
  const gesture = useGesture({}, { scale: 0.98 });
  return (
    <AnimatePresence>
      {open && (
        <motion.aside role={role} aria-label={ariaLabel}
                      initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}
                      transition={{ duration: 0.22, ease: EASE }}
                      className={`${POS[position]} w-[312px] max-w-[calc(100vw-2.5rem)] rounded-card bg-surface shadow-float dark:border dark:border-hairline p-5 ${className}`}>
          <div className="flex items-start gap-3">
            {icon && <span className="w-9 h-9 shrink-0 rounded-full border border-hairline text-ink grid place-items-center [&_svg]:w-[17px] [&_svg]:h-[17px]" aria-hidden>{icon}</span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                {count !== undefined && <span className="text-[32px] leading-none font-medium tracking-[-0.02em] text-ink tabular">{count}</span>}
                <span className="text-title text-ink">{title}</span>
              </div>
              {body && <div className="text-label font-normal text-muted mt-1.5 leading-snug">{body}</div>}
            </div>
            {onDismiss && (
              <button type="button" onClick={onDismiss} aria-label={ariaLabel ? `Close ${ariaLabel}` : "Close"}
                      className="w-8 h-8 -mt-1 -mr-1 grid place-items-center rounded-full text-muted hover:text-ink hover:bg-tile focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
                <X size={15} aria-hidden />
              </button>
            )}
          </div>
          {children}
          {(cta || onDismiss) && (
            <div className="flex items-center gap-2 mt-4">
              {cta && (
                <motion.button type="button" onClick={cta.onPress} {...gesture}
                               className="flex-1 h-10 rounded-full bg-signal-strong text-signal-on text-[14px] font-semibold inline-flex items-center justify-center gap-2 px-4 hover:bg-signal-text dark:hover:bg-signal-text focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                  <span>{cta.label}</span>{cta.icon}
                </motion.button>
              )}
              {onDismiss && (
                <button type="button" onClick={onDismiss}
                        className="h-10 rounded-full bg-tile hover:bg-tile-hover text-ink text-[14px] font-medium inline-flex items-center justify-center px-4 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                  {dismissLabel}
                </button>
              )}
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
