import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Database, Eraser, Lock, MessageSquareText, Sparkles } from "lucide-react";
import { get, post } from "@/api/client";
import { useRole } from "@/state/role";
import { AnswerCard, Chip, UserBubble } from "./ask/Message";
import { useAsk, type AskResult } from "./ask/store";

/** Extra examples the rule-based (template) provider is known to answer; shown under the API's suggestions. */
const MORE_MINISTRY = ["What is the median diagnostic interval by province?", "Compare the male and female rate in 2024",
  "Which provinces have the most stage IV cancers?", "How has the rate in Musanze changed over time?", "What was the national rate in 2024?"];

const SOURCES = [
  { t: "Incidence rates", d: "ASR & crude, by district, province, sex, age band, year" },
  { t: "Trends", d: "Joinpoint segments and annual % change" },
  { t: "Geography", d: "Hotspots (LISA), SIR" },
  { t: "Care quality", d: "H. pylori testing by facility, stage mix" },
  { t: "Survival & signals", d: "1-year survival, diagnostic intervals, warning signs" },
  { t: "Models", d: "AUROC, AUPRC, lead time per tier" },
];

/** V8 - Ask the Data (SPEC §15.2): NL -> validated read-only SQL -> answer + chart + table + SQL + provenance. */
export default function AskData() {
  const { role, facilityId } = useRole();
  const { turns, add, patch, clear } = useAsk();
  const sugg = useQuery({ queryKey: ["ask", "suggestions", role, facilityId], queryFn: () => get<string[]>("/ask/suggestions"), staleTime: 300_000 });
  const suggestions = sugg.data?.data ?? [];
  const provider = (sugg.data as any)?.provider as string | undefined;
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const pending = turns.some((t) => t.status === "pending");
  const [params, setParams] = useSearchParams();

  const ask = useCallback((q: string, reuseId?: string) => {
    const question = q.trim();
    if (!question) return;
    const id = reuseId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (reuseId) patch(id, { status: "pending", error: undefined, result: undefined, askedAt: Date.now() });
    else add({ id, question, askedAt: Date.now(), role, status: "pending" });
    setText("");
    post<AskResult>("/ask", { question })
      .then((res) => patch(id, { status: "done", result: res.data, runId: res.meta?.run_id, simTime: res.meta?.sim_time, provider }))
      .catch((e: unknown) => patch(id, { status: "failed", error: e instanceof Error ? e.message : "Request failed" }));
  }, [add, patch, role, provider]);

  // deep link from the command palette: /ask?q=...
  useEffect(() => {
    const q = params.get("q");
    if (q) { ask(q); params.delete("q"); setParams(params, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns.length, turns[turns.length - 1]?.status]);
  useEffect(() => {
    inputRef.current?.focus();
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!pending) ask(text); }
    else if (e.key === "ArrowUp" && !text) { const last = [...turns].reverse()[0]; if (last) { e.preventDefault(); setText(last.question); } }
    else if (e.key === "Escape") setText("");
  };

  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_250px] h-[calc(100vh-8.5rem)] min-h-[560px] max-w-[1400px]">
      <section className="panel flex flex-col min-h-0 overflow-hidden" aria-label="Ask the data">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
          <div className="w-8 h-8 rounded-lg bg-kivu/20 text-kivu flex items-center justify-center" aria-hidden><MessageSquareText size={16} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold leading-tight">Ask the data</h1>
            <p className="text-[11px] text-fog">Plain-English questions over the published surveillance marts · answers show their SQL</p>
          </div>
          {turns.length > 0 && <button className="btn text-xs py-1" onClick={() => { clear(); inputRef.current?.focus(); }}><Eraser size={13} /> Clear</button>}
        </header>

        <div className="flex-1 min-h-0 overflow-auto px-4 py-4 flex flex-col gap-4" aria-live="polite" aria-relevant="additions">
          {turns.length === 0 ? <Welcome suggestions={suggestions} more={role === "ministry" ? MORE_MINISTRY : []} onAsk={ask} loading={sugg.isLoading} /> : turns.map((t) => (
            <div key={t.id} className="flex flex-col gap-2.5">
              <UserBubble t={t} />
              <AnswerCard t={t} onAsk={(q) => ask(q)} onRetry={() => ask(t.question, t.id)} />
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="border-t border-line/50 p-3 bg-basalt/30">
          {turns.length > 0 && suggestions.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1" aria-label="Suggested questions">
              {suggestions.map((s) => <button key={s} onClick={() => ask(s)} disabled={pending}
                className="shrink-0 text-[11px] rounded-full border border-line/60 px-2.5 py-1 text-fog hover:text-mist hover:border-kivu disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-kivu">{s}</button>)}
            </div>
          )}
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (!pending) ask(text); }}>
            <label className="sr-only" htmlFor="ask-input">Your question</label>
            <textarea id="ask-input" ref={inputRef} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} maxLength={500}
              placeholder="e.g. Which districts have the highest rates in the last 3 years?"
              className="flex-1 resize-none bg-ridge2/70 border border-line rounded-xl px-3.5 py-2.5 text-sm leading-snug outline-none focus:border-kivu focus:ring-2 focus:ring-kivu/30 max-h-32" />
            <button type="submit" className="btn btn-primary h-[42px] w-[42px] justify-center p-0 rounded-xl disabled:opacity-40" disabled={pending || !text.trim()} aria-label="Ask">
              <ArrowUp size={17} />
            </button>
          </form>
          <div className="flex justify-between text-[10px] text-fog mt-1.5 px-1">
            <span><kbd className="font-sans">Enter</kbd> ask · <kbd className="font-sans">Shift+Enter</kbd> new line · <kbd className="font-sans">↑</kbd> last question · <kbd className="font-sans">/</kbd> focus</span>
            <span className="tabular">{text.length}/500</span>
          </div>
        </div>
      </section>

      <aside className="flex flex-col gap-3 min-h-0 overflow-auto" aria-label="About Ask the data">
        <div className="panel p-3.5">
          <div className="panel-title mb-2">How answers are made</div>
          <ol className="text-xs flex flex-col gap-2">
            {[["Understand", `Your question is mapped to SQL by ${provider === "template" || !provider ? "deterministic rules (template mode)" : `the ${provider} model`}.`],
              ["Guard", "One read-only SELECT over allowed tables only; LIMIT 1000; 5 s timeout."],
              ["Answer", "Text is written from the result rows; every number is checked against them."],
              ["Show", "Chart, table and the exact SQL, so you can verify."]].map(([h, d], i) => (
              <li key={h} className="flex gap-2"><span className="w-4 h-4 rounded-full bg-ridge2 text-[10px] flex items-center justify-center tabular shrink-0 mt-px">{i + 1}</span>
                <span><b className="font-semibold">{h}.</b> <span className="text-fog">{d}</span></span></li>
            ))}
          </ol>
        </div>
        <div className="panel p-3.5">
          <div className="panel-title mb-2 flex items-center gap-1.5"><Database size={11} /> What it can see</div>
          <ul className="text-xs flex flex-col gap-1.5">
            {SOURCES.map((s) => <li key={s.t}><span className="font-medium">{s.t}</span> <span className="text-fog">— {s.d}</span></li>)}
            {role === "doctor" && <li><span className="font-medium">Your patients</span> <span className="text-fog">— risk list and alerts, your facility only</span></li>}
          </ul>
          <p className="text-[10px] text-fog mt-2.5 flex items-start gap-1.5"><Lock size={11} className="mt-px shrink-0" />{role === "ministry" ? "Ministry view: aggregate tables only, never patient rows." : "Doctor view: patient tables are filtered to your facility."}</p>
        </div>
        <div className="text-[10px] text-fog px-1 flex items-center gap-1.5"><Sparkles size={11} /> Provider: <b className="text-mist">{provider ?? "…"}</b></div>
      </aside>
    </div>
  );
}

