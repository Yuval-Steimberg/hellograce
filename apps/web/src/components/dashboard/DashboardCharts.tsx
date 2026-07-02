import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { format, parseISO } from "date-fns";
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid,
} from "recharts";
import type { DashboardSummary } from "@/lib/dashboardApi";

// A calm, wellness palette (independent of light/dark tokens so the dashboard
// reads consistently). Terracotta = the signature accent; charcoal = ink; sage
// = positive/goal-met.
const CLAY = "#B05A41";
const CLAY_SOFT = "#E4C4B8";
const INK = "#241F1B";
const SAGE = "#5C8A6E";
const GRID = "#EDE7E0";
const MUTE = "#9A9089";

const card = "rounded-2xl border border-sand bg-white p-5 shadow-[0_1px_2px_rgba(36,31,27,0.04)]";

function fmtDay(d: string): string {
  try { return format(parseISO(d.length <= 10 ? `${d}T00:00:00` : d), "MMM d"); } catch { return d; }
}

const TT = { fontSize: 12, borderRadius: 12, border: "1px solid #EDE7E0", background: "#fff", color: INK, boxShadow: "0 4px 16px rgba(36,31,27,0.08)" } as const;

export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.5, delay }}>
      {children}
    </motion.div>
  );
}

export function StatCard({ label, value, sub, tone = "ink" }: { label: string; value: string; sub?: string; tone?: "ink" | "clay" | "sage" }) {
  const color = tone === "clay" ? CLAY : tone === "sage" ? SAGE : INK;
  return (
    <div className={`${card} flex flex-col justify-between`}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 font-serif text-3xl leading-none" style={{ color }}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

const KG = 1 / 2.2046226218;
export function WeightChart({ weight, unit = "lbs" }: { weight: DashboardSummary["weight"]; unit?: "lbs" | "kg" }) {
  const conv = (lbs: number) => (unit === "kg" ? Math.round(lbs * KG * 10) / 10 : Math.round(lbs * 10) / 10);
  const u = unit === "kg" ? "kg" : "lbs";
  const data = weight.series.map((p) => ({ date: p.date, weight: conv(p.weight) }));
  const goal = weight.goal != null ? conv(weight.goal) : null;
  const hasData = data.length >= 2;
  return (
    <div className={card}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-serif text-lg text-foreground">Weight</h3>
        {goal != null && <span className="text-xs text-muted-foreground">Goal {goal} {u}</span>}
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CLAY} stopOpacity={0.22} />
                <stop offset="100%" stopColor={CLAY} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fontSize: 11, fill: MUTE }} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis domain={["dataMin - 3", "dataMax + 3"]} tick={{ fontSize: 11, fill: MUTE }} tickLine={false} axisLine={false} width={38} />
            <Tooltip contentStyle={TT} labelFormatter={fmtDay} formatter={(v: number) => [`${v} ${u}`, "Weight"]} />
            {goal != null && <ReferenceLine y={goal} stroke={SAGE} strokeDasharray="4 4" strokeWidth={1.5} />}
            <Area type="monotone" dataKey="weight" stroke={CLAY} strokeWidth={2.5} fill="url(#wg)" dot={{ r: 2.5, fill: CLAY }} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <EmptyChart note="Log a couple of weigh-ins and your trend line appears here." />
      )}
    </div>
  );
}

