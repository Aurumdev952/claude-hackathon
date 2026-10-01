const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

const SIZE = { sm: "w-9 h-9 text-[13px]", md: "w-10 h-10 text-[14px]", lg: "w-14 h-14 text-[18px]" } as const;

/** Initials avatar (design v3): ink initials on a quiet grey circle, one look for every patient (no photos in synthetic
 * data, and no per-patient colours: colour is kept for risk). `id` is accepted for backward compatibility. */
export function PatientAvatar({ name, size = "md", className = "" }: { name: string; id?: number | string; size?: "sm" | "md" | "lg"; className?: string }) {
  return (
    <span aria-hidden className={`shrink-0 inline-grid place-items-center rounded-full bg-tile-hover text-ink font-semibold tracking-[0.01em] select-none ${SIZE[size]} ${className}`}>
      {initials(name)}
    </span>
  );
}
