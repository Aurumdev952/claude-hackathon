import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { CalendarClock, Pause, Play } from "lucide-react";
import { api, ApiError, get } from "@/api/client";
import { usePortalContainer } from "@/components/ui/portal";
import { Seg } from "@/components/ui/PillTabs";
import { InfoHint } from "@/components/ui/InfoHint";
import { useLive } from "@/state/live";

type Running = { id?: string; status?: string; days?: number; progress: number; step: string | null };
type Tick = { sim_time_from?: string; sim_time_to?: string; rows?: Record<string, number>; care?: Record<string, number | boolean>; seconds?: number; status?: string;
  care_world?: { summary?: Record<string, number> } };
type SimStatus = {
  sim_time: string; sim_end: string; days_left: number; running_job: Running | null; last_tick: Tick | null;
  auto: { enabled: boolean; running: boolean; paused: boolean; seconds_per_day: number; demo_mode: boolean; source?: "process" | "api" | null;
    api?: { enabled: boolean; seconds_per_day: number; next_tick_at: string | null; last_error: string | null; stopped_reason: string | null } };
};
type Job = { id: string; status: "queued" | "running" | "done" | "failed"; progress: number; step: string | null; error: string | null };

const START = Date.UTC(2026, 5, 30);   // first simulated day after the generated history (contract §3)
const PACES = [{ value: "10", label: "10 s" }, { value: "30", label: "30 s" }, { value: "60", label: "1 min" }] as const;
const day = (s: string | undefined | null, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) =>
  (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" }) : "—");
const postSim = <T,>(body: unknown) => api<T>("/admin/sim", { method: "POST", body: JSON.stringify(body) });

/** Simulation control (plan §8): a compact pill with the simulated date in the top bar, for every role. The popover
 * advances the clock by a day, a week or a month (a background job with progress), runs the auto clock at a chosen
 * pace, shows the runway to the end of the simulation and the last tick's summary. When a tick finishes, every query
 * is refetched (the WebSocket refresh only names the marts it knows about). */
export function SimControl() {
  const portal = usePortalContainer();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pace, setPace] = useState<string>("30");
  const st = useQuery({
    queryKey: ["sim", "status"], queryFn: () => get<SimStatus>("/admin/sim/status"), retry: false,
    refetchInterval: (q) => (q.state.data?.data.running_job || jobId ? 1500 : open ? 5000 : 15000),
  });
  const job = useQuery({
    queryKey: ["sim", "job", jobId], enabled: !!jobId, queryFn: () => get<Job>(`/admin/sim/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data?.data.status === "done" || q.state.data?.data.status === "failed" ? false : 1000),
  });
  const s = st.data?.data;
  const live = useLive();
  const simTime = s?.sim_time ?? live.simTime ?? null;
  const running: Running | null = (job.data?.data && (job.data.data.status === "running" || job.data.data.status === "queued")) ? job.data.data : s?.running_job ?? null;

  // a tick finished (ours or the auto clock's): the publish lands within ~2 s, then refetch everything
  const was = useRef(false);
  useEffect(() => {
    const now = !!running;
    if (was.current && !now) {
      const t1 = setTimeout(() => qc.invalidateQueries(), 2500);
      const t2 = setTimeout(() => qc.invalidateQueries(), 6000);
      was.current = now;
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    was.current = now;
  }, [!!running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const j = job.data?.data;
    if (j?.status === "failed") { setErr(j.error ?? "The tick failed"); setJobId(null); }
    if (j?.status === "done") setJobId(null);
  }, [job.data?.data.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (s?.auto?.seconds_per_day) setPace(String(PACES.find((p) => +p.value === s.auto.seconds_per_day)?.value ?? pace)); }, [s?.auto?.seconds_per_day]); // eslint-disable-line react-hooks/exhaustive-deps

  const advance = async (days: number) => {
    setErr(null);
    try { const r = await postSim<{ job_id: string }>({ action: "advance", days }); setJobId(r.data.job_id); st.refetch(); }
    catch (e) { setErr((e as ApiError).code === "SIM_BUSY" ? "A tick is already running; wait for it to finish." : (e as Error).message); }
  };
  const toggleAuto = async () => {
    setErr(null);
    try { await postSim(s?.auto.enabled ? { action: "auto_stop" } : { action: "auto_start", seconds_per_day: Number(pace) }); st.refetch(); }
    catch (e) { setErr((e as Error).message); }
  };
  const changePace = async (v: string) => {
    setPace(v);
    if (s?.auto.enabled) { try { await postSim({ action: "auto_start", seconds_per_day: Number(v) }); st.refetch(); } catch (e) { setErr((e as Error).message); } }
  };

  const end = s ? Date.parse(`${s.sim_end.slice(0, 10)}T00:00:00Z`) : null;
  const now = simTime ? Date.parse(`${simTime.slice(0, 10)}T00:00:00Z`) : null;
  const done = end && now ? Math.max(0, Math.min(1, (now - START) / (end - START))) : 0;
  const auto = !!s?.auto.enabled;
  const label = simTime ? `Sim ${day(simTime)}` : "Simulation";
  const tick = s?.last_tick;
  const rowsIn = tick?.rows ? Object.values(tick.rows).reduce((a, b) => a + (Number(b) || 0), 0) : null;
  const care = tick?.care ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-GB") : "—");

  return (
    <Popover isOpen={open} onOpenChange={setOpen} placement="bottom-end" offset={10} portalContainer={portal} backdrop="transparent"
             classNames={{ content: "p-0 bg-surface shadow-float rounded-card dark:border dark:border-hairline" }}>
      <PopoverTrigger>
        <button type="button" aria-label={`Simulation, ${simTime ? day(simTime) : "date unknown"}${running ? ", advancing" : auto ? ", auto clock on" : ""}`}
                className="h-10 shrink-0 inline-flex items-center gap-2 rounded-full bg-surface border border-hairline text-ink pl-1 pr-1 min-[2000px]:pr-3.5 hover:bg-tile transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
          <span className="relative w-8 h-8 rounded-full bg-tile grid place-items-center" aria-hidden>
            <CalendarClock size={15} />
            {(running || auto) && <span className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full border-2 border-surface ${running ? "bg-sky animate-pulseDot" : "bg-success"}`} />}
          </span>
          <span className="hidden min-[2000px]:inline text-[14px] font-medium whitespace-nowrap tabular">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="w-[340px] max-w-[92vw] px-5 py-5 text-ink" role="group" aria-label="Simulation control">
          <div className="flex items-center gap-1">
            <span className="text-label text-muted">Simulated today</span>
            <InfoHint size={13} label="About the simulation" className="!w-6 !h-6 !min-w-6"
                      content="All data are synthetic. Advancing the clock replays the EMR for the next days, lets simulated patients act on their care plans, reconciles the care engine, and re-runs the analytics and risk scores. The clock is shared by everyone using this data set." />
          </div>
          <div className="text-[28px] leading-9 font-medium tracking-[-0.01em] tabular" data-testid="sim-date">{day(simTime)}</div>
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-tile overflow-hidden" role="img" aria-label={`${Math.round(100 * done)}% of the simulated period used`}>
              <div className="h-full rounded-full bg-sky" style={{ width: `${100 * done}%` }} />
            </div>
            <div className="flex justify-between text-micro text-muted mt-1.5 tabular">
              <span>{s ? `${s.days_left.toLocaleString("en-GB")} days of runway` : "—"}</span><span>Ends {day(s?.sim_end)}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-4">
            {[[1, "+1 day"], [7, "+1 week"], [30, "+1 month"]].map(([d, l]) => (
              <Button key={l} size="sm" radius="full" variant="flat" isDisabled={!!running || !s || s.days_left <= 0} onPress={() => advance(d as number)}
                      className="h-9 bg-tile text-ink font-medium data-[hover=true]:bg-tile-hover">{l}</Button>
            ))}
          </div>
          {running && (
            <div className="mt-3" role="status" aria-live="polite">
              <div className="flex justify-between text-micro text-muted"><span className="truncate">{running.step ? `${running.step.charAt(0).toUpperCase()}${running.step.slice(1)}` : "Starting"}</span><span className="tabular">{Math.round(100 * (running.progress ?? 0))}%</span></div>
              <div className="h-1.5 rounded-full bg-tile overflow-hidden mt-1">
                <div className="h-full rounded-full bg-sky transition-[width] duration-700" style={{ width: `${Math.max(4, 100 * (running.progress ?? 0))}%` }} />
              </div>
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-hairline flex items-center gap-3">
            <Button isIconOnly radius="full" size="sm" aria-label={auto ? "Pause the auto clock" : "Start the auto clock"} onPress={toggleAuto} isDisabled={!s}
                    className={`w-10 h-10 min-w-10 ${auto ? "bg-ink text-ink-on" : "bg-tile text-ink data-[hover=true]:bg-tile-hover"}`}>
              {auto ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
            </Button>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{auto ? "Auto clock on" : "Auto clock off"}</div>
              <div className="text-micro text-muted truncate">{auto ? (s?.auto.source === "process" ? "Run by the simulator process" : `Advancing one day every ${paceLabel(s?.auto.seconds_per_day)}`) : s?.auto.api?.stopped_reason === "sim_end" ? "Stopped at the end date" : "Press play to advance day by day"}</div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-micro text-muted">Seconds per day</span>
            <Seg label="Seconds per simulated day" value={pace} onChange={changePace} options={PACES.map((p) => ({ value: p.value, label: p.label }))} />
          </div>

          <div className="mt-4 pt-4 border-t border-hairline">
            <div className="text-label text-muted mb-2">Last tick{tick?.sim_time_from ? `, ${day(tick.sim_time_from, { day: "numeric", month: "short" })} to ${day(tick.sim_time_to, { day: "numeric", month: "short" })}` : ""}</div>
            {tick ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] tabular">
                <dt className="text-muted">EMR rows ingested</dt><dd className="text-right">{num(rowsIn)}</dd>
                <dt className="text-muted">Care tasks completed</dt><dd className="text-right">{num(care.completed)}</dd>
                <dt className="text-muted">Reminders sent</dt><dd className="text-right">{num(care.reminders)}</dd>
                <dt className="text-muted">Escalations</dt><dd className="text-right">{num(care.escalations)}</dd>
              </dl>
            ) : <p className="text-micro text-muted">No tick yet in this data set.</p>}
          </div>
          {err && <p className="text-micro text-signal-text mt-3" role="alert">{err}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function paceLabel(spd: number | undefined) {
  if (!spd) return "—";
  return spd >= 60 ? `${Math.round(spd / 60)} min` : `${Math.round(spd)} s`;
}
