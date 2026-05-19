import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Users, DollarSign, TrendingUp, Percent } from 'lucide-react';

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

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl p-5 border" style={CARD_STYLE}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
      <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Business Metrics</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Revenue, growth, and retention overview</p>
      </div>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <PageShell>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </PageShell>
  );
}

export default function BusinessPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['business'],
    queryFn: api.business,
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingSkeleton />;
  if (error || !data) return (
    <PageShell>
      <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
        Failed to load business metrics. Check API connectivity.
      </div>
    </PageShell>
  );

  const { totals, active, weekly_signups, retention } = data;

  return (
    <PageShell>
      {/* Primary stats row */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <motion.div variants={fadeUp}>
          <StatCard label="Total Users" value={totals.users.toLocaleString()} />
        </motion.div>
        <motion.div variants={fadeUp}>
          <StatCard label="MRR" value={`$${totals.mrr.toFixed(2)}`} sub="Monthly Recurring Revenue" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <StatCard label="Paid + Pro" value={totals.paid + totals.pro} sub={`${totals.paid} standard · ${totals.pro} pro`} />
        </motion.div>
        <motion.div variants={fadeUp}>
          <StatCard label="Conversion" value={`${totals.conversion_pct}%`} sub="Trial → paid" />
        </motion.div>
      </motion.div>

      {/* Secondary stats row */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-3 gap-3">
        <motion.div variants={fadeUp}>
          <StatCard label="Active (7d)" value={active.active_7d} sub="Paid users replied in 7 days" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <StatCard label="Active (30d)" value={active.active_30d} sub="Paid users replied in 30 days" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <StatCard label="Trial Active" value={totals.trial_active} sub="In 3-day trial window" />
        </motion.div>
      </motion.div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Weekly signups */}
        <motion.div variants={fadeUp} initial="hidden" animate="show"
          className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Weekly Signups (8 weeks)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={weekly_signups} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="week"
                tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: string) => v.slice(5)} // MM-DD
              />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} name="Signups" />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Retention cohort */}
        <motion.div variants={fadeUp} initial="hidden" animate="show"
          className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Retention by Cohort (%)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={retention} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="cohort" tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} formatter={(v: number) => [`${v}%`, 'Retention']} />
              <Bar dataKey="pct" fill="#6366f1" radius={[4, 4, 0, 0]} name="Retention %" />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>
      </div>

      {/* MRR breakdown */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl p-5 border" style={CARD_STYLE}>
        <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>MRR Breakdown</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                <th className="text-left py-2 pr-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Plan</th>
                <th className="text-right py-2 pr-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Users</th>
                <th className="text-right py-2 pr-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Price/mo</th>
                <th className="text-right py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">MRR</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                <td className="py-2.5 pr-4 text-foreground font-medium">Standard</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-foreground">{totals.paid}</td>
                <td className="py-2.5 pr-4 text-right text-muted-foreground">$9.99</td>
                <td className="py-2.5 text-right tabular-nums text-foreground">${(totals.paid * 9.99).toFixed(2)}</td>
              </tr>
              <tr className="border-b" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                <td className="py-2.5 pr-4 text-foreground font-medium">Pro</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-foreground">{totals.pro}</td>
                <td className="py-2.5 pr-4 text-right text-muted-foreground">$24.99</td>
                <td className="py-2.5 text-right tabular-nums text-foreground">${(totals.pro * 24.99).toFixed(2)}</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 text-foreground font-semibold">Total</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-foreground font-semibold">{totals.paid + totals.pro}</td>
                <td className="py-2.5 pr-4 text-right text-muted-foreground">—</td>
                <td className="py-2.5 text-right tabular-nums text-foreground font-semibold">${totals.mrr.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </motion.div>
    </PageShell>
  );
}
