import { useMemo, useState } from "react";
import { Select, SelectItem } from "@heroui/react";
import { ClipboardCheck, Filter } from "lucide-react";
import { useStatus } from "@/api/hooks";
import { BentoGrid, Card, chartDetailTabs, DataTable, GridItem, Loading, PageHeader, Seg, StatTile, usePortalContainer } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { fmt } from "@/lib/format";
import { useLive } from "@/state/live";
import { useRole } from "@/state/role";
import { useOperational } from "./outlook/api";
import { MinistryOnly } from "./Outlook";
import { FUNNEL_STEPS, STEP_LABEL, useFunnel, usePathways, type Funnel } from "./programme/api";
import { AdherenceCard, ChwCard, Empty, FunnelBars, ImpactCard } from "./programme/Cards";

type Period = "all" | "12m" | "3m";

/** Start of the period (ISO date) relative to the simulated "today". */
function periodFrom(p: Period, sim: string | null | undefined): string | null {
  if (p === "all" || !sim) return null;
  const t = new Date(sim.slice(0, 10));
  t.setUTCMonth(t.getUTCMonth() - (p === "12m" ? 12 : 3));
  return t.toISOString().slice(0, 10);
}

/** v3 Follow-up programme (plan §8): how flagged patients move through care coordination, who follows through, the CHW
 * workload and the (associational) impact on stage and survival. Ministry aggregates only, small cells as "<5". */
export default function CareProgramme() {
  const role = useRole((s) => s.role);
  const st = useStatus();
  const live = useLive();
  const sim = live.simTime ?? st.data?.meta?.sim_time;
  const [period, setPeriod] = useState<Period>("all");
  const [district, setDistrict] = useState<string | null>(null);
  if (role !== "ministry") return <MinistryOnly title="Follow-up programme" />;
  return (
    <div className="flex flex-col gap-5 min-w-0" data-testid="programme">
      <PageHeader icon={<ClipboardCheck size={18} />} title="Follow-up programme"
        info={{
          about: "Care coordination from flag to diagnosis: doctors approve high-risk flags into care plans, patients are reminded by app, SMS and community health workers, and the EMR records whether they acted.",
          method: "Counts come from the care engine's plans, tasks and notifications, reconciled against EMR evidence (endoscopies, labs, visits) at every simulated day.",
          notes: "Synthetic data. The ministry sees aggregates only; any count under 5 is shown as \"<5\".",
        }}
        right={<div className="flex items-center gap-2">
          <Seg label="Period" variant="surface" value={period} onChange={setPeriod} options={[{ value: "all", label: "All time" }, { value: "12m", label: "12 months" }, { value: "3m", label: "3 months" }]} />
        </div>} />
      <BentoGrid>
        <GridItem span={{ lg: 8 }}><FunnelCard from={periodFrom(period, sim)} to={sim?.slice(0, 10) ?? null} district={district} setDistrict={setDistrict} /></GridItem>
        <GridItem span={{ lg: 4 }}><ImpactCard /></GridItem>
        <GridItem span={{ lg: 6 }}><AdherenceCard /></GridItem>
        <GridItem span={{ lg: 6 }}><ChwCard /></GridItem>
      </BentoGrid>
    </div>
  );
}

const rate = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || !b ? null : (100 * a) / b);

function FunnelCard({ from, to, district, setDistrict }: { from: string | null; to: string | null; district: string | null; setDistrict: (d: string | null) => void }) {
  const portal = usePortalContainer();
  const q = useFunnel({ from, to, district });
  const pw = usePathways();
  const ops = useOperational();
  const names = useMemo(() => Object.fromEntries((ops.data?.data.capacity_by_district ?? []).map((d) => [d.district_code, d.name])), [ops.data]);
  const f = q.data?.data;
  const n = (s: string) => f?.steps.find((x) => x.step === s)?.n ?? null;
  const approvedShare = rate(n("approved"), n("flagged")), attendedShare = rate(n("attended"), n("notified")), endoShare = rate(n("endoscopy"), n("attended"));
  const empty = f && f.steps.every((s) => s.n === 0);
  const tbl = (rows: Funnel["by_district"] | Funnel["by_pathway"], key: "district_code" | "pathway") => (
    <DataTable ariaLabel={key === "pathway" ? "Funnel by pathway" : "Funnel by district"} rows={rows as any[]} columns={[
      { key, label: key === "pathway" ? "Pathway" : "District", fmt: (v) => (key === "pathway" ? pw.data?.data.find((p) => p.id === v)?.name ?? v : names[v] ?? v) },
      ...FUNNEL_STEPS.map((s) => ({ key: s, label: STEP_LABEL[s], num: true, fmt: (v: number | null, r: any) => (v === null ? r[`${s}_label`] ?? "<5" : v) }))]} />
  );
  return (
    <Card title="From flag to diagnosis" icon={<Filter size={16} />} className="h-full" aria-label="Care funnel"
          actions={
            <Select aria-label="District" size="sm" radius="full" selectedKeys={new Set([district ?? "ALL"])} popoverProps={{ portalContainer: portal }}
                    onSelectionChange={(k) => { const v = [...(k as Set<string>)][0]; setDistrict(!v || v === "ALL" ? null : v); }}
                    classNames={{ base: "w-[180px] max-sm:w-[132px]", trigger: "bg-tile data-[hover=true]:bg-tile-hover shadow-none h-8 min-h-8", value: "text-[13px]" }}
                    items={[{ code: "ALL", name: "All districts" }, ...Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => ({ code, name }))]}>
              {(it) => <SelectItem key={it.code}>{it.name}</SelectItem>}
            </Select>}
          detail={f ? { tabs: [
            ...chartDetailTabs({ table: tbl(f.by_district, "district_code") }).map((t) => ({ ...t, label: "By district" })),
            ...chartDetailTabs({ table: tbl(f.by_pathway, "pathway") }).map((t) => ({ ...t, key: "pathway", label: "By pathway" })),
            ...chartDetailTabs({ method: "Flagged: HIGH-risk alerts raised in the period. Approved: turned into a care plan by a doctor. Notified: at least one message sent (app, SMS or CHW). Attended: the patient came for the first care step. Endoscopy: an endoscopy reached the EMR. Cancer found / early stage: a diagnosis after the plan, at stage I or II.", notes: "Percentages are the conversion from the previous step. Counts under 5 are suppressed, so a later step can look larger than a suppressed earlier one." }),
          ] } : undefined}
          detailLabel="Care funnel: details">
      {q.isLoading ? <Loading h={300} /> : q.error ? <ErrorNote error={q.error} /> : f ? (
        empty ? <Empty h={260}>No flags in this period{district ? ` for ${names[district] ?? district}` : ""}. Pick a longer period or another district.</Empty> : (
          <div className="flex flex-col gap-5">
            <FunnelBars funnel={f} />
            <div className="grid grid-cols-3 gap-2.5">
              <StatTile label="Flags approved" value={approvedShare === null ? "<5" : `${fmt(approvedShare, 0)}%`} sub="Of HIGH flags" />
              <StatTile label="Attended" value={attendedShare === null ? "<5" : `${fmt(attendedShare, 0)}%`} sub="Of notified patients" />
              <StatTile label="Scoped" value={endoShare === null ? "<5" : `${fmt(endoShare, 0)}%`} sub="Of those who attended" />
            </div>
          </div>
        )
      ) : null}
    </Card>
  );
}
