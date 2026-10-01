import type { AriaRole, CSSProperties, ReactNode } from "react";
import { Button } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cardEnter, hoverLift, tapPress } from "@/lib/motion";
import { InfoHint, type InfoHintProps } from "./InfoHint";
import { DetailModal, useDetailModal, type DetailModalProps } from "./DetailModal";
import { MotionScopeContext, useMotionScope } from "./motionScope";

export type CardDetail = ReactNode | (Omit<DetailModalProps, "isOpen" | "onOpenChange" | "onClose" | "title"> & { title?: ReactNode });

export type CardProps = {
  title?: ReactNode;
  /** Plain-text title for accessible names when `title` is a node. */
  titleText?: string;
  /** Icon shown in a soft tinted tile before the title. */
  icon?: ReactNode;
  iconTone?: IconTone;
  /** ⓘ content: a node, or InfoHint sections ({ about, method, notes }). */
  info?: ReactNode | Pick<InfoHintProps, "about" | "method" | "notes" | "content">;
  /** Header controls (segmented toggles, chips…). */
  actions?: ReactNode;
  /** Detail content: a chevron in the header opens it in a DetailModal (node = modal body, object = full modal props). */
  detail?: CardDetail;
  /** Accessible name of the chevron (default "Open details"). */
  detailLabel?: string;
  /** Makes the whole card clickable (hover lift). Mutually exclusive with nested interactive content. */
  onPress?: () => void;
  pressLabel?: string;
  /** default = white card; tile = inner surface-2 tile; glass = frosted; outline = transparent with hairline. */
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

const TONE = {
  default: "bg-surface border border-border shadow-card",
  tile: "bg-surface-2 border border-border/70",
  glass: "glass shadow-float",
  outline: "border border-border",
} as const;
export type IconTone = "accent" | "success" | "warning" | "danger" | "neutral";
export const ICON_TONE: Record<IconTone, string> = {
  accent: "bg-accent-soft text-accent", success: "bg-success/10 text-tone-success", warning: "bg-warning/15 text-tone-warning",
  danger: "bg-danger/10 text-tone-danger", neutral: "bg-surface-2 text-fg-muted",
};
const PAD = { none: "p-0", sm: "p-3.5", md: "p-5", lg: "p-6" } as const;

const isInfoObject = (x: unknown): x is Pick<InfoHintProps, "about" | "method" | "notes" | "content"> =>
  !!x && typeof x === "object" && !("$$typeof" in (x as object)) && !Array.isArray(x) && ("about" in (x as object) || "method" in (x as object) || "notes" in (x as object) || "content" in (x as object));
const isDetailObject = (x: unknown): x is Exclude<CardDetail, ReactNode> =>
  !!x && typeof x === "object" && !("$$typeof" in (x as object)) && !Array.isArray(x) && ("tabs" in (x as object) || "children" in (x as object));

/** Bento card (plan §A2): icon tile + title + ⓘ + actions + chevron → DetailModal; staggered entrance; hover lift when clickable. */
export function Card({ title, titleText, icon, iconTone = "accent", info, actions, detail, detailLabel = "Open details", onPress, pressLabel, tone = "default", padding = "md", as = "section",
  role, className = "", headerClassName = "", bodyClassName = "", style, footer, children, static: noAnim, ...rest }: CardProps) {
  const scope = useMotionScope();
  const reduce = useReducedMotion();
  const d = useDetailModal();
  const M = motion[as] as typeof motion.section;
  const anim = noAnim || scope === "item" ? {} : scope === "grid" ? { variants: cardEnter } : { variants: cardEnter, initial: reduce ? false : "hidden", animate: "show" };
  const press = onPress ? { whileHover: hoverLift, whileTap: tapPress, onClick: onPress, role: role ?? "button", tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPress(); } }, "aria-label": pressLabel } : {};
  const hasHeader = title !== undefined || icon || info || actions || detail;
  const detailProps = isDetailObject(detail) ? detail : { children: detail };
  const name = titleText ?? (typeof title === "string" ? title : undefined);
  const infoLabel = `About ${name ?? "this card"}`;
  const infoNode = info ? (isInfoObject(info) ? <InfoHint {...info} title={name ?? title} label={infoLabel} />
                                              : <InfoHint content={info as ReactNode} title={name ?? title} label={infoLabel} />) : null;
  return (
    <>
    <M {...anim} {...press} role={press.role ?? role} aria-label={rest["aria-label"] ?? press["aria-label"]} style={style}
       className={`relative min-w-0 flex flex-col rounded-card ${TONE[tone]} ${PAD[padding]} ${onPress ? "cursor-pointer transition-shadow hover:shadow-float focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" : ""} ${className}`}>
      <MotionScopeContext.Provider value="item">
        {hasHeader && (
          <header className={`flex items-center gap-2.5 min-h-8 mb-3 ${padding === "none" ? "px-5 pt-4" : ""} ${headerClassName}`}>
            {icon && <span className={`w-8 h-8 shrink-0 rounded-[10px] grid place-items-center ${ICON_TONE[iconTone]}`} aria-hidden>{icon}</span>}
            <div className="min-w-0 flex-1 flex items-center gap-0.5">
              {title !== undefined && <h2 className="text-title text-fg truncate">{title}</h2>}
              {infoNode}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
            {detail && (
              <Button isIconOnly size="sm" radius="full" variant="flat" aria-label={detailLabel} onPress={d.open}
                      className="min-w-8 w-8 h-8 bg-surface-2 border border-border text-fg-muted data-[hover=true]:text-fg data-[hover=true]:bg-surface">
                <ChevronRight size={16} aria-hidden />
              </Button>
            )}
          </header>
        )}
        <div className={`flex-1 min-h-0 min-w-0 ${bodyClassName}`}>{children}</div>
        {footer && <footer className="mt-3">{footer}</footer>}
      </MotionScopeContext.Provider>
    </M>
    {/* outside the card so portal events never bubble into a clickable card */}
    {detail && <DetailModal {...detailProps} {...d.modalProps} title={detailProps.title ?? title ?? ""} icon={detailProps.icon ?? icon} />}
    </>
  );
}
