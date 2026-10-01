import type { ReactNode } from "react";
import { Chip } from "@heroui/react";

/** Status vocabulary. `optimal / suboptimal / critical` follow the reference screens; `good / warning / serious` map onto
 * the viz STATUS scale; `info` and `neutral` are for non-judgemental chips (e.g. "HH", "Rising" in an info context). */
export type StatusKind = "optimal" | "good" | "suboptimal" | "warning" | "serious" | "critical" | "info" | "neutral";

type Tone = "success" | "warning" | "serious" | "danger" | "info" | "neutral";
const TONE: Record<StatusKind, Tone> = {
  optimal: "success", good: "success", suboptimal: "warning", warning: "warning", serious: "serious", critical: "danger", info: "info", neutral: "neutral",
};
const LABEL: Record<StatusKind, string> = {
  optimal: "Optimal", good: "Good", suboptimal: "Suboptimal", warning: "Warning", serious: "Elevated", critical: "Critical", info: "Info", neutral: "Unknown",
};
/** Pill look per tone (design v3): HIGH = solid signal + white text; MEDIUM / elevated = signal-soft + signal text;
 * LOW / good = grey tile + muted text (green dot); info / neutral = grey tile + muted text. */
const SOFT: Record<Tone, string> = {
  success: "bg-tile text-muted",
  warning: "bg-signal-soft text-signal-text",
  serious: "bg-signal-soft text-signal-text",
  danger: "bg-signal-strong text-signal-on",
  info: "bg-tile text-muted",
  neutral: "bg-tile text-muted",
};
const GLYPH_COLOR: Record<Tone, string> = {
  success: "text-success", warning: "text-signal", serious: "text-signal", danger: "text-signal", info: "text-sky", neutral: "text-faint",
};

/** Small glyph so status never relies on colour alone: ● good / info / neutral, — warning, ◆ serious, ▼ critical. */
export function StatusGlyph({ status, size = 8, className = "" }: { status: StatusKind; size?: number; className?: string }) {
  const tone = TONE[status];
  const cls = `${GLYPH_COLOR[tone]} shrink-0 ${className}`;
  if (tone === "danger") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><path d="M5 8.8.8 1.4h8.4Z" fill="currentColor" /></svg>;
  if (tone === "warning") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><rect x="1" y="3.9" width="8" height="2.2" rx="1.1" fill="currentColor" /></svg>;
  if (tone === "serious") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="currentColor" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><circle cx="5" cy="5" r="3.6" fill="currentColor" /></svg>;
}

export type StatusChipProps = {
  status: StatusKind;
  /** Visible text; defaults to the status name ("Optimal", "Critical" …). */
  label?: ReactNode;
  size?: "sm" | "md";
  /** soft = tinted pill (default); outline = white pill with hairline border, coloured glyph, ink text (reference style). */
  variant?: "soft" | "outline";
  /** Replace the default shape glyph (e.g. a lucide icon). Pass `false` only when the label itself states the status. */
  icon?: ReactNode | false;
  className?: string;
  title?: string;
};

/** Status pill: small glyph + text, never colour only. Built on HeroUI Chip. */
export function StatusChip({ status, label, size = "sm", variant = "soft", icon, className = "", title }: StatusChipProps) {
  const tone = TONE[status];
  const solid = variant !== "outline" && tone === "danger";
  const glyph = icon === false ? null : icon ?? <StatusGlyph status={status} size={size === "md" ? 8 : 7} className={solid ? "!text-signal-on" : ""} />;
  const look = variant === "outline" ? "bg-surface border border-hairline text-ink" : SOFT[tone];
  return (
    <Chip
      size={size}
      radius="full"
      variant="flat"
      title={title}
      startContent={glyph ? <span className={`inline-flex items-center ${variant === "outline" ? GLYPH_COLOR[tone] : ""}`}>{glyph}</span> : undefined}
      classNames={{
        base: `${look} h-auto gap-1.5 ${size === "md" ? "px-3 py-1" : "px-2.5 py-[3px]"} ${className}`,
        content: `px-0 font-semibold ${size === "md" ? "text-[13px] leading-[18px]" : "text-[12px] leading-4"}`,
      }}
    >
      {label ?? LABEL[status]}
    </Chip>
  );
}
