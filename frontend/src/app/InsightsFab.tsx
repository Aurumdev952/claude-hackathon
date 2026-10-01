import { useLocation } from "react-router-dom";
import { create } from "zustand";
import { Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { aiInsightCards, useInsights } from "@/api/hooks";
import type { Insight } from "@/api/types";
import { DetailModal } from "@/components/ui/DetailModal";
import { FloatingGlassCard } from "@/components/ui/FloatingGlassCard";
import { StatusGlyph, type StatusKind } from "@/components/ui/StatusChip";
import { cardEnter, stagger } from "@/lib/motion";
import { activeNav } from "./nav";

/** Insights UI state shared by the floating card and the TopNav bell. */
type InsightsUi = { open: boolean; dismissed: Record<string, boolean>; setOpen: (o: boolean) => void; dismiss: (view: string) => void };
export const useInsightsUi = create<InsightsUi>((set) => ({
  open: false, dismissed: {},
  setOpen: (open) => set({ open }),
  dismiss: (view) => set((s) => ({ dismissed: { ...s.dismissed, [view]: true } })),
}));

/** AI insight cards for the current route. Cards exist only when a real LLM provider is configured (template mode → null),
 * and only on ministry views (as before). */
export function useRouteInsights(): { view: string | null; cards: Insight[]; provider: string | null } {
  const { pathname } = useLocation();
  const nav = activeNav(pathname);
  const enabled = !!nav && nav.role !== "doctor" && !pathname.startsWith("/doctor/case") && !["/agent", "/ask"].includes(nav.to);
  const view = enabled ? nav!.view : "overview";
  const { data } = useInsights(view, enabled);
  const cards = enabled ? aiInsightCards(data) ?? [] : [];
  return { view: enabled ? view : null, cards, provider: data?.provider ? String(data.provider) : null };
}

const SEVERITY: Record<Insight["severity"], StatusKind> = { info: "info", warning: "warning", critical: "critical" };
const SEV_LABEL: Record<Insight["severity"], string> = { info: "For information", warning: "Worth watching", critical: "Needs attention" };

/** Floating "N new insights" card (bottom-left, flat white) that opens a DetailModal with the AI insight cards. Renders
 * nothing without cards. */
export function InsightsFab({ className = "" }: { className?: string }) {
  const { view, cards, provider } = useRouteInsights();
  const { open, setOpen, dismissed, dismiss } = useInsightsUi();
  if (!view || !cards.length) return null;
  return (
    <>
      <FloatingGlassCard open={!dismissed[view]} role="complementary" ariaLabel="AI insights" className={className}
                         count={cards.length} title={cards.length === 1 ? "New insight" : "New insights"}
                         icon={<Sparkles size={18} />}
                         body={cards[0].title}
                         cta={{ label: "Review insights", onPress: () => setOpen(true) }}
                         onDismiss={() => dismiss(view)} />
      <DetailModal isOpen={open} onOpenChange={setOpen} title="AI insights" icon={<Sparkles size={18} />} size="2xl"
                   subtitle={provider ? `Written by ${provider} from this view's data` : undefined}
                   info="Short readings of this view written by the configured language model from the published marts. Numbers are checked against the data before display; treat them as prompts for a closer look, not conclusions.">
        <motion.ul className="flex flex-col gap-2.5" variants={stagger()} initial="hidden" animate="show" aria-label="Insight cards">
          {cards.map((c) => (
            <motion.li key={c.id} variants={cardEnter} className="rounded-tile bg-tile px-5 py-4">
              <div className="flex items-center gap-2 text-[13px] text-muted mb-1">
                <StatusGlyph status={SEVERITY[c.severity] ?? "info"} size={9} />
                {SEV_LABEL[c.severity] ?? "Info"}
              </div>
              <h3 className="text-[16px] font-semibold text-ink leading-[22px]">{c.title}</h3>
              <p className="text-[14px] text-muted leading-[21px] mt-1">{c.body}</p>
            </motion.li>
          ))}
        </motion.ul>
      </DetailModal>
    </>
  );
}
