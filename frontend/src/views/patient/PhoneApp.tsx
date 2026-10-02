import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ClipboardList, Home as HomeIcon, Route, SmilePlus, UserRound } from "lucide-react";
import { EASE } from "@/lib/motion";
import { usePush } from "@/lib/useLiveSocket";
import { AppIcon } from "@/views/doctor/ApprovePlanModal";
import { useMe, useMyPlan, useNotes } from "./api";
import { Home } from "./Home";
import { PhoneLayer } from "./kit";
import { CheckinScreen, Inbox, JourneyScreen, MeScreen, PlanScreen } from "./Screens";

type Tab = "home" | "plan" | "journey" | "checkin" | "me";
const TABS: { key: Tab; label: string; icon: typeof HomeIcon }[] = [
  { key: "home", label: "Home", icon: HomeIcon }, { key: "plan", label: "Plan", icon: ClipboardList }, { key: "journey", label: "Journey", icon: Route },
  { key: "checkin", label: "Check-in", icon: SmilePlus }, { key: "me", label: "Me", icon: UserRound },
];

/** The patient app itself (same screens in the phone simulator and the installable PWA): five tabs, a messages overlay,
 * and the live notification banner that drops from the top when a `notification` WS event arrives. `onPushed` lets the
 * simulator shake the phone. */
export function PhoneApp({ framed, onSwitch, onPushed }: { framed: boolean; onSwitch?: () => void; onPushed?: () => void }) {
  const [tab, setTab] = useState<Tab>("home");
  const [inbox, setInbox] = useState<null | "app" | "sms">(null);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const me = useMe();
  const plan = useMyPlan();
  const notes = useNotes();
  const simNow = (plan.data?.meta?.sim_time as string | undefined) ?? (notes.data?.meta?.sim_time as string | undefined) ?? null;
  const plans = plan.data?.data?.plans ?? [];
  const list = notes.data?.data ?? [];
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [tab, inbox]);
  const go = (t: Tab) => { setInbox(null); setTab(t); };
  return (
    <PhoneLayer.Provider value={layer}>
      <div ref={setLayer} className="relative h-full w-full overflow-hidden bg-page text-ink flex flex-col" data-testid="patient-app">
        <Banner framed={framed} onOpen={(ch) => setInbox(ch === "SMS" ? "sms" : "app")} onPushed={onPushed} />
        <div ref={scroller} className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden pa-scroll ${framed ? "pt-[50px]" : "pa-safe-top"}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={inbox ? `inbox-${inbox}` : tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }} className="min-h-full">
              {me.error ? <div className="p-6 text-[15px] text-signal-text" role="alert">{(me.error as Error).message}</div>
                : inbox ? <Inbox notes={list} onBack={() => setInbox(null)} initial={inbox} />
                : tab === "home" ? <Home me={me.data?.data} plans={plans} notes={list} simNow={simNow} onInbox={() => setInbox("app")} onTab={go} />
                : tab === "plan" ? <PlanScreen plans={plans} simNow={simNow} />
                : tab === "journey" ? <JourneyScreen simNow={simNow} />
                : tab === "checkin" ? <CheckinScreen onDone={() => go("home")} />
                : <MeScreen me={me.data?.data} plans={plans} onSwitch={onSwitch} />}
            </motion.div>
          </AnimatePresence>
        </div>
        <nav aria-label="Patient app" className={`shrink-0 bg-surface/95 border-t border-hairline ${framed ? "pb-[22px]" : "pa-safe-bottom"}`}>
          <ul className="grid grid-cols-5 h-[60px]">
            {TABS.map((t) => {
              const on = !inbox && tab === t.key;
              return (
                <li key={t.key} className="contents">
                  <button type="button" onClick={() => go(t.key)} aria-current={on ? "page" : undefined}
                          className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-brand ${on ? "text-ink" : "text-muted"}`}>
                    <t.icon size={22} strokeWidth={on ? 2.3 : 1.8} aria-hidden />
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </PhoneLayer.Provider>
  );
}

/** iOS-like banner: drops from the top with a spring, stays 5 s, tap to open the message. */
function Banner({ framed, onOpen, onPushed }: { framed: boolean; onOpen: (channel: string) => void; onPushed?: () => void }) {
  const { banners, seq, shift } = usePush();
  const reduce = useReducedMotion();
  const cur = banners[0] ?? null;
  useEffect(() => { if (seq) onPushed?.(); }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!cur) return; const t = window.setTimeout(shift, 5200); return () => window.clearTimeout(t); }, [cur, shift]);
  return (
    <div className={`absolute inset-x-2 z-50 pointer-events-none ${framed ? "top-[52px]" : "top-[max(env(safe-area-inset-top),8px)]"}`} aria-live="polite">
      <AnimatePresence>
        {cur && (
          <motion.button key={cur.id} type="button" onClick={() => { onOpen(cur.channel); shift(); }}
                         initial={reduce ? { opacity: 0 } : { y: -130, opacity: 0.6 }} animate={{ y: 0, opacity: 1 }} exit={reduce ? { opacity: 0 } : { y: -130, opacity: 0 }}
                         transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.9 }}
                         className="pointer-events-auto w-full text-left rounded-[24px] bg-surface/95 shadow-float px-4 py-3 border border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                         aria-label={`New message: ${cur.title}`} data-testid="push-banner">
            <span className="flex items-center gap-2 text-[12px] text-muted">
              <AppIcon size={20} /><span className="font-semibold text-ink/80">My care</span>{cur.channel === "SMS" && <span>SMS</span>}<span className="flex-1" /><span>now</span>
            </span>
            <span className="block text-[15px] leading-5 font-semibold text-ink mt-1.5">{cur.title}</span>
            <span className="block text-[14px] leading-5 text-ink/75 line-clamp-2">{cur.body}</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
