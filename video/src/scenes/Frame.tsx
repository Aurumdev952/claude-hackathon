import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { easeOut, clamp } from "../lib/anim";
import { C, FONT, R, T } from "../theme";
import { BrandMark } from "./BrandMark";

export type SceneDef = { id: string; title: string; duration: number };

export const useIsVertical = () => {
  const { width, height } = useVideoConfig();
  return height > width;
};

/** Page padding and the content box below the scene title, for both 16:9 and 9:16. */
export function useLayout() {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const padX = vertical ? 64 : 96;
  const top = vertical ? 300 : 250;
  const bottom = vertical ? 150 : 120;
  return { width, height, vertical, padX, top, bottom, contentW: width - 2 * padX, contentH: height - top - bottom };
}

/** Synthetic-data badge: always visible on every frame (the data rule), neutral tile pill with a dot glyph. */
export function SyntheticPill({ small = false, onWhite = false }: { small?: boolean; onWhite?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, background: onWhite ? C.tile : C.surface, color: C.ink2, borderRadius: R.pill,
                   padding: small ? "8px 18px" : "12px 24px", ...(small ? T.micro : T.label), fontFamily: FONT, whiteSpace: "nowrap" }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: C.warning }} />
      Synthetic data
    </span>
  );
}

export function BandPill({ band, size = "md" }: { band: string; size?: "md" | "lg" }) {
  const b = band.toUpperCase();
  const style: React.CSSProperties = b === "HIGH" || b === "DIAGNOSED" ? { background: C.signalStrong, color: "#FFFFFF" }
    : b === "MEDIUM" ? { background: C.signalSoft, color: C.signalText } : { background: C.tile, color: C.ink2 };
  return (
    <span style={{ ...style, borderRadius: R.pill, padding: size === "lg" ? "14px 30px" : "8px 20px", fontFamily: FONT,
                   ...(size === "lg" ? T.title : T.label), whiteSpace: "nowrap" }}>
      {b === "HIGH" ? "High risk" : b === "MEDIUM" ? "Medium risk" : b === "LOW" ? "Low risk" : b.charAt(0) + b.slice(1).toLowerCase().replace(/_/g, " ")}
    </span>
  );
}

/** One scene: page background, header strip (brand, context, synthetic badge), the scene title and subtitle, the content,
 * and a segmented progress track. Content fades in over 14 frames and out over the last 8. */
export function SceneFrame({ title, subtitle, context, index, scenes, children, hideTitle = false }: {
  title: string; subtitle?: string; context: string; index: number; scenes: SceneDef[]; children: React.ReactNode; hideTitle?: boolean;
}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const L = useLayout();
  const enter = interpolate(frame, [0, 14], [0, 1], { ...clamp, easing: easeOut });
  const exit = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], clamp);
  const o = Math.min(enter, exit);
  return (
    <AbsoluteFill style={{ background: C.page, fontFamily: FONT, color: C.ink }}>
      <div style={{ position: "absolute", left: L.padX, right: L.padX, top: L.vertical ? 64 : 52, display: "flex", alignItems: "center",
                    justifyContent: "space-between", gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, ...T.label, color: C.ink }}>
          <BrandMark size={34} draw={index === 0 ? interpolate(frame, [2, 30], [0, 1], { ...clamp, easing: easeOut }) : 1} />
          <span><span style={{ fontWeight: 400 }}>Early</span> <span style={{ fontWeight: 600 }}>Signals</span></span>
          <span style={{ color: C.muted, fontWeight: 500, marginLeft: 6 }}>{context}</span>
        </div>
        <SyntheticPill small />
      </div>
      {!hideTitle && (
        <div style={{ position: "absolute", left: L.padX, right: L.padX, top: L.vertical ? 150 : 128, opacity: o,
                      transform: `translateY(${(1 - enter) * 18}px)` }}>
          <div style={{ ...(L.vertical ? T.h1 : T.h1), color: C.ink }}>{title}</div>
          {subtitle && <div style={{ ...T.body, color: C.muted, marginTop: 6, maxWidth: 1400 }}>{subtitle}</div>}
        </div>
      )}
      <div style={{ position: "absolute", left: L.padX, top: L.top, width: L.contentW, height: L.contentH, opacity: o }}>
        {children}
      </div>
      <ProgressTrack index={index} scenes={scenes} />
    </AbsoluteFill>
  );
}

function ProgressTrack({ index, scenes }: { index: number; scenes: SceneDef[] }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const L = useLayout();
  const p = Math.min(1, frame / Math.max(1, durationInFrames - 1));
  return (
    <div style={{ position: "absolute", left: L.padX, right: L.padX, bottom: L.vertical ? 64 : 48, display: "flex", gap: 8 }}>
      {scenes.map((s, i) => (
        <div key={s.id} style={{ flex: s.duration, height: 4, borderRadius: 2, background: C.hairline, overflow: "hidden" }}>
          <div style={{ height: 4, width: `${i < index ? 100 : i === index ? p * 100 : 0}%`, background: C.brand }} />
        </div>
      ))}
    </div>
  );
}

/** Flat white card. */
export function Card({ children, style, pad = 40 }: { children: React.ReactNode; style?: React.CSSProperties; pad?: number }) {
  return <div style={{ background: C.surface, borderRadius: R.card, padding: pad, boxSizing: "border-box", ...style }}>{children}</div>;
}
