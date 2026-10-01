import { type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Badge, Button, Dropdown, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger, Kbd, Tooltip } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Building2, Check, ChevronDown, Database, Landmark, Menu, Moon, Search, Stethoscope, Sun } from "lucide-react";
import { useStatus } from "@/api/hooks";
import { InfoHint } from "@/components/ui/InfoHint";
import { PillTabs } from "@/components/ui/PillTabs";
import { ago, date } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { useLive } from "@/state/live";
import { useRole } from "@/state/role";
import { useInsightsUi, useRouteInsights } from "./InsightsFab";
import { activeNav, navFor } from "./nav";

/** Round 40px icon button: white, hairline edge, ink icon (design v3 header). */
const iconBtn = "min-w-10 w-10 h-10 bg-surface border border-hairline text-ink data-[hover=true]:bg-tile data-[focus-visible=true]:outline-signal";

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <span className="w-9 h-9 rounded-full bg-signal grid place-items-center" aria-hidden>
        <svg viewBox="0 0 32 32" className="w-[22px] h-[22px]"><path d="M5 21 L11.5 12.5 L15.5 17.5 L20.5 9.5 L27 21" fill="none" stroke="white" strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" /></svg>
      </span>
      <span className="hidden sm:block font-semibold tracking-[-0.01em] text-[18px] leading-6 text-ink whitespace-nowrap">Early Signals</span>
    </div>
  );
}

function SyntheticNote() {
  return (
    <div role="note" aria-label="Synthetic data notice" className="hidden lg:flex items-center h-8 pl-3 pr-0.5 rounded-full bg-surface text-muted">
      <span className="text-[12px] font-medium whitespace-nowrap">Synthetic data</span>
      <InfoHint size={14} label="About the synthetic data" className="!w-7 !h-7 !min-w-7"
                content={<><b>Synthetic data for demonstration.</b> These are not real patients or real district statistics. The EMR records come from an OpenMRS-shaped simulator for gastric cancer surveillance in Rwanda.</>} />
    </div>
  );
}

