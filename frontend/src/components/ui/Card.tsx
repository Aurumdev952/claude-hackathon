import type { AriaRole, CSSProperties, ReactNode } from "react";
import { Button } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { cardEnter } from "@/lib/motion";
import { InfoHint, type InfoHintProps } from "./InfoHint";
import { DetailModal, useDetailModal, type DetailModalProps } from "./DetailModal";
import { MotionScopeContext, useMotionScope } from "./motionScope";

export type CardDetail = ReactNode | (Omit<DetailModalProps, "isOpen" | "onOpenChange" | "onClose" | "title"> & { title?: ReactNode });

export type CardProps = {
  title?: ReactNode;
  /** Heading of the detail modal when it should differ from the (styled) card title. Defaults to `detail.title`, then
   * `titleText`, then `title`. */
  modalTitle?: ReactNode;
  /** Plain-text title for accessible names when `title` is a node. */
  titleText?: string;
  /** Icon shown in a 36px outlined circle before the title (ink; signal when `iconTone="danger"`, an alerting state). */
  icon?: ReactNode;
  /** v2 tinted icon tiles. v3 draws every icon in ink inside an outlined circle; only "danger" (alerting) turns it signal. */
  iconTone?: IconTone;
  /** The page's one hero card: radius 28 instead of 24. */
  hero?: boolean;
  /** ⓘ content: a node, or InfoHint sections ({ about, method, notes }). */
  info?: ReactNode | Pick<InfoHintProps, "about" | "method" | "notes" | "content">;
  /** Header controls (segmented toggles, chips…). */
  actions?: ReactNode;
  /** Detail content: a chevron in the header opens it in a DetailModal (node = modal body, object = full modal props). */
  detail?: CardDetail;
  /** Accessible name of the round "open" button (default "Open details"). */
  detailLabel?: string;
  /** Makes the whole card clickable (cursor + focus ring, no lift). Mutually exclusive with nested interactive content. */
  onPress?: () => void;
  pressLabel?: string;
  /** default = flat white card; tile = nested grey tile (radius 16); glass = flat overlay surface (no blur);
   * outline = transparent with a hairline. */
  tone?: "default" | "tile" | "glass" | "outline";
  padding?: "none" | "sm" | "md" | "lg";
  as?: "section" | "article" | "div" | "li";
  role?: AriaRole;
  "aria-label"?: string;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  footer?: ReactNode;
  children?: ReactNode;
  /** Disable the entrance animation. */
  static?: boolean;
};

/** Flat cards: no border or shadow in light; a barely visible hairline edge in dark only. */
const TONE = {
  default: "bg-surface border border-transparent dark:border-hairline",
  tile: "bg-tile",
  glass: "overlay-surface",
  outline: "border border-hairline",
} as const;
export type IconTone = "accent" | "success" | "warning" | "danger" | "neutral";
/** v2 icon-tile colours, kept for compatibility. v3 icons are ink in an outlined circle (see Card). */
export const ICON_TONE: Record<IconTone, string> = {
  accent: "text-ink", success: "text-ink", warning: "text-ink", danger: "text-signal", neutral: "text-muted",
};
/** Card padding: 24 small, 28 default, 32 large. */
const PAD = { none: "p-0", sm: "p-6", md: "p-7", lg: "p-8" } as const;

const isInfoObject = (x: unknown): x is Pick<InfoHintProps, "about" | "method" | "notes" | "content"> =>
  !!x && typeof x === "object" && !("$$typeof" in (x as object)) && !Array.isArray(x) && ("about" in (x as object) || "method" in (x as object) || "notes" in (x as object) || "content" in (x as object));
export const isDetailObject = (x: unknown): x is Exclude<CardDetail, ReactNode> =>
  !!x && typeof x === "object" && !("$$typeof" in (x as object)) && !Array.isArray(x) && ("tabs" in (x as object) || "children" in (x as object));

/** Card (design v3, reference "Activity" card): 36px outlined circle icon + 17px title + ⓘ + one optional badge /
 * actions + a round outlined "open" button → DetailModal. Flat white, radius 24 (hero 28), fade-in on page load. */
export function Card({ title, modalTitle, titleText, icon, iconTone = "accent", hero, info, actions, detail, detailLabel = "Open details", onPress, pressLabel, tone = "default", padding = "md", as = "section",
  role, className = "", headerClassName = "", bodyClassName = "", style, footer, children, static: noAnim, ...rest }: CardProps) {
  const scope = useMotionScope();
  const reduce = useReducedMotion();
  const d = useDetailModal();
  const M = motion[as] as typeof motion.section;
  const anim = noAnim || scope === "item" ? {} : scope === "grid" ? { variants: cardEnter } : { variants: cardEnter, initial: reduce ? false : "hidden", animate: "show" };
  const press = onPress ? { onClick: onPress, role: role ?? "button", tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPress(); } }, "aria-label": pressLabel } : {};
  const hasHeader = title !== undefined || icon || info || actions || detail;
  const detailProps = isDetailObject(detail) ? detail : { children: detail };
  const name = titleText ?? (typeof title === "string" ? title : undefined);
  const infoLabel = `About ${name ?? "this card"}`;
  const infoNode = info ? (isInfoObject(info) ? <InfoHint {...info} title={name ?? title} label={infoLabel} />
                                              : <InfoHint content={info as ReactNode} title={name ?? title} label={infoLabel} />) : null;
  const radius = tone === "tile" ? "rounded-tile" : hero ? "rounded-hero" : "rounded-card";
  return (
    <>
    <M {...anim} {...press} role={press.role ?? role} aria-label={rest["aria-label"] ?? press["aria-label"]} style={style}
       className={`relative min-w-0 flex flex-col ${radius} ${TONE[tone]} ${PAD[padding]} ${onPress ? "cursor-pointer transition-colors hover:bg-tile/60 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal" : ""} ${className}`}>
      <MotionScopeContext.Provider value="item">
        {hasHeader && (
          <header className={`flex items-center max-sm:flex-wrap gap-3 min-h-9 mb-5 ${padding === "none" ? "px-7 pt-6" : ""} ${headerClassName}`}>
            {icon && (
              <span className={`w-9 h-9 shrink-0 rounded-full border grid place-items-center [&_svg]:w-[17px] [&_svg]:h-[17px] ${iconTone === "danger" ? "border-signal/40 text-signal" : "border-hairline text-ink"}`} aria-hidden>{icon}</span>
            )}
            <div className="min-w-0 flex-1 flex items-center gap-0.5 min-h-9">
              {title !== undefined && <h2 className="text-title text-ink truncate">{title}</h2>}
              {infoNode}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0 max-sm:shrink max-sm:min-w-0 max-sm:max-w-full max-sm:overflow-x-auto scrollbar-none">{actions}</div>}
            {detail && (
              <Button isIconOnly size="sm" radius="full" variant="light" aria-label={detailLabel} onPress={d.open}
                      className="min-w-9 w-9 h-9 bg-surface border border-hairline text-ink data-[hover=true]:bg-tile">
                <ArrowUpRight size={16} aria-hidden />
              </Button>
            )}
          </header>
        )}
        <div className={`flex-1 min-h-0 min-w-0 ${bodyClassName}`}>{children}</div>
        {footer && <footer className="mt-4">{footer}</footer>}
      </MotionScopeContext.Provider>
    </M>
    {/* outside the card so portal events never bubble into a clickable card */}
    {detail && <DetailModal {...detailProps} {...d.modalProps} title={detailProps.title ?? modalTitle ?? name ?? title ?? ""} icon={detailProps.icon ?? icon} />}
    </>
  );
}
