/** Video kinds and params (docs/contracts/v3-loop.md §8). */
export type VideoKind = "patient" | "ministry" | "ministry_vertical";
export type PatientVideoParams = { patient_id: number | string };
export type MinistryVideoParams = { from?: number | string; to?: number | string; sex?: string; age?: string; def?: string };
export type VideoParams = PatientVideoParams | MinistryVideoParams;

export type VideoJob = {
  job_id: string; status: "queued" | "rendering" | "done" | "error"; progress: number; stage?: string; error: string | null;
  url: string | null; poster_url: string | null; download_url?: string | null; render_seconds?: number | null;
};
