import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { Apple, Check, Globe, HeartHandshake, Hospital, Lock, MessageSquare, Phone, Salad, Smartphone, Syringe, UserRound, Utensils } from "lucide-react";
import { post } from "@/api/client";
import { Sparkline } from "@/components/ui";
import { EASE, SPRING } from "@/lib/motion";
import { day, facilityShort, type Me, type MyJourney, type MyPlan, type Note, relDays, useMyJourney } from "./api";
import { PCard, pBtn, Screen, SectionTitle, StepPill } from "./kit";

/* ------------------------------------------------------------------------------------------------ plan */

/** My care plan: every step with a status that updates live as the EMR shows it done (the row flashes when it changes). */
export function PlanScreen({ plans, simNow }: { plans: MyPlan[]; simNow: string | null }) {
  const reduce = useReducedMotion();
  const prev = useRef<Record<string, string>>({});
  const changed = useMemo(() => {
    const out = new Set<string>();
    for (const p of plans) for (const t of p.tasks) if (prev.current[t.id] && prev.current[t.id] !== t.status) out.add(t.id);
    return out;
  }, [plans]);
  useEffect(() => { for (const p of plans) for (const t of p.tasks) prev.current[t.id] = t.status; }, [plans]);
  const open = plans.filter((p) => p.status === "ACTIVE" || p.status === "ESCALATED");
  const closed = plans.filter((p) => !open.includes(p));
  return (
    <Screen label="My care plan" title="My care plan" sub="Steps your doctor agreed with you">
      {!plans.length && <PCard><p className="text-[15px] text-muted">You have no care plan yet. Your doctor will send you a message if you need a check-up.</p></PCard>}
      {[...open, ...closed].map((p) => {
        const steps = [...p.tasks].filter((t) => t.status !== "CANCELLED" || t.patient_facing).sort((a, b) => a.seq - b.seq || (a.occurrence ?? 0) - (b.occurrence ?? 0));
        const done = steps.filter((t) => t.status === "COMPLETED").length;
        return (
          <PCard key={p.id} label={p.pathway_name ?? p.pathway} className={open.includes(p) ? "" : "opacity-80"}>
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-[19px] leading-6 font-semibold text-ink">{p.pathway_name ?? "Care plan"}</h2>
                <div className="text-[13px] text-muted mt-0.5 tabular">Agreed {day(p.approved_at)}{p.target_facility_name ? `, ${facilityShort(p.target_facility_name)}` : ""}</div>
              </div>
              <span className="text-[13px] text-muted tabular shrink-0 pt-1">{done} of {steps.length}</span>
            </div>
            <div className="flex gap-1 mt-3" aria-hidden>{steps.map((t) => <span key={t.id} className={`h-1.5 flex-1 rounded-full ${t.status === "COMPLETED" ? "bg-ink" : "bg-hairline"}`} />)}</div>
            <ol className="mt-3 flex flex-col" aria-label="Steps">
              {steps.map((t) => {
                const flash = changed.has(t.id);
                const d = relDays(simNow, t.due_at);
                return (
                  <motion.li key={t.id} layout={!reduce} className="relative flex items-center gap-3 py-3.5 border-b border-hairline last:border-0 min-h-[64px]">
                    {flash && !reduce && <motion.span className="absolute inset-x-[-12px] inset-y-0 rounded-[16px] bg-sky-soft" initial={{ opacity: 0.9 }} animate={{ opacity: 0 }} transition={{ duration: 2.4, ease: EASE }} aria-hidden />}
                    <span className={`relative w-7 h-7 rounded-full grid place-items-center shrink-0 ${t.status === "COMPLETED" ? "bg-ink text-ink-on" : "border-[1.5px] border-hairline"}`} aria-hidden>
                      {t.status === "COMPLETED" && <Check size={15} strokeWidth={2.6} />}
                    </span>
                    <div className="relative flex-1 min-w-0">
                      <div className={`text-[16px] leading-[22px] font-medium ${t.patient_facing ? "text-ink" : "text-muted"}`}>{t.title}</div>
                      <div className="text-[13px] text-muted tabular">
                        {t.status === "COMPLETED" ? `Done ${day(t.completed_at)}` : !t.patient_facing ? "Your care team does this" : t.status === "SCHEDULED" ? `From ${day(t.opens_at)}` : d !== null && d < 0 ? `Was due ${day(t.due_at)}` : `By ${day(t.due_at)}`}
                      </div>
                    </div>
                    <span className="relative"><StepPill status={t.status} /></span>
                  </motion.li>
                );
              })}
            </ol>
          </PCard>
        );
      })}
    </Screen>
  );
}

