import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Check, ChevronLeft, ChevronRight, MessageSquareText, Search, Send, X } from "lucide-react";
import { get, patch, post, qs } from "@/api/client";
import type { Alert, PatientRow } from "@/api/types";
import { BandChip, SeverityChip } from "@/components/ui/Status";
import { ErrorNote, Loading, Panel } from "@/components/ui/Panel";
import { useRole } from "@/state/role";
import { date, fmt } from "@/lib/format";
import { FacilityPicker } from "./doctor/FacilityPicker";
import { RiskCard } from "./doctor/RiskCard";
import { MiniSeries, Timeline } from "./doctor/Timeline";

export default function DoctorWorkspace() {
  const { facilityId, facilityName, role } = useRole();
  const [tab, setTab] = useState<"flagged" | "diagnosed" | "alerts">("flagged");
  const [selected, setSelected] = useState<number | null>(null);
  if (role !== "doctor" || !facilityId) return <FacilityPicker />;
  return (
    <div className="grid grid-cols-[minmax(420px,1fr)_minmax(560px,1.35fr)] gap-4 h-full min-h-[640px]">
      <div className="flex flex-col min-h-0 gap-3">
        <div className="flex items-end justify-between">
          <div>
            <div className="panel-title">Doctor workspace</div>
            <h1 className="text-xl font-bold">{facilityName?.replace(" (Synthetic)", "")}</h1>
          </div>
          <button className="text-xs text-kivu hover:underline" onClick={() => useRole.setState({ facilityId: null, facilityName: null })}>Change facility</button>
        </div>
        <div className="seg self-start" role="tablist">
          {(["flagged", "diagnosed", "alerts"] as const).map((t) => (
            <button key={t} role="tab" aria-pressed={tab === t} onClick={() => setTab(t)}>{t === "flagged" ? "Risk-ranked patients" : t === "diagnosed" ? "Diagnosed cases" : "Alerts inbox"}</button>
          ))}
        </div>
        {tab === "alerts" ? <AlertsInbox onOpen={setSelected} /> : <PatientList status={tab} selected={selected} onSelect={setSelected} />}
      </div>
      <div className="min-h-0 overflow-auto">{selected ? <PatientPanel patientId={selected} /> : <Empty />}</div>
    </div>
  );
}

function Empty() {
  return <div className="panel h-full flex items-center justify-center text-fog text-sm p-10 text-center">Select a patient to see why they were flagged, their timeline, and the 3D case analysis.</div>;
}

