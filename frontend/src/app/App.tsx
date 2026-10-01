import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./Shell";
import { Loading } from "@/components/ui/Panel";
import { useRole } from "@/state/role";

const Overview = lazy(() => import("@/views/Overview"));
const GeoExplorer = lazy(() => import("@/views/GeoExplorer"));
const TrendsLab = lazy(() => import("@/views/TrendsLab"));
const EarlyWarning = lazy(() => import("@/views/EarlyWarning"));
const CareQuality = lazy(() => import("@/views/CareQuality"));
const ModelArena = lazy(() => import("@/views/ModelArena"));
const DoctorWorkspace = lazy(() => import("@/views/DoctorWorkspace"));
const CaseAnalysis = lazy(() => import("@/views/CaseAnalysis"));
const AskData = lazy(() => import("@/views/AskData"));

export function App() {
  const role = useRole((s) => s.role);
  return (
    <Shell>
      <Suspense fallback={<Loading h={400} />}>
        <Routes>
          <Route path="/" element={role === "doctor" ? <Navigate to="/doctor" replace /> : <Overview />} />
          <Route path="/geo" element={<GeoExplorer />} />
          <Route path="/trends" element={<TrendsLab />} />
          <Route path="/warning" element={<EarlyWarning />} />
          <Route path="/quality" element={<CareQuality />} />
          <Route path="/models" element={<ModelArena />} />
          <Route path="/doctor" element={<DoctorWorkspace />} />
          <Route path="/doctor/case/:patientId" element={<CaseAnalysis />} />
          <Route path="/ask" element={<AskData />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
