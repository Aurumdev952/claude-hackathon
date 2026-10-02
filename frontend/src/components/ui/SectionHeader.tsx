import type { ReactNode } from "react";
import { InfoHint, type InfoHintProps } from "./InfoHint";

type Info = ReactNode | Pick<InfoHintProps, "about" | "method" | "notes" | "content">;
const infoProps = (info: Info, title: ReactNode, label: string) =>
  info && typeof info === "object" && !("$$typeof" in (info as object)) && !Array.isArray(info)
    ? { ...(info as object), title, label } : { content: info as ReactNode, title, label };

/** Section row inside a page or column (reference "Cardiovascular System" + risk score on the right). */
export function SectionHeader({ title, icon, info, actions, right, className = "", as: H = "h2" }: {
  title: ReactNode; icon?: ReactNode; info?: Info; actions?: ReactNode; right?: ReactNode; className?: string; as?: "h2" | "h3";
}) {
  return (
    <div className={`flex items-center gap-3 min-w-0 ${className}`}>
      {icon && <span className="w-9 h-9 shrink-0 rounded-full border border-hairline text-ink grid place-items-center [&_svg]:w-[17px] [&_svg]:h-[17px]" aria-hidden>{icon}</span>}
      <div className="flex items-center gap-0.5 min-w-0">
        <H className="text-[20px] leading-7 font-semibold tracking-[-0.01em] text-ink truncate">{title}</H>
        {info ? <InfoHint {...infoProps(info, title, `About ${typeof title === "string" ? title : "this section"}`)} /> : null}
      </div>
      {right && <div className="flex-1 min-w-0">{right}</div>}
      {!right && <div className="flex-1" />}
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** Page title row: title (28/34), lede moved into ⓘ, right-side actions. `eyebrow` is rendered as a small muted line
 * under the title (v3 bans eyebrows above headings). */
export function PageHeader({ title, eyebrow, info, lede, actions, right, icon, className = "" }: {
  title: ReactNode; eyebrow?: ReactNode; info?: Info; lede?: ReactNode; actions?: ReactNode; right?: ReactNode; icon?: ReactNode; className?: string;
}) {
  const hint = info ?? lede;
  return (
    <header className={`flex items-center gap-4 flex-wrap min-w-0 ${className}`}>
      {icon && <span className="w-10 h-10 shrink-0 rounded-full border border-hairline bg-surface text-ink grid place-items-center [&_svg]:w-[18px] [&_svg]:h-[18px]" aria-hidden>{icon}</span>}
      <div className={`min-w-0 flex-1 ${icon ? "max-sm:basis-[calc(100%-56px)]" : "max-sm:basis-full"}`}>
        <div className="flex items-center gap-0.5 min-w-0">
          <h1 className="text-h1 text-ink sm:truncate max-sm:text-[22px] max-sm:leading-7">{title}</h1>
          {hint ? <InfoHint {...infoProps(hint, title, `About ${typeof title === "string" ? title : "this page"}`)} placement="bottom-start" /> : null}
        </div>
        {eyebrow && <div className="text-label text-muted mt-0.5">{eyebrow}</div>}
      </div>
      {right && <div className="max-w-full min-w-0 overflow-x-auto scrollbar-none -my-1 py-1">{right}</div>}
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
