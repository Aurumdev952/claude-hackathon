import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, MessageSquareText, NotebookPen } from "lucide-react";
import { get, post } from "@/api/client";
import { ErrorNote, Loading } from "@/components/ui/Panel";
import { BandChip } from "@/components/ui/Status";
import { date } from "@/lib/format";
import { useRole } from "@/state/role";
import { FacilityPicker } from "./doctor/FacilityPicker";
import { RiskCard } from "./doctor/RiskCard";
import { AlertActions } from "./DoctorWorkspace";
import { BodyStage } from "./case/BodyStage";
import { ConditionsPanel } from "./case/ConditionsPanel";
import { useCaseUI } from "./case/store";
import type { CaseData } from "./case/types";

/** V7b Doctor Case Analysis (SPEC v1.1): aggregated conditions, vitals and labs on an interactive 3D body. */
export default function CaseAnalysis() {
  const { patientId } = useParams();
  const { role, facilityId } = useRole();
  const reset = useCaseUI((s) => s.reset);
  useEffect(() => { reset(); return () => reset(); }, [patientId, reset]);
  const q = useQuery({
    queryKey: ["patients", "case", Number(patientId), facilityId],
    queryFn: () => get<CaseData>(`/patients/${patientId}/case`),
    enabled: role === "doctor" && !!facilityId && !!patientId,
  });
  if (role !== "doctor" || !facilityId) return <FacilityPicker />;
  if (q.isLoading) return <Loading h={480} label="Aggregating the case" />;
  if (q.error) return <div className="p-4"><ErrorNote error={q.error} /></div>;
  const data = q.data!.data;
  return (
    <div className="grid gap-3 p-3 h-full min-h-[760px] grid-cols-[300px_minmax(520px,1fr)_350px]" data-testid="case-analysis">
      <aside className="min-h-0 overflow-auto pr-1 flex flex-col gap-3"><CaseSidebar data={data} /></aside>
      <section className="min-h-0 flex flex-col"><BodyStage data={data} /></section>
      <aside className="min-h-0 overflow-auto pr-1"><ConditionsPanel data={data} /></aside>
    </div>
  );
}

function CaseSidebar({ data }: { data: CaseData }) {
  const h = data.header;
  const t = data.tumour;
  return (
    <>
      <div>
        <Link to="/doctor" className="text-xs text-kivu hover:underline inline-flex items-center gap-0.5"><ChevronLeft size={13} /> Doctor workspace</Link>
        <div className="panel-title mt-2">Case analysis</div>
        <h1 className="text-xl font-bold leading-tight">{h.name}</h1>
        <div className="text-xs text-fog mt-0.5 tabular">{h.display_id} · {h.sex === "M" ? "Male" : "Female"}, {h.age} y · {h.district_name ?? h.district_code}</div>
        <div className="text-xs text-fog">{String(h.home_facility_name ?? "").replace(" (Synthetic)", "")}</div>
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {h.is_case ? <span className="chip bg-laterite/20 text-laterite">Gastric cancer · {h.case_status?.toLowerCase()}</span> : <BandChip band={data.risk?.risk_band} size="md" />}
          {h.death_date && <span className="chip bg-ridge2 text-fog">Died {date(h.death_date)}</span>}
        </div>
      </div>

      {t ? (
        <section className="panel p-3 text-xs">
          <h2 className="panel-title mb-2">Tumour & spread</h2>
          <dl className="grid grid-cols-[96px_1fr] gap-y-1">
            <dt className="text-fog">Site</dt><dd className="capitalize">{t.lesion_location ?? "not recorded"}{t.lesion_size_mm ? ` · ${t.lesion_size_mm} mm` : ""}</dd>
            <dt className="text-fog">TNM</dt><dd className="tabular font-semibold">{t.t_stage || t.n_stage || t.m_stage ? [t.t_stage, t.n_stage, t.m_stage].map((x) => x ?? "?").join(" ") : <span className="font-normal text-fog">not staged</span>}</dd>
            <dt className="text-fog">Stage</dt><dd className="font-semibold">{t.stage_group ?? "unknown"}</dd>
            <dt className="text-fog">Histology</dt><dd>{[t.lauren && `Lauren ${String(t.lauren).toLowerCase()}`, t.grade && `${String(t.grade).toLowerCase()} grade`].filter(Boolean).join(", ") || "—"}</dd>
            <dt className="text-fog">Intent</dt><dd>{t.treatment_intent ?? "—"}</dd>
            <dt className="text-fog">Diagnosed</dt><dd>{date((t.endo_date as string) ?? (h.dx_date as string))}</dd>
          </dl>
        </section>
      ) : data.suspected ? (
        <section className="panel p-3 text-xs">
          <h2 className="panel-title mb-1.5">Suspected region</h2>
          <p className="leading-relaxed">Symptoms and findings point to the <b className="capitalize">{data.suspected.region}</b> of the stomach
            (involvement {Math.round(100 * data.suspected.score)}/100). Not diagnosed — the body shows a search zone, not a tumour.</p>
        </section>
      ) : null}

      <section className="panel p-3"><h2 className="panel-title mb-2">Risk</h2><RiskCard risk={data.risk} compact /></section>
      <section className="panel p-3"><h2 className="panel-title mb-2">Alerts</h2><AlertActions alerts={data.alerts} /></section>
      <ExplainAndNotes data={data} />
    </>
  );
}

function ExplainAndNotes({ data }: { data: CaseData }) {
  const id = data.header.patient_id;
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const ex = useMutation({ mutationFn: () => post<any>(`/patients/${id}/explain`, {}) });
  const add = useMutation({
    mutationFn: () => post(`/patients/${id}/notes`, { note }),
    onSuccess: () => { setNote(""); qc.invalidateQueries({ queryKey: ["patients", "case", id] }); },
  });
  const notes = useQuery({ queryKey: ["patients", "notes", id, add.data], queryFn: () => get<any[]>(`/patients/${id}/notes`), initialData: undefined });
  const list = notes.data?.data ?? data.notes;
  const explain = ex.data?.data;
  return (
    <section className="panel p-3 text-xs">
      <button className="btn text-xs" onClick={() => ex.mutate()} disabled={ex.isPending}><MessageSquareText size={13} /> {ex.isPending ? "Summarising…" : "Explain this case"}</button>
      {ex.error && <div className="mt-2"><ErrorNote error={ex.error} /></div>}
      {explain && <div className="mt-2 leading-relaxed text-[12.5px]">{explain.summary}<div className="text-[10px] text-fog mt-1">{explain.disclaimer} · {explain.generated_by}</div></div>}
      <div className="panel-title mt-3 mb-1.5 flex items-center gap-1"><NotebookPen size={12} /> Case notes</div>
      <ul className="flex flex-col gap-1.5 mb-2">
        {list.map((n: any, i: number) => <li key={n.note_id ?? i} className="rounded bg-ridge2/60 p-2"><div className="text-[10px] text-fog">{date(n.created_at)}</div>{n.note}</li>)}
        {!list.length && <li className="text-fog">No notes yet.</li>}
      </ul>
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate(); }}>
        <input className="flex-1 bg-ridge2 rounded px-2 py-1 border border-line text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the team" aria-label="New case note" maxLength={2000} />
        <button className="btn text-xs py-1" disabled={!note.trim() || add.isPending}>Save</button>
      </form>
    </section>
  );
}
