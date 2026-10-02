import { C } from "../theme";

/** The Early Signals mark for video: two rising signal lines, brand2 (#98D59B) at the lower left to brand (#4F6F51) at
 * the upper right. Same geometry as frontend/src/components/brand/BrandMark.tsx (this package cannot import it).
 * `draw` (0..1) traces the lines in, the lower one a beat behind, as the app's loading splash does. */
const PATHS = ["M6 45 L37 15 L50 28 L71 6 L94 29", "M6 76 L37 46 L50 58 L71 37 L94 60"];

export function BrandMark({ size = 34, draw = 1, id = "es-mark" }: { size?: number; draw?: number; id?: string }) {
  return (
    <svg viewBox="0 0 100 82" width={size} height={(size * 82) / 100} style={{ overflow: "visible", flexShrink: 0 }}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="4" y1="78" x2="96" y2="4">
          <stop offset="0" stopColor={C.brand2} />
          <stop offset="1" stopColor={C.brand} />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${id})`} strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round">
        {PATHS.map((d, i) => {
          const k = Math.max(0, Math.min(1, (draw - i * 0.25) / 0.75));   // the lower line starts a quarter later
          return <path key={d} d={d} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - k} opacity={k > 0 ? 1 : 0} />;
        })}
      </g>
    </svg>
  );
}