/* ------------------------------------------------------------------------------------------------ journey */

const TIPS = [
  { icon: Utensils, text: "Eat six small meals a day instead of three large ones." },
  { icon: Apple, text: "Add protein to every meal: beans, eggs, milk, fish or meat." },
  { icon: Salad, text: "Drink between meals, not with them, and go easy on sugary drinks." },
];

/** My journey: a calm phase timeline in patient words; diagnosed patients also see recovery, B12 and nutrition. */
export function JourneyScreen({ simNow }: { simNow: string | null }) {
  const q = useMyJourney();
  const j: MyJourney | undefined = q.data?.data;
  const phases = j?.phases ?? [];
  const lastDone = phases.reduce((acc, p, i) => (p.status === "done" ? i : acc), -1);
  const anyCurrent = phases.some((x) => x.status === "current");
  const hadOperation = phases.some((p) => p.milestones.some((m) => m.label === "Operation"));
  const rec = j?.recovery;
  const diagnosed = !!rec || phases.some((p) => ["Treatment", "Recovery", "Surveillance", "Survivorship", "Palliative"].includes(p.phase));
  return (
    <Screen label="My journey" title="My journey" sub={diagnosed ? "Treatment, recovery and staying well" : "Where you are in your care"}>
      <PCard label="Phases" className="!py-3">
        {q.isLoading && <div className="h-40 animate-pulse rounded-[16px] bg-tile" />}
        {!q.isLoading && !phases.length && <p className="text-[15px] text-muted py-2">Your journey starts when your doctor agrees a care plan with you.</p>}
        <ol aria-label="Journey">
          {phases.map((p, i) => {
            const cur = p.status === "current" || (!anyCurrent && i === lastDone);
            const done = p.status === "done" && !cur;
            return (
              <li key={`${p.phase}-${i}`} className="relative flex gap-4 pb-1" aria-current={cur ? "step" : undefined}>
                <div className="flex flex-col items-center w-5 shrink-0 pt-[18px]">
                  <span className={`rounded-full shrink-0 ${cur ? "w-4 h-4 bg-signal ring-4 ring-signal/20" : done ? "w-3 h-3 bg-ink" : "w-3 h-3 border-[1.5px] border-dashed border-faint"}`} aria-hidden />
                  {i < phases.length - 1 && <span className={`flex-1 w-[2px] mt-1 ${done ? "bg-ink" : "bg-hairline"}`} aria-hidden />}
                </div>
                <div className="flex-1 min-w-0 py-3">
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[17px] leading-6 ${cur ? "font-semibold text-ink" : done ? "text-ink" : "text-muted"}`}>{p.label}</span>
                    {cur && <span className="text-[12.5px] font-medium text-signal-text">You are here</span>}
                  </div>
                  <div className="text-[13px] text-muted tabular">{p.start ? day(p.start, { day: "numeric", month: "long", year: "numeric" }) : "Coming up"}</div>
                  {p.milestones.some((m) => m.label !== p.label) && (cur || p.milestones.length <= 2) && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {p.milestones.filter((m) => m.label !== p.label).slice(-4).map((m, k) => <li key={k} className="text-[14px] text-ink/80 flex gap-2"><span className="text-muted tabular w-[52px] shrink-0">{day(m.date, { day: "numeric", month: "short" })}</span>{m.label}</li>)}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </PCard>

      {rec && (
        <>
          <SectionTitle>Your recovery</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <PCard className="!p-4" label="Next visit">
              <div className="text-[13px] text-muted">Next visit</div>
              <div className="text-[20px] leading-7 font-semibold text-ink mt-1 tabular">{rec.next_visit ? day(rec.next_visit) : "Not booked"}</div>
              {rec.next_visit && <div className="text-[13px] text-muted">{(() => { const d = relDays(simNow, rec.next_visit); return d === null ? "" : d < 0 ? "Please book again" : d === 0 ? "Today" : `In ${d} days`; })()}</div>}
            </PCard>
            <PCard className="!p-4" label="Treatment">
              <div className="text-[13px] text-muted">Treatment cycles</div>
              <div className="text-[20px] leading-7 font-semibold text-ink mt-1 tabular">{rec.treatment_cycles.planned ? `${rec.treatment_cycles.done ?? 0} of ${rec.treatment_cycles.planned}` : "None"}</div>
              {!!rec.treatment_cycles.planned && <div className="flex gap-1 mt-2" aria-hidden>{Array.from({ length: rec.treatment_cycles.planned }, (_, i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${i < (rec.treatment_cycles.done ?? 0) ? "bg-ink" : "bg-hairline"}`} />)}</div>}
            </PCard>
          </div>
          {rec.weight.length > 1 && (
            <PCard label="Weight">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] text-muted flex-1">Your weight</span>
                <span className="text-[22px] font-semibold text-ink tabular">{rec.weight[rec.weight.length - 1].value.toFixed(1)}</span><span className="text-[14px] text-muted">kg</span>
              </div>
              <div className="mt-3"><Sparkline values={rec.weight.map((w) => w.value)} height={56} /></div>
              <div className="flex justify-between text-[12px] text-muted tabular mt-1"><span>{day(rec.weight[0].date, { month: "short", year: "numeric" })}</span><span>{day(rec.weight[rec.weight.length - 1].date, { month: "short", year: "numeric" })}</span></div>
            </PCard>
          )}
          {hadOperation && (
            <PCard label="Vitamin B12" className="flex gap-4">
              <span className="w-11 h-11 rounded-full bg-tile grid place-items-center text-ink shrink-0" aria-hidden><Syringe size={20} /></span>
              <div>
                <div className="text-[16px] font-semibold text-ink">Vitamin B12 injections</div>
                <p className="text-[14px] leading-5 text-muted mt-1">After your operation your body cannot take vitamin B12 from food. You need an injection about every 3 months, and a blood test once a year.</p>
              </div>
            </PCard>
          )}
          <PCard label="Eating well">
            <div className="text-[16px] font-semibold text-ink">Eating well</div>
            <ul className="mt-3 flex flex-col gap-3">
              {TIPS.map((t) => (
                <li key={t.text} className="flex gap-3 items-start text-[15px] leading-[21px] text-ink/85"><span className="w-9 h-9 rounded-full bg-tile grid place-items-center text-ink shrink-0" aria-hidden><t.icon size={17} /></span><span className="pt-1.5">{t.text}</span></li>
              ))}
            </ul>
          </PCard>
        </>
      )}
      {!diagnosed && phases.length > 0 && (
        <PCard label="What happens next">
          <div className="text-[16px] font-semibold text-ink">What happens next</div>
          <p className="text-[14px] leading-5 text-muted mt-1.5">After your check-up, the doctor will talk with you about the result and the next step. You will get a message here when it is time.</p>
        </PCard>
      )}
    </Screen>
  );
}

