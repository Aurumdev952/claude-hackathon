import { useEffect, useRef, useState } from "react";
import type { VideoWidget as VideoWidgetT } from "@agent/widgets";
import { AlertTriangle, Check, Copy, Download, Film, Play } from "lucide-react";
import { Card } from "@/components/ui";

type JobView = Pick<VideoWidgetT, "status" | "url" | "poster_url" | "download_url" | "error"> & { progress?: number };

const STAGE: Record<VideoWidgetT["status"], string> = { queued: "Queued", rendering: "Rendering", done: "Ready", error: "Failed" };

/** create_video output (v3, plan §7-8): a Remotion render job on the video server. Polls `status_url` (proxied `/video`)
 * until the MP4 is ready, then shows the poster with an inline player, Download and Copy link. Patient videos carry the
 * display ID only. */
export function VideoWidget({ widget: w }: { widget: VideoWidgetT }) {
  const [job, setJob] = useState<JobView>({ status: w.status, progress: w.progress, url: w.url, poster_url: w.poster_url, download_url: w.download_url ?? null, error: w.error ?? null });
  const [lost, setLost] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const fails = useRef(0);
  const done = job.status === "done" || job.status === "error";

  useEffect(() => {
    if (done) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch(w.status_url, { headers: { Accept: "application/json" } });
        if (r.status === 404) { if (live) setLost(true); return; }
        if (!r.ok) throw new Error(String(r.status));
        const v = (await r.json()) as JobView;
        fails.current = 0;
        if (!live) return;
        setJob((j) => ({ ...j, ...v }));
        if (v.status === "done" || v.status === "error") return;
      } catch {
        if (++fails.current >= 8) { if (live) setLost(true); return; }
      }
      if (live) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 800);
    return () => { live = false; clearTimeout(timer); };
  }, [w.status_url, done]);

  const copy = async () => {
    if (!job.url) return;
    try {
      await navigator.clipboard.writeText(new URL(job.url, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked: the link is still on the Download button */ }
  };

  const failed = job.status === "error" || lost;
  const pct = Math.round(100 * Math.max(0, Math.min(1, job.progress ?? (job.status === "done" ? 1 : 0))));
  const vertical = w.video_kind === "ministry_vertical";
  const frame = vertical ? "aspect-[9/16] max-h-[520px] mx-auto" : "aspect-video";
  const status = failed ? (lost ? "Unavailable" : STAGE.error) : STAGE[job.status];

  return (
    <Card as="article" aria-label={`Video: ${w.title}`} className="agent-widget" title={w.title} icon={failed ? <AlertTriangle size={16} /> : <Film size={16} />}
          iconTone={failed ? "danger" : "accent"}
          actions={<span className="inline-flex items-center gap-2 text-[13px] text-muted tabular" aria-live="polite">
            <span className={`w-2 h-2 rounded-full ${failed ? "bg-signal" : job.status === "done" ? "bg-success" : "bg-sky animate-pulse"}`} aria-hidden />
            {status}{!done && !failed && job.status === "rendering" ? ` ${pct}%` : ""}
          </span>}>
      <div className="flex flex-col gap-4">
        {w.subtitle && <p className="text-[14px] leading-5 text-muted -mt-3">{w.subtitle}</p>}
        <div className={`relative w-full ${frame} rounded-tile overflow-hidden bg-tile`}>
          {job.status === "done" && job.url && !failed ? (
            playing
              ? <video src={job.url} poster={job.poster_url ?? undefined} controls autoPlay playsInline className="absolute inset-0 w-full h-full bg-black object-contain" />
              : (
                <button type="button" onClick={() => setPlaying(true)} aria-label={`Play ${w.title}`}
                        className="group absolute inset-0 w-full h-full focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand">
                  {job.poster_url && <img src={job.poster_url} alt="" className="absolute inset-0 w-full h-full object-contain" />}
                  <span className="absolute inset-0 grid place-items-center">
                    <span className="w-14 h-14 rounded-full bg-ink/85 grid place-items-center text-ink-on transition-transform group-hover:scale-105"><Play size={22} className="ml-0.5" aria-hidden /></span>
                  </span>
                </button>
              )
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
              {failed ? (
                <p className="text-[14px] leading-5 text-ink max-w-sm">
                  {lost ? "The video service is not reachable or the job has expired. Ask again to start a new render." : job.error ?? "The render failed. Ask again to retry."}
                </p>
              ) : (
                <>
                  <Film size={28} className="text-muted" aria-hidden />
                  <div className="w-full max-w-xs">
                    <div className="h-1.5 rounded-full bg-surface overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Render progress">
                      <div className="h-full rounded-full bg-sky transition-[width] duration-700 ease-out" style={{ width: `${Math.max(4, pct)}%` }} />
                    </div>
                    <p className="mt-3 text-[13px] text-muted">{job.status === "queued" ? "Waiting for the renderer" : "Rendering frames"} · usually 1–2 minutes</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.status === "done" && job.url && !failed && (
            <>
              <a href={job.download_url ?? `${job.url}?download=1`} download
                 className="inline-flex items-center gap-2 h-9 rounded-full bg-tile pl-3.5 pr-4 text-[13px] font-medium text-ink hover:bg-tile-hover transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                <Download size={14} aria-hidden />Download MP4
              </a>
              <button type="button" onClick={copy}
                      className="inline-flex items-center gap-2 h-9 rounded-full bg-tile pl-3.5 pr-4 text-[13px] font-medium text-ink hover:bg-tile-hover transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? "Link copied" : "Copy link"}
              </button>
            </>
          )}
          <span className="flex-1" />
          <span className="text-[13px] text-muted">{w.cached ? "From cache · " : ""}Synthetic data{w.video_kind === "patient" ? " · display ID only" : " · aggregates only"}</span>
        </div>
      </div>
    </Card>
  );
}
