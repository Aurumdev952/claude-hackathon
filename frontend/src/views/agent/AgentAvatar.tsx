import { Landmark, Stethoscope } from "lucide-react";
import { PERSONA, type AgentRole } from "./types";

/** Agent mark (design v3): the persona icon in ink inside an outlined circle, like every card icon. No fill, no glow. */
export function AgentAvatar({ role, size = 28, className = "" }: { role: AgentRole; size?: number; className?: string }) {
  const Icon = role === "doctor" ? Stethoscope : Landmark;
  return (
    <span className={`relative shrink-0 rounded-full border border-hairline bg-surface text-ink grid place-items-center ${className}`}
          style={{ width: size, height: size }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.75} />
    </span>
  );
}

/** "Ministry analyst" / "Clinical assistant" pill: which agent answers (decided by the top-nav role switch). The facility
 * is a separate muted label, not a middle-dot suffix. */
export function AgentChip({ role, facilityName, className = "" }: { role: AgentRole; facilityName?: string | null; className?: string }) {
  const fac = facilityName?.replace(" (Synthetic)", "");
  return (
    <span className={`inline-flex items-center gap-2.5 min-w-0 ${className}`} data-testid="agent-chip">
      <span className="inline-flex items-center gap-2 h-9 rounded-full bg-surface dark:border dark:border-hairline pl-1 pr-3.5 min-w-0 max-w-full">
        <AgentAvatar role={role} size={28} />
        <span className="text-[14px] font-semibold text-ink whitespace-nowrap truncate">{PERSONA[role].name}</span>
      </span>
      {role === "doctor" && fac && <span className="text-label text-muted truncate hidden sm:inline">{fac}</span>}
    </span>
  );
}
