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
  /** light = grey track + ink pill (white text), for controls inside cards; surface = white track + grey pill with ink
   * text, the quiet look for controls sitting on the page background (filter row); navy = no track, plain text tabs + ink pill (top nav);
   * glass = grey track + white pill (quiet, e.g. over a stage). */
  variant?: "light" | "surface" | "navy" | "glass";
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
    tabList: "bg-tile",
    cursor: "bg-ink dark:bg-ink shadow-none",
    /** Selected background drawn on the tab itself when HeroUI drops the cursor (disableAnimation / reduced motion). */
    still: "data-[selected=true]:bg-ink",
    text: "text-muted group-data-[selected=true]:text-ink-on group-data-[hover-unselected=true]:text-ink",
    count: "bg-ink/5 text-muted group-data-[selected=true]:bg-ink-on/20 group-data-[selected=true]:text-ink-on",
  },
  surface: {
    tabList: "bg-surface",
    cursor: "bg-tile-hover dark:bg-tile-hover shadow-none",
    still: "data-[selected=true]:bg-tile-hover",
    text: "text-muted group-data-[selected=true]:text-ink group-data-[selected=true]:font-semibold group-data-[hover-unselected=true]:text-ink",
    count: "bg-ink/5 text-muted",
  },
  navy: {
    tabList: "bg-transparent",
    cursor: "bg-ink dark:bg-ink shadow-none",
    still: "data-[selected=true]:bg-ink",
    text: "text-muted group-data-[selected=true]:text-ink-on group-data-[hover-unselected=true]:text-ink",
    count: "bg-ink/5 text-muted group-data-[selected=true]:bg-ink-on/20 group-data-[selected=true]:text-ink-on",
  },
  glass: {
    tabList: "bg-tile",
    cursor: "bg-surface dark:bg-hairline shadow-none",
    still: "data-[selected=true]:bg-surface dark:data-[selected=true]:bg-hairline",
    text: "text-muted group-data-[selected=true]:text-ink group-data-[hover-unselected=true]:text-ink",
    count: "bg-ink/5 text-muted group-data-[selected=true]:bg-signal-soft group-data-[selected=true]:text-signal-text",
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
        tabList: `${variant === "navy" ? "p-0 gap-1" : "p-1 gap-0.5"} ${look.tabList}`,
        tab: `${size === "sm" ? "h-8 px-3.5" : "h-10 px-4"} data-[focus-visible=true]:outline-signal data-[focus-visible=true]:outline-2 data-[focus-visible=true]:outline-offset-2 ${still ? look.still : ""} ${tabClassName}`,
        tabContent: `${look.text} font-medium ${size === "sm" ? "text-[13px]" : "text-[14px]"} transition-colors`,
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
  variant?: "light" | "surface" | "glass";
  className?: string;
};

/** Segmented control with the PillTabs look but the original `Seg` semantics (role="group" + aria-pressed buttons),
 * so existing views and e2e selectors keep working. Grey track; light = ink pill, glass = white pill. Sliding pill via a
 * shared layoutId. */
export function Seg<T extends string>({ value, options, onChange, label, size = "sm", variant = "light", className = "" }: SegProps<T>) {
  const id = useId();
  const pill = variant === "glass" ? "bg-surface dark:bg-hairline" : variant === "surface" ? "bg-tile-hover" : "bg-ink";
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-full p-1 ${variant === "surface" ? "bg-surface" : "bg-tile"} ${className}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} title={o.title} onClick={() => onChange(o.value)}
                  className={`relative rounded-full ${size === "sm" ? "h-7 px-3 text-[13px]" : "h-8 px-4 text-[14px]"} font-medium transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal
                    ${on ? (variant === "light" ? "text-ink-on" : "text-ink font-semibold") : "text-muted hover:text-ink"}`}>
            {on && <motion.span layoutId={`seg-${id}`} className={`absolute inset-0 rounded-full ${pill}`} transition={SPRING} aria-hidden />}
            <span className="relative whitespace-nowrap">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
