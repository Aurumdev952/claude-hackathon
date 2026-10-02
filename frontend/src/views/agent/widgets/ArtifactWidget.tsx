import { useEffect, useState } from "react";
import type { ArtifactFile, ArtifactSpec } from "@agent/widgets";
import { AlertTriangle, Download, FileCode2, FileText, ImageIcon, Maximize2, Terminal } from "lucide-react";
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
          actions={<span className="hidden sm:inline text-[13px] text-muted tabular">{(a.duration_ms / 1000).toFixed(1)} s</span>}>
      <div className="flex flex-col gap-4">
        {!a.ok && (
          <div className="flex items-start gap-2.5 rounded-tile bg-tile text-[14px] leading-5 text-ink px-4 py-3">
            <span className="mt-1.5 w-2 h-2 rounded-full bg-signal shrink-0" aria-hidden />
            {a.timed_out ? "The script ran out of time. Ask for a smaller analysis or fewer rows." : a.error ?? "The script failed. Open the console for details."}
          </div>
        )}
        {images.map((f) => <ImageFile key={f.url} file={f} title={a.title} />)}
        {html.map((f) => <HtmlFile key={f.url} file={f} />)}
        {other.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Files">
            {other.map((f) => (
              <li key={f.url}>
                <a href={f.url} download={f.name} className="inline-flex items-center gap-2 h-9 rounded-full bg-tile pl-3.5 pr-3 text-[13px] font-medium text-ink hover:bg-tile-hover transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                  <FileText size={14} className="text-muted" aria-hidden />{f.name}<span className="text-muted font-normal tabular">{kb(f.bytes)}</span><Download size={14} className="text-muted" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
        {log && (
          <div>
            <button type="button" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}
                    className="inline-flex items-center gap-2 h-8 text-[13px] font-medium text-muted hover:text-ink hover:bg-tile rounded-full px-3 -ml-3 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              <Terminal size={14} aria-hidden />{showLog ? "Hide console" : "Show console"}
            </button>
            {showLog && <pre className="mt-2 max-h-56 overflow-auto rounded-tile bg-tile p-4 text-[12px] leading-relaxed font-mono whitespace-pre-wrap text-ink/85">{log}</pre>}
          </div>
        )}
        <p className="flex flex-wrap gap-x-4 text-[13px] text-muted">
          <span>{a.rows_in.toLocaleString("en-US")} rows in</span>
          <span>{a.files.length} file{a.files.length === 1 ? "" : "s"} out</span>
          {a.network_isolated && <span>Ran offline in the sandbox</span>}
        </p>
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
      <div className={`relative rounded-tile overflow-hidden group ${failed ? "bg-tile" : "bg-white"}`}>
        {!loaded && !failed && <div className="aspect-[16/9] animate-pulse bg-tile" aria-hidden />}
        {failed ? <div className="aspect-[16/9] grid place-items-center text-[14px] text-muted"><span className="inline-flex items-center gap-2"><ImageIcon size={15} aria-hidden />This image has expired. Run the analysis again to redraw it.</span></div> : (
          <img src={file.url} alt={title ?? file.name} loading="lazy" onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
               className={`w-full h-auto block transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0 absolute inset-0"}`} />
        )}
        {loaded && (
          <button type="button" onClick={d.open} aria-label="Enlarge image"
                  className="absolute top-3 right-3 w-9 h-9 rounded-full bg-surface border border-hairline grid place-items-center text-ink hover:bg-tile opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity">
            <Maximize2 size={15} aria-hidden />
          </button>
        )}
      </div>
      <figcaption className="sr-only">{file.name}</figcaption>
      <DetailModal {...d.modalProps} title={title ?? file.name} size="5xl" icon={<ImageIcon size={16} />}
                   footer={<a href={file.url} download={file.name} className="inline-flex items-center gap-2 h-10 rounded-full px-4 text-[14px] font-medium text-ink bg-tile hover:bg-tile-hover transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Download size={15} aria-hidden />Download PNG</a>}>
        <img src={file.url} alt={title ?? file.name} className="w-full h-auto rounded-tile bg-white" />
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
  if (err) return <div className="rounded-tile bg-tile p-6 text-center text-[14px] text-muted">This interactive chart has expired. Run the analysis again to redraw it.</div>;
  if (!doc) return <div className="h-[380px] rounded-tile bg-tile animate-pulse" aria-label="Loading interactive output" />;
  return <iframe title={file.name} srcDoc={doc} sandbox="allow-scripts" className="w-full h-[420px] rounded-tile border border-hairline bg-white" loading="lazy" />;
}

function withCsp(html: string) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`;
}
