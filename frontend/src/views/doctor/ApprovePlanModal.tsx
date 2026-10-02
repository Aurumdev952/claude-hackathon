import { type ReactNode, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Select, SelectItem } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ClipboardCheck, MessageSquare, Smartphone, UsersRound } from "lucide-react";
import { AppIcon } from "@/components/brand/BrandMark";
import { type ApiError, post } from "@/api/client";
import { useFiltersMeta } from "@/api/hooks";
import { DetailModal, ErrorNote, InfoHint, Skeleton } from "@/components/ui";
import { date } from "@/lib/format";
import { EASE } from "@/lib/motion";
import { useLive } from "@/state/live";
import { type Channel, CHANNELS, DX_PATHWAYS, type Pathway, type PathwaysEnvelope, isOpenPlan, usePathways, usePatientCare } from "./care";

type Preview = {
  pathway: string; target_facility: { id: number; name: string } | null;
  tasks: { type: string; title: string; due_at: string | null; status: string }[];
  messages: { channel: Channel; title: string; body: string; greeting?: string }[];
};

export type ApproveTarget = {
  patientId: number;
  /** Plain label for the modal subtitle (doctor UI: the patient's name and display id). */
  label?: ReactNode;
  alertId?: string | null;
  trigger?: string | null;
  isCase?: boolean;
  /** Pre-selected pathway (a next-plan suggestion); otherwise it follows the alert trigger or the diagnosis. */
  pathway?: string | null;
};

const short = (n: string | null | undefined) => String(n ?? "").replace(" (Synthetic)", "");
const ymd = (s: string | null | undefined) => (s ? s.slice(0, 10) : "");

/** "Approve & plan" (plan §6): pick the pathway (pre-selected from the alert trigger), adjust the due date, facility and
 * channels, see exactly what the patient will receive, then approve. Nothing reaches the patient before this. */
export function ApprovePlanModal({ target, isOpen, onOpenChange }: { target: ApproveTarget | null; isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <DetailModal isOpen={isOpen && !!target} onOpenChange={onOpenChange} size="4xl" icon={<ClipboardCheck size={18} />}
                 title={target?.alertId ? "Approve and plan care" : "Start a care plan"} subtitle={target?.label}
                 info="Approving creates a care plan in the EMR (a care-coordination encounter with the pathway, its steps and the referral order) and sends the first message on the channels you choose. Reminders follow a fixed ladder: an app reminder 3 days before the due date, app and SMS on the day, a community health worker visit 7 days late, and a doctor follow-up 14 days late. Messages never mention a diagnosis.">
      {target && <ApproveBody key={`${target.patientId}-${target.alertId ?? ""}-${target.pathway ?? ""}`} target={target} onDone={() => onOpenChange(false)} />}
    </DetailModal>
  );
}

