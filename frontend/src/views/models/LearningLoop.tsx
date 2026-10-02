import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Textarea } from "@heroui/react";
import type { EChartsOption } from "echarts";
import { Check, GitCompareArrows, History, Radar, RefreshCw, RotateCcw, ShieldCheck, Tags, X } from "lucide-react";
import { api, ApiError, get } from "@/api/client";
import { EChart, useThemeMode } from "@/components/charts/EChart";
import { BentoGrid, Card, chartDetailTabs, DataTable, GridItem, Loading, SectionHeader, StatTile, usePortalContainer } from "@/components/ui";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { date, fmt, signed } from "@/lib/format";
import { modalMotion } from "@/lib/motion";
import { HUE, ink } from "@/lib/viz";
import { useLive } from "@/state/live";
import { chartBase, tipHead, tipRow } from "../trends/kit";

type Gate = { name: string; value: number | null; threshold: number; pass: boolean; champion: number | null; challenger: number | null; note: string };
type MetricSet = Record<string, number | null> & { n_high?: number; high_cut?: number };
type ModelCard = { model_id: string; version: string; trained_at: string; train_window: string; status: string; parent_model_id: string | null; n_feedback_labels: number | null;
  promoted_at: string | null; promoted_by: string | null; promote_reason: string | null; high_cut: number | null; ipw: Record<string, unknown> | null; metrics: Record<string, MetricSet> };
type Run = { run_id: string; sim_time: string; champion_id: string; challenger_id: string; decision: string; decided_by: string | null; decided_at: string | null;
  n_feedback_labels: number | null; runtime_s: number | null; started_at: string; gates: Gate[]; metrics?: { champion: MetricSet; challenger: MetricSet; volume?: { champion: number; challenger: number; population: number } } };
type Loop = {
  champion: ModelCard | null; challenger: ModelCard | null; gates: Gate[]; decision: string | null; latest_run: Run | null;
  comparison: { champion: MetricSet; challenger: MetricSet; volume?: { champion: number; challenger: number; population: number }; holdout?: { n: number; n_pos: number }; verified_slice?: { n: number; n_pos?: number } } | null;
  history: Run[]; feedback: { n: number; by_source: Record<string, number | string>; by_kind: Record<string, number>; verified_cancers: number };
  monitoring: { psi: { feature: string; value: number; detail: string }[]; calibration: { as_of: string; metric: string; value: number | null; n: number | null; detail: string | null }[];
    alert_volume: { date: string; value: number }[]; high_count: { date: string; value: number }[] };
  audit: { audit_at: string; sim_time: string; action: string; model_id: string; previous_model_id: string | null; actor: string; reason: string }[];
  running_job: { id: string; status: string; progress: number; step: string | null } | null;
};
type Job = { id: string; status: "queued" | "running" | "done" | "failed"; progress: number; step: string | null; result: unknown; error: string | null };

const ACTOR = "Ministry user (demo)";
const GATE_LABEL: Record<string, string> = {
  auroc: "AUROC", auprc: "AUPRC", ppv_at_high: "PPV at HIGH", brier: "Brier score", calibration_slope: "Calibration slope",
  subgroup_auroc_drop: "Subgroup AUROC drop", high_volume_change: "HIGH alert volume",
};
const DECISION: Record<string, { label: string; tone: "pass" | "fail" | "neutral" }> = {
  pending: { label: "Ready to promote", tone: "pass" }, gates_failed: { label: "Gates failed", tone: "fail" }, promoted: { label: "Promoted", tone: "neutral" },
  rolled_back: { label: "Rolled back", tone: "neutral" }, rolled_back_to: { label: "Restored", tone: "neutral" },
};
const SOURCE_LABEL: Record<string, string> = { care_outcome: "Care plan outcomes", flag_backfill: "Past flags, later scoped", endoscopy_after_flag: "Endoscopy after a flag", hp_after_flag: "H. pylori test after a flag" };

const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "X-Actor": ACTOR } });

