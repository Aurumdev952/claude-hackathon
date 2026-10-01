import { useEffect, useState } from "react";
import { Tooltip } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { Crosshair, Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import { useCaseUI } from "./store";

/** Is `el` (or any element) in browser fullscreen? */
function useFullscreen(target: React.RefObject<HTMLElement>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const h = () => setOn(!!document.fullscreenElement && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, [target]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void target.current?.requestFullscreen?.().catch(() => undefined);
  };
  return [on, toggle] as const;
}

function RoundBtn({ label, onPress, children, active }: { label: string; onPress: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip content={label} placement="left" delay={250} closeDelay={0} classNames={{ content: "bg-fg text-bg text-xs font-medium px-2.5 py-1 rounded-lg shadow-float" }}>
      <motion.button type="button" onClick={onPress} aria-label={label} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.92 }}
                     className={`w-10 h-10 rounded-full grid place-items-center glass shadow-tile focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
                                 ${active ? "!bg-accent text-white" : "text-fg hover:!bg-surface"}`}>
        {children}
      </motion.button>
    </Tooltip>
  );
}

/** Floating round zoom + / − / fullscreen buttons (reference bottom-right of the body); a reset button appears once the
 * camera has moved to an organ. Zoom goes through the case store (`zoomDelta`) to the scene's CameraControls. */
export function StageControls({ stage }: { stage: React.RefObject<HTMLElement> }) {
  const zoom = useCaseUI((s) => s.zoom);
  const selected = useCaseUI((s) => s.selectedOrgan);
  const set = useCaseUI((s) => s.set);
  const [fs, toggleFs] = useFullscreen(stage);
  return (
    <div className="flex flex-col items-center gap-2 pointer-events-auto" role="group" aria-label="Camera">
      <AnimatePresence>
        {selected && (
          <motion.div initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}>
            <RoundBtn label="Reset view" onPress={() => set({ selectedOrgan: null, system: null })}><Crosshair size={16} aria-hidden /></RoundBtn>
          </motion.div>
        )}
      </AnimatePresence>
      <RoundBtn label="Zoom in" onPress={() => zoom(1)}><Plus size={17} aria-hidden /></RoundBtn>
      <RoundBtn label="Zoom out" onPress={() => zoom(-1)}><Minus size={17} aria-hidden /></RoundBtn>
      <RoundBtn label={fs ? "Exit full screen" : "Full screen"} onPress={toggleFs} active={fs}>
        {fs ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
      </RoundBtn>
    </div>
  );
}