function ApproveBody({ target, onDone }: { target: ApproveTarget; onDone: () => void }) {
  const qc = useQueryClient();
  const pw = usePathways();
  const care = usePatientCare(target.patientId);
  const env = pw.data as unknown as PathwaysEnvelope | undefined;
  const all: Pathway[] = env?.data ?? [];
  const recommended = useMemo(() => {
    if (target.pathway && all.some((p) => p.id === target.pathway)) return target.pathway;
    const byTrigger = target.trigger ? env?.trigger_pathway?.[target.trigger] : null;
    if (byTrigger) return byTrigger;
    if (target.trigger) { const hit = all.find((p) => p.triggers.includes(target.trigger!)); if (hit) return hit.id; }
    return target.isCase ? "ONCOLOGY_TREATMENT" : "ENDOSCOPY_REFERRAL";
  }, [env, all, target.trigger, target.isCase, target.pathway]);
  const ordered = useMemo(() => {
    const dx = target.isCase && !target.alertId;
    const rank = (p: Pathway) => (p.id === recommended ? 0 : dx === DX_PATHWAYS.includes(p.id) ? 1 : 2);
    return [...all].sort((a, b) => rank(a) - rank(b));
  }, [all, recommended, target.isCase, target.alertId]);

  const [pathway, setPathway] = useState<string | null>(null);
  const sel = pathway ?? recommended;
  const pdef = all.find((p) => p.id === sel);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const ch = channels ?? pdef?.default_channels ?? ["APP", "SMS"];
  const [due, setDue] = useState<string>("");
  const [facility, setFacility] = useState<string>("");
  const [note, setNote] = useState("");
  useEffect(() => { setChannels(null); setDue(""); }, [sel]);

  const body = { patient_id: target.patientId, pathway: sel, alert_id: target.alertId ?? undefined, channels: ch,
                 due_override: due || undefined, target_facility_id: facility ? Number(facility) : undefined };
  const pv = useQuery({
    queryKey: ["care-preview", body],
    queryFn: () => post<Preview>("/care/notifications/preview", body),
    enabled: !!pdef, placeholderData: keepPreviousData, staleTime: 30_000,
  });
  const preview = pv.data?.data;
  const firstDue = preview?.tasks.find((t) => t.due_at)?.due_at ?? null;
  const simNow = pv.data?.meta?.sim_time ?? null;

  const meta = useFiltersMeta();
  const facilities = useMemo(() => {
    const fs: { location_id: number; name: string; facility_type: string }[] = meta.data?.data?.facilities ?? [];
    const keep = fs.filter((f) => f.facility_type !== "HEALTH_CENTRE" || f.location_id === preview?.target_facility?.id);
    return keep.sort((a, b) => a.name.localeCompare(b.name));
  }, [meta.data, preview?.target_facility?.id]);
  const facilityKey = facility || (preview?.target_facility ? String(preview.target_facility.id) : "");

  const existing = (care.data?.data?.plans ?? []).find((p) => p.pathway === sel && isOpenPlan(p));
  const m = useMutation({
    mutationFn: () => post<any>("/care/plans", { ...body, note: note.trim() || undefined }),
    onSuccess: (res) => {
      const n = (res.data?.notifications ?? []).length;
      useLive.getState().toast(`Care plan approved: ${pdef?.name ?? sel}. ${n ? `${n} message${n === 1 ? "" : "s"} sent to the patient.` : "Steps scheduled."}`);
      for (const k of ["alerts", "patients", "care"]) qc.invalidateQueries({ queryKey: [k] });
      onDone();
    },
  });

  if (pw.isLoading) return <Skeleton variant="text" rows={6} label="Loading pathways" />;
  if (pw.error) return <ErrorNote error={pw.error} />;
  const toggle = (c: Channel) => setChannels(ch.includes(c) ? ch.filter((x) => x !== c) : [...ch, c]);
  const app = preview?.messages.find((x) => x.channel === "APP");
  const sms = preview?.messages.find((x) => x.channel === "SMS");
  const err = m.error as ApiError | null;
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col gap-5 min-w-0">
        <section aria-label="Pathway">
          <h3 className="text-label text-muted mb-2">Pathway</h3>
          <div role="radiogroup" aria-label="Care pathway" className="flex flex-col gap-1.5">
            {ordered.map((p) => {
              const on = p.id === sel;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setPathway(p.id)}
                        className={`text-left rounded-tile px-4 py-3 flex items-start gap-3 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand
                                    ${on ? "bg-tile ring-1 ring-ink" : "bg-tile/60 hover:bg-tile"}`}>
                  <span className={`mt-0.5 w-[18px] h-[18px] rounded-full shrink-0 grid place-items-center border ${on ? "bg-ink border-ink" : "border-faint"}`} aria-hidden>
                    {on && <span className="w-1.5 h-1.5 rounded-full bg-ink-on" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-[14px] leading-5 font-semibold text-ink">{p.name}</span>
                      {p.id === recommended && <span className="text-micro text-muted">{target.pathway === p.id ? "Suggested" : "Recommended"}</span>}
                    </span>
                    <span className={`block text-micro font-normal text-muted mt-0.5 ${on ? "" : "line-clamp-1"}`}>{p.description}</span>
                  </span>
                  <span className="text-micro text-muted tabular shrink-0 pt-0.5">{p.tasks.length} steps</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className="text-label text-muted">First step due</span>
            <input type="date" aria-label="Due date" value={due || ymd(firstDue)} min={simNow ? ymd(new Date(Date.parse(simNow) + 86400_000).toISOString()) : undefined}
                   onChange={(e) => setDue(e.target.value)}
                   className="h-10 rounded-full bg-tile px-4 text-[14px] text-ink tabular outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [color-scheme:inherit]" />
          </label>
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="text-label text-muted" id="fac-label">Facility</span>
            <Select aria-labelledby="fac-label" size="sm" radius="full" selectedKeys={facilityKey ? [facilityKey] : []} disallowEmptySelection
                    items={facilities.map((f) => ({ key: String(f.location_id), label: short(f.name) }))}
                    onSelectionChange={(k) => { const v = Array.from(k as Set<string>)[0]; if (v) setFacility(String(v)); }}
                    classNames={{ trigger: "bg-tile data-[hover=true]:bg-tile-hover shadow-none h-10 min-h-10 px-4", value: "text-[14px] text-ink", popoverContent: "bg-surface shadow-float rounded-tile" }}>
              {(i) => <SelectItem key={i.key}>{i.label}</SelectItem>}
            </Select>
          </div>
        </div>

        <section aria-label="Channels">
          <h3 className="text-label text-muted mb-2 flex items-center gap-0.5">Channels
            <InfoHint mode="tooltip" size={13} className="!w-6 !h-6 !min-w-6" label="About channels"
                      content="App and SMS carry the same advice. A community health worker visit is arranged automatically when a step is 7 days late; ticking it here also tells the health worker from the start." />
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Notification channels">
            {CHANNELS.map((c) => {
              const on = ch.includes(c.key);
              const Icon = c.key === "APP" ? Smartphone : c.key === "SMS" ? MessageSquare : UsersRound;
              return (
                <button key={c.key} type="button" aria-pressed={on} onClick={() => toggle(c.key)}
                        className={`h-10 pl-3 pr-4 rounded-full inline-flex items-center gap-2 text-[14px] font-medium transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand
                                    ${on ? "bg-ink text-ink-on" : "bg-tile text-muted hover:text-ink"}`}>
                  <span className={`w-5 h-5 rounded-full grid place-items-center ${on ? "bg-ink-on/15" : ""}`} aria-hidden>{on ? <Check size={13} /> : <Icon size={14} />}</span>
                  {c.long}
                </button>
              );
            })}
          </div>
        </section>

        <Input radius="full" value={note} onValueChange={setNote} placeholder="Note for the team (optional, never sent to the patient)" aria-label="Note for the team" maxLength={2000}
               classNames={{ inputWrapper: "bg-tile data-[hover=true]:bg-tile-hover group-data-[focus=true]:bg-tile shadow-none h-10", input: "text-[14px]" }} />

        <section aria-label="Steps">
          <h3 className="text-label text-muted mb-2">Steps</h3>
          <ol className="flex flex-col">
            {(pdef?.tasks ?? []).map((t, i) => {
              const now = preview?.tasks.find((x) => x.type === t.type);
              return (
                <li key={`${t.type}-${i}`} className="flex items-center gap-3 py-2 border-b border-hairline last:border-0">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-micro tabular shrink-0 ${now ? "bg-ink text-ink-on" : "bg-tile text-muted"}`}>{i + 1}</span>
                  <span className="flex-1 min-w-0 text-[14px] text-ink truncate">{t.title}</span>
                  <span className="text-micro text-muted tabular shrink-0">
                    {now?.due_at ? `Due ${date(now.due_at)}` : t.due_days ? `${t.due_days} days after the step before` : "When needed"}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      <aside className="flex flex-col gap-4 min-w-0 md:sticky md:top-0 self-start" aria-label="Patient message preview">
        <div className="flex items-center gap-0.5">
          <h3 className="text-label text-muted">What the patient receives</h3>
          <InfoHint mode="tooltip" size={13} className="!w-6 !h-6 !min-w-6" label="About the message"
                    content="Plain advice only: messages never mention cancer or a diagnosis. English for now; the wording lives in one catalogue so translations can be added." />
        </div>
        <LockScreen>
          <AnimatePresence mode="popLayout" initial={false}>
            {!preview && pv.isLoading ? <motion.div key="l" className="h-24 rounded-[20px] bg-white/60 animate-pulse" /> : null}
            {app && ch.includes("APP") && (
              <motion.div key={`app-${app.body}`} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE }}>
                <NotificationMock title={app.title} body={`${app.greeting ? `${app.greeting} ` : ""}${app.body}`} />
              </motion.div>
            )}
            {sms && ch.includes("SMS") && (
              <motion.div key={`sms-${sms.body}`} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE, delay: 0.05 }}>
                <SmsMock body={sms.body} />
              </motion.div>
            )}
            {!ch.length && <motion.p key="none" className="text-[13px] text-white/80 text-center py-6">No channel selected: the plan is recorded, but the patient is not told.</motion.p>}
          </AnimatePresence>
        </LockScreen>
        {ch.includes("CHW") && <p className="text-micro text-muted">The community health worker for the patient's village is told about the plan and visits if a step is late.</p>}
        {existing && <p className="text-label text-ink rounded-tile bg-tile px-4 py-3">This patient already has an open {pdef?.name.toLowerCase()} plan. Pick another pathway, or manage the open plan in the care plan card.</p>}
        {err && <ErrorNote error={err} />}
        <div className="flex gap-2">
          <Button radius="full" variant="flat" className="h-11 px-5 bg-tile text-ink text-[14px] font-medium" onPress={onDone}>Cancel</Button>
          <Button radius="full" className="flex-1 h-11 px-5 bg-brand-strong text-brand-on font-semibold text-[14px] data-[hover=true]:bg-brand-text"
                  isLoading={m.isPending} isDisabled={!pdef || !!existing} onPress={() => m.mutate()}>Approve and notify</Button>
        </div>
      </aside>
    </div>
  );
}

/** A small phone lock screen for the message preview (always the dark wallpaper so it reads as a phone). */
function LockScreen({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[28px] p-3 pt-2.5 flex flex-col gap-2 min-h-[220px]" style={{ background: "#20242C" }}>
      <div className="text-center text-white/90 tabular pt-1 pb-2">
        <div className="text-[34px] leading-9 font-medium tracking-[-0.02em]">9:41</div>
        <div className="text-[12px] text-white/60">Preview</div>
      </div>
      {children}
    </div>
  );
}


export function NotificationMock({ title, body, when = "now" }: { title: string; body: string; when?: string }) {
  return (
    <div className="rounded-[20px] bg-white/85 text-[#15171C] px-3.5 py-3 backdrop-blur-sm">
      <div className="flex items-center gap-2 text-[11.5px] text-[#4A4F5C]">
        <AppIcon size={18} /><span className="font-semibold">My care</span><span className="flex-1" /><span>{when}</span>
      </div>
      <div className="text-[13.5px] leading-[18px] font-semibold mt-1.5">{title}</div>
      <div className="text-[13px] leading-[18px] mt-0.5 line-clamp-4">{body}</div>
    </div>
  );
}

function SmsMock({ body }: { body: string }) {
  return (
    <div className="rounded-[20px] bg-white/85 text-[#15171C] px-3.5 py-3">
      <div className="flex items-center gap-2 text-[11.5px] text-[#4A4F5C]">
        <span className="w-[18px] h-[18px] rounded-[6px] bg-[#2E9E6A] grid place-items-center" aria-hidden><MessageSquare size={11} color="white" /></span>
        <span className="font-semibold">Messages</span><span className="flex-1" /><span>now</span>
      </div>
      <div className="text-[13.5px] leading-[18px] font-semibold mt-1.5">Care team (SMS)</div>
      <div className="text-[13px] leading-[18px] mt-0.5 line-clamp-4">{body}</div>
    </div>
  );
}

export { AppIcon };