/** Pass / fail glyph with a word (never colour alone). */
export function GateGlyph({ pass, label }: { pass: boolean; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-label whitespace-nowrap ${pass ? "text-tone-success" : "text-signal-text"}`}>
      <span className={`w-5 h-5 rounded-full grid place-items-center ${pass ? "bg-success/15" : "bg-signal-soft"}`} aria-hidden>
        {pass ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
      </span>
      {label ?? (pass ? "Pass" : "Fail")}
    </span>
  );
}

function useJob(id: string | null) {
  return useQuery({ queryKey: ["models", "job", id], enabled: !!id, queryFn: () => get<Job>(`/models/jobs/${id}`),
    refetchInterval: (q) => (q.state.data?.data.status === "done" || q.state.data?.data.status === "failed" ? false : 1000) });
}

/** ModelArena "Learning loop" (plan §4, contract §7): champion vs challenger with gate checks, promote / roll back with a
 * required reason (and a second confirmation to override failed gates), retrain now, history, feedback labels, drift and
 * calibration on verified outcomes. Ministry only. */
export function LearningLoop() {
  const q = useQuery({ queryKey: ["models", "learning-loop"], queryFn: () => get<Loop>("/models/learning-loop"), retry: false });
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobLabel, setJobLabel] = useState("");
  const job = useJob(jobId);
  const d = q.data?.data;
  const running = job.data?.data && (job.data.data.status === "queued" || job.data.data.status === "running") ? job.data.data : null;
  useEffect(() => {
    const st = job.data?.data.status;
    if (st === "done" || st === "failed") {
      useLive.getState().toast(st === "done" ? `${jobLabel} finished` : `${jobLabel} failed: ${job.data?.data.error ?? "unknown error"}`, st === "done" ? "info" : "alert");
      // the job republishes; the API swaps to the new serve file within ~2 s
      const t = setTimeout(() => qc.invalidateQueries({ queryKey: ["models"] }), 2500);
      setJobId(null);
      return () => clearTimeout(t);
    }
  }, [job.data?.data.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = (id: string, label: string) => { setJobLabel(label); setJobId(id); };
  const busy = !!running || !!d?.running_job;

  return (
    <section className="flex flex-col gap-4 min-w-0" aria-label="Learning loop">
      <SectionHeader title="Learning loop" icon={<RefreshCw size={16} />} className="mt-3"
        info={{ about: "Verified outcomes from follow-up (endoscopy results, H. pylori tests) become new labels. A challenger model is retrained on them every 30 simulated days and compared with the champion on the same untouched holdout. A person decides whether to promote it.",
                method: "Flagged patients are scoped more often, so naive retraining would reinforce the model's own choices. The challenger is trained with inverse-propensity weights (1 / P(scoped | risk), clipped 1–20) and evaluated on the time-split holdout plus a verified-outcomes slice.",
                notes: "Synthetic data. Gates: no metric worse than the champion by more than 0.01, subgroup AUROC drop at most 0.05, HIGH alert volume within ±25% or a small absolute change." }}
        actions={running ? <JobProgress job={running} label={jobLabel} /> : undefined} />
      {q.isLoading ? <Loading h={320} /> : q.error ? <ErrorNote error={q.error} /> : d ? (
        <BentoGrid>
          <GridItem span={{ lg: 8 }}><ChampionCard d={d} busy={busy} onJob={start} /></GridItem>
          <GridItem span={{ lg: 4 }}><FeedbackCard d={d} /></GridItem>
          <GridItem span={{ lg: 6 }}><HistoryCard d={d} busy={busy} onJob={start} /></GridItem>
          <GridItem span={{ lg: 6 }}><MonitoringCard d={d} /></GridItem>
        </BentoGrid>
      ) : null}
    </section>
  );
}

function JobProgress({ job, label }: { job: Job | { status: string; progress: number; step: string | null }; label: string }) {
  return (
    <div className="flex items-center gap-3 min-w-[240px]" role="status" aria-live="polite">
      <span className="text-label text-muted whitespace-nowrap">{label || "Model job"}{job.step ? `: ${job.step}` : ""}</span>
      <span className="w-28 h-1.5 rounded-full bg-tile overflow-hidden" role="progressbar" aria-label={`${label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 * (job.progress ?? 0))}>
        <span className="block h-full rounded-full bg-sky transition-[width] duration-500" style={{ width: `${Math.max(4, 100 * (job.progress ?? 0))}%` }} />
      </span>
    </div>
  );
}

