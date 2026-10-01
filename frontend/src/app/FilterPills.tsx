import { Button, Popover, PopoverContent, PopoverTrigger, Select, SelectItem } from "@heroui/react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { useFiltersMeta } from "@/api/hooks";
import { PillTabs } from "@/components/ui/PillTabs";
import { useFilters, type Filters } from "@/state/filters";

const selectCls = {
  trigger: "bg-surface shadow-none data-[hover=true]:bg-surface h-10 min-h-10 rounded-full px-4",
  value: "text-[13px] font-medium !text-ink",
  selectorIcon: "text-muted",
  popoverContent: "bg-surface shadow-float rounded-tile dark:border dark:border-hairline",
};
/** Inside the period popover the year selects sit on white, so they take the grey tile. */
const yearSelectCls = { ...selectCls, trigger: "bg-tile shadow-none data-[hover=true]:bg-tile-hover h-10 min-h-10 rounded-full px-4" };

/** Ministry filter row (design v3): one quiet row of white segmented controls on the page (period popover, sex, age band,
 * rate, case definition). Writes useFilters. */
export function FilterPills() {
  const f = useFilters();
  const meta = useFiltersMeta();
  const years: number[] = meta.data?.data?.years ?? Array.from({ length: 12 }, (_, i) => 2015 + i);
  const yearItems = years.map((y) => ({ key: String(y), label: String(y) }));
  return (
    <div className="flex flex-wrap items-center gap-2 pb-5" role="toolbar" aria-label="Filters">
      <Popover placement="bottom-start" offset={8} classNames={{ content: "bg-surface shadow-float rounded-card p-0 dark:border dark:border-hairline" }}>
        <PopoverTrigger>
          <Button size="sm" radius="full" variant="flat" aria-label={`Period ${f.yearFrom} to ${f.yearTo}`}
                  className="h-10 px-4 bg-surface text-ink text-[13px] font-medium data-[hover=true]:bg-surface gap-2"
                  startContent={<CalendarRange size={16} className="text-ink" aria-hidden />} endContent={<ChevronDown size={15} className="text-muted" aria-hidden />}>
            <span className="tabular">{f.yearFrom} to {f.yearTo}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="p-5 w-[300px]">
            <div className="text-label text-muted mb-2.5">Period</div>
            <div className="flex items-center gap-2">
              <Select aria-label="From year" size="sm" radius="full" items={yearItems} selectedKeys={[String(f.yearFrom)]} disallowEmptySelection classNames={yearSelectCls}
                      onChange={(e) => e.target.value && f.set({ yearFrom: Number(e.target.value) })}>
                {(i) => <SelectItem key={i.key}>{i.label}</SelectItem>}
              </Select>
              <span className="text-muted" aria-hidden>to</span>
              <Select aria-label="To year" size="sm" radius="full" items={yearItems} selectedKeys={[String(f.yearTo)]} disallowEmptySelection classNames={yearSelectCls}
                      onChange={(e) => e.target.value && f.set({ yearTo: Number(e.target.value) })}>
                {(i) => <SelectItem key={i.key}>{i.label}</SelectItem>}
              </Select>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <PillTabs variant="surface" ariaLabel="Sex" size="sm" selectedKey={f.sex} onSelectionChange={(v) => f.set({ sex: v as Filters["sex"] })}
                items={[{ key: "ALL", label: "All" }, { key: "F", label: "Female" }, { key: "M", label: "Male" }]} />
      <PillTabs variant="surface" ariaLabel="Age band" size="sm" selectedKey={f.ageBand} onSelectionChange={(v) => f.set({ ageBand: v as Filters["ageBand"] })}
                items={[{ key: "ALL", label: "All ages" }, { key: "<50", label: "<50" }, { key: "50-64", label: "50–64" }, { key: "65+", label: "65+" }]} />
      <PillTabs variant="surface" ariaLabel="Rate" size="sm" selectedKey={f.metric} onSelectionChange={(v) => f.set({ metric: v as Filters["metric"] })}
                items={[{ key: "asr", label: "Age-standardised" }, { key: "crude_rate", label: "Crude" }]} />
      <Select aria-label="Case definition" size="sm" radius="full" className="w-[220px]" selectedKeys={[f.caseDef]} disallowEmptySelection classNames={selectCls}
              onChange={(e) => e.target.value && f.set({ caseDef: e.target.value as Filters["caseDef"] })}>
        <SelectItem key="CONFIRMED_PROBABLE">Confirmed + probable</SelectItem>
        <SelectItem key="CONFIRMED">Confirmed only</SelectItem>
      </Select>
    </div>
  );
}
