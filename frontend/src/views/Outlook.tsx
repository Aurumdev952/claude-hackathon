import { useState } from "react";
import { Telescope } from "lucide-react";
import { BentoGrid, Card, GridItem, PageHeader } from "@/components/ui";
import { VideoButton } from "@/components/video";
import { useFilters } from "@/state/filters";
import { useRole } from "@/state/role";
import type { FcMetric } from "./outlook/api";
import { OutlookHero } from "./outlook/Hero";
import { DriversCard } from "./outlook/Drivers";
import { ScenarioCard } from "./outlook/Scenario";
import { RiskFactorsCard } from "./outlook/RiskFactors";
import { ProjectedMapCard } from "./outlook/ProjectedMap";
import { CapacityCard } from "./outlook/Capacity";

/** Ministry reel parameters from the persistent filter bar (period, sex, age band, case definition). */
export function useReelParams() {
  const f = useFilters();
  return { from: f.yearFrom, to: f.yearTo, sex: f.sex, age: f.ageBand, def: f.caseDef };
}

/** v3 Outlook (plan §5c): where gastric cancer is heading to 2031, why, and what could change it. Ministry only. */
export default function Outlook() {
  const role = useRole((s) => s.role);
  const [metric, setMetric] = useState<FcMetric>("cases");
  const reel = useReelParams();
  if (role !== "ministry") return <MinistryOnly title="Outlook to 2031" />;
  return (
    <div className="flex flex-col gap-5 min-w-0" data-testid="outlook">
      <PageHeader icon={<Telescope size={18} />} title="Outlook to 2031"
        info={{
          about: "Where gastric cancer is heading in Rwanda: a forecast of national cases and rates to 2031, the reasons behind the change, the risk factors that drive it, and what prevention or earlier diagnosis could change.",
          method: "Forecasts use the synthetic national cancer registry (2000 onwards) with population projections; they are refitted every 30 simulated days, and every past forecast is backtested.",
          notes: "Synthetic data throughout. Projections are model estimates, and scenario effects are associations, not causal effects.",
        }}
        actions={<VideoButton kind="ministry" params={reel} title="Surveillance reel" />} />
      <BentoGrid>
        <GridItem span={{ lg: 8 }}><OutlookHero metric={metric} setMetric={setMetric} /></GridItem>
        <GridItem span={{ lg: 4 }}><DriversCard /></GridItem>
        <GridItem span={12}><ScenarioCard /></GridItem>
        <GridItem span={12}><RiskFactorsCard /></GridItem>
        <GridItem span={{ lg: 5 }}><ProjectedMapCard /></GridItem>
        <GridItem span={{ lg: 7 }}><CapacityCard /></GridItem>
      </BentoGrid>
    </div>
  );
}

/** Shown when a doctor or patient opens a ministry-only view through a direct link. */
export function MinistryOnly({ title }: { title: string }) {
  const setRole = useRole((s) => s.setRole);
  return (
    <div className="flex flex-col gap-5 min-w-0">
      <PageHeader title={title} />
      <Card title="This is a ministry view" info="Ministry views show aggregates only, with small cells suppressed. Doctors see patient-level data for their own facility in the Patients view.">
        <p className="text-[15px] text-ink/90 max-w-[560px]">Switch to the ministry role to see national aggregates.</p>
        <button type="button" onClick={() => setRole("ministry")} className="mt-4 h-10 px-4 rounded-full bg-ink text-ink-on text-[14px] font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">View as ministry</button>
      </Card>
    </div>
  );
}
