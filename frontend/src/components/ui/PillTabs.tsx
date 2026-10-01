import { type Key, type MouseEvent, type ReactNode, useId } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Tab, Tabs } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { SPRING } from "@/lib/motion";

export type PillTabItem<K extends string = string> = {
  key: K;
  label: ReactNode;
  count?: number | null;
  icon?: ReactNode;
  /** Router link (HeroUI uses the Providers' navigate). */
  href?: string;
  /** Panel content; omit when the tabs only switch state elsewhere. */
  content?: ReactNode;
  isDisabled?: boolean;
  /** Accessible title override (when the label is not plain text). */
  title?: string;
};

export type PillTabsProps<K extends string = string> = {
  items: PillTabItem<K>[];
  selectedKey: K;
  onSelectionChange?: (key: K) => void;
  /** light = grey track + white pill; navy = white track + navy pill (top nav); glass = frosted track over a stage. */
  variant?: "light" | "navy" | "glass";
  size?: "sm" | "md";
  ariaLabel: string;
  fullWidth?: boolean;
  className?: string;
  panelClassName?: string;
  /** Extra classes for every tab (e.g. tighter padding). */
  tabClassName?: string;
};

const LOOK = {
  light: {
    tabList: "bg-surface-2 border border-border",
    cursor: "bg-surface dark:bg-content3 shadow-tile",
    /** Selected background drawn on the tab itself when HeroUI drops the cursor (disableAnimation / reduced motion). */
    still: "data-[selected=true]:bg-surface dark:data-[selected=true]:bg-content3 data-[selected=true]:shadow-tile",
    text: "text-fg-muted group-data-[selected=true]:text-fg group-data-[hover-unselected=true]:text-fg",
    count: "bg-fg/5 text-fg-muted group-data-[selected=true]:bg-accent-soft group-data-[selected=true]:text-accent",
  },
  navy: {
    tabList: "bg-surface border border-border shadow-tile",
    cursor: "bg-nav dark:bg-nav shadow-[0_6px_16px_-6px_rgb(var(--nav)/0.55)]",
    still: "data-[selected=true]:bg-nav dark:data-[selected=true]:bg-nav data-[selected=true]:shadow-[0_6px_16px_-6px_rgb(var(--nav)/0.55)]",
    text: "text-fg-muted group-data-[selected=true]:text-nav-fg group-data-[hover-unselected=true]:text-fg",
    count: "bg-fg/5 text-fg-muted group-data-[selected=true]:bg-nav-fg/20 group-data-[selected=true]:text-nav-fg",
  },
  glass: {
    tabList: "glass shadow-tile",
    cursor: "bg-accent dark:bg-accent shadow-[0_6px_16px_-6px_rgb(var(--accent)/0.6)]",
    still: "data-[selected=true]:bg-accent dark:data-[selected=true]:bg-accent",
    text: "text-fg-muted group-data-[selected=true]:text-white group-data-[hover-unselected=true]:text-fg",
    count: "bg-fg/5 text-fg-muted group-data-[selected=true]:bg-white/25 group-data-[selected=true]:text-white",
  },
} as const;

/** Pill tabs (plan §A2) on HeroUI Tabs: rounded-full track, sliding cursor, optional count chips. role="tablist". */
export function PillTabs<K extends string = string>({ items, selectedKey, onSelectionChange, variant = "light", size = "md", ariaLabel, fullWidth, className = "", panelClassName = "", tabClassName = "" }: PillTabsProps<K>) {
  const look = LOOK[variant];
  // Providers sets HeroUI's global disableAnimation under reduced motion, which removes the sliding cursor: paint the
  // selected pill on the tab instead so the active state (e.g. white text on navy) is always visible.
  const still = useReducedMotion();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Tabs
      aria-label={ariaLabel}
      selectedKey={selectedKey}
      onSelectionChange={(k: Key) => onSelectionChange?.(String(k) as K)}
      variant="solid"
      radius="full"
      size={size}
      fullWidth={fullWidth}
      disabledKeys={items.filter((i) => i.isDisabled).map((i) => i.key)}
      classNames={{
        base: className,
        tabList: `p-1 gap-0.5 ${look.tabList}`,
        tab: `${size === "sm" ? "h-7 px-3" : "h-9 px-4"} data-[focus-visible=true]:outline-accent ${still ? look.still : ""} ${tabClassName}`,
        tabContent: `${look.text} font-medium ${size === "sm" ? "text-xs" : "text-[13px]"} transition-colors`,
        cursor: look.cursor,
        panel: `px-0 pt-3 pb-0 ${panelClassName}`,
      }}
    >
      {items.map((i) => (
        <Tab key={i.key} href={i.href} onClick={i.href ? (e: MouseEvent<HTMLElement>) => {
          // client-side routing (modifier clicks keep the browser's open-in-new-tab behaviour)
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          if (`${location.pathname}${location.search}` !== i.href) navigate(i.href!);
        } : undefined} title={
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={i.title}>
            {i.icon}
            <span>{i.label}</span>
            {i.count !== undefined && i.count !== null && (
              <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] leading-[18px] text-center tabular ${look.count}`}>{i.count}</span>
            )}
          </span>
        }>
          {i.content}
        </Tab>
      ))}
    </Tabs>
  );
}

export type SegProps<T extends string> = {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
  variant?: "light" | "glass";
  className?: string;
};

/** Segmented control with the PillTabs look but the original `Seg` semantics (role="group" + aria-pressed buttons),
 * so existing views and e2e selectors keep working. Sliding pill via a shared layoutId. */
export function Seg<T extends string>({ value, options, onChange, label, size = "sm", variant = "light", className = "" }: SegProps<T>) {
  const id = useId();
  const track = variant === "glass" ? "glass" : "bg-surface-2 border border-border";
  const pill = variant === "glass" ? "bg-accent" : "bg-surface shadow-tile dark:bg-content3";
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-full p-0.5 ${track} ${className}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} title={o.title} onClick={() => onChange(o.value)}
                  className={`relative rounded-full ${size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-[13px]"} font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60
                    ${on ? (variant === "glass" ? "text-white" : "text-fg") : "text-fg-muted hover:text-fg"}`}>
            {on && <motion.span layoutId={`seg-${id}`} className={`absolute inset-0 rounded-full ${pill}`} transition={SPRING} aria-hidden />}
            <span className="relative whitespace-nowrap">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
