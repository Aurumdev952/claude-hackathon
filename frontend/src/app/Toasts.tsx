import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BellRing, Info, X } from "lucide-react";
import { useLive } from "@/state/live";
import { SPRING } from "@/lib/motion";

/** Live toasts (bottom-right glass cards), auto-dismissed after 6 s. */
export function Toasts() {
  const { toasts, dismiss } = useLive();
  useEffect(() => { if (toasts.length) { const t = setTimeout(() => dismiss(toasts[0].id), 6000); return () => clearTimeout(t); } }, [toasts, dismiss]);
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 items-end" aria-live="assertive">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div key={t.id} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 24 }} transition={SPRING}
                      className="glass shadow-float rounded-tile pl-3 pr-2 py-2.5 text-[13px] text-fg flex items-center gap-3 max-w-[380px]">
            <span className={`w-8 h-8 rounded-[10px] grid place-items-center shrink-0 ${t.tone === "alert" ? "bg-danger/10 text-tone-danger" : "bg-accent-soft text-accent"}`} aria-hidden>
              {t.tone === "alert" ? <BellRing size={15} /> : <Info size={15} />}
            </span>
            <span className="flex-1">{t.text}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="w-7 h-7 grid place-items-center rounded-full text-fg-muted hover:text-fg hover:bg-fg/5"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