/* ------------------------------------------------------------------------------------------------ check-in */

function Range({ label, hint, value, onChange, low, high }: { label: string; hint: string; value: number; onChange: (v: number) => void; low: string; high: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-[16px] font-semibold text-ink" htmlFor={`pa-${label}`}>{label}</label>
        <span className="text-[22px] font-semibold text-ink tabular w-8 text-right">{value}</span>
      </div>
      <div className="text-[13px] text-muted">{hint}</div>
      <input id={`pa-${label}`} type="range" min={0} max={10} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))}
             className="pa-range mt-1" style={{ ["--pa-fill" as string]: `${value * 10}%` }} aria-valuetext={`${value} of 10`} />
      <div className="flex justify-between text-[12px] text-muted -mt-1"><span>{low}</span><span>{high}</span></div>
    </div>
  );
}

/** Weekly check-in: appetite, pain, energy (0-10), dumping yes/no and an optional weight, sent to the EMR (encounter 16). */
export function CheckinScreen({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const [appetite, setAppetite] = useState(6);
  const [pain, setPain] = useState(2);
  const [energy, setEnergy] = useState(6);
  const [dumping, setDumping] = useState<boolean | null>(null);
  const [weight, setWeight] = useState("");
  const w = weight.trim() ? Number(weight.replace(",", ".")) : null;
  const wBad = w !== null && (!Number.isFinite(w) || w < 20 || w > 250);
  const m = useMutation({
    mutationFn: () => post("/me/checkins", { appetite, pain, energy, dumping: !!dumping, weight_kg: w ?? undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  if (m.isSuccess) {
    return (
      <Screen label="Check-in sent">
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 pt-20" role="status">
          <motion.span initial={reduce ? false : { scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING}
                       className="w-24 h-24 rounded-full bg-ink text-ink-on grid place-items-center" aria-hidden><Check size={44} strokeWidth={2.4} /></motion.span>
          <h1 className="text-[28px] leading-9 font-semibold text-ink">Thank you</h1>
          <p className="text-[16px] leading-6 text-muted max-w-[300px]">Your answers are in your health record. Your care team will look at them at your next visit.</p>
          <button type="button" className={`${pBtn.ink} mt-4 w-full max-w-[280px]`} onClick={() => { m.reset(); onDone(); }}>Done</button>
        </div>
      </Screen>
    );
  }
  return (
    <Screen label="Weekly check-in" title="Weekly check-in" sub="How have you been this week?">
      <PCard className="flex flex-col gap-5">
        <Range label="Appetite" hint="How much did you want to eat?" value={appetite} onChange={setAppetite} low="None" high="Normal" />
        <Range label="Pain" hint="Pain in your stomach or belly" value={pain} onChange={setPain} low="No pain" high="Worst" />
        <Range label="Energy" hint="How much energy did you have?" value={energy} onChange={setEnergy} low="Very tired" high="Full" />
      </PCard>
      <PCard>
        <div className="text-[16px] font-semibold text-ink" id="pa-dumping">Dizzy, sweaty or sick soon after eating?</div>
        <div className="text-[13px] text-muted">Within an hour of a meal</div>
        <div className="grid grid-cols-2 gap-2.5 mt-3" role="radiogroup" aria-labelledby="pa-dumping">
          {[{ v: true, l: "Yes" }, { v: false, l: "No" }].map((o) => (
            <button key={o.l} type="button" role="radio" aria-checked={dumping === o.v} onClick={() => setDumping(o.v)}
                    className={`h-12 rounded-full text-[16px] font-semibold transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal ${dumping === o.v ? "bg-ink text-ink-on" : "bg-tile text-ink"}`}>{o.l}</button>
          ))}
        </div>
      </PCard>
      <PCard>
        <label className="text-[16px] font-semibold text-ink" htmlFor="pa-weight">Your weight <span className="text-muted font-normal">(optional)</span></label>
        <div className="mt-3 flex items-center gap-2 h-12 rounded-full bg-tile px-5">
          <input id="pa-weight" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="For example 58.5"
                 className="flex-1 min-w-0 bg-transparent text-[17px] text-ink tabular outline-none placeholder:text-faint" aria-invalid={wBad} />
          <span className="text-[15px] text-muted">kg</span>
        </div>
        {wBad && <p className="text-[13px] text-signal-text mt-2">Enter a weight between 20 and 250 kg</p>}
      </PCard>
      {m.error && <p className="text-[14px] text-signal-text px-1" role="alert">{(m.error as Error).message}</p>}
      <button type="button" className={pBtn.primary} disabled={dumping === null || wBad || m.isPending} onClick={() => m.mutate()}>Send to my care team</button>
      <p className="text-[13px] text-muted text-center px-4">If you feel very unwell, vomit blood or have black stools, go to your health centre today.</p>
    </Screen>
  );
}

/* ------------------------------------------------------------------------------------------------ me */

export function MeScreen({ me, plans, onSwitch }: { me: Me | undefined; plans: MyPlan[]; onSwitch?: () => void }) {
  const channels = [...new Set(plans.flatMap((p) => p.channels))];
  const first = me?.given_name?.split(/\s+/)[0] ?? "";
  const rows = [
    { icon: Hospital, k: "My clinic", v: facilityShort(me?.facility.name) || "Not set" },
    { icon: HeartHandshake, k: "Community health worker", v: me ? me.chw.phone : "", action: <span className="w-10 h-10 rounded-full bg-ink text-ink-on grid place-items-center" aria-hidden><Phone size={16} /></span> },
    { icon: Globe, k: "Language", v: "English" },
    { icon: Smartphone, k: "Messages by", v: channels.length ? channels.map((c) => (c === "APP" ? "app" : c === "SMS" ? "SMS" : "health worker")).join(", ").replace(/^./, (x) => x.toUpperCase()) : "App" },
  ];
  return (
    <Screen label="Me" title="Me">
      <PCard className="flex items-center gap-4">
        <span className="w-16 h-16 rounded-full bg-tile-hover text-ink grid place-items-center text-[24px] font-semibold shrink-0" aria-hidden>{first ? first[0] : <UserRound size={26} />}</span>
        <div className="min-w-0">
          <div className="text-[22px] leading-7 font-semibold text-ink truncate">{first}</div>
          <div className="text-[14px] text-muted tabular">{me?.display_id}</div>
        </div>
      </PCard>
      <PCard className="!py-1.5">
        <ul>
          {rows.map((r) => (
            <li key={r.k} className="flex items-center gap-3.5 py-3.5 border-b border-hairline last:border-0 min-h-[64px]">
              <span className="w-10 h-10 rounded-full bg-tile grid place-items-center text-ink shrink-0" aria-hidden><r.icon size={18} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-muted">{r.k}</div>
                <div className="text-[16px] text-ink truncate">{r.v}</div>
              </div>
              {r.action}
            </li>
          ))}
        </ul>
      </PCard>
      <PCard className="flex gap-3.5" label="Privacy">
        <span className="w-10 h-10 rounded-full bg-tile grid place-items-center text-ink shrink-0" aria-hidden><Lock size={18} /></span>
        <div>
          <div className="text-[16px] font-semibold text-ink">Your privacy</div>
          <p className="text-[14px] leading-5 text-muted mt-1">Only your care team sees what you share here. Messages never include results; your doctor tells you those in person. This is a demo with synthetic data.</p>
        </div>
      </PCard>
      {onSwitch && <button type="button" className={pBtn.soft} onClick={onSwitch}>Switch demo patient</button>}
    </Screen>
  );
}

/* ------------------------------------------------------------------------------------------------ inbox */

/** Messages: app notifications with unread dots (opening one marks it read), and the SMS thread styled like a phone's
 * messages app. */
export function Inbox({ notes, onBack, initial = "app" }: { notes: Note[]; onBack: () => void; initial?: "app" | "sms" }) {
  const qc = useQueryClient();
  const [view, setView] = useState<"app" | "sms">(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const read = useMutation({
    mutationFn: (id: string) => post(`/me/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const app = notes.filter((n) => n.channel === "APP");
  const sms = notes.filter((n) => n.channel === "SMS").slice().reverse();
  const unread = app.filter((n) => !n.read_sim).length;
  return (
    <Screen label="Messages" title="Messages" onBack={onBack}>
      <div className="grid grid-cols-2 p-1 rounded-full bg-tile" role="tablist" aria-label="Message type">
        {(["app", "sms"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
                  className={`relative h-10 rounded-full text-[15px] font-semibold focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal ${view === k ? "text-ink" : "text-muted"}`}>
            {view === k && <motion.span layoutId="pa-inbox-tab" className="absolute inset-0 rounded-full bg-surface dark:bg-hairline" transition={SPRING} aria-hidden />}
            <span className="relative">{k === "app" ? `In the app${unread ? ` (${unread})` : ""}` : "SMS"}</span>
          </button>
        ))}
      </div>
      {view === "app" ? (
        <ul className="flex flex-col gap-2.5" aria-label="App messages">
          {app.map((n) => {
            const isOpen = openId === n.id;
            return (
              <li key={n.id}>
                <button type="button" aria-expanded={isOpen} onClick={() => { setOpenId(isOpen ? null : n.id); if (!n.read_sim) read.mutate(n.id); }}
                        className="w-full text-left rounded-[22px] bg-surface p-4 flex gap-3 dark:border dark:border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
                  <span className="w-2.5 pt-2 shrink-0" aria-hidden>{!n.read_sim && <span className="block w-2.5 h-2.5 rounded-full bg-signal" />}</span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-2">
                      <span className={`flex-1 text-[16px] leading-[22px] text-ink ${n.read_sim ? "font-medium" : "font-semibold"}`}>{n.title}</span>
                      <span className="text-[12.5px] text-muted tabular shrink-0">{day(n.created_sim, { day: "numeric", month: "short" })}</span>
                    </span>
                    <span className={`block text-[14.5px] leading-[21px] text-muted mt-0.5 ${isOpen ? "" : "line-clamp-2"}`}>{isOpen && n.greeting ? `${n.greeting} ` : ""}{n.body}</span>
                    {!n.read_sim && <span className="sr-only">Unread</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {!app.length && <li className="text-[15px] text-muted text-center py-10">No messages yet</li>}
        </ul>
      ) : (
        <div className="rounded-[24px] bg-surface flex flex-col min-h-[440px] overflow-hidden dark:border dark:border-hairline" aria-label="SMS thread">
          <div className="flex flex-col items-center gap-1 py-4 border-b border-hairline">
            <span className="w-12 h-12 rounded-full bg-tile-hover grid place-items-center text-ink" aria-hidden><MessageSquare size={20} /></span>
            <span className="text-[14px] font-semibold text-ink">Care team</span>
            <span className="text-[12px] text-muted">SMS, text only</span>
          </div>
          <ol className="flex-1 flex flex-col gap-2 px-4 py-4">
            {sms.map((n, i) => (
              <motion.li key={n.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }}>
                {(i === 0 || !sms[i - 1].created_sim.startsWith(n.created_sim.slice(0, 10))) && (
                  <div className="text-center text-[12px] text-muted my-2 tabular">{day(n.created_sim, { weekday: "short", day: "numeric", month: "short" })}</div>
                )}
                <div className="max-w-[86%] rounded-[20px] rounded-bl-[6px] bg-tile px-3.5 py-2.5 text-[15px] leading-[21px] text-ink">{n.body}</div>
              </motion.li>
            ))}
            {!sms.length && <li className="text-[15px] text-muted text-center py-10">No text messages yet</li>}
          </ol>
          <div className="mx-3 mb-3 h-11 rounded-full border border-hairline px-4 flex items-center text-[14px] text-faint">Replies are not read by this number</div>
        </div>
      )}
    </Screen>
  );
}
