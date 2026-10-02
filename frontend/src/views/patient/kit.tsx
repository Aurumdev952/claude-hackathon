import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, X } from "lucide-react";
import { EASE, SPRING_SOFT } from "@/lib/motion";

/** One scrolling screen of the patient app: a large title (and optional trailing control), then content. */
export function Screen({ title, sub, trailing, onBack, children, label }: {
  title?: ReactNode; sub?: ReactNode; trailing?: ReactNode; onBack?: () => void; children: ReactNode; label: string;
}) {
  return (
    <section aria-label={label} className="min-h-full px-5 pb-8 pt-3 flex flex-col gap-4">
      {(title || onBack) && (
        <header className="flex items-end gap-3 pt-2 pb-1">
          {onBack && (
            <button type="button" onClick={onBack} aria-label="Back" className="w-11 h-11 -ml-2 rounded-full grid place-items-center text-ink hover:bg-tile focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
              <ChevronLeft size={24} aria-hidden />
            </button>
          )}
          <div className="min-w-0 flex-1">
            {sub && <div className="text-[13px] leading-[18px] text-muted">{sub}</div>}
            {title && <h1 className="text-[30px] leading-[36px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>}
          </div>
          {trailing}
        </header>
      )}
      {children}
    </section>
  );
}

/** White card on the grey page (radius 24, flat). */
export function PCard({ children, className = "", as: As = "div", label }: { children: ReactNode; className?: string; as?: "div" | "section" | "article"; label?: string }) {
  return <As aria-label={label} className={`rounded-[24px] bg-surface p-5 dark:border dark:border-hairline ${className}`}>{children}</As>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1 -mb-1">
      <h2 className="text-[17px] leading-6 font-semibold text-ink">{children}</h2>
      {right}
    </div>
  );
}

export const pBtn = {
  primary: "h-12 px-5 rounded-full bg-signal-strong text-signal-on text-[16px] font-semibold active:scale-[.98] transition-transform focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50",
  ink: "h-12 px-5 rounded-full bg-ink text-ink-on text-[15px] font-semibold active:scale-[.98] transition-transform focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-45",
  soft: "h-12 px-4 rounded-full bg-tile text-ink text-[15px] font-medium hover:bg-tile-hover active:scale-[.98] transition-transform focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-45",
};

/** The phone screen element: sheets and banners portal into it so they stay inside the simulated device. */
export const PhoneLayer = createContext<HTMLElement | null>(null);

/** Bottom sheet inside the phone screen (portalled to the screen layer; fixed to the viewport in the full-screen app). */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const layer = useContext(PhoneLayer);
  if (!layer) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="absolute inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
          <motion.button type="button" aria-label="Close" className="absolute inset-0 bg-[rgb(21_23_28/0.32)] cursor-default" onClick={onClose}
                         initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} />
          <motion.div className="absolute inset-x-0 bottom-0 rounded-t-[28px] bg-surface px-5 pt-3 pb-8 pa-safe-bottom dark:border-t dark:border-hairline"
                      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={SPRING_SOFT}>
            <div className="w-10 h-1.5 rounded-full bg-hairline mx-auto mb-3" aria-hidden />
            <div className="flex items-center gap-3 mb-4">
              <h2 className="flex-1 text-[20px] leading-7 font-semibold text-ink">{title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-full bg-tile grid place-items-center text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"><X size={18} /></button>
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>, layer);
}

/** A quiet status pill for plan steps (patient wording). */
export function StepPill({ status }: { status: string }) {
  const late = status === "OVERDUE" || status === "ESCALATED";
  const label = status === "COMPLETED" ? "Done" : late ? "Late" : status === "SCHEDULED" ? "Later" : status === "DECLINED" ? "Not needed" : status === "CANCELLED" ? "Cancelled" : "To do";
  return (
    <span className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[12.5px] font-medium shrink-0 ${status === "COMPLETED" ? "bg-ink text-ink-on" : late ? "bg-signal-soft text-signal-text" : "bg-tile text-muted"}`}>
      {late && <span className="w-1.5 h-1.5 rounded-full bg-signal" aria-hidden />}{label}
    </span>
  );
}
