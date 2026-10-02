import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { Player } from "@remotion/player";
import { Check, Download, Film, Link2, RotateCcw } from "lucide-react";
import { FPS, MinistryReel, PatientCaseSummary, SIZES, ministryDuration, patientDuration } from "@video/compositions";
import type { MinistryReelProps, PatientVideoProps } from "@video/props";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { useRole } from "@/state/role";
import { StudioSkeleton } from "./VideoModal";
import type { VideoJob, VideoKind, VideoParams } from "./types";

const BASE = "/video";

function roleHeaders(): Record<string, string> {
  const { role, facilityId } = useRole.getState();
  const h: Record<string, string> = { "X-Role": role };
  if (role === "doctor" && facilityId) h["X-Facility-Id"] = String(facilityId);
  return h;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { ...init, headers: { ...roleHeaders(), ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  } catch {
    throw new Error("The video server is not reachable. Start it with make video-serve (or make serve).");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 502 || res.status === 504) throw new Error("The video server is not running. Start it with make video-serve.");
    const up = body?.upstream?.error;
    throw new Error(up?.message ?? body?.error ?? `Video server error ${res.status}`);
  }
  return body as T;
}

const query = (p: VideoParams) => {
  const q = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") q.set(k, String(v)); });
  return q.toString();
};

/** Preview (Player) + export (render job) for one video. Lazy-loaded by VideoModal. */
export default function VideoStudio({ kind, params }: { kind: VideoKind; params: VideoParams }) {
  const role = useRole((s) => `${s.role}:${s.facilityId ?? ""}`);
  const qs = query(params);
  const props = useQuery({
    queryKey: ["video-props", kind, qs, role],
    queryFn: () => call<PatientVideoProps | MinistryReelProps>(`/props/${kind}?${qs}`),
    staleTime: 60_000, retry: false,
  });
  const vertical = kind === "ministry_vertical";
  const size = vertical ? SIZES.vertical : SIZES.landscape;
  const player = useMemo(() => {
    if (!props.data) return null;
    return kind === "patient"
      ? { component: PatientCaseSummary as React.ComponentType<Record<string, unknown>>, duration: patientDuration(props.data as PatientVideoProps) }
      : { component: MinistryReel as unknown as React.ComponentType<Record<string, unknown>>, duration: ministryDuration(props.data as MinistryReelProps) };
  }, [props.data, kind]);

  if (props.isLoading) return <StudioSkeleton vertical={vertical} />;
  if (props.error) return <ErrorNote error={props.error} />;
  if (!props.data || !player) return null;
  const seconds = Math.round(player.duration / FPS);
  return (
    <div className="flex flex-col gap-4">
      <div className={`rounded-tile overflow-hidden bg-page mx-auto w-full ${vertical ? "max-w-[min(100%,42vh)]" : ""}`}>
        <Player component={player.component} inputProps={props.data as unknown as Record<string, unknown>} durationInFrames={player.duration}
                compositionWidth={size.width} compositionHeight={size.height} fps={FPS} controls clickToPlay acknowledgeRemotionLicense
                initialFrame={Math.min(110, player.duration - 1)}
                style={{ width: "100%", aspectRatio: `${size.width} / ${size.height}` }} />
      </div>
      <ExportBar kind={kind} params={params} seconds={seconds} size={`${size.width}×${size.height}`} />
    </div>
  );
}

function ExportBar({ kind, params, seconds, size }: { kind: VideoKind; params: VideoParams; seconds: number; size: string }) {
  const [job, setJob] = useState<VideoJob | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const poll = (id: string) => {
    call<VideoJob>(`/jobs/${id}`).then((j) => {
      setJob(j);
      if (j.status === "error") setErr(new Error(j.error ?? "The render failed"));
      else if (j.status !== "done") timer.current = window.setTimeout(() => poll(id), 1000);
    }).catch((e) => { setErr(e); });
  };
  const start = async () => {
    setErr(null); setCopied(false);
    setJob({ job_id: "", status: "queued", progress: 0, error: null, url: null, poster_url: null });
    try {
      const r = await call<{ job_id: string; cached: boolean }>("/jobs", { method: "POST", body: JSON.stringify({ kind, params }) });
      poll(r.job_id);
    } catch (e) {
      setErr(e); setJob(null);
    }
  };
  const copy = async () => {
    if (!job?.url) return;
    const link = new URL(job.url, window.location.origin).toString();
    try { await navigator.clipboard.writeText(link); } catch { window.prompt("Copy this link", link); }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const busy = job !== null && (job.status === "queued" || job.status === "rendering");
  const pct = Math.round((job?.progress ?? 0) * 100);
  return (
    <div className="flex flex-col gap-3">
      {err !== null && <ErrorNote error={err} />}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="text-label text-muted min-w-0 flex-1">
          {busy ? (
            <div className="flex items-center gap-3" role="status" aria-live="polite">
              <div className="h-1.5 flex-1 max-w-[320px] rounded-full bg-tile overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Render progress">
                <div className="h-full bg-sky rounded-full transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
              </div>
              <span className="tabular whitespace-nowrap">{job?.status === "queued" ? "Waiting to render" : `Rendering ${pct}%`}</span>
            </div>
          ) : job?.status === "done" ? (
            <span className="inline-flex items-center gap-1.5 text-tone-success"><Check size={14} aria-hidden />MP4 ready{job.render_seconds ? `, rendered in ${Math.round(job.render_seconds)} s` : ""}</span>
          ) : (
            <span>{seconds} s, {size}, H.264. Rendering takes a few minutes on the server.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {job?.status === "done" && job.url ? (
            <>
              <Button size="md" radius="full" variant="flat" className="bg-tile text-ink" startContent={copied ? <Check size={15} aria-hidden /> : <Link2 size={15} aria-hidden />} onPress={copy}>
                {copied ? "Link copied" : "Copy link"}
              </Button>
              <Button as="a" href={job.download_url ?? `${job.url}?download=1`} download size="md" radius="full" color="primary" startContent={<Download size={15} aria-hidden />}>
                Download MP4
              </Button>
              <Button isIconOnly size="md" radius="full" variant="light" aria-label="Export again" onPress={start}><RotateCcw size={15} aria-hidden /></Button>
            </>
          ) : (
            <Button size="md" radius="full" color="primary" isLoading={busy} startContent={busy ? undefined : <Film size={15} aria-hidden />} onPress={start} isDisabled={busy}>
              {busy ? "Exporting" : "Export MP4"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
