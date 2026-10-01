import { ReactNode, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Activity, BarChart3, Brain, Command, Database, FlaskConical, Map, MessageSquareText, Moon, ShieldAlert, Stethoscope, Sun, TrendingUp, X } from "lucide-react";
import { useFilters } from "@/state/filters";
import { useLive } from "@/state/live";
import { useRole } from "@/state/role";
import { useFiltersMeta, useInsights, useStatus } from "@/api/hooks";
import { ago, date } from "@/lib/format";
import { useLiveSocket } from "@/lib/useLiveSocket";
import { DataQualityDrawer } from "./DataQuality";
import { CommandPalette } from "./CommandPalette";

export const NAV = [
  { to: "/", label: "National Overview", icon: Activity, view: "overview", role: "ministry" },
  { to: "/geo", label: "Geo Explorer", icon: Map, view: "geo", role: "ministry" },
  { to: "/trends", label: "Trends Lab", icon: TrendingUp, view: "trends", role: "ministry" },
  { to: "/warning", label: "Early Warning", icon: ShieldAlert, view: "warning", role: "ministry" },
  { to: "/quality", label: "H. pylori & Care", icon: FlaskConical, view: "quality", role: "ministry" },
  { to: "/models", label: "Model Arena", icon: Brain, view: "models", role: "any" },
  { to: "/doctor", label: "Doctor Workspace", icon: Stethoscope, view: "overview", role: "doctor" },
  { to: "/ask", label: "Ask the Data", icon: MessageSquareText, view: "overview", role: "any" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  useLiveSocket();
  const loc = useLocation();
  const [dq, setDq] = useState(false);
  const [cmd, setCmd] = useState(false);
  const role = useRole((s) => s.role);
  const nav = NAV.find((n) => (n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)));
  const fullBleed = loc.pathname.startsWith("/doctor/case");
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmd((v) => !v); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const showFilters = role === "ministry" && ["/", "/geo", "/trends", "/warning"].some((p) => (p === "/" ? loc.pathname === "/" : loc.pathname.startsWith(p)));
  return (
    <div className="h-full flex flex-col terrain-bg">
      <div className="bg-sorghum/15 border-b border-sorghum/30 text-[11px] text-center py-1 text-mist tracking-wide" role="note">
        <b className="text-sorghum">Synthetic data for demonstration</b> — not real patients or real district statistics.
      </div>
      <Header onCmd={() => setCmd(true)} onDq={() => setDq(true)} />
      <div className="flex flex-1 min-h-0">
        <SideNav />
        <main className="flex-1 min-w-0 flex flex-col min-h-0">
          {showFilters && <FilterBar />}
          <div className="flex-1 min-h-0 flex">
            <div className={`flex-1 min-w-0 overflow-auto ${fullBleed ? "" : "p-4"}`}>{children}</div>
            {!fullBleed && nav && nav.role !== "doctor" && <InsightRail view={nav.view} />}
          </div>
        </main>
      </div>
      <Toasts />
      {dq && <DataQualityDrawer onClose={() => setDq(false)} />}
      {cmd && <CommandPalette onClose={() => setCmd(false)} />}
    </div>
  );
}

function Header({ onCmd, onDq }: { onCmd: () => void; onDq: () => void }) {
  const { role, setRole, facilityName } = useRole();
  const navigate = useNavigate();
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark");
  const flip = () => {
    const t = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("es-theme", t); } catch { /* ignore */ }
    setTheme(t);
  };
  return (
    <header className="h-14 shrink-0 flex items-center gap-4 px-4 border-b border-line/60 bg-basalt/80 backdrop-blur">
      <div className="flex items-center gap-2.5 w-56">
        <svg viewBox="0 0 32 32" className="w-7 h-7" aria-hidden><path d="M2 25 L10 13 L15 19 L21 8 L30 25 Z" fill="rgb(var(--laterite))" opacity=".85" /><path d="M2 25 L10 13 L15 19 L21 8 L30 25" fill="none" stroke="rgb(var(--mist))" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="21" cy="8" r="2.3" fill="rgb(var(--sorghum))" /></svg>
        <div className="leading-tight">
          <div className="font-bold tracking-tight text-[15px]">Early Signals</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-fog">Gastric cancer · Rwanda</div>
        </div>
      </div>
      <LiveIndicator />
      <div className="flex-1" />
      <button className="btn text-fog" onClick={onCmd} aria-label="Command palette"><Command size={14} /> <span className="text-xs">Ctrl K</span></button>
      <button className="btn" onClick={onDq}><Database size={14} /> Data quality</button>
      <div className="seg" role="group" aria-label="Role">
        <button aria-pressed={role === "ministry"} onClick={() => { setRole("ministry"); navigate("/"); }}>Ministry</button>
        <button aria-pressed={role === "doctor"} onClick={() => { setRole("doctor"); navigate("/doctor"); }}>Doctor{facilityName && role === "doctor" ? ` · ${facilityName.replace(" (Synthetic)", "")}` : ""}</button>
      </div>
      <button className="btn px-2" onClick={flip} aria-label="Toggle light/dark theme">{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>
    </header>
  );
}

