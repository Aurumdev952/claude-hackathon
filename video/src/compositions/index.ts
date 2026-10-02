/** Browser-safe entry for the compositions (the frontend Player imports this through `@video`). */
import type { MinistryReelProps, PatientVideoProps } from "../props";
import { ministryScenes } from "./ministryScenes";
import { patientScenes } from "./patientScenes";

export { PatientCaseSummary } from "./PatientCaseSummary";
export { MinistryReel } from "./MinistryReel";
export { patientScenes, organGroups } from "./patientScenes";
export { ministryScenes } from "./ministryScenes";

export const FPS = 30;
export const SIZES = { landscape: { width: 1920, height: 1080 }, vertical: { width: 1080, height: 1920 } } as const;
export const patientDuration = (p: PatientVideoProps) => patientScenes(p).reduce((a, s) => a + s.duration, 0);
export const ministryDuration = (p: MinistryReelProps) => ministryScenes(p).reduce((a, s) => a + s.duration, 0);
