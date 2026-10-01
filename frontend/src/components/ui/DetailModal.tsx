import { type ReactNode, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, useDisclosure } from "@heroui/react";
import { BarChart3, BookOpen, Table2 } from "lucide-react";
import { modalMotion } from "@/lib/motion";
import { PillTabs } from "./PillTabs";
import { InfoHint } from "./InfoHint";
import { usePortalContainer } from "./portal";

export type DetailTab = { key: string; label: ReactNode; content: ReactNode; count?: number; icon?: ReactNode };

export type DetailModalProps = {
  isOpen: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  title: ReactNode;
  icon?: ReactNode;
  /** Small muted line under the title (e.g. filter scope). */
  subtitle?: ReactNode;
  /** Header ⓘ content. */
  info?: ReactNode;
  size?: "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "full";
  /** Tabbed body; ignored when `children` is given. */
  tabs?: DetailTab[];
  defaultTab?: string;
  children?: ReactNode;
  footer?: ReactNode;
};

/** Detail modal (design v3): white, radius 24, one soft shadow, dimmed backdrop (no heavy blur), quick fade + scale,
 * focus trap, Esc to close. */
export function DetailModal({ isOpen, onOpenChange, onClose, title, icon, subtitle, info, size = "4xl", tabs, defaultTab, children, footer }: DetailModalProps) {
  const portal = usePortalContainer();
  return (
    <Modal isOpen={isOpen} portalContainer={portal} onOpenChange={onOpenChange} onClose={onClose} size={size} backdrop="opaque" placement="center" scrollBehavior="inside"
           motionProps={modalMotion as any}
           classNames={{
             base: "rounded-modal bg-surface shadow-float max-h-[88vh] dark:border dark:border-hairline",
             backdrop: "bg-[rgb(21_23_28/0.32)]",
             header: "px-7 pt-6 pb-2 flex items-center gap-3 pr-16",
             body: "px-7 pt-2 pb-7",
             footer: "px-7 pb-6 pt-0",
             closeButton: "top-5 right-5 w-9 h-9 rounded-full border border-hairline text-ink hover:bg-tile active:bg-tile-hover",
           }}>
      <ModalContent>
        {() => (
          <>
            <ModalHeader>
              {icon && <span className="w-9 h-9 shrink-0 rounded-full border border-hairline text-ink grid place-items-center [&_svg]:w-[17px] [&_svg]:h-[17px]" aria-hidden>{icon}</span>}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <h2 className="text-[22px] leading-[28px] font-semibold tracking-[-0.01em] text-ink truncate">{title}</h2>
                  {info && <InfoHint content={info} label={`About ${typeof title === "string" ? title : "this view"}`} />}
                </div>
                {subtitle && <div className="text-label text-muted mt-0.5">{subtitle}</div>}
              </div>
            </ModalHeader>
            <ModalBody>{children ?? (tabs?.length ? <TabbedBody tabs={tabs} defaultTab={defaultTab} /> : null)}</ModalBody>
            {footer && <ModalFooter>{footer}</ModalFooter>}
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

function TabbedBody({ tabs, defaultTab }: { tabs: DetailTab[]; defaultTab?: string }) {
  const [sel, setSel] = useState(defaultTab ?? tabs[0].key);
  if (tabs.length === 1) return <>{tabs[0].content}</>;
  return (
    <PillTabs ariaLabel="Detail views" selectedKey={sel} onSelectionChange={setSel} size="sm"
              items={tabs.map((t) => ({ key: t.key, label: t.label, count: t.count, icon: t.icon, content: <div className="min-w-0">{t.content}</div> }))} />
  );
}

export type ChartDetailProps = { chart?: ReactNode; table?: ReactNode; method?: ReactNode; notes?: ReactNode; defaultTab?: "chart" | "table" | "method" };

/** Standard Chart / Table / Method tab set for a chart card's detail modal. */
export function chartDetailTabs({ chart, table, method, notes }: Omit<ChartDetailProps, "defaultTab">): DetailTab[] {
  const out: DetailTab[] = [];
  if (chart) out.push({ key: "chart", label: "Chart", icon: <BarChart3 size={13} aria-hidden />, content: chart });
  if (table) out.push({ key: "table", label: "Table", icon: <Table2 size={13} aria-hidden />, content: <div className="overflow-auto max-h-[60vh] rounded-tile bg-surface">{table}</div> });
  if (method || notes) out.push({
    key: "method", label: "Method", icon: <BookOpen size={13} aria-hidden />,
    content: (
      <div className="max-w-[680px] text-[14px] leading-[22px] text-ink/90 flex flex-col gap-3">
        {method && <div>{method}</div>}
        {notes && <div className="text-muted">{notes}</div>}
      </div>
    ),
  });
  return out;
}

/** Tabbed Chart / Table / Method body (use as DetailModal children). */
export function ChartDetail({ defaultTab, ...rest }: ChartDetailProps) {
  const tabs = chartDetailTabs(rest);
  if (!tabs.length) return null;
  return <TabbedBody tabs={tabs} defaultTab={defaultTab && tabs.some((t) => t.key === defaultTab) ? defaultTab : undefined} />;
}

/** Disclosure state for a DetailModal: `const d = useDetailModal(); <Button onPress={d.open} /> <DetailModal {...d.modalProps} … />`. */
export function useDetailModal(defaultOpen = false) {
  const d = useDisclosure({ defaultOpen });
  return { isOpen: d.isOpen, open: d.onOpen, close: d.onClose, toggle: () => (d.isOpen ? d.onClose() : d.onOpen()),
           modalProps: { isOpen: d.isOpen, onOpenChange: d.onOpenChange } };
}
