import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./Shell";
import { Loading } from "@/components/ui/Skeleton";
import { useRole } from "@/state/role";

const Overview = lazy(() => import("@/views/Overview"));
const GeoExplorer = lazy(() => import("@/views/GeoExplorer"));
const TrendsLab = lazy(() => import("@/views/TrendsLab"));
const EarlyWarning = lazy(() => import("@/views/EarlyWarning"));
const CareQuality = lazy(() => import("@/views/CareQuality"));
const ModelArena = lazy(() => import("@/views/ModelArena"));
const DoctorWorkspace = lazy(() => import("@/views/DoctorWorkspace"));
const CaseAnalysis = lazy(() => import("@/views/CaseAnalysis"));
const AgentView = lazy(() => import("@/views/agent/AgentView"));
// v3 (docs/contracts/v3-loop.md §9)
const Outlook = lazy(() => import("@/views/Outlook"));
const CareProgramme = lazy(() => import("@/views/CareProgramme"));
const PatientApp = lazy(() => import("@/views/PatientApp"));

/** The old "Ask the data" route now opens the AI agent (plan §B7), keeping the question (?q=). */
function AskRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/agent", search }} replace />;
}

export function App() {
  const { pathname } = useLocation();
  // /patient/app is the installable PWA scope: full screen, no dashboard shell
  if (pathname === "/patient/app" || pathname.startsWith("/patient/app/")) {
    return <Suspense fallback={<Loading h={400} />}><PatientApp fullscreen /></Suspense>;
  }
  return <ShellApp />;
}

function ShellApp() {
  const role = useRole((s) => s.role);
  return (
    <Shell>
      <Suspense fallback={<div className="pt-2"><Loading h={400} /></div>}>
        <Routes>
          <Route path="/" element={role === "doctor" ? <Navigate to="/doctor" replace /> : role === "patient" ? <Navigate to="/patient" replace /> : <Overview />} />
          <Route path="/geo" element={<GeoExplorer />} />
          <Route path="/trends" element={<TrendsLab />} />
          <Route path="/warning" element={<EarlyWarning />} />
          <Route path="/quality" element={<CareQuality />} />
          <Route path="/models" element={<ModelArena />} />
          <Route path="/doctor" element={<DoctorWorkspace />} />
          <Route path="/doctor/case/:patientId" element={<CaseAnalysis />} />
          <Route path="/agent" element={<AgentView />} />
          <Route path="/ask" element={<AskRedirect />} />
          <Route path="/outlook" element={<Outlook />} />
          <Route path="/programme" element={<CareProgramme />} />
          <Route path="/patient" element={<PatientApp />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
