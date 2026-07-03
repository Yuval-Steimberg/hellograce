import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";
import { graceInsight } from "@/lib/dashboard-insights";

const CLAY = "#B05A41";
const SAGE = "#5C8A6E";
const INK = "#241F1B";

/**
 * A single warm, human line from Grace, grounded in the user's real data.
 * Feels like a note from a companion — not a data readout. The accent color
 * shifts with the tone of what she's saying.
 */
export function GraceInsightCard({ data }: { data: DashboardSummary }) {
  const insight = graceInsight(data);
  const accent = insight.tone === "clay" ? CLAY : insight.tone === "sage" ? SAGE : INK;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="relative flex items-start gap-4 overflow-hidden rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]"
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} aria-hidden />
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-serif text-lg text-white"
        style={{ background: accent }}
        aria-hidden
      >
        G
      </div>
      <div className="min-w-0 pt-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">A note from Grace</p>
        <p className="mt-1 text-[15px] leading-relaxed text-foreground">{insight.text}</p>
      </div>
    </motion.div>
  );
}
