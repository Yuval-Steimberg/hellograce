import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";

/**
 * Today's fluids vs the GLP-1 hydration range, plus a 7-day consistency row.
 * Read-only surfacing of the water that's already tracked (chat + the Water tab
 * in QuickLog write to the same water_logs). Always renders — an empty state
 * gently invites the first log rather than hiding, since hydration is one of the
 * most common GLP-1 struggles.
 */
export function HydrationCard({ data }: { data: DashboardSummary }) {
  const { today, goalMin, history } = data.hydration;
  const pct = goalMin > 0 ? Math.min(100, Math.round((today / goalMin) * 100)) : 0;
  const hitGoal = today >= goalMin;
  const daysAtGoal = history.filter((d) => d.oz >= goalMin).length;

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-serif text-lg text-foreground">Fluids today</h3>
        <span className="text-sm text-muted-foreground">
          {today} <span className="text-foreground/40">/ {goalMin} oz</span>
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5 }}
          className="h-full rounded-full"
          style={{ background: hitGoal ? "linear-gradient(90deg,#4F9CC4,#2E7FA6)" : "linear-gradient(90deg,#8FC7DE,#4F9CC4)" }}
        />
      </div>

      <p className="mt-2 text-sm text-foreground/70">
        {today <= 0
          ? `No water logged yet — aim for ${goalMin} oz, sipped through the day.`
          : hitGoal
            ? `You're in the ${goalMin}+ oz range. Nice.`
            : `About ${goalMin - today} oz to reach ${goalMin}.`}
      </p>

      {history.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-end gap-1">
            {history.map((d) => {
              const h = Math.max(6, Math.min(100, goalMin > 0 ? Math.round((d.oz / goalMin) * 100) : 0));
              return (
                <div key={d.day} className="flex-1" title={`${d.oz} oz`}>
                  <div className="mx-auto w-full rounded-sm" style={{ height: `${Math.round(h * 0.36)}px`, background: d.oz >= goalMin ? "#2E7FA6" : "#BFE0EC" }} />
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">Hit your range on {daysAtGoal} of the last {history.length} days.</p>
        </div>
      )}
    </div>
  );
}
