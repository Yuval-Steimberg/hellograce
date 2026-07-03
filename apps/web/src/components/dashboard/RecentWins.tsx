import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";
import { computeWins } from "@/lib/dashboard-insights";

/**
 * A quiet strip of real, earned wins. Renders nothing when there's nothing
 * genuine to celebrate yet — so it never feels like hollow cheerleading.
 */
export function RecentWins({ data }: { data: DashboardSummary }) {
  const wins = computeWins(data);
  if (wins.length === 0) return null;

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <h3 className="mb-3 font-serif text-lg text-foreground">Wins worth noticing</h3>
      <div className="flex flex-wrap gap-2.5">
        {wins.map((win, i) => (
          <motion.div
            key={win.text}
            initial={{ opacity: 0, scale: 0.96 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: i * 0.06 }}
            className="inline-flex items-center gap-2 rounded-full border border-sand py-2 pl-2.5 pr-4"
            style={{ background: "linear-gradient(135deg,#FCFAF5,#F7EEE7)" }}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-sm" aria-hidden>{win.icon}</span>
            <span className="text-sm text-foreground/85">{win.text}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
