import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type FunnelStep } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import CohortUsersPanel, { type CohortRef } from '@/components/admin/CohortUsersPanel';

const CARD_STYLE = { background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' };
const TooltipStyle = {
  backgroundColor: 'hsl(217 33% 13%)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  fontSize: 12,
  color: 'hsl(214 32% 91%)',
};
const stagger = { show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Growth &amp; Funnel</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Acquisition funnel, activity, conversion rates, and where users drop off.</p>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <motion.div variants={fadeUp} className="rounded-xl p-4 border" style={CARD_STYLE}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</p>
      <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </motion.div>
  );
}

function FunnelRow({ step, onDrill }: { step: FunnelStep; onDrill: (s: FunnelStep) => void }) {
  const clickable = step.tracked && step.cohort_key;
  return (
    <div
      className={`rounded-lg p-3 border ${clickable ? 'hover:bg-white/[0.03] cursor-pointer' : ''} transition-colors`}
      style={{ borderColor: 'rgba(255,255,255,0.06)' }}
      onClick={() => clickable && onDrill(step)}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <span className="text-sm text-foreground">{step.label}</span>
        <span className="text-sm text-foreground tabular-nums">
          {step.tracked ? step.count.toLocaleString() : <span className="text-muted-foreground text-xs">not tracked</span>}
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${step.tracked ? Math.min(step.of_total_pct, 100) : 0}%` }} />
      </div>
      {step.from_prev_pct != null && (
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground tabular-nums">
          <span className="text-emerald-400/80">{step.from_prev_pct}% from previous</span>
          {step.drop_pct != null && step.drop_pct > 0 && (
            <span className="text-rose-400/80">−{step.drop_pct}% drop-off</span>
          )}
        </div>
      )}
    </div>
  );
}

function RateCard({ label, pct, sub }: { label: string; pct: number; sub?: string }) {
  return (
    <motion.div variants={fadeUp} className="rounded-xl p-4 border" style={CARD_STYLE}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</p>
      <p className="text-xl font-semibold text-foreground tabular-nums">{pct}%</p>
      <div className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {sub && <p className="text-[11px] text-muted-foreground mt-1.5">{sub}</p>}
    </motion.div>
  );
}

export default function GrowthPage() {
  const funnelQ = useQuery({ queryKey: ['funnel'], queryFn: () => api.funnel(), refetchInterval: 60_000 });
  const overviewQ = useQuery({ queryKey: ['analytics'], queryFn: () => api.analytics(), refetchInterval: 60_000 });
  const [drill, setDrill] = useState<CohortRef | null>(null);

  if (funnelQ.isLoading || overviewQ.isLoading) {
    return (
      <PageShell>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </PageShell>
    );
  }
  if (funnelQ.error || overviewQ.error || !funnelQ.data || !overviewQ.data) {
    return (
      <PageShell>
        <div className="rounded-xl p-4 border bg-destructive/10 border-destructive/20 text-sm text-destructive">
          Failed to load analytics: {((funnelQ.error || overviewQ.error) as Error)?.message ?? 'unknown error'}
        </div>
      </PageShell>
    );
  }

  const o = overviewQ.data;
  const f = funnelQ.data;

  return (
    <PageShell>
      {/* Top KPIs */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Total users" value={o.users.total.toLocaleString()} sub={`+${o.users.new_today} today · +${o.users.new_7d} this week`} />
        <Stat label="Daily active" value={o.active.dau.toLocaleString()} sub="sent a message in 24h" />
        <Stat label="Weekly active" value={o.active.wau.toLocaleString()} sub="last 7 days" />
        <Stat label="Monthly active" value={o.active.mau.toLocaleString()} sub="last 30 days" />
      </motion.div>

      {/* DAU trend */}
      <div className="rounded-xl p-4 border" style={CARD_STYLE}>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Daily active users · last 14 days</p>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={o.active.series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="dauFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="date" tick={{ fill: 'hsl(215 16% 50%)', fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fill: 'hsl(215 16% 50%)', fontSize: 10 }} allowDecimals={false} />
            <Tooltip contentStyle={TooltipStyle} />
            <Area type="monotone" dataKey="count" stroke="#818cf8" strokeWidth={2} fill="url(#dauFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Funnel + rates */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl p-4 border" style={CARD_STYLE}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Acquisition funnel</p>
          <div className="space-y-2">
            {f.steps.map((s) => (
              <FunnelRow key={s.key} step={s} onDrill={(st) => st.cohort_key && setDrill({ key: st.cohort_key, label: st.label })} />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">{f.note}</p>
        </div>

        <div>
          <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 gap-3">
            <RateCard label="Onboarding completion" pct={o.rates.onboarding_completion_pct} sub="completed / started" />
            <RateCard label="Trial start rate" pct={o.rates.trial_start_pct} sub="of all accounts" />
            <RateCard label="Trial → paid" pct={o.rates.trial_conversion_pct} sub="of ended trials" />
            <RateCard label="Paid conversion" pct={o.rates.paid_conversion_pct} sub="of all accounts" />
            <RateCard label="Churn" pct={o.rates.churn_pct} sub="canceled / (paying+canceled)" />
            <RateCard label="Reminders enabled" pct={o.rates.reminders_enabled_pct} sub="not paused" />
          </motion.div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Stat label="Avg messages / user" value={o.averages.messages_per_user} />
            <Stat label="Avg food logs / user" value={o.averages.food_logs_per_user} />
          </div>
        </div>
      </div>

      {/* Drop-off analysis */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl p-4 border" style={CARD_STYLE}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Most common missing profile fields</p>
          {o.missing_onboarding_fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">No missing fields.</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(120, o.missing_onboarding_fields.length * 34)}>
              <BarChart data={o.missing_onboarding_fields} layout="vertical" margin={{ left: 30, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'hsl(215 16% 50%)', fontSize: 10 }} allowDecimals={false} />
                <YAxis type="category" dataKey="field" tick={{ fill: 'hsl(215 16% 50%)', fontSize: 11 }} width={90} />
                <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar dataKey="count" fill="#818cf8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-xl p-4 border" style={CARD_STYLE}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Onboarding drop-off points</p>
          <p className="text-[11px] text-muted-foreground mb-2">Where in-progress users last stopped (last slot asked).</p>
          {o.dropoff_slots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one is mid-onboarding right now.</p>
          ) : (
            <div className="space-y-1.5">
              {o.dropoff_slots.map((d) => (
                <div key={d.slot} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">{d.slot}</span>
                  <span className="text-muted-foreground tabular-nums">{d.count}</span>
                </div>
              ))}
            </div>
          )}
          {(!o.tracking.website_visits || !o.tracking.dashboard_opens) && (
            <p className="text-[11px] text-muted-foreground mt-4 pt-3 border-t border-white/[0.06]">
              Not tracked yet: website visits, dashboard opens, voice usage. These need event instrumentation
              (a lightweight pixel / event table) before they can appear here.
            </p>
          )}
        </div>
      </div>

      {drill && <CohortUsersPanel cohort={drill} onClose={() => setDrill(null)} />}
    </PageShell>
  );
}
