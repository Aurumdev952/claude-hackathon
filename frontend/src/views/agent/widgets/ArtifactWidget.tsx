import { useEffect, useState } from "react";
import type { ArtifactFile, ArtifactSpec } from "@agent/widgets";
import { AlertTriangle, Download, FileCode2, FileText, ImageIcon, Maximize2, ShieldCheck, Terminal, Timer } from "lucide-react";
import { Card, DetailModal, useDetailModal } from "@/components/ui";

/** The artifact server's CSP for HTML, re-applied inside the srcdoc iframe (agent/src/routes/artifacts.ts). */
const HTML_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.plot.ly; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** run_python output (plan §B7): PNG as <img>, plotly HTML in an opaque-origin sandboxed iframe, other files as downloads. */
export function ArtifactWidget({ widget: a }: { widget: ArtifactSpec }) {
  const [showLog, setShowLog] = useState(false);
  const images = a.files.filter((f) => f.kind === "image");
  const html = a.files.filter((f) => f.kind === "html");
  const other = a.files.filter((f) => f.kind !== "image" && f.kind !== "html");
  const log = [a.stdout, a.stderr].filter(Boolean).join("\n").trim();
  return (
    <Card as="article" aria-label={`Sandbox output: ${a.title ?? a.run}`} className="agent-widget"
          title={a.title ?? (a.ok ? "Python analysis" : "Python run failed")} icon={a.ok ? <FileCode2 size={16} /> : <AlertTriangle size={16} />} iconTone={a.ok ? "accent" : "danger"}
          actions={
            <div className="hidden sm:flex items-center gap-1.5 text-micro text-fg-muted">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 border border-border px-2 py-0.5 tabular"><Timer size={11} aria-hidden />{(a.duration_ms / 1000).toFixed(1)} s</span>
              {a.network_isolated && <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 border border-border px-2 py-0.5"><ShieldCheck size={11} aria-hidden />Offline sandbox</span>}
            </div>
          }>
      <div className="flex flex-col gap-3">
        {!a.ok && (
          <div className="rounded-tile bg-danger/10 border border-danger/20 text-tone-danger text-[13px] px-3.5 py-2.5">
            {a.timed_out ? "The script ran out of time." : a.error ?? "The script failed."}
          </div>
        )}
        {images.map((f) => <ImageFile key={f.url} file={f} title={a.title} />)}
        {html.map((f) => <HtmlFile key={f.url} file={f} />)}
        {other.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Files">
            {other.map((f) => (
              <li key={f.url}>
                <a href={f.url} download={f.name} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 border border-border px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface transition">
                  <FileText size={13} aria-hidden />{f.name}<span className="text-fg-muted tabular">{kb(f.bytes)}</span><Download size={13} className="text-fg-muted" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
        {log && (
          <div>
            <button type="button" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}
                    className="inline-flex items-center gap-1.5 text-micro text-fg-muted hover:text-fg rounded-full px-2 py-1 -ml-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              <Terminal size={12} aria-hidden />{showLog ? "Hide console" : "Show console"}
            </button>
            {showLog && <pre className="mt-1.5 max-h-56 overflow-auto rounded-tile bg-surface-2 border border-border p-3 text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap text-fg/85">{log}</pre>}
          </div>
        )}
        <p className="text-micro text-fg-muted">{a.rows_in} rows in · {a.files.length} file{a.files.length === 1 ? "" : "s"} out</p>
      </div>
    </Card>
  );
}

const kb = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function ImageFile({ file, title }: { file: ArtifactFile; title?: string }) {
  const d = useDetailModal();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <figure className="m-0">
      <div className="relative rounded-tile overflow-hidden border border-border bg-white group">
        {!loaded && !failed && <div className="aspect-[16/9] animate-pulse bg-surface-2" aria-hidden />}
        {failed ? <div className="aspect-[16/9] grid place-items-center text-label text-fg-muted"><span className="inline-flex items-center gap-1.5"><ImageIcon size={14} aria-hidden />Image expired or unavailable</span></div> : (
          <img src={file.url} alt={title ?? file.name} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
               className={`w-full h-auto block transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0 absolute inset-0"}`} />
        )}
        {loaded && (
          <button type="button" onClick={d.open} aria-label="Enlarge image"
                  className="absolute top-2 right-2 w-8 h-8 rounded-full bg-surface/90 border border-border shadow-tile grid place-items-center text-fg-muted hover:text-fg opacity-0 group-hover:opacity-100 focus:opacity-100 transition">
            <Maximize2 size={14} aria-hidden />
          </button>
        )}
      </div>
      <figcaption className="sr-only">{file.name}</figcaption>
      <DetailModal {...d.modalProps} title={title ?? file.name} size="5xl" icon={<ImageIcon size={16} />}
                   footer={<a href={file.url} download={file.name} className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium text-fg border border-border bg-surface shadow-tile hover:bg-surface-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"><Download size={14} aria-hidden />Download PNG</a>}>
        <img src={file.url} alt={title ?? file.name} className="w-full h-auto rounded-tile border border-border bg-white" />
      </DetailModal>
    </figure>
  );
}

/** Plotly HTML: fetched and shown through srcdoc so the iframe gets an opaque origin (sandbox without allow-same-origin)
 * and the artifact CSP travels with it as a meta tag. */
function HtmlFile({ file }: { file: ArtifactFile }) {
  const [doc, setDoc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(file.url, { headers: { Accept: "text/plain, */*" } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (live) setDoc(withCsp(t)); })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [file.url]);
  if (err) return <div className="rounded-tile border border-border bg-surface-2 p-6 text-center text-label text-fg-muted">Interactive output expired or unavailable</div>;
  if (!doc) return <div className="h-[380px] rounded-tile bg-surface-2 animate-pulse" aria-label="Loading interactive output" />;
  return <iframe title={file.name} srcDoc={doc} sandbox="allow-scripts" className="w-full h-[420px] rounded-tile border border-border bg-white" loading="lazy" />;
}

function withCsp(html: string) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`;
}
