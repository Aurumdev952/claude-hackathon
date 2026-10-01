import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BellRing, Info, X } from "lucide-react";
import { useLive } from "@/state/live";
import { SPRING } from "@/lib/motion";

/** Live toasts (bottom-right white cards with the popover shadow), auto-dismissed after 6 s. */
export function Toasts() {
  const { toasts, dismiss } = useLive();
  useEffect(() => { if (toasts.length) { const t = setTimeout(() => dismiss(toasts[0].id), 6000); return () => clearTimeout(t); } }, [toasts, dismiss]);
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 items-end" aria-live="assertive">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div key={t.id} layout initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING}
                      className="bg-surface shadow-float rounded-card dark:border dark:border-hairline pl-3 pr-2 py-3 text-[14px] text-ink flex items-center gap-3 max-w-[400px]">
            <span className={`w-9 h-9 rounded-full border grid place-items-center shrink-0 ${t.tone === "alert" ? "border-signal/40 text-signal" : "border-hairline text-ink"}`} aria-hidden>
              {t.tone === "alert" ? <BellRing size={16} /> : <Info size={16} />}
            </span>
            <span className="flex-1">{t.text}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="w-8 h-8 grid place-items-center rounded-full text-muted hover:text-ink hover:bg-tile"><X size={15} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
