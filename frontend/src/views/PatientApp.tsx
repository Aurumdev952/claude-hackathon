import { PageHeader } from "@/components/ui";

/** v3 placeholder: phone-frame simulator (/patient) and full-screen PWA (/patient/app). The UI track replaces it. */
export default function PatientApp({ fullscreen = false }: { fullscreen?: boolean }) {
  return <PageHeader title={fullscreen ? "Patient app" : "Patient app simulator"} />;
}