function LiveIndicator() {
  const { data } = useStatus();
  const live = useLive();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const run = data?.data?.pipeline;
  const sim = live.simTime ?? data?.meta?.sim_time;
  const published = live.lastRefresh ?? (data?.meta?.published_at ? Date.parse(data.meta.published_at) : null);
  const stale = published ? Date.now() - published > 2 * 5 * 60_000 && !live.lastRefresh : false;
  return (
    <div className="flex items-center gap-2 text-xs text-fog tabular" aria-live="polite">
      <span className={`w-2 h-2 rounded-full ${stale ? "bg-sorghum" : "bg-tea animate-pulseDot"}`} aria-hidden />
      <span>Updated {ago(published)}</span><span className="text-line">·</span>
      <span>sim date <b className="text-mist">{date(sim)}</b></span><span className="text-line">·</span>
      <span>run #{live.runId ?? data?.meta?.run_id ?? "—"}</span>
      {run?.status === "FAILED" && <span className="chip bg-laterite/20 text-laterite">last run failed</span>}
    </div>
  );
}

function SideNav() {
  const role = useRole((s) => s.role);
  return (
    <nav className="w-56 shrink-0 border-r border-line/60 p-3 flex flex-col gap-1 bg-basalt/40" aria-label="Views">
      {NAV.filter((n) => n.role === "any" || n.role === role).map((n, i) => (
        <NavLink key={n.to} to={n.to} end={n.to === "/"}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? "bg-kivu/20 text-mist shadow-[inset_2px_0_0_rgb(var(--kivu))]" : "text-fog hover:text-mist hover:bg-ridge2/50"}`}>
          <n.icon size={16} /> <span className="flex-1">{n.label}</span><span className="text-[10px] text-line">V{NAV.indexOf(n) + 1}</span>
        </NavLink>
      ))}
      <div className="flex-1" />
      <div className="text-[10px] text-fog leading-snug p-2 border border-line/50 rounded-lg">
        {role === "ministry" ? "Ministry view: aggregates only, cells under 5 cases suppressed." : "Doctor view: patient-level data for your facility only."}
      </div>
    </nav>
  );
}

function FilterBar() {
  const f = useFilters();
  const meta = useFiltersMeta();
  const years: number[] = meta.data?.data?.years ?? [2015, 2026];
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-line/50 bg-basalt/50 text-xs">
      <label className="flex items-center gap-2 text-fog">Period
        <select className="bg-ridge2 border border-line rounded px-1.5 py-1 text-mist" value={f.yearFrom} onChange={(e) => f.set({ yearFrom: Number(e.target.value) })} aria-label="From year">
          {years.map((y) => <option key={y}>{y}</option>)}</select>–
        <select className="bg-ridge2 border border-line rounded px-1.5 py-1 text-mist" value={f.yearTo} onChange={(e) => f.set({ yearTo: Number(e.target.value) })} aria-label="To year">
          {years.map((y) => <option key={y}>{y}</option>)}</select>
      </label>
      <Seg label="Sex" value={f.sex} onChange={(v) => f.set({ sex: v })} options={[{ value: "ALL", label: "All" }, { value: "F", label: "Female" }, { value: "M", label: "Male" }]} />
      <Seg label="Age band" value={f.ageBand} onChange={(v) => f.set({ ageBand: v })} options={[{ value: "ALL", label: "All ages" }, { value: "<50", label: "<50" }, { value: "50-64", label: "50–64" }, { value: "65+", label: "65+" }]} />
      <Seg label="Case definition" value={f.caseDef} onChange={(v) => f.set({ caseDef: v })} options={[{ value: "CONFIRMED_PROBABLE", label: "Confirmed + probable" }, { value: "CONFIRMED", label: "Confirmed" }]} />
      <Seg label="Rate" value={f.metric} onChange={(v) => f.set({ metric: v })} options={[{ value: "asr", label: "Age-standardised" }, { value: "crude_rate", label: "Crude" }]} />
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (<div className="seg" role="group" aria-label={label}>{options.map((o) => <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>);
}

function InsightRail({ view }: { view: string }) {
  const { data, isLoading } = useInsights(view);
  const cards = data?.data ?? [];
  const tone = { info: "border-kivu/60", warning: "border-sorghum/70", critical: "border-laterite/70" } as const;
  return (
    <aside className="w-80 shrink-0 border-l border-line/60 p-3 overflow-auto bg-basalt/30" aria-label="AI insights">
      <div className="flex items-center justify-between mb-2">
        <h2 className="panel-title">Insights</h2>
        <span className="text-[10px] text-fog">{(data as any)?.provider === "template" ? "template summaries" : `AI · ${(data as any)?.provider ?? ""}`}</span>
      </div>
      {isLoading && <div className="text-xs text-fog animate-pulse">Reading the marts…</div>}
      <div className="flex flex-col gap-2.5">
        {cards.map((c) => (
          <article key={c.id} className={`panel p-3 border-l-[3px] ${tone[c.severity] ?? tone.info} animate-rise`}>
            <h3 className="text-sm font-semibold mb-1 leading-snug">{c.title}</h3>
            <p className="text-xs text-fog leading-relaxed">{c.body}</p>
          </article>
        ))}
        {!isLoading && cards.length === 0 && <p className="text-xs text-fog">No insight cards for this view yet.</p>}
      </div>
    </aside>
  );
}

function Toasts() {
  const { toasts, dismiss } = useLive();
  useEffect(() => { if (toasts.length) { const t = setTimeout(() => dismiss(toasts[0].id), 6000); return () => clearTimeout(t); } }, [toasts, dismiss]);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} className={`panel px-4 py-3 text-sm flex items-center gap-3 ${t.tone === "alert" ? "border-laterite/70" : ""}`}>
          <ShieldAlert size={16} className={t.tone === "alert" ? "text-laterite" : "text-kivu"} />{t.text}
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
