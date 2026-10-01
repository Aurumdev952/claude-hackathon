import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { Tooltip } from "@heroui/react";
import { motion } from "framer-motion";
import { SPRING } from "@/lib/motion";

type IconType = LucideIcon;

export type RailItem = {
  key: string;
  label: string;
  icon: IconType;
  /** Router destination (renders a NavLink) … */
  to?: string;
  /** … or an action (renders a button). */
  onPress?: () => void;
  /** Extra paths that count as active (e.g. "/ask" for "/agent"). */
  match?: readonly string[];
  /** Dot badge (e.g. unread). */
  badge?: boolean;
  active?: boolean;
};

export type IconRailProps = {
  items: RailItem[];
  /** Items pinned to the bottom (actions such as data quality). */
  footer?: RailItem[];
  ariaLabel: string;
  layoutId?: string;
  className?: string;
  children?: ReactNode;
};

const isActive = (path: string, it: RailItem) => {
  if (it.active !== undefined) return it.active;
  const targets = [it.to, ...(it.match ?? [])].filter(Boolean) as string[];
  return targets.some((t) => (t === "/" ? path === "/" : path === t || path.startsWith(`${t}/`)));
};

/** 60px vertical icon rail (no longer used by the Shell in v3: navigation lives in the header). Flat white, ink active pill. */
export function IconRail({ items, footer = [], ariaLabel, layoutId = "rail-active", className = "", children }: IconRailProps) {
  const { pathname } = useLocation();
  const render = (it: RailItem) => {
    const on = isActive(pathname, it);
    const inner = (
      <>
        {on && <motion.span layoutId={layoutId} className="absolute inset-0 rounded-full bg-ink" transition={SPRING} aria-hidden />}
        <it.icon size={18} className={`relative transition-colors ${on ? "text-ink-on" : "text-muted group-hover:text-ink"}`} aria-hidden />
        {it.badge && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-signal ring-2 ring-surface" aria-hidden />}
      </>
    );
    const cls = "group relative w-10 h-10 grid place-items-center rounded-full transition-colors hover:bg-tile";
    return (
      <li key={it.key}>
        <Tooltip content={it.label} placement="right" delay={250} closeDelay={0} offset={10}
                 classNames={{ content: "bg-ink text-ink-on text-xs font-medium px-2.5 py-1 rounded-full" }}>
          {it.to ? (
            <NavLink to={it.to} end={it.to === "/"} aria-label={it.label} aria-current={on ? "page" : undefined} className={cls}>{inner}</NavLink>
          ) : (
            <button type="button" onClick={it.onPress} aria-label={it.label} className={cls}>{inner}</button>
          )}
        </Tooltip>
      </li>
    );
  };
  return (
    <nav aria-label={ariaLabel} className={`w-[60px] shrink-0 flex flex-col items-center gap-1 py-2 rounded-card bg-surface ${className}`}>
      <ul className="flex flex-col items-center gap-1">{items.map(render)}</ul>
      {children}
      {footer.length > 0 && (
        <>
          <div className="flex-1" />
          <div className="w-6 h-px bg-hairline my-1" aria-hidden />
          <ul className="flex flex-col items-center gap-1">{footer.map(render)}</ul>
        </>
      )}
    </nav>
  );
}
