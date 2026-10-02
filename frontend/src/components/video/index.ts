/** Data videos (track L4). Screens place a button that opens the modal:
 *   <VideoButton kind="patient" params={{ patient_id }} />                      (doctor case screen)
 *   <VideoButton kind="ministry" params={{ from, to, sex, age, def }} />         (Overview / Outlook)
 * or control <VideoModal isOpen … /> themselves. The Player and compositions load lazily on first open. */
export { VideoModal, VideoButton, type VideoModalProps } from "./VideoModal";
export type { VideoKind, VideoParams, PatientVideoParams, MinistryVideoParams, VideoJob } from "./types";
