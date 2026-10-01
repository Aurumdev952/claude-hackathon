import type { ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight } from "lucide-react";
import { AnimatedNumber } from "./AnimatedNumber";
import { Card, type CardDetail, type CardProps, type IconTone } from "./Card";
import { GradientRangeBar, type GradientRangeBarProps } from "./GradientRangeBar";
import { InfoHint } from "./InfoHint";
import { Sparkline } from "./Sparkline";
import { StatusChip, type StatusKind } from "./StatusChip";

export type MetricDelta = {
  text: ReactNode;
  /** Direction of change (arrow). */
  dir?: -1 | 0 | 1;
  /** Is the change good, bad or neither? (colour + arrow, never colour alone) */
  tone?: "good" | "bad" | "neutral";
};

/** A number is animated; a string / node is shown as-is. */
export type MetricValue = number | string | ReactNode | null | undefined;

const DELTA_TONE = { good: "bg-success/10 text-tone-success", bad: "bg-danger/10 text-tone-danger", neutral: "bg-fg/5 text-fg-muted" } as const;

export function DeltaChip({ delta, className = "" }: { delta: MetricDelta; className?: string }) {
  const Icon = delta.dir === 1 ? ArrowUpRight : delta.dir === -1 ? ArrowDownRight : ArrowRight;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular whitespace-nowrap ${DELTA_TONE[delta.tone ?? "neutral"]} ${className}`}>
      <Icon size={12} aria-hidden />{delta.text}
    </span>
  );
}

/** Split "+2.1%" / "×3.4" / "1,234" into prefix, number and suffix so pre-formatted strings still count up. */
function parseNumeric(s: string): { pre: string; n: number; post: string; dec: number; group: boolean } | null {
  const m = /^(\s*[^\d\s]{0,2}\s?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(s);
  if (!m) return null;
  const raw = m[2];
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return { pre: m[1], n, post: m[3], dec: raw.includes(".") ? raw.split(".")[1].length : 0, group: raw.includes(",") };
}

function Value({ value, format, decimals, className }: { value: MetricValue; format?: (n: number) => string; decimals?: number; className: string }) {
  if (typeof value === "number") return <AnimatedNumber value={value} format={format} decimals={decimals} className={className} />;
  if (typeof value === "string") {
    const p = parseNumeric(value);
    if (p) {
      const f = (n: number) => `${p.pre}${p.group ? n.toLocaleString("en-US", { minimumFractionDigits: p.dec, maximumFractionDigits: p.dec }) : n.toFixed(p.dec)}${p.post}`;
      return <AnimatedNumber value={p.n} format={f} className={className} />;
    }
  }
  return <span className={`tabular ${className}`}>{value === null || value === undefined || value === "" ? "—" : value}</span>;
}

export type MetricCardProps = {
  label: ReactNode;
  value: MetricValue;
  unit?: ReactNode;
  format?: (n: number) => string;
  decimals?: number;
  icon?: ReactNode;
  iconTone?: IconTone;
  delta?: MetricDelta | null;
  /** Status chip (glyph + text). */
  status?: StatusKind | { status: StatusKind; label?: ReactNode } | null;
  /** Small trailing note next to the number (e.g. "4 flags"). */
  aside?: ReactNode;
  info?: CardProps["info"];
  detail?: CardDetail;
  detailLabel?: string;
  onPress?: () => void;
  spark?: (number | null | undefined)[];
  sparkColor?: string;
  range?: Omit<GradientRangeBarProps, "value"> & { value?: number | null };
  footer?: ReactNode;
  size?: "md" | "lg";
  as?: CardProps["as"];
  role?: CardProps["role"];
  className?: string;
  children?: ReactNode;
};

/** Metric card (plan §A2, reference "Key areas of concern" cards): label + chevron, big number with a tiny unit, delta and
 * status chips, optional sparkline or gradient range bar. */
export function MetricCard({ label, value, unit, format, decimals, icon, iconTone, delta, status, aside, info, detail, detailLabel, onPress, spark, sparkColor, range,
  footer, size = "md", as = "article", role, className = "", children }: MetricCardProps) {
  const st = status ? (typeof status === "string" ? { status } : status) : null;
  return (
    <Card as={as} role={role} padding="sm" className={`!p-4 ${className}`} onPress={onPress} pressLabel={typeof label === "string" ? label : undefined}
          title={<span className="text-label font-medium text-fg-muted">{label}</span>} modalTitle={label} titleText={typeof label === "string" ? label : undefined} icon={icon} iconTone={iconTone} info={info} detail={detail} detailLabel={detailLabel ?? (typeof label === "string" ? `${label}: details` : undefined)}
          headerClassName="!mb-2 !min-h-0"
          actions={onPress && !detail ? <ChevronRight size={16} className="text-fg-muted" aria-hidden /> : undefined}>
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-baseline gap-1 min-w-0">
          <Value value={value} format={format} decimals={decimals} className={`${size === "lg" ? "text-display" : "text-metric"} text-fg`} />
          {unit && <span className="text-label text-fg-muted">{unit}</span>}
        </div>
        {aside && <div className="text-label text-fg-muted whitespace-nowrap pb-1">{aside}</div>}
      </div>
      {(delta || st) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {st && <StatusChip status={st.status} label={st.label} />}
          {delta && <DeltaChip delta={delta} />}
        </div>
      )}
      {spark && spark.length > 1 && <div className="mt-3"><Sparkline values={spark} color={sparkColor} height={34} /></div>}
      {range && <div className="mt-3"><GradientRangeBar {...range} value={range.value ?? (typeof value === "number" ? value : null)} /></div>}
      {children}
      {footer && <div className="mt-2 text-micro text-fg-muted">{footer}</div>}
    </Card>
  );
}

export type StatTileProps = {
  label: ReactNode;
  value: MetricValue;
  unit?: ReactNode;
  format?: (n: number) => string;
  decimals?: number;
  icon?: ReactNode;
  /** One-liner moved into a tooltip ⓘ. */
  info?: ReactNode;
  status?: StatusKind | null;
  sub?: ReactNode;
  className?: string;
};

/** Small inner tile (reference "Age 36 years" / "CRP 1.8 mg/L" tiles): surface-2, icon, label, value + unit. */
export function StatTile({ label, value, unit, format, decimals, icon, info, status, sub, className = "" }: StatTileProps) {
  return (
    <div className={`rounded-tile bg-surface-2 border border-border/70 px-3 py-2.5 min-w-0 ${className}`}>
      <div className="flex items-center gap-1.5 text-micro text-fg-muted">
        {icon && <span className="text-accent shrink-0" aria-hidden>{icon}</span>}
        <span className="truncate">{label}</span>
        {info && <InfoHint content={info} mode="tooltip" size={12} label={`About ${typeof label === "string" ? label : "this value"}`} className="!w-5 !h-5 !min-w-5 -my-1" />}
      </div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <Value value={value} format={format} decimals={decimals} className="text-[18px] font-semibold leading-6 text-fg" />
        {unit && <span className="text-micro text-fg-muted">{unit}</span>}
      </div>
      {(status || sub) && (
        <div className="flex items-center gap-1.5 mt-1">
          {status && <StatusChip status={status} />}
          {sub && <span className="text-micro text-fg-muted leading-snug">{sub}</span>}
        </div>
      )}
    </div>
  );
}

export type PairSide = { label: ReactNode; value: MetricValue; unit?: ReactNode; format?: (n: number) => string; decimals?: number; marker?: string };

export type PairCardProps = {
  left: PairSide;
  right: PairSide;
  /** Visual on the far left (e.g. stacked bars) with an optional caption such as "+5 yrs". */
  visual?: ReactNode;
  visualCaption?: ReactNode;
  info?: CardProps["info"];
  detail?: CardDetail;
  title?: ReactNode;
  className?: string;
};

/** "Heart age 46 yrs › Chronological age 42 yrs" layout (plan §A2). */
export function PairCard({ left, right, visual, visualCaption, info, detail, title, className = "" }: PairCardProps) {
  const side = (s: PairSide) => (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-label text-fg-muted">
        <span className="w-1.5 h-3 rounded-sm shrink-0" style={{ background: s.marker ?? "rgb(var(--fg-muted) / .5)" }} aria-hidden />
        <span className="truncate">{s.label}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-1">
        <Value value={s.value} format={s.format} decimals={s.decimals} className="text-metric text-fg" />
        {s.unit && <span className="text-label text-fg-muted">{s.unit}</span>}
      </div>
    </div>
  );
  return (
    <Card padding="sm" className={`!p-4 ${className}`} title={title} info={title ? info : undefined} detail={detail} headerClassName={title || detail ? "" : "!hidden"}>
      {!title && info && <div className="absolute top-2 right-2"><InfoHint {...(typeof info === "object" && info !== null && !("$$typeof" in (info as object)) ? (info as object) : { content: info as ReactNode })} label="About this comparison" /></div>}
      <div className={`flex items-center gap-4 ${!title && info ? "pr-5" : ""}`}>
        {visual && (
          <div className="shrink-0 rounded-tile bg-surface-2 border border-border/70 p-2 flex flex-col items-center gap-1">
            {visual}
            {visualCaption && <span className="text-micro font-semibold text-fg">{visualCaption}</span>}
          </div>
        )}
        <div className="flex-1 min-w-0">{side(left)}</div>
        <ChevronRight size={18} className="text-fg-muted/60 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">{side(right)}</div>
      </div>
    </Card>
  );
}
