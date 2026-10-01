import type { ReactNode } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@heroui/react";
import { Info } from "lucide-react";

export type InfoHintProps = {
  /** Free-form content (shown under "About" when other sections are present). */
  content?: ReactNode;
  about?: ReactNode;
  method?: ReactNode;
  notes?: ReactNode;
  /** Heading at the top of the popover (usually the card title). */
  title?: ReactNode;
  /** Accessible name of the ⓘ trigger. */
  label?: string;
  /** popover (default) = click/keyboard dialog with sections; tooltip = hover/focus one-liner. */
  mode?: "popover" | "tooltip";
  placement?: "top" | "bottom" | "left" | "right" | "top-start" | "top-end" | "bottom-start" | "bottom-end";
  size?: number;
  className?: string;
};

const has = (x: ReactNode) => x !== undefined && x !== null && x !== false && x !== "";

/** ⓘ info icon (plan §A2): absorbs the subtitles, method notes, captions and disclaimers that used to sit on screen. */
export function InfoHint({ content, about, method, notes, title, label = "More information", mode = "popover", placement = "bottom-end", size = 15, className = "" }: InfoHintProps) {
  const aboutBody = has(about) ? about : content;
  const sections = ([["About", aboutBody], ["Method", method], ["Notes", notes]] as const).filter(([, v]) => has(v));
  if (!sections.length) return null;
  const trigger = (
    <Button isIconOnly size="sm" variant="light" radius="full" aria-label={label}
            className={`min-w-7 w-7 h-7 text-fg-muted data-[hover=true]:text-fg data-[hover=true]:bg-fg/5 ${className}`}>
      <Info size={size} aria-hidden />
    </Button>
  );
  if (mode === "tooltip") {
    return (
      <Tooltip content={<div className="max-w-[260px] text-xs leading-relaxed">{sections.map(([, v]) => v)[0]}</div>} placement={placement} delay={150} closeDelay={60}
               classNames={{ content: "bg-surface text-fg border border-border shadow-float rounded-tile px-3 py-2" }}>
        {trigger}
      </Tooltip>
    );
  }
  const single = sections.length === 1 && sections[0][0] === "About";
  return (
    <Popover placement={placement} showArrow offset={8} backdrop="transparent"
             classNames={{ content: "p-0 bg-surface border border-border shadow-float rounded-tile", base: "before:bg-surface" }}>
      <PopoverTrigger>{trigger}</PopoverTrigger>
      <PopoverContent>
        <div className="w-[320px] max-w-[86vw] px-4 py-3.5 text-[12.5px] leading-relaxed text-fg">
          {has(title) && <div className="text-title mb-1.5">{title}</div>}
          <div className="flex flex-col gap-2.5">
            {sections.map(([h, v]) => (
              <section key={h}>
                {!single && <h4 className="text-micro font-semibold uppercase tracking-wide text-fg-muted mb-0.5">{h}</h4>}
                <div className="text-fg/90">{v}</div>
              </section>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
