import { useNavigate } from "react-router-dom";
import { ClipboardCheck, Telescope } from "lucide-react";
import { Card, Loading, StatTile } from "@/components/ui";
import { fmt, signed } from "@/lib/format";
import { FanSpark } from "../outlook/FanChart";
import { useForecastSeries } from "../outlook/api";
import { useAdherence, useFunnel, type Funnel } from "../programme/api";
import { FunnelBars } from "../programme/Cards";

const MINI_STEPS = ["approved", "notified", "attended", "endoscopy"] as const;

/** Overview card: the care-coordination funnel from approval to attendance and the median days to endoscopy. The whole
 * card opens the Follow-up programme. */
export function CareCoordinationCard() {
  const nav = useNavigate();
  const f = useFunnel({});
  const adh = useAdherence("pathway");
  const funnel = f.data?.data;
  const mini: Funnel | null = funnel ?? null;
  const endo = adh.data?.data.find((r) => r.level === "ENDOSCOPY_REFERRAL");
  const approved = funnel?.steps.find((s) => s.step === "approved");
  return (
    <Card title="Care coordination" icon={<ClipboardCheck size={16} />} className="h-full" bodyClassName="flex flex-col"
          onPress={() => nav("/programme")} pressLabel="Care coordination: open the follow-up programme">
      {f.isLoading ? <Loading h={200} /> : mini ? (
        <>
          <FunnelBars funnel={mini} compact only={MINI_STEPS} />
          <div className="grid grid-cols-2 gap-2.5 mt-auto pt-5">
            <StatTile label="Care plans" value={approved?.n === null || approved?.n === undefined ? approved?.n_label ?? "<5" : approved.n} sub="Approved from flags" />
            <StatTile label="Days to endoscopy" value={endo?.median_days === null || endo?.median_days === undefined ? (endo ? "<5" : "—") : fmt(endo.median_days, 0)}
                      unit={endo?.median_days !== null && endo?.median_days !== undefined ? "median" : undefined} sub="From approval" />
          </div>
        </>
      ) : null}
    </Card>
  );
}

/** Overview card: the national forecast to 2031 as a mini fan, with the 2031 mean and the change since 2025. The whole
 * card opens the Outlook. */
export function OutlookMiniCard() {
  const nav = useNavigate();
  const q = useForecastSeries({ metric: "cases" });
  const d = q.data?.data;
  const end = d?.forecast[d.forecast.length - 1];
  const base = d ? [...d.history].reverse().find((p) => p.mean !== null) : undefined;
  const change = end && base?.mean ? (100 * (end.mean - base.mean)) / base.mean : null;
  return (
    <Card title={`Outlook ${end?.year ?? 2031}`} icon={<Telescope size={16} />} className="h-full" bodyClassName="flex flex-col"
          onPress={() => nav("/outlook")} pressLabel="Outlook: open the forecast">
      {q.isLoading ? <Loading h={200} /> : d && end ? (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-display text-ink tabular">{Math.round(end.mean).toLocaleString("en-GB")}</span>
            <span className="text-[15px] leading-5 text-muted">cases</span>
          </div>
          <div className="text-label font-normal text-muted mt-1.5 tabular">Expected in {end.year}, {change === null ? "" : `${signed(change, 0, "%")} vs ${base?.year}`}</div>
          <div className="mt-auto pt-5"><FanSpark history={d.history} forecast={d.forecast} height={150} /></div>
          <div className="flex justify-between text-micro text-muted tabular mt-2"><span>2014</span><span>{end.year}</span></div>
        </>
      ) : <div className="text-label text-muted">No forecast published yet.</div>}
    </Card>
  );
}
