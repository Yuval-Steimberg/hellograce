import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";

/**
 * "This week" rollup — averages + this-week weight change + a plateau signal +
 * one hedged, non-causal insight from Grace. Renders nothing until there's at
 * least one real number to show, so it never reads as empty cheerleading.
 */
export function WeeklyReview({ data }: { data: DashboardSummary }) {
  const wk = data.weekly;
  const hasAny =
    wk.avgProtein != null || wk.weightDeltaLbs != null || wk.avgOz != null || wk.plateau != null;
  if (!hasAny) return null;

  const stats: Array<{ label: string; value: string; sub?: string }> = [];
  if (wk.weightDeltaLbs != null) {
    const d = wk.weightDeltaLbs;
    stats.push({
      label: "Weight this week",
      value: d < 0 ? `−${Math.abs(d)} lb` : d > 0 ? `+${d} lb` : "steady",
      sub: d < 0 ? "down" : d > 0 ? "up" : "held",
    });
  }
  if (wk.avgProtein != null) {
    stats.push({
      label: "Avg protein",
      value: `${wk.avgProtein}g`,
      sub: wk.proteinGoal ? `goal ${wk.proteinGoal}g` : `${wk.daysProteinLogged} days logged`,
    });
  }
  if (wk.avgOz != null) {
    stats.push({
      label: "Avg fluids",
      value: `${wk.avgOz} oz`,
      sub: `${wk.daysWaterAtGoal}/${wk.waterDaysWindow} days at goal`,
    });
  }

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-serif text-lg text-foreground">This week</h3>
        {wk.plateau?.stalled && (
          <span className="rounded-full bg-secondary px-3 py-1 text-xs text-foreground/70">
            Scale flat ~{Math.round(wk.plateau.days / 7)} wk
          </span>
        )}
      </div>

      {stats.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 6 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="rounded-xl border border-sand bg-secondary/30 px-3 py-3 text-center"
            >
              <div className="font-serif text-xl text-foreground">{s.value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.label}</div>
              {s.sub && <div className="text-[11px] text-foreground/40">{s.sub}</div>}
            </motion.div>
          ))}
        </div>
      )}

      {wk.insight && (
        <p className="mt-4 rounded-xl bg-[#F7EEE7] px-4 py-3 text-sm leading-relaxed text-foreground/85">
          {wk.insight}
        </p>
      )}
    </div>
  );
}
