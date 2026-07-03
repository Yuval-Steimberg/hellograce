import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";
import { injectionCountdown } from "@/lib/dashboard-insights";

const CLAY = "#B05A41";
const SAGE = "#5C8A6E";
const INK = "#241F1B";

const ENC_BLOB_RE = /^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;
const clean = (v: string | null): string | null => (v && ENC_BLOB_RE.test(v.trim()) ? null : v);

/**
 * Medication + injection-day support. The next injection is derived client-side
 * from the stored weekday (weekly cadence). Reminders are managed in Settings —
 * we link there rather than assert times we don't have in this payload.
 */
export function InjectionCard({ data }: { data: DashboardSummary }) {
  const p = data.profile;
  const medication = clean(p.medication);
  const inj = injectionCountdown(p.injectionDay);
  // Nothing worth showing yet — let the profile-completeness card do the nudging.
  if (!medication && !inj && p.glp1Week == null) return null;

  const soon = inj != null && inj.daysUntil <= 1;
  const accent = soon ? CLAY : INK;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.5 }}
      className="grid gap-4 rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)] sm:grid-cols-[auto,1fr] sm:items-center sm:gap-6"
    >
      {/* Next injection tile */}
      {inj ? (
        <div
          className="flex flex-col items-center justify-center rounded-2xl px-6 py-4 text-center sm:min-w-[150px]"
          style={{ background: soon ? "rgba(176,90,65,0.08)" : "#FCFAF5", border: `1px solid ${soon ? "#E4C4B8" : "#EDE7E0"}` }}
        >
          <span className="text-2xl" aria-hidden>💉</span>
          <span className="mt-1 font-serif text-2xl leading-none" style={{ color: accent }}>
            {inj.isToday ? "Today" : inj.isTomorrow ? "Tomorrow" : inj.label.replace(/^in /, "")}
          </span>
          <span className="mt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {inj.isToday || inj.isTomorrow ? "Next shot" : `Next shot · ${inj.weekday}`}
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-sand bg-[#FCFAF5] px-6 py-4 text-center sm:min-w-[150px]">
          <span className="text-2xl" aria-hidden>💊</span>
          <span className="mt-1 text-xs text-muted-foreground">Add your injection day in Settings</span>
        </div>
      )}

      {/* Details */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-serif text-lg text-foreground">{medication ?? "Your GLP-1"}</h3>
          {p.doseMg != null && (
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-foreground/70">{p.doseMg} mg</span>
          )}
          {p.glp1Week != null && (
            <span className="rounded-full px-2.5 py-0.5 text-xs" style={{ background: "rgba(92,138,110,0.12)", color: SAGE }}>
              Week {p.glp1Week}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {soon
            ? "Shot day is right around the corner. A solid protein day and plenty of water help it settle."
            : inj
              ? `Grace keeps an eye on your ${inj.weekday} rhythm and checks in around it.`
              : "Tell Grace which day you inject and she'll build your check-ins around it."}
        </p>
        <Link to="/settings" className="mt-3 inline-flex items-center gap-1 text-sm font-medium" style={{ color: CLAY }}>
          Manage reminders in Settings →
        </Link>
      </div>
    </motion.div>
  );
}
