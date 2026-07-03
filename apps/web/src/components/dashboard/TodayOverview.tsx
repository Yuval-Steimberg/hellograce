import { motion } from "framer-motion";
import type { DashboardSummary } from "@/lib/dashboardApi";
import { ringPct, injectionCountdown, nextBestAction } from "@/lib/dashboard-insights";

// Brand palette (kept local so the dashboard reads consistently regardless of
// light/dark tokens — mirrors DashboardCharts.tsx).
const CLAY = "#B05A41";
const INK = "#241F1B";
const SAGE = "#5C8A6E";

/** A calm SVG progress ring. Animates its sweep in on mount. */
function ProgressRing({
  pct, color, size = 76, stroke = 8, children,
}: {
  pct: number; color: string; size?: number; stroke?: number; children: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EDE7E0" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c - dash * c }}
          transition={{ duration: 0.9, ease: "easeOut", delay: 0.15 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">{children}</div>
    </div>
  );
}

function RingTile({ pct, color, big, small, label }: { pct: number; color: string; big: string; small?: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <ProgressRing pct={pct} color={color}>
        <span className="font-serif text-lg" style={{ color }}>{big}</span>
        {small && <span className="mt-0.5 text-[10px] text-muted-foreground">{small}</span>}
      </ProgressRing>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

function StatTile({ label, value, sub, color = INK }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 text-center">
      <span className="font-serif text-2xl leading-none sm:text-3xl" style={{ color }}>{value}</span>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      {sub && <span className="text-[11px] text-muted-foreground/80">{sub}</span>}
    </div>
  );
}

export function TodayOverview({
  data, wConv, wLabel,
}: {
  data: DashboardSummary;
  wConv: (lbs: number) => number;
  wLabel: string;
}) {
  const n = data.nutrition;
  const w = data.weight;
  const proteinPct = ringPct(n.today.protein, n.proteinGoal);
  const hasCalorieGoal = n.calorieGoal != null && n.calorieGoal > 0;
  const caloriePct = hasCalorieGoal ? ringPct(n.today.calories, n.calorieGoal) : 0;
  const meals = n.today.items.length;
  const inj = injectionCountdown(data.profile.injectionDay);
  const action = nextBestAction(data);
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <section
      className="overflow-hidden rounded-3xl border border-sand p-5 shadow-[0_2px_20px_rgba(176,90,65,0.06)] sm:p-6"
      style={{ background: "linear-gradient(140deg,#FCFAF5 0%,#F7EEE7 100%)" }}
    >
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: SAGE }} />
          <h2 className="font-serif text-lg text-foreground">Today</h2>
        </div>
        <span className="text-xs text-muted-foreground">{today}</span>
      </div>

      <div className="grid grid-cols-2 items-center gap-y-6 sm:grid-cols-4 sm:gap-4">
        <RingTile
          pct={proteinPct} color={CLAY}
          big={`${n.today.protein}g`} small={`of ${n.proteinGoal}g`} label="Protein"
        />
        {hasCalorieGoal ? (
          <RingTile
            pct={caloriePct} color={INK}
            big={`${n.today.calories}`} small={`of ${n.calorieGoal}`} label="Calories"
          />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-[76px] w-[76px] flex-col items-center justify-center rounded-full border border-sand bg-white/70">
              <span className="font-serif text-2xl" style={{ color: INK }}>{meals}</span>
            </div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Meals today</span>
          </div>
        )}
        <StatTile
          label="Lost so far" color={CLAY}
          value={w.lostLbs != null ? `${wConv(w.lostLbs)} ${wLabel}` : "—"}
          sub={w.start != null ? `from ${wConv(w.start)} ${wLabel}` : "add start weight"}
        />
        <StatTile
          label="To goal"
          value={w.toGoLbs != null ? `${wConv(w.toGoLbs)} ${wLabel}` : "—"}
          sub={w.goal != null ? `goal ${wConv(w.goal)} ${wLabel}` : "set a goal"}
        />
      </div>

      {/* Context chips */}
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-sand/70 pt-4">
        {n.streak > 0 && (
          <Chip icon="🔥" text={`${n.streak}-day streak`} />
        )}
        {inj && (
          <Chip icon="💉" text={inj.isToday ? "Shot day is today" : inj.isTomorrow ? "Shot day tomorrow" : `Next shot ${inj.label}`} tone={inj.daysUntil <= 1 ? "clay" : "plain"} />
        )}
        {hasCalorieGoal && meals > 0 && <Chip icon="🍽️" text={`${meals} meal${meals === 1 ? "" : "s"} logged`} />}
        {action && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-white">
            {action}
          </span>
        )}
      </div>
    </section>
  );
}

function Chip({ icon, text, tone = "plain" }: { icon: string; text: string; tone?: "plain" | "clay" }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs"
      style={
        tone === "clay"
          ? { borderColor: "#E4C4B8", background: "rgba(176,90,65,0.08)", color: CLAY }
          : { borderColor: "#EDE7E0", background: "#fff", color: INK }
      }
    >
      <span aria-hidden>{icon}</span>
      <span>{text}</span>
    </span>
  );
}