function LiveIndicator() {
  const { data } = useStatus();
  const live = useLive();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  const run = data?.data?.pipeline;
  const sim = live.simTime ?? data?.meta?.sim_time;
  const published = live.lastRefresh ?? (data?.meta?.published_at ? Date.parse(data.meta.published_at) : null);
  const stale = published ? Date.now() - published > 2 * 5 * 60_000 && !live.lastRefresh : false;
  const failed = run?.status === "FAILED";
  const dot = failed ? "bg-danger" : stale ? "bg-warning" : "bg-success";
  return (
    <Tooltip placement="bottom" delay={150} classNames={{ content: "bg-surface text-ink shadow-float rounded-tile px-3.5 py-2.5 dark:border dark:border-hairline" }}
             content={
               <dl className="text-[13px] grid grid-cols-[auto_auto] gap-x-4 gap-y-1 tabular">
                 <dt className="text-muted">Last refresh</dt><dd>{ago(published)}</dd>
                 <dt className="text-muted">Simulated date</dt><dd>{date(sim)}</dd>
                 <dt className="text-muted">Pipeline run</dt><dd>#{live.runId ?? data?.meta?.run_id ?? "—"}{failed ? ", last run failed" : ""}</dd>
                 <dt className="text-muted">Live updates</dt><dd>{live.connected ? "Connected" : "Polling"}</dd>
               </dl>
             }>
      <button type="button" className="hidden min-[1780px]:flex items-center gap-2 h-10 px-3 rounded-full text-[13px] text-muted hover:text-ink hover:bg-surface tabular"
              aria-label={`Data updated ${ago(published)}${failed ? ", last run failed" : ""}`}>
        <span className="relative flex w-2 h-2" aria-hidden>
          {!stale && !failed && <span className={`absolute inset-0 rounded-full ${dot} animate-ping2`} />}
          <span className={`relative w-2 h-2 rounded-full ${dot}`} />
        </span>
        <span aria-live="polite" className="whitespace-nowrap">Updated {ago(published)}</span>
      </button>
    </Tooltip>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Button isIconOnly size="sm" radius="full" variant="flat" className={iconBtn} aria-label="Toggle light/dark theme" onPress={toggle}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={theme} initial={{ rotate: -90, opacity: 0, scale: 0.6 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 90, opacity: 0, scale: 0.6 }} transition={{ duration: 0.2 }} className="grid place-items-center">
          {theme === "dark" ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
        </motion.span>
      </AnimatePresence>
    </Button>
  );
}

function RoleMenu() {
  const { role, setRole, facilityName } = useRole();
  const navigate = useNavigate();
  const fac = facilityName?.replace(" (Synthetic)", "") ?? null;
  // accessible name stays "Doctor · <facility>" (e2e); the visible pill shows the facility, or "Ministry"
  const label = role === "doctor" ? `Doctor${fac ? ` · ${fac}` : ""}` : "Ministry";
  const shown = role === "doctor" ? fac ?? "Doctor" : "Ministry";
  return (
    <Dropdown placement="bottom-end" classNames={{ content: "bg-surface shadow-float rounded-card p-2 min-w-[280px] dark:border dark:border-hairline" }}>
      <DropdownTrigger>
        <Button size="sm" radius="full" variant="flat" aria-label={label} className="h-10 pl-1 pr-2 lg:pr-3.5 min-w-0 lg:min-w-[120px] max-w-[260px] shrink-0 gap-1 lg:gap-2 bg-surface border border-hairline text-ink data-[hover=true]:bg-tile"
                startContent={<span className="w-8 h-8 rounded-full bg-tile text-ink grid place-items-center shrink-0" aria-hidden>{role === "doctor" ? <Stethoscope size={15} /> : <Landmark size={15} />}</span>}
                endContent={<ChevronDown size={15} className="text-muted shrink-0" aria-hidden />}>
          <span className="truncate text-[14px] font-medium hidden lg:inline">{shown}</span>
        </Button>
      </DropdownTrigger>
      <DropdownMenu aria-label="Switch role" onAction={(k) => {
        if (k === "ministry") { setRole("ministry"); navigate("/"); }
        if (k === "doctor") { setRole("doctor"); navigate("/doctor"); }
      }}>
        <DropdownSection title="View as" classNames={{ heading: "text-micro text-muted px-2" }}>
          <DropdownItem key="ministry" description="Aggregates only, small cells suppressed" startContent={<Landmark size={16} className="text-ink" aria-hidden />}
                        endContent={role === "ministry" ? <Check size={15} className="text-signal" aria-hidden /> : null}>Ministry</DropdownItem>
          <DropdownItem key="doctor" description={fac ? `Patient-level data for ${fac}` : "Patient-level data for one facility"} startContent={<Building2 size={16} className="text-ink" aria-hidden />}
                        endContent={role === "doctor" ? <Check size={15} className="text-signal" aria-hidden /> : null}>Doctor</DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  );
}

/** Compact navigation for narrow screens: the current view as a pill that opens a menu of views (+ search and data
 * quality, whose icon buttons are hidden there). */
function NavMenu({ items, current, onCmd, onDq }: { items: ReturnType<typeof navFor>; current: string; onCmd: () => void; onDq: () => void }) {
  const navigate = useNavigate();
  const cur = items.find((i) => i.to === current);
  const Icon = cur?.icon ?? Menu;
  return (
    <Dropdown placement="bottom" classNames={{ content: "bg-surface shadow-float rounded-card p-2 min-w-[240px] dark:border dark:border-hairline" }}>
      <DropdownTrigger>
        <Button size="sm" radius="full" variant="flat" aria-label={`Views${cur ? `, current: ${cur.label}` : ""}`}
                className="h-10 pl-1 pr-3.5 min-w-0 max-w-full bg-surface border border-hairline text-ink data-[hover=true]:bg-tile gap-2"
                startContent={<span className="w-8 h-8 rounded-full bg-ink text-ink-on grid place-items-center shrink-0" aria-hidden><Icon size={15} /></span>}
                endContent={<ChevronDown size={15} className="text-muted shrink-0" aria-hidden />}>
          <span className="truncate text-[14px] font-medium">{cur?.label ?? "Menu"}</span>
        </Button>
      </DropdownTrigger>
      <DropdownMenu aria-label="Views" selectionMode="single" selectedKeys={current ? [current] : []} disallowEmptySelection={false}
                    onAction={(k) => {
                      const key = String(k);
                      if (key === "__search") return onCmd();
                      if (key === "__dq") return onDq();
                      navigate(key);
                    }}>
        <DropdownSection title="Views" showDivider classNames={{ heading: "text-micro text-muted px-2" }}>
          {items.map((i) => (
            <DropdownItem key={i.to} startContent={<i.icon size={16} className="text-ink" aria-hidden />}>{i.label}</DropdownItem>
          ))}
        </DropdownSection>
        <DropdownSection title="Tools" classNames={{ heading: "text-micro text-muted px-2" }}>
          <DropdownItem key="__search" startContent={<Search size={16} className="text-muted" aria-hidden />}>Search</DropdownItem>
          <DropdownItem key="__dq" startContent={<Database size={16} className="text-muted" aria-hidden />}>Data quality</DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  );
}

/** Plain search field (reference "Search for any health metrics"): looks like an input, opens the command palette. */
function SearchField({ onCmd }: { onCmd: () => void }) {
  return (
    <button type="button" onClick={onCmd} aria-label="Search" aria-keyshortcuts="Control+K"
            className="hidden 2xl:flex items-center gap-2.5 h-10 w-[200px] min-[1600px]:w-[260px] pl-3.5 pr-2 rounded-full bg-surface text-muted text-[14px] hover:text-ink transition-colors">
      <Search size={17} className="text-ink shrink-0" aria-hidden />
      <span className="flex-1 text-left truncate">Search or ask</span>
    </button>
  );
}

/** Top navigation (design v3): 72px header. Logo + wordmark and the synthetic-data pill on the left, plain text tabs in
 * the centre (active = ink pill), search field + round icon buttons + role pill on the right. */
export function TopNav({ onCmd, onDq, extra }: { onCmd: () => void; onDq: () => void; extra?: ReactNode }) {
  const role = useRole((s) => s.role);
  const { pathname } = useLocation();
  const items = navFor(role);
  const current = activeNav(pathname);
  const sel = current && items.some((i) => i.to === current.to) ? current.to : "";
  const { cards } = useRouteInsights();
  const setInsights = useInsightsUi((s) => s.setOpen);
  const n = cards.length;
  return (
    // three columns (1fr auto 1fr): the nav stays centred, and the sides never shrink below their content
    <header className="h-[72px] shrink-0 grid grid-cols-[auto_1fr_auto] sm:grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4 px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <Logo />
        <SyntheticNote />
      </div>
      <nav aria-label="Primary" className="min-w-0 flex justify-center">
        <PillTabs variant="navy" ariaLabel="Views" selectedKey={sel} size="md" className="hidden xl:flex" tabClassName="px-3 2xl:px-4"
                  items={items.map((i) => ({ key: i.to, href: i.to, label: i.label }))} />
        <div className="xl:hidden min-w-0 flex justify-start sm:justify-center w-full"><NavMenu items={items} current={sel} onCmd={onCmd} onDq={onDq} /></div>
      </nav>
      <div className="flex items-center gap-2 justify-end">
        <LiveIndicator />
        {extra}
        <SearchField onCmd={onCmd} />
        <Tooltip content={<span className="flex items-center gap-1.5 text-xs">Search <Kbd keys={["ctrl"]}>K</Kbd></span>} delay={300} placement="bottom">
          <Button isIconOnly size="sm" radius="full" variant="flat" className={`${iconBtn} hidden sm:inline-flex 2xl:hidden`} aria-label="Search" aria-keyshortcuts="Control+K" onPress={onCmd}><Search size={17} aria-hidden /></Button>
        </Tooltip>
        <Tooltip content="Data quality" delay={300} placement="bottom">
          <Button isIconOnly size="sm" radius="full" variant="flat" className={`${iconBtn} hidden sm:inline-flex`} aria-label="Data quality" onPress={onDq}><Database size={17} aria-hidden /></Button>
        </Tooltip>
        <Badge content="" isInvisible={!n} color="primary" size="sm" shape="circle" placement="top-right" classNames={{ badge: "w-2.5 h-2.5 min-w-2.5 border-2 border-surface bg-signal translate-x-[-6px] translate-y-[6px]" }}>
          <Button isIconOnly size="sm" radius="full" variant="flat" className={iconBtn} aria-label={n ? `AI insights, ${n} new` : "AI insights, none for this view"} isDisabled={!n} onPress={() => setInsights(true)}>
            <Bell size={17} aria-hidden />
          </Button>
        </Badge>
        <ThemeToggle />
        <RoleMenu />
      </div>
    </header>
  );
}