export function NutritionChart({ nutrition }: { nutrition: DashboardSummary["nutrition"] }) {
  const [metric, setMetric] = useState<"protein" | "calories">("protein");
  const data = nutrition.history.map((d) => ({ day: d.day, protein: d.protein, calories: d.calories }));
  const goal = metric === "protein" ? nutrition.proteinGoal : nutrition.calorieGoal;
  const hasData = data.some((d) => d.protein > 0 || d.calories > 0);
  return (
    <div className={card}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-serif text-lg text-foreground">Nutrition</h3>
        <div className="flex rounded-full bg-secondary p-0.5 text-xs">
          {(["protein", "calories"] as const).map((m) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`rounded-full px-3 py-1 capitalize transition-colors ${metric === m ? "bg-white text-foreground shadow-sm" : "text-muted-foreground"}`}>
              {m}
            </button>
          ))}
        </div>
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" tickFormatter={fmtDay} tick={{ fontSize: 11, fill: MUTE }} tickLine={false} axisLine={false} minTickGap={20} />
            <YAxis tick={{ fontSize: 11, fill: MUTE }} tickLine={false} axisLine={false} width={38} />
            <Tooltip contentStyle={TT} labelFormatter={fmtDay} cursor={{ fill: "rgba(176,90,65,0.06)" }}
              formatter={(v: number) => [metric === "protein" ? `${v} g` : `${v} kcal`, metric === "protein" ? "Protein" : "Calories"]} />
            {goal != null && <ReferenceLine y={goal} stroke={SAGE} strokeDasharray="4 4" strokeWidth={1.5} label={{ value: "goal", fontSize: 10, fill: SAGE, position: "right" }} />}
            <Bar dataKey={metric} radius={[5, 5, 0, 0]} maxBarSize={26}
              fill={metric === "protein" ? CLAY : INK} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <EmptyChart note="Your daily protein and calories will chart here as you log meals." />
      )}
    </div>
  );
}

export function MoodChart({ mood }: { mood: DashboardSummary["mood"] }) {
  const data = mood.series.map((p) => ({ date: p.date, score: p.score }));
  if (data.length < 2) return null;
  return (
    <div className={card}>
      <h3 className="mb-3 font-serif text-lg text-foreground">Mood</h3>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fontSize: 11, fill: MUTE }} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis domain={[1, 10]} ticks={[2, 4, 6, 8, 10]} tick={{ fontSize: 11, fill: MUTE }} tickLine={false} axisLine={false} width={24} />
          <Tooltip contentStyle={TT} labelFormatter={fmtDay} formatter={(v: number) => [`${v}/10`, "Mood"]} />
          <Line type="monotone" dataKey="score" stroke={SAGE} strokeWidth={2.5} dot={{ r: 2.5, fill: SAGE }} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const SYMPTOM_EMOJI: Record<string, string> = {
  nausea: "🤢", vomiting: "🤮", constipation: "🚽", diarrhea: "💧", fatigue: "😴",
  headache: "🤕", dizziness: "💫", heartburn: "🔥", bloating: "🎈",
};

/** The differentiator, made visible: Grace's learned patterns of how THIS body
 *  handles side effects — the thing no generic tracker can show. */
export function SymptomPatterns({ symptoms }: { symptoms: DashboardSummary["symptoms"] }) {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return (
    <div className={card}>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-serif text-lg text-foreground">What Grace has learned about your body</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        The more you share how you feel after your shot, the better Grace gets at seeing your personal patterns — something a generic tracker never can.
      </p>

      {symptoms.patterns.length === 0 ? (
        <EmptyChart note="No patterns yet. Next time a side effect hits, tell Grace — she'll start learning your rhythm and what helps." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {symptoms.patterns.map((p) => (
            <div key={p.symptom} className="rounded-xl border border-sand bg-secondary/40 p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground">{SYMPTOM_EMOJI[p.symptom] ?? "•"} {cap(p.symptom)}</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-muted-foreground">{p.count}×</span>
              </div>
              <p className="mt-2 text-sm text-foreground/80">
                {p.typicalTiming ? <>Usually hits <span className="font-medium" style={{ color: CLAY }}>{p.typicalTiming}</span>.</> : <>Come up a few times — still learning the timing.</>}
                {p.topRemedy && <> <span style={{ color: SAGE }} className="font-medium">{p.topRemedy}</span> helped before.</>}
              </p>
            </div>
          ))}
        </div>
      )}

      {symptoms.recent.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent</p>
          <div className="flex flex-wrap gap-2">
            {symptoms.recent.slice(0, 12).map((r, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full border border-sand bg-white px-2.5 py-1 text-xs text-foreground/80">
                {SYMPTOM_EMOJI[r.symptom] ?? "•"} {cap(r.symptom)}
                <span className="text-muted-foreground">· {fmtDay(r.date)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyChart({ note }: { note: string }) {
  return (
    <div className="flex h-[180px] items-center justify-center rounded-xl border border-dashed border-sand bg-secondary/30 px-6 text-center">
      <p className="text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

export function useGreeting(name: string | null): string {
  return useMemo(() => {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    return name ? `${part}, ${name}` : part;
  }, [name]);
}