const pct = (v: number | null | undefined, nd = 1) => (v === null || v === undefined ? "—" : `${fmt(100 * v, nd)}%`);
const ROWS: { k: string; label: string; f: (v: number | null | undefined) => string; better: "hi" | "lo" | "one" }[] = [
  { k: "auroc", label: "AUROC", f: (v) => fmt(v, 3), better: "hi" },
  { k: "auprc", label: "AUPRC", f: (v) => fmt(v, 3), better: "hi" },
  { k: "brier", label: "Brier score", f: (v) => fmt(v, 4), better: "lo" },
  { k: "calib_slope", label: "Calibration slope", f: (v) => fmt(v, 2), better: "one" },
  { k: "ppv_at_high", label: "PPV at HIGH", f: (v) => pct(v), better: "hi" },
  { k: "sens_at_spec90", label: "Sensitivity at 90% specificity", f: (v) => pct(v, 0), better: "hi" },
];

function ChampionCard({ d, busy, onJob }: { d: Loop; busy: boolean; onJob: (id: string, label: string) => void }) {
  const [modal, setModal] = useState<"promote" | "rollback" | null>(null);
  const c = d.comparison;
  const ch = d.challenger, ca = d.champion;
  const dec = d.decision ? DECISION[d.decision] : null;
  const failing = d.gates.filter((g) => !g.pass);
  const canRollback = !!ca?.promoted_at || d.audit.some((a) => a.model_id === ca?.model_id);
  const head = (label: string, m: ModelCard | null, sub: ReactNode) => (
    <div className="min-w-0">
      <div className="text-label text-muted">{label}</div>
      <div className="text-[15px] font-semibold text-ink truncate mt-0.5" title={m?.model_id}>{m ? m.model_id.replace(/^tier2-xgb-?/, "XGBoost ").replace(/^XGBoost ch-/, "XGBoost ") : "None yet"}</div>
      <div className="text-micro text-muted mt-0.5 tabular">{sub}</div>
    </div>
  );
  return (
    <Card title="Champion and challenger" icon={<GitCompareArrows size={16} />} className="h-full" aria-label="Champion and challenger"
          actions={dec ? <span className={`inline-flex items-center h-7 px-3 rounded-full text-micro font-medium ${dec.tone === "fail" ? "bg-signal-soft text-signal-text" : dec.tone === "pass" ? "bg-success/15 text-tone-success" : "bg-tile text-muted"}`}>{dec.label}</span> : undefined}>
      <div className="grid grid-cols-2 gap-4 pb-4 border-b border-hairline">
        {head("Champion (live)", ca, ca ? <>Trained {date(ca.trained_at)}, window {ca.train_window}{ca.promoted_at ? `, promoted ${date(ca.promoted_at)}` : ""}</> : null)}
        {head("Challenger", ch, ch ? <>Trained {date(ch.trained_at)}, {ch.n_feedback_labels ?? 0} feedback labels</> : "Retrains every 30 simulated days")}
      </div>
      {c && ch ? (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] mt-4">
          <table className="w-full text-[13px] tabular" aria-label="Holdout metrics, champion and challenger">
            <thead><tr className="text-muted text-left"><th className="font-medium pb-1.5">Holdout</th><th className="font-medium pb-1.5 text-right">Champion</th><th className="font-medium pb-1.5 text-right">Challenger</th><th className="font-medium pb-1.5 text-right">Change</th></tr></thead>
            <tbody>
              {ROWS.map((r) => {
                const a = c.champion?.[r.k] ?? null, b = c.challenger?.[r.k] ?? null;
                const delta = a !== null && b !== null ? b - a : null;
                return (
                  <tr key={r.k} className="border-t border-hairline">
                    <td className="py-1.5 text-ink">{r.label}</td>
                    <td className="py-1.5 text-right text-muted">{r.f(a)}</td>
                    <td className="py-1.5 text-right text-ink font-medium">{r.f(b)}</td>
                    <td className="py-1.5 text-right text-muted">{delta === null ? "—" : r.k === "ppv_at_high" || r.k === "sens_at_spec90" ? signed(100 * delta, 1, " pts") : signed(delta, r.k === "brier" ? 4 : r.k === "calib_slope" ? 2 : 3)}</td>
                  </tr>
                );
              })}
              {c.volume && (
                <tr className="border-t border-hairline">
                  <td className="py-1.5 text-ink">HIGH flags today</td>
                  <td className="py-1.5 text-right text-muted">{c.volume.champion}</td>
                  <td className="py-1.5 text-right text-ink font-medium">{c.volume.challenger}</td>
                  <td className="py-1.5 text-right text-muted">{signed(c.volume.challenger - c.volume.champion, 0)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div>
            <div className="text-label text-muted mb-1.5">Gates</div>
            <ul className="flex flex-col" aria-label="Promotion gates" data-testid="gates">
              {d.gates.map((g) => (
                <li key={g.name} className="flex items-center gap-3 py-1.5 border-t border-hairline first:border-t-0" aria-label={`${GATE_LABEL[g.name] ?? g.name}: ${g.pass ? "pass" : "fail"}`}>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-ink truncate">{GATE_LABEL[g.name] ?? g.name}</span>
                    <span className="block text-micro text-muted truncate" title={g.note}>{gateDetail(g)}</span>
                  </span>
                  <GateGlyph pass={g.pass} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="text-label font-normal text-muted mt-4">No challenger has been trained yet. Retrain now, or let the simulated clock run for 30 days.</p>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-5">
        <Button radius="full" color="primary" className="h-10 px-5 font-medium" isDisabled={!ch || busy} onPress={() => setModal("promote")} startContent={<ShieldCheck size={15} aria-hidden />}>Promote challenger</Button>
        <Button radius="full" variant="bordered" className="h-10 px-5 border-hairline text-ink" isDisabled={!canRollback || busy} onPress={() => setModal("rollback")} startContent={<RotateCcw size={15} aria-hidden />}>Roll back</Button>
        {!canRollback && <span className="text-micro text-muted">Roll back needs a champion that replaced another model.</span>}
        {ch && failing.length > 0 && <span className="text-micro text-muted ml-auto">{failing.length} gate{failing.length > 1 ? "s" : ""} failed; promoting needs an override.</span>}
      </div>
      {modal && <DecisionModal kind={modal} d={d} onClose={() => setModal(null)} onJob={onJob} />}
    </Card>
  );
}

function gateDetail(g: Gate): string {
  if (g.name === "high_volume_change") return `${g.champion ?? "—"} to ${g.challenger ?? "—"} flags (${signed(100 * (g.value ?? 0), 0, "%")})`;
  if (g.name === "subgroup_auroc_drop") return `Largest drop ${fmt(g.value, 3)}, limit ${fmt(g.threshold, 2)}`;
  if (g.name === "calibration_slope") return `${fmt(g.champion, 2)} to ${fmt(g.challenger, 2)}, distance from 1 ${g.value !== null && g.value > 0 ? "grows" : "shrinks"} ${fmt(Math.abs(g.value ?? 0), 2)}`;
  if (g.name === "brier") return `Change ${signed(g.value, 4)}, limit +${fmt(g.threshold, 2)}`;
  return `Change ${signed(g.value, 3)}, limit ${fmt(g.threshold, 2)}`;
}

function DecisionModal({ kind, d, onClose, onJob }: { kind: "promote" | "rollback"; d: Loop; onClose: () => void; onJob: (id: string, label: string) => void }) {
  const portal = usePortalContainer();
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState<Gate[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const model = kind === "promote" ? d.challenger : d.champion;
  const ok = reason.trim().length >= 3 && (!override || confirm);
  const submit = async () => {
    if (!model) return;
    setSending(true); setErr(null);
    try {
      const r = await post<{ job_id: string }>(`/models/${encodeURIComponent(model.model_id)}/${kind}`, { reason: reason.trim(), force: !!override });
      onJob(r.data.job_id, kind === "promote" ? "Promotion" : "Roll back");
      onClose();
    } catch (e) {
      const a = e as ApiError;
      if (a.code === "GATES_FAILED") setOverride(((a.details as { gates?: Gate[] })?.gates) ?? d.gates.filter((g) => !g.pass));
      else setErr(a.message ?? String(e));
    } finally { setSending(false); }
  };
  return (
    <Modal isOpen onOpenChange={(o) => !o && onClose()} portalContainer={portal} size="lg" backdrop="opaque" placement="center" motionProps={modalMotion as any}
           classNames={{ base: "rounded-modal bg-surface shadow-float dark:border dark:border-hairline", backdrop: "bg-[rgb(21_23_28/0.32)]", header: "px-7 pt-6 pb-1", body: "px-7", footer: "px-7 pb-6",
                         closeButton: "top-5 right-5 w-9 h-9 rounded-full border border-hairline text-ink hover:bg-tile" }}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-0.5">
          <span className="text-[22px] leading-7 font-semibold text-ink">{override ? "Promote despite failed gates?" : kind === "promote" ? "Promote the challenger" : "Roll back the champion"}</span>
          <span className="text-label font-normal text-muted">{kind === "promote" ? "It becomes the live model: every patient is re-scored and the dashboards republish." : "The model it replaced becomes live again, and every patient is re-scored."}</span>
        </ModalHeader>
        <ModalBody className="gap-4">
          {override && (
            <div className="rounded-tile bg-signal-soft/60 px-4 py-3">
              <div className="text-label text-ink mb-1.5">These gates failed</div>
              <ul className="flex flex-col gap-1.5">
                {override.map((g) => <li key={g.name} className="flex items-center justify-between gap-3 text-[13px]"><span className="text-ink">{GATE_LABEL[g.name] ?? g.name}<span className="text-muted">, {gateDetail(g)}</span></span><GateGlyph pass={false} /></li>)}
              </ul>
              <label className="flex items-start gap-2.5 mt-3 text-[13px] text-ink cursor-pointer">
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[rgb(var(--signal-strong))]" />
                I have reviewed the failed gates and accept the risk of promoting this model anyway.
              </label>
            </div>
          )}
          <Textarea label="Reason" labelPlacement="outside" placeholder={kind === "promote" ? "For example: better AUPRC on verified outcomes" : "For example: alert volume too high for endoscopy capacity"}
                    value={reason} onValueChange={setReason} minRows={2} isRequired description="Recorded in the audit log with your name and the simulated date."
                    classNames={{ inputWrapper: "bg-tile data-[hover=true]:bg-tile-hover shadow-none", label: "!text-label !text-ink" }} />
          {err && <ErrorNote error={new Error(err)} />}
        </ModalBody>
        <ModalFooter>
          <Button radius="full" variant="light" onPress={onClose} className="h-10 px-4">Cancel</Button>
          <Button radius="full" color="primary" className="h-10 px-5 font-medium" isDisabled={!ok} isLoading={sending} onPress={submit}>
            {override ? "Promote anyway" : kind === "promote" ? "Promote" : "Roll back"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function FeedbackCard({ d }: { d: Loop }) {
  const m = useThemeMode();
  const h = HUE[m];
  const src = Object.entries(d.feedback.by_source);
  const max = Math.max(1, ...src.map(([, v]) => (typeof v === "number" ? v : 0)));
  return (
    <Card title="Feedback labels" icon={<Tags size={16} />} className="h-full"
          info="Verified outcomes the challenger learns from: care plan outcomes, and past HIGH flags later followed by an endoscopy. Sources with fewer than 5 labels show as <5.">
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile label="Labels" value={d.feedback.n} sub="Verified outcomes" />
        <StatTile label="Cancers" value={d.feedback.verified_cancers} sub="Confirmed positive" />
      </div>
      <ul className="flex flex-col gap-3 mt-5" aria-label="Feedback labels by source">
        {src.map(([k, v]) => (
          <li key={k}>
            <div className="flex justify-between text-[13px]"><span className="text-ink">{SOURCE_LABEL[k] ?? k}</span><span className={`tabular font-medium ${typeof v === "number" ? "text-ink" : "text-muted"}`}>{v}</span></div>
            <div className="h-1.5 rounded-full bg-tile mt-1.5 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: typeof v === "number" ? `${(100 * v) / max}%` : "4%", background: typeof v === "number" ? h.sky : "rgb(var(--faint))" }} />
            </div>
          </li>
        ))}
        {!src.length && <li className="text-label text-muted">No verified outcomes yet.</li>}
      </ul>
    </Card>
  );
}

function HistoryCard({ d, busy, onJob }: { d: Loop; busy: boolean; onJob: (id: string, label: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const retrain = async () => {
    setErr(null);
    try { const r = await post<{ job_id: string }>("/models/retrain", {}); onJob(r.data.job_id, "Retraining"); }
    catch (e) { setErr((e as Error).message); }
  };
  const rows = d.history.map((r) => {
    const a = r.metrics?.champion?.auroc ?? null, b = r.metrics?.challenger?.auroc ?? null;
    return { ...r, dAuroc: a !== null && b !== null ? b - a : null, failed: (r.gates ?? []).filter((g) => !g.pass).length };
  });
  const audit = d.audit;
  return (
    <Card title="Retrain history" icon={<History size={16} />} className="h-full"
          actions={<Button size="sm" radius="full" variant="bordered" className="h-9 px-4 border-hairline text-ink" isDisabled={busy} onPress={retrain} startContent={<RefreshCw size={14} aria-hidden />}>Retrain now</Button>}
          detail={audit.length ? { tabs: chartDetailTabs({ table: <DataTable ariaLabel="Promotion audit log" rows={audit} columns={[
            { key: "audit_at", label: "When", fmt: (v) => date(v) }, { key: "action", label: "Action" }, { key: "model_id", label: "Model" },
            { key: "previous_model_id", label: "Replaced" }, { key: "actor", label: "By" }, { key: "reason", label: "Reason" }]} /> }), title: "Promotion audit log", defaultTab: "table" } : undefined}
          detailLabel="Open the promotion audit log">
      {err && <div className="mb-3"><ErrorNote error={new Error(err)} /></div>}
      {rows.length ? (
        <div className="overflow-auto max-h-[300px]">
          <DataTable ariaLabel="Retrain runs" rows={rows} columns={[
            { key: "sim_time", label: "Sim date", fmt: (v) => date(v) },
            { key: "challenger_id", label: "Challenger", fmt: (v) => String(v).replace("tier2-xgb-ch-", "") },
            { key: "dAuroc", label: "AUROC change", num: true, fmt: (v) => (v === null ? "—" : signed(v, 3)) },
            { key: "n_feedback_labels", label: "Labels", num: true },
            { key: "decision", label: "Outcome", fmt: (v, r) => (v === "gates_failed" ? <GateGlyph pass={false} label={`${r.failed} gate${r.failed > 1 ? "s" : ""} failed`} /> : v === "pending" ? <GateGlyph pass label="All gates pass" /> : DECISION[v]?.label ?? v) },
          ]} />
        </div>
      ) : <p className="text-label font-normal text-muted">No retrain runs yet.</p>}
      {audit.length > 0 && <p className="text-micro text-muted mt-3">Last decision: {audit[0].action} of {audit[0].model_id} by {audit[0].actor}, {date(audit[0].audit_at)}.</p>}
    </Card>
  );
}

function MonitoringCard({ d }: { d: Loop }) {
  const m = useThemeMode();
  const psi = d.monitoring.psi.slice(0, 8);
  const cal = d.monitoring.calibration;
  const lastOf = (metric: string) => [...cal].reverse().find((x) => x.metric === metric);
  const slope = lastOf("calib_slope"), ppv = lastOf("ppv_verified"), ver = lastOf("verified_outcomes");
  const option = useMemo<EChartsOption>(() => {
    const b = chartBase(), k = ink(), h = HUE[m];
    const rows = [...psi].reverse();
    return {
      ...b, grid: { left: 150, right: 40, top: 8, bottom: 24 },
      xAxis: { ...b.xAxis, type: "value", min: 0, max: Math.max(0.3, ...psi.map((p) => p.value)) * 1.05, splitLine: { show: false }, axisLabel: { ...b.xAxis.axisLabel, formatter: (v: number) => fmt(v, 1) } },
      yAxis: { ...b.yAxis, type: "category", data: rows.map((p) => p.feature.replace(/_/g, " ")), axisLabel: { ...b.yAxis.axisLabel, color: k.secondary, width: 140, overflow: "truncate" } },
      tooltip: { ...b.tooltip, trigger: "axis", axisPointer: { type: "none" }, formatter: (ps: any) => { const p = rows[ps[0].dataIndex]; return tipHead(p.feature.replace(/_/g, " ")) + tipRow(h.sky, "PSI", fmt(p.value, 3), p.detail); } },
      series: [{ type: "bar", data: rows.map((p) => ({ value: p.value, itemStyle: { color: p.value >= 0.25 ? h.signal : h.sky, borderRadius: [0, 6, 6, 0] } })), barWidth: 10,
                 label: { show: true, position: "right", color: k.secondary, fontSize: 11, formatter: (p: any) => fmt(p.value, 2) },
                 markLine: { silent: true, symbol: "none", lineStyle: { color: k.axis, type: [3, 3] }, label: { color: k.muted, fontSize: 10, formatter: (p: any) => (p.value === 0.1 ? "0.1 moderate" : "0.25 major") },
                             data: [{ xAxis: 0.1 }, { xAxis: 0.25 }] } }],
    } as EChartsOption;
  }, [psi, m]);
  const major = psi.filter((p) => p.value >= 0.25).length;
  return (
    <Card title="Drift and calibration" icon={<Radar size={16} />} className="h-full"
          info={{ about: "Population stability index (PSI) compares each top feature's distribution in the last 90 simulated days with the training data: under 0.1 stable, 0.1–0.25 moderate, over 0.25 major drift. Calibration and PPV are measured on verified outcomes only.",
                  notes: "Time-based features (days in cohort, days since a visit) drift by construction as the clock moves; drift in clinical features matters more." }}
          detail={psi.length ? { tabs: chartDetailTabs({ table: <DataTable ariaLabel="Feature drift" rows={d.monitoring.psi} columns={[{ key: "feature", label: "Feature" }, { key: "value", label: "PSI", num: true, fmt: (v) => fmt(v, 3) }, { key: "detail", label: "Level" }]} /> }), defaultTab: "table" } : undefined}
          detailLabel="Drift: view as table">
      <div className="grid grid-cols-3 gap-2.5">
        <StatTile label="Verified outcomes" value={ver?.value ?? d.feedback.n} sub="Since the last training" />
        <StatTile label="PPV, verified" value={ppv?.value === null || ppv?.value === undefined ? "—" : `${fmt(100 * ppv.value, 0)}%`} sub={ppv?.n ? `${ppv.n} HIGH flags scoped` : "HIGH flags scoped"} />
        <StatTile label="Calibration slope" value={slope?.value === null || slope?.value === undefined ? "—" : fmt(slope.value, 2)} sub={slope ? "1.0 is ideal" : "Too few outcomes yet"} />
      </div>
      <div className="flex items-center justify-between mt-5">
        <span className="text-label text-muted">Feature drift, top {psi.length}</span>
        {major > 0 && <span className="inline-flex items-center gap-1.5 text-micro text-signal-text"><span className="w-1.5 h-1.5 rounded-full bg-signal" aria-hidden />{major} feature{major > 1 ? "s" : ""} with major drift</span>}
      </div>
      {psi.length ? <EChart option={option} height={Math.max(180, psi.length * 26 + 32)} ariaLabel="Population stability index of the top features" /> : <p className="text-label text-muted mt-2">No drift measured yet.</p>}
    </Card>
  );
}
