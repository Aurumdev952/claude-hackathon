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
/** Glyph colour + soft background + legible text per tone (text uses the darker "tone" steps on white). */
const SOFT: Record<Tone, string> = {
  success: "bg-success/10 text-tone-success",
  warning: "bg-warning/15 text-tone-warning",
  serious: "bg-serious/10 text-tone-serious",
  danger: "bg-danger/10 text-tone-danger",
  info: "bg-accent-soft text-accent",
  neutral: "bg-surface-2 text-fg-muted",
};
const GLYPH_COLOR: Record<Tone, string> = {
  success: "text-success", warning: "text-warning", serious: "text-serious", danger: "text-danger", info: "text-accent", neutral: "text-fg-muted",
};

/** Shape-coded glyph so status never relies on colour alone: ▲ good, — warning, ◆ serious, ▼ critical, ● info/neutral. */
export function StatusGlyph({ status, size = 9, className = "" }: { status: StatusKind; size?: number; className?: string }) {
  const tone = TONE[status];
  const cls = `${GLYPH_COLOR[tone]} shrink-0 ${className}`;
  if (tone === "success") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><path d="M5 1.2 9.2 8.6H.8Z" fill="currentColor" /></svg>;
  if (tone === "danger") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><path d="M5 8.8.8 1.4h8.4Z" fill="currentColor" /></svg>;
  if (tone === "warning") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><rect x="1" y="3.9" width="8" height="2.2" rx="1.1" fill="currentColor" /></svg>;
  if (tone === "serious") return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="currentColor" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 10 10" className={cls} aria-hidden><circle cx="5" cy="5" r="3.4" fill="currentColor" /></svg>;
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

/** Status chip: glyph + text, never colour only (plan §A2). Built on HeroUI Chip. */
export function StatusChip({ status, label, size = "sm", variant = "soft", icon, className = "", title }: StatusChipProps) {
  const tone = TONE[status];
  const glyph = icon === false ? null : icon ?? <StatusGlyph status={status} size={size === "md" ? 10 : 9} />;
  const look = variant === "outline" ? "bg-surface border border-border text-fg shadow-tile" : SOFT[tone];
  return (
    <Chip
      size={size}
      radius="full"
      variant="flat"
      title={title}
      startContent={glyph ? <span className={`inline-flex items-center ${variant === "outline" ? GLYPH_COLOR[tone] : ""}`}>{glyph}</span> : undefined}
      classNames={{
        base: `${look} h-auto gap-1 ${size === "md" ? "px-2.5 py-1" : "px-2 py-0.5"} ${className}`,
        content: `px-0 font-medium leading-4 ${size === "md" ? "text-xs" : "text-[11px]"}`,
      }}
    >
      {label ?? LABEL[status]}
    </Chip>
  );
}
