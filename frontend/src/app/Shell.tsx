import { type ReactNode, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { PageTransition } from "@/components/ui/PageTransition";
import { useLiveSocket } from "@/lib/useLiveSocket";
import { useRole } from "@/state/role";
import { CommandPalette } from "./CommandPalette";
import { DataQualityDrawer } from "./DataQuality";
import { FilterPills } from "./FilterPills";
import { InsightsFab } from "./InsightsFab";
import { Toasts } from "./Toasts";
import { TopNav } from "./TopNav";

export { NAV } from "./nav";

const FILTER_PATHS = ["/", "/geo", "/trends", "/warning"];

/** App shell (design v3): 72px header with the navigation (no left rail), one quiet filter row on ministry views, the page
 * on the plain page token; floating insights card; drawers. */
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
  return (
    <div className="h-full flex flex-col bg-page text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-full focus:bg-surface focus:shadow-float">Skip to content</a>
      <TopNav onCmd={() => setCmd(true)} onDq={() => setDq(true)} />
      <div className="flex flex-1 min-h-0 px-4 sm:px-6 pb-4 sm:pb-6">
        <main id="main" className="flex-1 min-w-0 flex flex-col min-h-0">
          {showFilters && <FilterPills />}
          <div className={`flex-1 min-h-0 ${fullBleed ? "overflow-auto xl:overflow-hidden rounded-card" : fill ? "overflow-auto overflow-x-hidden" : "overflow-auto overflow-x-hidden -mx-1 px-1 pb-24"}`}>
            <PageTransition className={fill ? "h-full" : "min-h-full"}>{children}</PageTransition>
          </div>
        </main>
      </div>
      <InsightsFab className="!left-4 sm:!left-6 !bottom-4 sm:!bottom-6" />
      <Toasts />
      <DataQualityDrawer isOpen={dq} onClose={() => setDq(false)} />
      <CommandPalette isOpen={cmd} onClose={() => setCmd(false)} />
    </div>
  );
}
