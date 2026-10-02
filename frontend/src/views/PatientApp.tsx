import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Smartphone } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useLiveSocket } from "@/lib/useLiveSocket";
import { useRole } from "@/state/role";
import { useMyPlan } from "./patient/api";
import { PhoneApp } from "./patient/PhoneApp";
import { DemoPicker, EventLog, PhoneFrame, SimStrip } from "./patient/Simulator";
import "./patient/patient.css";

const ABOUT = "A simulated patient phone. When a doctor approves a care plan, the patient receives plain advice in the app and by SMS, sees their plan and journey, confirms bookings, tracks medicines and sends weekly check-ins that are written back to the EMR. Synthetic patients only; the name shown on the phone is the patient's own app view.";

/** v3 patient app (plan §6): `/patient` = phone simulator + event log + simulate strip; `/patient/app` = the same screens
 * full screen (installable PWA scope, outside the dashboard shell). */
export default function PatientApp({ fullscreen = false }: { fullscreen?: boolean }) {
  return fullscreen ? <FullScreen /> : <SimulatorPage />;
}

function SimulatorPage() {
  const { role, patientId, setRole } = useRole();
  useEffect(() => { if (role !== "patient") setRole("patient"); }, [role, setRole]);
  const plan = useMyPlan();
  const [shake, setShake] = useState(0);
  const simNow = (plan.data?.meta?.sim_time as string | undefined) ?? null;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Patient app" eyebrow="Simulated phone, synthetic patients" icon={<Smartphone size={18} />} info={ABOUT}
                  actions={
                    <div className="flex items-center gap-2">
                      {patientId && <DemoPicker compact />}
                      <Link to="/patient/app" target="_blank" rel="noreferrer" aria-label="Open the full-screen app in a new tab"
                            className="h-10 px-4 rounded-full bg-surface text-ink text-[14px] font-medium inline-flex items-center gap-2 hover:bg-tile dark:border dark:border-hairline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal">
                        <ExternalLink size={14} aria-hidden />Full screen
                      </Link>
                    </div>
                  } />
      {!patientId ? (
        <div className="min-h-[480px] grid place-items-center"><DemoPicker /></div>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] items-start">
            <div className="min-w-0" key={patientId}>
              <PhoneFrame simNow={simNow} shakeKey={shake}>
                <PhoneApp framed onPushed={() => setShake((x) => x + 1)} />
              </PhoneFrame>
            </div>
            <div className="min-w-0 lg:sticky lg:top-0 flex flex-col gap-5">
              <SimStrip />
              <EventLog key={patientId} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Full-screen app for a real phone: safe-area aware, its own live socket (it renders outside the dashboard shell), and
 * the service worker registered for the /patient/app scope only (production builds). */
function FullScreen() {
  useLiveSocket();
  const { role, patientId, setRole } = useRole();
  useEffect(() => { if (role !== "patient") setRole("patient"); }, [role, setRole]);
  useEffect(() => {
    // edge-to-edge on phones: let the content run under the notch and home bar (the screens pad with safe-area insets)
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = meta?.content;
    if (meta) meta.content = "width=device-width, initial-scale=1.0, viewport-fit=cover";
    document.title = "My care (Synthetic)";
    return () => { if (meta && before) meta.content = before; };
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/patient/app" }).catch(() => { /* offline shell is optional */ });
  }, []);
  if (!patientId) {
    return <div className="min-h-[100dvh] bg-page px-5 py-10 pa-safe-top grid place-items-start justify-center"><DemoPicker /></div>;
  }
  return (
    <div className="h-[100dvh] w-full bg-page">
      <PhoneApp framed={false} key={patientId} onSwitch={() => useRole.setState({ patientId: null, patientDisplayId: null })} />
    </div>
  );
}
