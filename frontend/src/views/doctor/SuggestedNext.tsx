import { type ReactNode, useState } from "react";
import { Button } from "@heroui/react";
import { motion, useReducedMotion } from "framer-motion";
import { ClipboardCheck, Signpost } from "lucide-react";
import { Card, ErrorNote } from "@/components/ui";
import { date } from "@/lib/format";
import { itemEnter, stagger } from "@/lib/motion";
import { ApprovePlanModal, type ApproveTarget } from "./ApprovePlanModal";
import { type Suggestion, useSuggestions } from "./care";
import { PatientAvatar } from "./PatientAvatar";

export const SUGGESTION_NOTE = (
  <>
    <span className="block">When a care plan ends with a result that needs a new plan, the care engine suggests the next pathway: cancer found
      at the endoscopy leads to specialist treatment, curative treatment to survivorship follow-up, and a palliative decision to comfort and
      support care.</span>
    <span className="block mt-2">Nothing starts on its own. The patient hears nothing until you start the plan and approve the first message.</span>
  </>
);

const fullName = (s: Suggestion) => [s.given_name, s.family_name].filter(Boolean).join(" ") || s.display_id;

/** The approval-modal target for a suggestion: its pathway pre-selected, the patient named as in the worklist. */
export const suggestionTarget = (s: Suggestion, label?: ReactNode): ApproveTarget => ({
  patientId: s.patient_id, isCase: true, pathway: s.pathway, // every suggested pathway follows a diagnosis
  label: label ?? <>{fullName(s)} <span className="tabular">{s.display_id}</span></>,
});

function StartButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Button size="sm" radius="full" className="h-9 px-4 bg-ink text-ink-on text-[13px] font-semibold shrink-0"
            startContent={<ClipboardCheck size={14} aria-hidden />} aria-label={label} onPress={onPress}>Start plan</Button>
  );
}

/** Follow-ups: open next-plan suggestions at this facility (GET /care/suggestions), one row per patient and pathway, each
 * with a Start plan button that opens the approval modal with the pathway pre-selected. Hidden when there are none. */
export function SuggestionsCard({ className = "" }: { className?: string }) {
  const reduce = useReducedMotion();
  const q = useSuggestions();
  const [start, setStart] = useState<ApproveTarget | null>(null);
  const rows = q.data?.data ?? [];
  if (q.error) return <div className={className}><ErrorNote error={q.error} /></div>;
  if (!rows.length) return null;
  return (
    <>
      <Card className={className} padding="none" title="Suggested next plans" icon={<Signpost size={16} />} info={{ about: SUGGESTION_NOTE }}
            actions={<span className="text-micro text-muted tabular">{rows.length} waiting</span>}>
        <motion.ul className="px-3 pb-3 flex flex-col" aria-label="Suggested next plans" variants={stagger(0.03)} initial={reduce ? false : "hidden"} animate="show">
          {rows.map((s) => (
            <motion.li key={`${s.patient_id}-${s.pathway}`} variants={itemEnter}
                       className="rounded-tile px-4 py-2.5 grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,280px)_minmax(0,1fr)_128px_auto] gap-x-4 gap-y-1 items-center">
              <span className="min-w-0 flex items-center gap-3">
                <PatientAvatar name={fullName(s)} size="sm" />
                <span className="min-w-0">
                  <span className="block text-[14px] leading-5 font-semibold text-ink truncate">{fullName(s)}</span>
                  <span className="block text-micro font-normal text-muted tabular truncate">{s.display_id}</span>
                </span>
              </span>
              <span className="min-w-0 order-last md:order-none col-span-2 md:col-span-1 pl-12 md:pl-0">
                <span className="block text-[14px] leading-5 font-medium text-ink truncate">{s.pathway_name}</span>
                <span className="block text-micro font-normal text-muted md:truncate">{s.reason}<span className="md:hidden">, since {date(s.since)}</span></span>
              </span>
              <span className="hidden md:block text-micro text-muted tabular">Since {date(s.since)}</span>
              <StartButton label={`Start ${s.pathway_name.toLowerCase()} plan for ${s.display_id}`} onPress={() => setStart(suggestionTarget(s))} />
            </motion.li>
          ))}
        </motion.ul>
      </Card>
      <ApprovePlanModal target={start} isOpen={!!start} onOpenChange={(o) => { if (!o) setStart(null); }} />
    </>
  );
}

/** Case screen: a compact banner above the care plans for the patient's open suggestion(s). */
export function SuggestionBanner({ suggestions, onStart, className = "" }: { suggestions: Suggestion[] | undefined; onStart: (s: Suggestion) => void; className?: string }) {
  if (!suggestions?.length) return null;
  return (
    <div className={`flex flex-col gap-2 ${className}`} aria-label="Suggested next plan" role="region">
      {suggestions.map((s) => (
        <div key={s.pathway} className="flex items-center gap-3 flex-wrap rounded-tile bg-tile px-4 py-3">
          <span className="w-9 h-9 rounded-full border border-hairline grid place-items-center shrink-0 text-ink" aria-hidden><Signpost size={15} /></span>
          <div className="min-w-0 flex-1 basis-[200px]">
            <div className="text-[14px] leading-5 font-semibold text-ink">Next plan suggested: {s.pathway_name}</div>
            <div className="text-micro font-normal text-muted tabular">{s.reason}, since {date(s.since)}</div>
          </div>
          <StartButton label={`Start ${s.pathway_name.toLowerCase()} plan`} onPress={() => onStart(s)} />
        </div>
      ))}
    </div>
  );
}

/** Patient panel care card: a one-line link per suggestion. */
export function SuggestionLink({ suggestions, onStart }: { suggestions: Suggestion[] | undefined; onStart: (s: Suggestion) => void }) {
  if (!suggestions?.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {suggestions.map((s) => (
        <button key={s.pathway} type="button" onClick={() => onStart(s)} title={s.reason}
                className="self-start inline-flex items-center gap-2 text-[13px] text-ink rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand group">
          <Signpost size={13} className="text-muted" aria-hidden />
          <span>Suggested: {s.pathway_name},</span>
          <span className="font-semibold underline decoration-hairline underline-offset-4 group-hover:decoration-ink">start</span>
        </button>
      ))}
    </div>
  );
}
