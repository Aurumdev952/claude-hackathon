import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const easeOut = Easing.bezier(0.22, 1, 0.36, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0..1 progress of an entrance that starts at `delay` frames and lasts `dur` frames (ease-out, deterministic). */
export function useProgress(delay = 0, dur = 30, easing = easeOut) {
  const frame = useCurrentFrame();
  return interpolate(frame, [delay, delay + Math.max(1, dur)], [0, 1], { ...clamp, easing });
}
export function progressAt(frame: number, delay = 0, dur = 30, easing = easeOut) {
  return interpolate(frame, [delay, delay + Math.max(1, dur)], [0, 1], { ...clamp, easing });
}
/** Spring 0..1 that starts at `delay` (critically damped: no bounce, settles calmly). */
export function useSpring(delay = 0, damping = 200) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping, mass: 0.9, stiffness: 120 } });
}
/** Fade + 24px rise for blocks entering a scene. */
export function rise(p: number, distance = 24): React.CSSProperties {
  return { opacity: p, transform: `translateY(${(1 - p) * distance}px)` };
}
export { clamp };
