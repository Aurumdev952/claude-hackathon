import { Avatar } from "@heroui/react";

const HUES = ["#3F6FE8", "#1baf7a", "#eb6834", "#8B7CF6", "#e87ba4", "#0ea5b7", "#eda100"];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

/** Initials avatar with a deterministic soft colour per patient (no photos in synthetic data). */
export function PatientAvatar({ name, id, size = "md", className = "" }: { name: string; id: number | string; size?: "sm" | "md" | "lg"; className?: string }) {
  const n = typeof id === "number" ? id : [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
  const c = HUES[Math.abs(n) % HUES.length];
  return (
    <Avatar name={name} getInitials={initials} size={size} radius="full" aria-hidden
            className={`shrink-0 font-semibold text-white ${className}`}
            style={{ background: `linear-gradient(135deg, ${c}, ${c}bb)`, boxShadow: `0 6px 16px -8px ${c}` }} />
  );
}
