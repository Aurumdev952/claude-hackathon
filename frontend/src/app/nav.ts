import { Activity, Brain, FlaskConical, Map, ShieldAlert, Sparkles, Stethoscope, TrendingUp } from "lucide-react";

export type NavRole = "ministry" | "doctor" | "any";
export type NavItem = {
  to: string;
  /** Short label for the top pill tabs and the rail tooltip. */
  label: string;
  /** Longer name for the command palette. */
  title: string;
  icon: typeof Activity;
  /** Insights view key (`/insights?view=`). */
  view: string;
  role: NavRole;
  /** Other paths that should highlight this entry. */
  match?: readonly string[];
};

/** App navigation (plan §A3). `/agent` is the AI agent (Track B); until it lands it redirects to `/ask`. */
export const NAV: readonly NavItem[] = [
  { to: "/", label: "Overview", title: "National overview", icon: Activity, view: "overview", role: "ministry" },
  { to: "/geo", label: "Geo", title: "Geo explorer", icon: Map, view: "geo", role: "ministry" },
  { to: "/trends", label: "Trends", title: "Trends lab", icon: TrendingUp, view: "trends", role: "ministry" },
  { to: "/warning", label: "Early warning", title: "Early warning", icon: ShieldAlert, view: "warning", role: "ministry" },
  { to: "/quality", label: "Care", title: "H. pylori & care quality", icon: FlaskConical, view: "quality", role: "ministry" },
  { to: "/doctor", label: "Patients", title: "Doctor workspace", icon: Stethoscope, view: "overview", role: "doctor" },
  { to: "/models", label: "Models", title: "Model arena", icon: Brain, view: "models", role: "any" },
  { to: "/agent", label: "Agent", title: "AI agent", icon: Sparkles, view: "overview", role: "any", match: ["/ask"] },
];

export const navFor = (role: "ministry" | "doctor") => NAV.filter((n) => n.role === "any" || n.role === role);

const hit = (path: string, p: string) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`));
/** The nav entry that owns a pathname (longest match wins). */
export function activeNav(pathname: string): NavItem | undefined {
  return [...NAV].sort((a, b) => b.to.length - a.to.length).find((n) => [n.to, ...(n.match ?? [])].some((p) => hit(pathname, p)));
}
