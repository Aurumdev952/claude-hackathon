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

/** Detail modal (plan §A2): HeroUI Modal with blur backdrop, spring entrance, focus trap, Esc to close. */
export function DetailModal({ isOpen, onOpenChange, onClose, title, icon, subtitle, info, size = "4xl", tabs, defaultTab, children, footer }: DetailModalProps) {
  const portal = usePortalContainer();
  return (
    <Modal isOpen={isOpen} portalContainer={portal} onOpenChange={onOpenChange} onClose={onClose} size={size} backdrop="blur" placement="center" scrollBehavior="inside"
           motionProps={modalMotion as any}
           classNames={{
             base: "rounded-modal bg-surface border border-border shadow-float max-h-[88vh]",
             backdrop: "bg-[rgb(11_18_32/0.28)] backdrop-blur-[6px]",
             header: "px-6 pt-5 pb-1 flex items-start gap-3 pr-14",
             body: "px-6 pt-2 pb-6",
             footer: "px-6 pb-5 pt-0",
             closeButton: "top-4 right-4 rounded-full text-fg-muted hover:bg-fg/5 active:bg-fg/10",
           }}>
      <ModalContent>
        {() => (
          <>
            <ModalHeader>
              {icon && <span className="w-9 h-9 shrink-0 rounded-tile bg-accent-soft text-accent grid place-items-center">{icon}</span>}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <h2 className="text-h1 text-fg truncate">{title}</h2>
                  {info && <InfoHint content={info} label={`About ${typeof title === "string" ? title : "this view"}`} />}
                </div>
                {subtitle && <div className="text-label text-fg-muted font-normal mt-0.5">{subtitle}</div>}
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
  if (table) out.push({ key: "table", label: "Table", icon: <Table2 size={13} aria-hidden />, content: <div className="overflow-auto max-h-[60vh] rounded-tile border border-border">{table}</div> });
  if (method || notes) out.push({
    key: "method", label: "Method", icon: <BookOpen size={13} aria-hidden />,
    content: (
      <div className="max-w-[720px] text-[13px] leading-relaxed text-fg/90 flex flex-col gap-3">
        {method && <div>{method}</div>}
        {notes && <div className="text-fg-muted">{notes}</div>}
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
