import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";
import { profileCompleteness } from "@/lib/dashboard-insights";

const SAGE = "#5C8A6E";

/**
 * "Grace is learning you" — a warm completeness meter, not a boring form.
 * Shows what Grace already knows and gently invites filling the gaps (each
 * links to Settings). Hidden once everything is known.
 */
export function ProfileCompleteness({ data }: { data: DashboardSummary }) {
  const { pct, known, missing } = profileCompleteness(data);
  if (missing.length === 0) return null;

  return (
    <div className="rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="font-serif text-lg text-foreground">Grace is learning you</h3>
        <span className="text-sm font-medium" style={{ color: SAGE }}>{pct}%</span>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        The more Grace knows, the more her guidance fits your body. You've shared {known.length} of {known.length + missing.length} basics.
      </p>

      {/* Meter */}
      <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-secondary">
        <motion.div
          className="h-full rounded-full"
          style={{ background: SAGE }}
          initial={{ width: 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {missing.map((m) => (
          <Link
            key={m.key}
            to="/settings"
            title={m.hint}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-sand bg-secondary/30 px-3 py-1.5 text-xs text-foreground/75 transition-colors hover:border-primary hover:text-foreground"
          >
            <span className="text-muted-foreground" aria-hidden>+</span> {m.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