function Welcome({ suggestions, more, onAsk, loading }: { suggestions: string[]; more: string[]; onAsk: (q: string) => void; loading: boolean }) {
  return (
    <div className="m-auto max-w-xl text-center py-6">
      <svg viewBox="0 0 120 40" className="w-28 mx-auto mb-3" aria-hidden>
        <path d="M2 36 L30 14 L44 24 L66 6 L92 26 L118 36 Z" fill="rgb(var(--kivu) / 0.18)" />
        <path d="M2 36 L30 14 L44 24 L66 6 L92 26 L118 36" fill="none" stroke="rgb(var(--kivu))" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="66" cy="6" r="2.5" fill="rgb(var(--sorghum))" />
      </svg>
      <h2 className="text-lg font-semibold">What would you like to know?</h2>
      <p className="text-sm text-fog mt-1">Ask about rates, trends, hotspots, H. pylori testing, survival or the risk models. Every answer comes with the query that produced it.</p>
      <div className="flex flex-wrap justify-center gap-2 mt-5" aria-label="Suggested questions">
        {loading ? <span className="text-xs text-fog animate-pulse">Loading suggestions…</span> : suggestions.map((s) => <Chip key={s} q={s} onAsk={onAsk} />)}
      </div>
      {more.length > 0 && (<>
        <div className="panel-title mt-6 mb-2">More you can ask</div>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5">
          {more.map((q) => <button key={q} onClick={() => onAsk(q)} className="text-xs text-fog hover:text-mist underline decoration-line underline-offset-4 hover:decoration-kivu rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-kivu">{q}</button>)}
        </div>
      </>)}
    </div>
  );
}
