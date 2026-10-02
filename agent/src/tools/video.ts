/**
 * create_video (v3, plan §7-8): starts a Remotion render on the video server (VIDEO_URL, default http://127.0.0.1:8790)
 * and returns a VideoWidget the chat UI turns into a poster card with status polling and a download link.
 *
 * Doctors render a patient case summary (display ID only, facility access checked here and again by the API through the
 * forwarded role headers); the ministry renders the national reel (aggregates, small cells suppressed by the API).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SERVE } from "../db/duck.js";
import { upstreamMessage, video } from "../lib/upstream.js";
import { VideoWidget, type VideoKind } from "../widgets/specs.js";
import { notFound, PatientRef, resolvePatient } from "./patient.js";
import { defineTool } from "./types.js";

interface JobView {
  job_id: string;
  status: "queued" | "rendering" | "done" | "error";
  progress?: number;
  url?: string | null;
  poster_url?: string | null;
  download_url?: string | null;
  error?: string | null;
}

export const createVideo = defineTool({
  name: "create_video",
  title: "Data video",
  description:
    "Renders a short data video (MP4, about 1-2 minutes to render) and shows the user a card with the poster, progress and a " +
    "download link. Doctor: kind 'patient' = case summary of one patient at your facility (risk, reasons, timeline, organ by " +
    "organ, care plan, journey; display ID only). Ministry: kind 'ministry' (16:9) or 'ministry_vertical' (9:16 for phones) " +
    "= national reel for years from-to (KPIs, ASR trend, district map, care funnel, 2031 forecast, model performance). " +
    "Use only when the user asks for a video. Returns {ok, job_id, status}.",
  roles: ["ministry", "doctor"],
  inputSchema: z.object({
    kind: z.enum(["patient", "ministry", "ministry_vertical"]),
    ...PatientRef,
    from: z.number().int().min(2000).max(2031).optional().describe("Ministry: first year (default 2015)"),
    to: z.number().int().min(2000).max(2031).optional().describe("Ministry: last year (default the current year)"),
    sex: z.enum(["ALL", "M", "F"]).optional(),
    age: z.enum(["ALL", "<50", "50-64", "65+"]).optional(),
  }),
  async execute(i, t) {
    const role = t.ctx.role;
    if (role === "doctor" && i.kind !== "patient") return { ok: false, error: "Doctors can create patient case videos only (kind 'patient')." };
    if (role === "ministry" && i.kind === "patient") return { ok: false, error: "Patient videos are for clinicians; the ministry can create the national reel (kind 'ministry' or 'ministry_vertical')." };
    let params: Record<string, unknown>;
    let title: string;
    let subtitle: string;
    if (i.kind === "patient") {
      let pid: number;
      try {
        pid = await resolvePatient(t, i);
      } catch (e) {
        return notFound(e);
      }
      const d = (await SERVE().one("SELECT display_id FROM pt_patient WHERE patient_id = ?", [pid]))?.display_id ?? String(pid);
      params = { patient_id: pid };
      title = `Case summary video · ${d}`;
      subtitle = "Risk, reasons, timeline, organ by organ, care plan and journey · synthetic data";
    } else {
      const sim = SERVE().meta().sim_time;
      const to = i.to ?? (sim ? Number(String(sim).slice(0, 4)) : 2026);
      const from = Math.min(i.from ?? 2015, to);
      params = { from, to, ...(i.sex ? { sex: i.sex } : {}), ...(i.age ? { age: i.age } : {}) };
      title = `National reel ${from}–${to}${i.kind === "ministry_vertical" ? " (vertical)" : ""}`;
      subtitle = `Gastric cancer surveillance, Rwanda · ${i.sex && i.sex !== "ALL" ? `sex ${i.sex} · ` : ""}${i.age && i.age !== "ALL" ? `age ${i.age} · ` : ""}synthetic data`;
    }
    try {
      const job = await video<{ job_id: string; cached?: boolean }>(t.ctx, "/video/jobs", { method: "POST", body: { kind: i.kind, params } });
      let view: JobView = { job_id: job.job_id, status: job.cached ? "done" : "queued" };
      try {
        view = await video<JobView>(t.ctx, `/video/jobs/${encodeURIComponent(job.job_id)}`);
      } catch {
        /* status is polled by the UI */
      }
      const widget = VideoWidget.parse({
        kind: "video", id: `vid_${randomUUID().slice(0, 8)}`, job_id: job.job_id, video_kind: i.kind as VideoKind, title, subtitle,
        status: view.status, progress: typeof view.progress === "number" ? Math.max(0, Math.min(1, view.progress)) : undefined,
        cached: Boolean(job.cached), url: view.url ?? null, poster_url: view.poster_url ?? null, download_url: view.download_url ?? null,
        status_url: `/video/jobs/${job.job_id}`, error: view.error ?? null,
      });
      return widget;
    } catch (e) {
      const m = upstreamMessage(e);
      return { ...m, error: `${m.error}. The video service may not be running (make video-serve).` };
    }
  },
  modelView(o) {
    if (o && typeof o === "object" && "kind" in o && o.kind === "video") {
      return { ok: true, job_id: o.job_id, video_kind: o.video_kind, status: o.status, cached: o.cached, title: o.title,
        note: "The video card is shown to the user with progress and a download link; rendering takes about 1-2 minutes." };
    }
    return o;
  },
});
