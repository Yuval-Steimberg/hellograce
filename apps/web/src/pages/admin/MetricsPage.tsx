import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { MessageSquare, Zap, ThumbsUp, Gauge, Users, TrendingUp, Clock, PauseCircle } from 'lucide-react';

const CHART_COLORS = ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#4f46e5'];

const stagger = {
  show: { transition: { staggerChildren: 0.05 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] } },
};

const TooltipStyle = {
  backgroundColor: 'hsl(217 33% 13%)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  fontSize: 12,
  color: 'hsl(214 32% 91%)',
};

export default function MetricsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['metrics'],
    queryFn: api.metrics,
    refetchInterval: 30_000,
  });

  if (isLoading) return <MetricsSkeleton />;
  if (error || !data) return (
    <PageShell>
      <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
        Failed to load metrics. Check API connectivity.
      </div>
    </PageShell>
  );

  const toolChartData = data.tools.map((t) => ({
    name: t.tool_name.replace('_', ' '),
    calls: Number(t.count),
    okRate: Math.round(Number(t.ok_rate) * 100),
    p95: Math.round(t.p95_ms),
  }));

  const feedbackData = data.feedback_last_7d.map((f) => ({
    name: f.signal_type,
    value: Number(f.count),
  }));

  const cacheHitPct = data.cache ? Math.round(data.cache.hitRate * 100) : null;

  return (
    <PageShell>
      {/* Activity KPIs */}
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"
      >
        <motion.div variants={fadeUp}>
          <KpiCard icon={<MessageSquare className="h-4 w-4" />} label="Messages (24h)" value={data.messages_last_24h} />
        </motion.div>
        <motion.div variants={fadeUp}>
          <KpiCard icon={<Zap className="h-4 w-4" />} label="Tool calls (24h)" value={data.tools.reduce((s, t) => s + Number(t.count), 0)} />
        </motion.div>
        <motion.div variants={fadeUp}>
          <KpiCard icon={<ThumbsUp className="h-4 w-4" />} label="Feedback (7d)" value={data.feedback_last_7d.reduce((s, f) => s + Number(f.count), 0)} />
        </motion.div>
        <motion.div variants={fadeUp}>
          <KpiCard icon={<Gauge className="h-4 w-4" />} label="Cache hit rate" value={cacheHitPct !== null ? `${cacheHitPct}%` : '—'} />
        </motion.div>
      </motion.div>

      {/* User stats */}
      {data.user_stats && (
        <motion.div
          variants={stagger}
          initial="hidden"
          animate="show"
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5"
        >
          {[
            { icon: <Users className="h-4 w-4" />, label: 'Total users', value: data.user_stats.total },
            { icon: <Clock className="h-4 w-4" />, label: 'On trial', value: data.user_stats.trial, color: 'amber' },
            { icon: <TrendingUp className="h-4 w-4" />, label: 'Paid', value: data.user_stats.paid, color: 'emerald' },
            { icon: <TrendingUp className="h-4 w-4" />, label: 'Pro', value: data.user_stats.pro, color: 'violet' },
            { icon: <PauseCircle className="h-4 w-4" />, label: 'Paused', value: data.user_stats.paused },
            { icon: <Users className="h-4 w-4" />, label: 'New this week', value: data.user_stats.new_this_week, color: 'sky' },
          ].map((kpi) => (
            <motion.div key={kpi.label} variants={fadeUp}>
              <KpiCard {...kpi} />
            </motion.div>
          ))}
        </motion.div>
      )}

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 lg:grid-cols-2 gap-4"
      >
        {/* Tool calls bar chart */}
        <motion.div variants={fadeUp}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold" style={{ letterSpacing: '-0.01em' }}>
                Tool usage (24h)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {toolChartData.length === 0 ? (
                <EmptyState label="No tool calls yet" />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={toolChartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                      formatter={(val: number, name: string) =>
                        name === 'okRate' ? [`${val}%`, 'ok rate'] : [val, name]
                      }
                    />
                    <Bar dataKey="calls" fill="#6366f1" radius={[4, 4, 0, 0]} name="calls" />
                    <Bar dataKey="okRate" fill="#4ade80" radius={[4, 4, 0, 0]} name="okRate" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Feedback pie chart */}
        <motion.div variants={fadeUp}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold" style={{ letterSpacing: '-0.01em' }}>
                Feedback signals (7d)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {feedbackData.length === 0 ? (
                <EmptyState label="No feedback yet" />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={feedbackData}
                      cx="50%"
                      cy="50%"
                      outerRadius={78}
                      innerRadius={36}
                      dataKey="value"
                      nameKey="name"
                      strokeWidth={0}
                    >
                      {feedbackData.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                    <Tooltip contentStyle={TooltipStyle} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Tool p95 latency */}
        {toolChartData.length > 0 && (
          <motion.div variants={fadeUp}>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold" style={{ letterSpacing: '-0.01em' }}>
                  Tool p95 latency (ms)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={toolChartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TooltipStyle} formatter={(v: number) => [`${v}ms`]} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                    <Bar dataKey="p95" fill="#818cf8" radius={[4, 4, 0, 0]} name="p95 ms" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Cache stats */}
        {data.cache && (
          <motion.div variants={fadeUp}>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold" style={{ letterSpacing: '-0.01em' }}>
                  Cache stats
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <StatRow label="Hits" value={data.cache.hits} />
                <StatRow label="Misses" value={data.cache.misses} />
                <StatRow label="Hit rate" value={`${Math.round(data.cache.hitRate * 100)}%`} accent />
              </CardContent>
            </Card>
          </motion.div>
        )}
      </motion.div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6">
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
          Metrics
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Auto-refreshes every 30 seconds</p>
      </div>
      {children}
    </div>
  );
}

const COLOR_MAP: Record<string, string> = {
  amber: 'text-amber-400',
  emerald: 'text-emerald-400',
  violet: 'text-violet-400',
  sky: 'text-sky-400',
};

function KpiCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  color?: string;
}) {
  return (
    <Card className="transition-all duration-200 hover:brightness-105">
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-2 text-muted-foreground mb-2">
          {icon}
          <span className="text-[11px] font-medium uppercase tracking-wider">{label}</span>
        </div>
        <p className={`text-2xl font-semibold tabular-nums ${color ? (COLOR_MAP[color] ?? '') : 'text-foreground'}`}
          style={{ letterSpacing: '-0.02em' }}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular-nums ${accent ? 'text-primary' : 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function MetricsSkeleton() {
  return (
    <div className="p-6">
      <Skeleton className="h-7 w-24 mb-1" />
      <Skeleton className="h-4 w-48 mb-6" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4">
            <Skeleton className="h-4 w-28 mb-3" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-5">
            <Skeleton className="h-4 w-36 mb-4" />
            <Skeleton className="h-[200px] w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
