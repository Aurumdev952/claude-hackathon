import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import { BAND_STATUS, STATUS } from "@/lib/viz";

/** Risk band chip: status colour + icon + label, never colour alone (SPEC §16.5). */
export function BandChip({ band, size = "sm" }: { band: string | null | undefined; size?: "sm" | "md" }) {
  if (!band) return <span className="chip bg-ridge2 text-fog"><CircleDashed size={11} /> Unscored</span>;
  const s = BAND_STATUS[band] ?? "warning";
  const Icon = band === "HIGH" ? AlertOctagon : band === "MEDIUM" ? AlertTriangle : CheckCircle2;
  const c = STATUS[s];
  return (
    <span className={`chip ${size === "md" ? "text-xs px-2.5 py-1" : ""}`} style={{ background: `${c}22`, color: c, boxShadow: `inset 0 0 0 1px ${c}55` }}>
      <Icon size={size === "md" ? 13 : 11} aria-hidden /> {band}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: string }) {
  return <BandChip band={severity === "HIGH" ? "HIGH" : "MEDIUM"} />;
}
