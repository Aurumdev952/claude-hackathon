import { Button, Popover, PopoverContent, PopoverTrigger, Select, SelectItem } from "@heroui/react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { useFiltersMeta } from "@/api/hooks";
import { PillTabs } from "@/components/ui/PillTabs";
import { useFilters, type Filters } from "@/state/filters";

const selectCls = {
  trigger: "bg-surface border border-border shadow-tile data-[hover=true]:bg-surface-2 h-9 min-h-9 rounded-full",
  value: "text-[13px] text-fg",
  popoverContent: "bg-surface border border-border shadow-float rounded-tile",
};

/** Ministry filter row (plan §A3): period popover, pill tabs for sex / age band / rate, case-definition select. Writes useFilters. */
export function FilterPills() {
  const f = useFilters();
  const meta = useFiltersMeta();
  const years: number[] = meta.data?.data?.years ?? Array.from({ length: 12 }, (_, i) => 2015 + i);
  const yearItems = years.map((y) => ({ key: String(y), label: String(y) }));
  return (
    <div className="flex flex-wrap items-center gap-2.5 pb-4" role="toolbar" aria-label="Filters">
      <Popover placement="bottom-start" offset={8} classNames={{ content: "bg-surface border border-border shadow-float rounded-tile p-0" }}>
        <PopoverTrigger>
          <Button size="sm" radius="full" variant="flat" aria-label={`Period ${f.yearFrom} to ${f.yearTo}`}
                  className="h-9 px-3.5 bg-surface border border-border shadow-tile text-fg text-[13px] font-medium data-[hover=true]:bg-surface-2"
                  startContent={<CalendarRange size={15} className="text-accent" aria-hidden />} endContent={<ChevronDown size={14} className="text-fg-muted" aria-hidden />}>
            <span className="tabular">{f.yearFrom} – {f.yearTo}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="p-3.5 w-[280px]">
            <div className="text-label font-medium text-fg-muted mb-2">Period</div>
            <div className="flex items-center gap-2">
              <Select aria-label="From year" size="sm" radius="full" items={yearItems} selectedKeys={[String(f.yearFrom)]} disallowEmptySelection classNames={selectCls}
                      onChange={(e) => e.target.value && f.set({ yearFrom: Number(e.target.value) })}>
                {(i) => <SelectItem key={i.key}>{i.label}</SelectItem>}
              </Select>
              <span className="text-fg-muted" aria-hidden>–</span>
              <Select aria-label="To year" size="sm" radius="full" items={yearItems} selectedKeys={[String(f.yearTo)]} disallowEmptySelection classNames={selectCls}
                      onChange={(e) => e.target.value && f.set({ yearTo: Number(e.target.value) })}>
                {(i) => <SelectItem key={i.key}>{i.label}</SelectItem>}
              </Select>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <PillTabs ariaLabel="Sex" size="sm" selectedKey={f.sex} onSelectionChange={(v) => f.set({ sex: v as Filters["sex"] })}
                items={[{ key: "ALL", label: "All" }, { key: "F", label: "Female" }, { key: "M", label: "Male" }]} />
      <PillTabs ariaLabel="Age band" size="sm" selectedKey={f.ageBand} onSelectionChange={(v) => f.set({ ageBand: v as Filters["ageBand"] })}
                items={[{ key: "ALL", label: "All ages" }, { key: "<50", label: "<50" }, { key: "50-64", label: "50–64" }, { key: "65+", label: "65+" }]} />
      <PillTabs ariaLabel="Rate" size="sm" selectedKey={f.metric} onSelectionChange={(v) => f.set({ metric: v as Filters["metric"] })}
                items={[{ key: "asr", label: "Age-standardised" }, { key: "crude_rate", label: "Crude" }]} />
      <Select aria-label="Case definition" size="sm" radius="full" className="w-[210px]" selectedKeys={[f.caseDef]} disallowEmptySelection classNames={selectCls}
              onChange={(e) => e.target.value && f.set({ caseDef: e.target.value as Filters["caseDef"] })}>
        <SelectItem key="CONFIRMED_PROBABLE">Confirmed + probable</SelectItem>
        <SelectItem key="CONFIRMED">Confirmed only</SelectItem>
      </Select>
    </div>
  );
}
