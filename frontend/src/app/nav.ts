import { Activity, Brain, ClipboardCheck, FlaskConical, Map, ShieldAlert, Smartphone, Sparkles, Stethoscope, Telescope, TrendingUp } from "lucide-react";
import type { AppRole } from "@/state/role";

export type NavRole = "ministry" | "doctor" | "patient" | "any";
export type NavItem = {
  to: string;
  /** Short label for the top pill tabs and the rail tooltip. */
  label: string;
  /** Longer name for the command palette. */
  title: string;
  icon: typeof Activity;
  /** Insights view key (`/insights?view=`); a view without its own insight facts reuses the closest one. */
  view: string;
  role: NavRole;
  /** Other paths that should highlight this entry. */
  match?: readonly string[];
};

/** App navigation (plan §A3). `/agent` is the AI agent chat (src/views/agent); `/ask` redirects to it. */
export const NAV: readonly NavItem[] = [
  { to: "/", label: "Overview", title: "National overview", icon: Activity, view: "overview", role: "ministry" },
  { to: "/geo", label: "Geo", title: "Geo explorer", icon: Map, view: "geo", role: "ministry" },
  { to: "/trends", label: "Trends", title: "Trends lab", icon: TrendingUp, view: "trends", role: "ministry" },
  { to: "/warning", label: "Early warning", title: "Early warning", icon: ShieldAlert, view: "warning", role: "ministry" },
  { to: "/quality", label: "Care", title: "H. pylori & care quality", icon: FlaskConical, view: "quality", role: "ministry" },
  { to: "/programme", label: "Follow-up", title: "Care coordination programme", icon: ClipboardCheck, view: "quality", role: "ministry" },
  { to: "/outlook", label: "Outlook", title: "Outlook and forecasts", icon: Telescope, view: "trends", role: "ministry" },
  { to: "/doctor", label: "Patients", title: "Doctor workspace", icon: Stethoscope, view: "overview", role: "doctor" },
  { to: "/patient", label: "Patient app", title: "Patient app (simulated phone)", icon: Smartphone, view: "overview", role: "patient" },
  { to: "/models", label: "Models", title: "Model arena", icon: Brain, view: "models", role: "any" },
  { to: "/agent", label: "Agent", title: "AI agent", icon: Sparkles, view: "overview", role: "any", match: ["/ask"] },
];

export const navFor = (role: AppRole) =>
  NAV.filter((n) => n.role === role || (n.role === "any" && role !== "patient"));

const hit = (path: string, p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));
/** The nav entry that owns a pathname (longest match wins). */
export function activeNav(pathname: string): NavItem | undefined {
  return [...NAV].sort((a, b) => b.to.length - a.to.length).find((n) => [n.to, ...(n.match ?? [])].some((p) => hit(pathname, p)));
}
