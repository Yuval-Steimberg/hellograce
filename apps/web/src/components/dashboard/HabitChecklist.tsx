import { useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { dashboardApi, type DashboardSummary } from "@/lib/dashboardApi";

/**
 * Quick-checkmark daily habits — the low-friction path for users who don't want
 * to log every detail. Tap to check/uncheck; each toggle persists for the user's
 * local day. Optimistic UI with revert on error. Resets naturally at the new day
 * (a fresh day simply has no checks yet).
 */
export function HabitChecklist({ data }: { data: DashboardSummary }) {
  const available = data.habits?.available ?? [];
  const [checked, setChecked] = useState<Set<string>>(new Set(data.habits?.checked ?? []));
  const [busy, setBusy] = useState<string | null>(null);
  if (available.length === 0) return null;

  const doneCount = available.filter((h) => checked.has(h.key)).length;

  const toggle = async (key: string) => {
    const next = !checked.has(key);
    setBusy(key);
    // Optimistic.
    setChecked((prev) => {
      const s = new Set(prev);
      if (next) s.add(key); else s.delete(key);
      return s;
    });
    try {
      const res = await dashboardApi.toggleHabit(key, next);
      setChecked(new Set(res.checked));
    } catch (e) {
      // Revert.
      setChecked((prev) => {
        const s = new Set(prev);
        if (next) s.delete(key); else s.add(key);
        return s;
      });
      toast.error(e instanceof Error ? e.message : "Couldn't update that");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-serif text-lg text-foreground">Today's checklist</h3>
        <span className="text-sm text-muted-foreground">{doneCount}/{available.length}</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {available.map((h, i) => {
          const on = checked.has(h.key);
          return (
            <motion.button
              key={h.key}
              onClick={() => toggle(h.key)}
              disabled={busy === h.key}
              initial={{ opacity: 0, y: 6 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.25, delay: i * 0.03 }}
              className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                on
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-sand bg-white text-foreground/70 hover:border-primary/50"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs ${
                  on ? "border-primary bg-primary text-white" : "border-sand bg-white text-transparent"
                }`}
                aria-hidden
              >
                ✓
              </span>
              <span className="flex-1 leading-tight">{h.label}</span>
              <span aria-hidden>{h.icon}</span>
            </motion.button>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        No pressure to log every bite — just tap what you did. You can also text Grace "hit protein and fluids".
      </p>
    </div>
  );
}
