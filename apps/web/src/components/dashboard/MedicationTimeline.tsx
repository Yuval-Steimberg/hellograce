import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";

/**
 * Dose timeline — "Week 1–4: 2.5mg → Week 5–8: 5mg" with weight change and the
 * most common symptom per dose period. Read-only history; never dosing advice.
 * Hidden until there's at least one period to show.
 */
export function MedicationTimeline({ data }: { data: DashboardSummary }) {
  const periods = data.medicationTimeline ?? [];
  if (periods.length === 0) return null;

  const weekLabel = (a: number | null, b: number | null) => {
    if (a == null) return null;
    if (b == null || b === a) return `Week ${a}`;
    return `Week ${a}–${b}`;
  };
  const capMed = (m: string | null) => (m ? m.charAt(0).toUpperCase() + m.slice(1) : null);

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <h3 className="mb-4 font-serif text-lg text-foreground">Your dose journey</h3>

      <div className="relative pl-5">
        {/* vertical rail */}
        <div className="absolute left-[6px] top-1 bottom-1 w-px bg-sand" aria-hidden />
        <div className="space-y-4">
          {periods.map((p, i) => {
            const wk = weekLabel(p.glp1WeekStart, p.glp1WeekEnd);
            return (
              <motion.div
                key={`${p.from}-${p.doseMg}`}
                initial={{ opacity: 0, x: 6 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: i * 0.05 }}
                className="relative"
              >
                <span
                  className={`absolute -left-5 top-1.5 h-3 w-3 rounded-full border-2 ${
                    p.current ? "border-primary bg-primary" : "border-sand bg-white"
                  }`}
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-serif text-lg text-foreground">{p.doseMg} mg</span>
                  {capMed(p.medication) && <span className="text-sm text-muted-foreground">{capMed(p.medication)}</span>}
                  {p.current && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">current</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {wk ? <>{wk} · </> : null}
                  {p.weightDeltaLbs != null && (
                    <span className={p.weightDeltaLbs < 0 ? "text-foreground/70" : "text-foreground/70"}>
                      {p.weightDeltaLbs < 0 ? `${Math.abs(p.weightDeltaLbs)} lb down` : p.weightDeltaLbs > 0 ? `${p.weightDeltaLbs} lb up` : "weight steady"}
                    </span>
                  )}
                  {p.weightDeltaLbs != null && p.topSymptom ? " · " : null}
                  {p.topSymptom && <span>most common: {p.topSymptom}</span>}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        A record of your dose history — always follow your prescriber for any changes.
      </p>
    </div>
  );
}
