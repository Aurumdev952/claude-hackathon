import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import "../agent.css";

/** Assistant markdown (plan §B7): GFM tables / task lists / strikethrough, highlight.js code, styled tables, copyable code. */
export const Markdown = memo(function Markdown({ children, streaming = false, className = "" }: { children: string; streaming?: boolean; className?: string }) {
  return (
    <div className={`md ${streaming ? "md-streaming" : ""} ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

const COMPONENTS: Components = {
  pre: ({ node, children }) => {
    const code = node?.children?.[0] as { properties?: { className?: unknown } } | undefined;
    const cls = Array.isArray(code?.properties?.className) ? (code!.properties!.className as string[]) : [];
    const lang = cls.find((c) => c.startsWith("language-"))?.slice(9);
    return <CodeBlock lang={lang}>{children}</CodeBlock>;
  },
  table: ({ children }) => (
    <div className="md-table" role="region" aria-label="Table" tabIndex={0}><table>{children}</table></div>
  ),
  a: ({ href, children }) => {
    if (href && href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/agent/artifacts")) return <Link to={href}>{children}</Link>;
    return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
  },
};

function CodeBlock({ lang, children }: { lang?: string; children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(ref.current?.innerText ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="md-code group">
      <div className="md-code-head">
        <span>{lang ?? "code"}</span>
        <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy code"} className="md-code-copy">
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}<span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