function PatientList({ status, selected, onSelect }: { status: "flagged" | "diagnosed"; selected: number | null; onSelect: (id: number) => void }) {
  const [page, setPage] = useState(1);
  const [band, setBand] = useState<string>("");
  const [q, setQ] = useState("");
  const [qDebounced, setQd] = useState("");
  useEffect(() => { const t = setTimeout(() => setQd(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(1), [status, band, qDebounced]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["patients", status, band, qDebounced, page],
    queryFn: () => get<PatientRow[]>(`/patients${qs({ status, risk_band: band || undefined, q: qDebounced || undefined, page, page_size: 25 })}`),
  });
  const rows = data?.data ?? [];
  const total = Number((data as any)?.total ?? 0);
  useEffect(() => { if (!selected && rows.length) onSelect(rows[0].patient_id); }, [rows, selected, onSelect]);
  return (
    <div className="panel flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 p-3 border-b border-line/50">
        <label className="flex items-center gap-2 flex-1 bg-ridge2/60 rounded-lg px-2">
          <Search size={14} className="text-fog" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or ID" className="bg-transparent py-1.5 text-sm outline-none flex-1" aria-label="Search patients" />
        </label>
        {status === "flagged" && (
          <div className="seg" role="group" aria-label="Risk band">
            {["", "HIGH", "MEDIUM", "LOW"].map((b) => <button key={b} aria-pressed={band === b} onClick={() => setBand(b)}>{b || "All"}</button>)}
          </div>
        )}
      </div>
      {error && <div className="p-3"><ErrorNote error={error} /></div>}
      {isLoading ? <Loading /> : (
        <ul className="flex-1 overflow-auto divide-y divide-line/30" aria-label="Patients">
          {rows.map((p) => (
            <li key={p.patient_id}>
              <button onClick={() => onSelect(p.patient_id)} className={`w-full text-left px-3 py-2.5 hover:bg-ridge2/50 ${selected === p.patient_id ? "bg-kivu/15 shadow-[inset_3px_0_0_rgb(var(--kivu))]" : ""}`}>
                <div className="flex items-center gap-2">
                  {status === "flagged" ? <BandChip band={p.risk_band} /> : <span className="chip bg-laterite/20 text-laterite">{p.case_status}</span>}
                  <span className="font-medium text-sm">{p.name}</span>
                  <span className="text-xs text-fog">{p.sex} · {p.age}</span>
                  <span className="flex-1" />
                  {p.open_alerts > 0 && <span className="chip bg-laterite/15 text-laterite">{p.open_alerts} alert{p.open_alerts > 1 ? "s" : ""}</span>}
                  {status === "flagged" && <span className="text-sm font-semibold tabular w-14 text-right">{fmt(100 * (p.ensemble_prob ?? 0))}%</span>}
                </div>
                <div className="text-xs text-fog mt-1 flex gap-2">
                  <span className="tabular">{p.display_id}</span><span>·</span>
                  <span className="truncate">{status === "flagged" ? (p.top_reasons ?? []).map((r) => r.label).join(" · ") || "—" : `diagnosed ${date(p.dx_date)}`}</span>
                </div>
                <div className="text-[10px] text-fog mt-0.5">last visit {date(p.last_visit)}{p.t1_score !== null ? ` · points ${p.t1_score}` : ""}</div>
              </button>
            </li>
          ))}
          {!rows.length && <li className="p-6 text-sm text-fog">No patients match.</li>}
        </ul>
      )}
      <div className="flex items-center justify-between p-2 border-t border-line/50 text-xs text-fog">
        <span className="tabular">{total.toLocaleString()} patients</span>
        <div className="flex items-center gap-1">
          <button className="btn px-1.5 py-1" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
          <span className="tabular px-2">{page} / {Math.max(1, Math.ceil(total / 25))}</span>
          <button className="btn px-1.5 py-1" disabled={page * 25 >= total} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function PatientPanel({ patientId }: { patientId: number }) {
  const nav = useNavigate();
  const p = useQuery({ queryKey: ["patients", "one", patientId], queryFn: () => get<any>(`/patients/${patientId}`) });
  const tl = useQuery({ queryKey: ["patients", "timeline", patientId], queryFn: () => get<any>(`/patients/${patientId}/timeline`) });
  const alerts = useQuery({ queryKey: ["alerts", "patient", patientId], queryFn: () => get<Alert[]>(`/alerts`) });
  const [explain, setExplain] = useState<any>(null);
  const ex = useMutation({ mutationFn: () => post<any>(`/patients/${patientId}/explain`, {}), onSuccess: (r) => setExplain(r.data) });
  useEffect(() => setExplain(null), [patientId]);
  if (p.isLoading) return <Loading h={500} />;
  if (p.error) return <ErrorNote error={p.error} />;
  const h = p.data!.data;
  const events = tl.data?.data?.events ?? [];
  const cutoff = Date.now() - 1000 * 86400 * 365 * 3;
  const recent = events.filter((e: any) => Date.parse(e.ts) >= Math.min(cutoff, Date.parse(h.last_encounter_date ?? new Date().toISOString()) - 3 * 365 * 86400000));
  const myAlerts = (alerts.data?.data ?? []).filter((a) => a.patient_id === patientId);
  return (
    <div className="flex flex-col gap-3 animate-rise">
      <div className="panel p-4 flex items-start gap-4">
        <div className="flex-1">
          <div className="text-xs text-fog tabular">{h.display_id} · {h.district_name} · cohort entry {date(h.entry_date)} ({String(h.entry_reason).toLowerCase().replace(/_/g, " ")})</div>
          <h2 className="text-2xl font-bold">{h.name}</h2>
          <div className="text-sm text-fog">{h.sex === "F" ? "Female" : "Male"}, {h.age} years · home facility {String(h.home_facility_name ?? "").replace(" (Synthetic)", "")}</div>
          {h.is_case && <div className="mt-1 chip bg-laterite/20 text-laterite">{h.case_status} gastric cancer · diagnosed {date(h.dx_date)}</div>}
        </div>
        <button className="btn btn-primary" onClick={() => nav(`/doctor/case/${patientId}`)}><Box size={15} /> Analyse case in 3D</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Panel title="Risk" method="Final band = mean of the calibrated XGBoost and sequence-model probabilities; HIGH is the top 2% of eligible GI-cohort patients (endoscopy capacity), MEDIUM the next 8%. Thresholds were frozen at training time.">
          <RiskCard risk={h.risk} />
        </Panel>
        <Panel title="Alerts & actions">
          <AlertActions alerts={myAlerts} />
          <div className="mt-3 border-t border-line/50 pt-3">
            <button className="btn" onClick={() => ex.mutate()} disabled={ex.isPending}><MessageSquareText size={14} /> {ex.isPending ? "Summarising…" : "Explain this patient"}</button>
            {explain && <div className="mt-2 text-sm leading-relaxed">{explain.summary}<div className="text-[10px] text-fog mt-1">{explain.disclaimer} · {explain.generated_by}</div></div>}
          </div>
        </Panel>
      </div>
      <Panel title="Timeline · last 3 years" subtitle="Dashed rings mark events the models weighed most">
        {tl.isLoading ? <Loading h={220} /> : <Timeline events={recent} />}
        <div className="grid grid-cols-2 gap-3 mt-2">
          <MiniSeries title="Haemoglobin (g/dL)" unit="g/dL" points={tl.data?.data?.series?.hb ?? []} threshold={h.sex === "M" ? 13 : 12} />
          <MiniSeries title="Weight (kg)" unit="kg" points={tl.data?.data?.series?.weight ?? []} />
        </div>
      </Panel>
    </div>
  );
}

export function AlertActions({ alerts }: { alerts: Alert[] }) {
  const qc = useQueryClient();
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: ({ id, status, reason }: { id: string; status: string; reason?: string }) => patch(`/alerts/${id}`, { status, reason, note: reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alerts"] }); qc.invalidateQueries({ queryKey: ["patients"] }); setDismissing(null); setReason(""); },
  });
  if (!alerts.length) return <div className="text-xs text-fog">No alerts for this patient.</div>;
  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((a) => (
        <li key={a.alert_id} className="rounded-lg border border-line/60 p-2.5">
          <div className="flex items-center gap-2 mb-1"><SeverityChip severity={a.severity} /><span className="text-xs font-semibold">{a.trigger.replace(/_/g, " ")}</span>
            <span className="flex-1" /><span className={`chip ${a.status === "NEW" ? "bg-kivu/20 text-mist" : "bg-ridge2 text-fog"}`}>{a.status}</span></div>
          <p className="text-xs leading-relaxed">{a.summary}</p>
          <p className="text-xs text-sorghum mt-1">{a.suggested_action}</p>
          {a.status !== "DISMISSED" && a.status !== "REFERRED" && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {a.status === "NEW" && <button className="btn text-xs py-1" onClick={() => m.mutate({ id: a.alert_id, status: "ACKNOWLEDGED" })}><Check size={13} /> Acknowledge</button>}
              <button className="btn text-xs py-1" onClick={() => m.mutate({ id: a.alert_id, status: "REFERRED" })}><Send size={13} /> Mark referred</button>
              <button className="btn text-xs py-1" onClick={() => setDismissing(a.alert_id)}><X size={13} /> Dismiss</button>
            </div>
          )}
          {dismissing === a.alert_id && (
            <div className="flex gap-1.5 mt-2">
              <input className="flex-1 bg-ridge2 rounded px-2 text-xs border border-line" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Dismiss reason" />
              <button className="btn text-xs py-1" disabled={!reason.trim()} onClick={() => m.mutate({ id: a.alert_id, status: "DISMISSED", reason })}>Confirm</button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function AlertsInbox({ onOpen }: { onOpen: (id: number) => void }) {
  const [status, setStatus] = useState("NEW");
  const [sev, setSev] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["alerts", "inbox", status, sev], queryFn: () => get<Alert[]>(`/alerts${qs({ status: status || undefined, severity: sev || undefined })}`) });
  return (
    <div className="panel flex flex-col min-h-0 flex-1">
      <div className="flex gap-2 p-3 border-b border-line/50">
        <div className="seg">{["NEW", "ACKNOWLEDGED", "REFERRED", "DISMISSED", ""].map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{s || "All"}</button>)}</div>
        <div className="seg">{["", "HIGH", "MEDIUM"].map((s) => <button key={s} aria-pressed={sev === s} onClick={() => setSev(s)}>{s || "Any"}</button>)}</div>
      </div>
      {isLoading ? <Loading /> : (
        <ul className="flex-1 overflow-auto divide-y divide-line/30">
          {(data?.data ?? []).map((a) => (
            <li key={a.alert_id}><button className="w-full text-left p-3 hover:bg-ridge2/50" onClick={() => onOpen(a.patient_id)}>
              <div className="flex items-center gap-2"><SeverityChip severity={a.severity} /><span className="text-sm font-medium">{a.name}</span>
                <span className="text-xs text-fog">{a.trigger.replace(/_/g, " ").toLowerCase()}</span><span className="flex-1" /><span className="text-[10px] text-fog">{date(a.created_at)}</span></div>
              <div className="text-xs text-fog mt-1">{a.summary}</div>
            </button></li>
          ))}
          {!data?.data?.length && <li className="p-6 text-sm text-fog">Inbox empty.</li>}
        </ul>
      )}
    </div>
  );
}
