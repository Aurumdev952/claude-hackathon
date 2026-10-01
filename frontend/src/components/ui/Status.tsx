import { CircleDashed } from "lucide-react";
import { BAND_STATUS } from "@/lib/viz";
import { StatusChip, type StatusKind } from "./StatusChip";

const BAND_KIND: Record<string, StatusKind> = { good: "good", warning: "warning", serious: "serious", critical: "critical" };

/** Risk band chip: StatusChip with a shape glyph + the band text, never colour alone (SPEC §16.5). */
export function BandChip({ band, size = "sm" }: { band: string | null | undefined; size?: "sm" | "md" }) {
  if (!band) return <StatusChip status="neutral" label="Unscored" size={size} icon={<CircleDashed size={size === "md" ? 12 : 10} aria-hidden />} />;
  const s = BAND_STATUS[band] ?? "warning";
  return <StatusChip status={BAND_KIND[s]} label={band} size={size} />;
}

export function SeverityChip({ severity }: { severity: string }) {
  return <BandChip band={severity === "HIGH" ? "HIGH" : "MEDIUM"} />;
}
