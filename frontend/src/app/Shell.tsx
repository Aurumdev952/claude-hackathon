import { type ReactNode, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Database, Search } from "lucide-react";
import { IconRail } from "@/components/ui/IconRail";
import { PageTransition } from "@/components/ui/PageTransition";
import { useLiveSocket } from "@/lib/useLiveSocket";
import { useRole } from "@/state/role";
import { CommandPalette } from "./CommandPalette";
import { DataQualityDrawer } from "./DataQuality";
import { FilterPills } from "./FilterPills";
import { InsightsFab } from "./InsightsFab";
import { navFor } from "./nav";
import { Toasts } from "./Toasts";
import { TopNav } from "./TopNav";

export { NAV } from "./nav";

const FILTER_PATHS = ["/", "/geo", "/trends", "/warning"];

/** App shell (plan §A3): top nav + left icon rail + page area with route transition; floating insights card; drawers. */
export function Shell({ children }: { children: ReactNode }) {
  useLiveSocket();
  const loc = useLocation();
  const [dq, setDq] = useState(false);
  const [cmd, setCmd] = useState(false);
  const role = useRole((s) => s.role);
  const fullBleed = loc.pathname.startsWith("/doctor/case");
  // pages that size themselves to the viewport (no page scroll padding): the case screen and the agent chat
  const fill = fullBleed || loc.pathname === "/agent" || loc.pathname.startsWith("/agent/");
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmd((v) => !v); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const showFilters = role === "ministry" && FILTER_PATHS.some((p) => (p === "/" ? loc.pathname === "/" : loc.pathname.startsWith(p)));
  const rail = navFor(role).map((n) => ({ key: n.to, to: n.to, label: n.title, icon: n.icon, match: n.match }));
  return (
    <div className="h-full flex flex-col page-bg text-fg">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-full focus:bg-surface focus:shadow-float">Skip to content</a>
      <TopNav onCmd={() => setCmd(true)} onDq={() => setDq(true)} />
      <div className="flex flex-1 min-h-0 gap-4 px-3 sm:px-4 pb-3 sm:pb-4">
        {!fullBleed && (
          <IconRail ariaLabel="Views" items={rail} className="hidden md:flex self-start max-h-full"
                    footer={[
                      { key: "search", label: "Search (Ctrl K)", icon: Search, onPress: () => setCmd(true) },
                      { key: "dq", label: "Data quality", icon: Database, onPress: () => setDq(true) },
                    ]} />
        )}
        <main id="main" className="flex-1 min-w-0 flex flex-col min-h-0">
          {showFilters && <FilterPills />}
          <div className={`flex-1 min-h-0 ${fullBleed ? "overflow-auto xl:overflow-hidden rounded-card" : fill ? "overflow-auto overflow-x-hidden" : "overflow-auto overflow-x-hidden -mx-1 px-1 pb-24"}`}>
            <PageTransition className={fill ? "h-full" : "min-h-full"}>{children}</PageTransition>
          </div>
        </main>
      </div>
      <InsightsFab className="!left-3 sm:!left-4 md:!left-[92px] !bottom-3 sm:!bottom-5" />
      <Toasts />
      <DataQualityDrawer isOpen={dq} onClose={() => setDq(false)} />
      <CommandPalette isOpen={cmd} onClose={() => setCmd(false)} />
    </div>
  );
}
