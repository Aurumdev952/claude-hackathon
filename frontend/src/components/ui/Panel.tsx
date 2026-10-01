/** Compatibility shim (plan §A5 phase 1): the old Panel API rendered with the v2 kit, so every existing panel migrates
 * at once. subtitle + method → ⓘ InfoHint; the table toggle → a "View as table" button that opens a DetailModal with
 * Chart / Table / Method tabs. New code should use Card / MetricCard / DetailModal directly. */
import type { ReactNode } from "react";
import { Button } from "@heroui/react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Card } from "./Card";
import { DetailModal, chartDetailTabs, useDetailModal } from "./DetailModal";

export { DataTable } from "./DataTable";
export { Seg } from "./PillTabs";
export { Loading } from "./Skeleton";

export function Panel({ title, method, children, table, className = "", actions, subtitle, icon, info }: {
  title: ReactNode; method?: ReactNode; children: ReactNode; table?: ReactNode; className?: string; actions?: ReactNode; subtitle?: ReactNode;
  icon?: ReactNode; info?: ReactNode;
}) {
  const d = useDetailModal();
  const hasInfo = !!(subtitle || method || info);
  return (
    <Card title={title} icon={icon} className={className}
          info={hasInfo ? { about: info ?? subtitle, method, notes: info && subtitle ? subtitle : undefined } : undefined}
          actions={(actions || table) ? (
            <>
              {actions}
              {table && (
                <Button isIconOnly size="sm" radius="full" variant="flat" aria-label="View as table" title="Details: chart, table, method" onPress={d.open}
                        className="min-w-8 w-8 h-8 bg-surface-2 border border-border text-fg-muted data-[hover=true]:text-fg data-[hover=true]:bg-surface">
                  <ChevronRight size={16} aria-hidden />
                </Button>
              )}
            </>
          ) : undefined}>
      {children}
      {table && (
        <DetailModal {...d.modalProps} title={title} icon={icon} info={subtitle} defaultTab="table"
                     tabs={chartDetailTabs({ chart: <div className="min-w-0">{children}</div>, table, method })} />
      )}
    </Card>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className="flex items-start gap-2 text-xs text-tone-danger p-3 rounded-tile border border-danger/30 bg-danger/10">
      <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden />{msg}
    </div>
  );
}
