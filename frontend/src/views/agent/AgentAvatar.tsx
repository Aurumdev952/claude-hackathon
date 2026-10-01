import { Landmark, Stethoscope } from "lucide-react";
import { PERSONA, type AgentRole } from "./types";

/** Round agent mark: the persona icon on the accent gradient; breathes while the agent works. */
export function AgentAvatar({ role, size = 28, busy = false }: { role: AgentRole; size?: number; busy?: boolean }) {
  const Icon = role === "doctor" ? Stethoscope : Landmark;
  return (
    <span className={`relative shrink-0 rounded-full grid place-items-center text-white shadow-tile ${busy ? "agent-pulse" : ""}`}
          style={{ width: size, height: size, background: "linear-gradient(135deg, rgb(var(--accent)) 0%, #6E5BD6 100%)" }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} strokeWidth={2} />
    </span>
  );
}

/** "Ministry analyst" / "Clinical assistant · facility" chip: which agent answers (decided by the top-nav role switch). */
export function AgentChip({ role, facilityName, className = "" }: { role: AgentRole; facilityName?: string | null; className?: string }) {
  const fac = facilityName?.replace(" (Synthetic)", "");
  return (
    <span className={`inline-flex items-center gap-2 rounded-full bg-surface border border-border shadow-tile pl-1 pr-3 py-1 min-w-0 ${className}`} data-testid="agent-chip">
      <AgentAvatar role={role} size={22} />
      <span className="text-[12.5px] font-semibold text-fg whitespace-nowrap">{PERSONA[role].name}</span>
      {role === "doctor" && fac && <span className="text-[12px] text-fg-muted truncate">· {fac}</span>}
    </span>
  );
}
