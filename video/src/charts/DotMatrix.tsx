import { useCurrentFrame } from "remotion";
import { progressAt } from "../lib/anim";
import { C } from "../theme";

/** "k out of n" as a grid of dots: the k highlighted dots fill first in the accent, the rest in the soft data hue.
 * Dots appear row by row (deterministic order). */
export function DotMatrix({ n = 100, k, cols = 10, size = 30, gap = 12, delay = 0, duration = 50, on = C.signal, off = C.skySoft }: {
  n?: number; k: number; cols?: number; size?: number; gap?: number; delay?: number; duration?: number; on?: string; off?: string;
}) {
  const frame = useCurrentFrame();
  const rows = Math.ceil(n / cols);
  const p = progressAt(frame, delay, duration, (t) => t);
  const shown = Math.round(p * n);
  return (
    <svg width={cols * (size + gap) - gap} height={rows * (size + gap) - gap}>
      {Array.from({ length: n }, (_, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        return (
          <circle key={i} cx={c * (size + gap) + size / 2} cy={r * (size + gap) + size / 2} r={size / 2}
                  fill={i < shown ? (i < k ? on : off) : C.tile} />
        );
      })}
    </svg>
  );
}
