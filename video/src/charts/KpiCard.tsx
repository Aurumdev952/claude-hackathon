import { useCurrentFrame } from "remotion";
import { progressAt, rise } from "../lib/anim";
import { fmtNum } from "../lib/format";
import { C, FONT, R, T } from "../theme";
import { CountUp } from "./CountUp";
import { Sparkline } from "./Sparkline";

/** Stat tile: label, counted value + unit, signed delta vs a named period (colour = direction x whether up is good, with
 * an arrow glyph so colour is never alone), optional sparkline. Flat white card, no border, no shadow. */
export function KpiCard({ label, value, unit, delta, deltaLabel, higherIsBetter = false, spark, decimals = 0, delay = 0, width, height = 260, nullLabel }: {
  label: string; value: number | null; unit?: string; delta?: number | null; deltaLabel?: string; higherIsBetter?: boolean;
  spark?: (number | null)[]; decimals?: number; delay?: number; width: number; height?: number; nullLabel?: string;
}) {
  const frame = useCurrentFrame();
  const p = progressAt(frame, delay, 24);
  const good = delta === null || delta === undefined || delta === 0 ? null : (delta > 0) === higherIsBetter;
  const tone = good === null ? C.muted : good ? C.successText : C.signalText;
  const arrow = !delta ? "" : delta > 0 ? "▲" : "▼";
  return (
    <div style={{ width, height, background: C.surface, borderRadius: R.card, padding: "30px 34px", boxSizing: "border-box",
                  display: "flex", flexDirection: "column", justifyContent: "space-between", fontFamily: FONT, ...rise(p) }}>
      <div style={{ ...T.label, color: C.muted }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <CountUp value={value} delay={delay + 6} duration={45} decimals={decimals} nullLabel={nullLabel} suffix={unit === "%" ? "%" : ""}
                 style={{ ...T.metric, color: C.ink }} />
        {unit && unit !== "%" && <span style={{ ...T.label, color: C.muted }}>{unit}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 44 }}>
        {delta !== null && delta !== undefined ? (
          <span style={{ ...T.micro, color: tone, opacity: progressAt(frame, delay + 40, 14) }}>
            {arrow} {fmtNum(Math.abs(delta), Math.abs(delta) < 10 ? 1 : 0)}{unit === "%" ? " pts" : "%"} {deltaLabel ?? ""}
          </span>
        ) : <span />}
        {spark && spark.filter((v) => v !== null).length > 1 && (
          <Sparkline values={spark} width={Math.min(170, width * 0.42)} height={44} delay={delay + 10} duration={45} />
        )}
      </div>
    </div>
  );
}
