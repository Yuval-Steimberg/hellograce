import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

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

function shortDay(d: string) {
  try { return format(new Date(d), 'MM/dd'); } catch { return d.slice(5); }
}

function SuccessRateBadge({ rate }: { rate: number }) {
  const color = rate >= 90 ? 'rgb(110,231,183)' : rate >= 70 ? 'rgb(253,224,71)' : 'rgb(252,165,165)';
  const bg = rate >= 90 ? 'rgba(16,185,129,0.12)' : rate >= 70 ? 'rgba(251,191,36,0.12)' : 'rgba(239,68,68,0.12)';
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums"
      style={{ background: bg, color }}>{rate}%</span>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>AI Quality</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Tool performance, satisfaction trends, and prompt history</p>
      </div>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <PageShell>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
      </div>
      <Skeleton className="h-48 rounded-xl" />
    </PageShell>
  );
}

export default function AIQualityPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['ai-quality'],
    queryFn: api.aiQuality,
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingSkeleton />;
  if (error || !data) return (
    <PageShell>
      <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
        Failed to load AI quality data. Check API connectivity.
      </div>
    </PageShell>
  );

  const { tools, fallback_trend, satisfaction_trend, latency_trend, prompts } = data;

  const totalCalls = tools.reduce((s, t) => s + t.calls, 0);
  const avgSuccessRate = tools.length > 0
    ? Math.round(tools.reduce((s, t) => s + t.success_rate, 0) / tools.length)
    : 0;
  const activePrompt = prompts.find((p) => p.active);
  const satisfactionData = satisfaction_trend.filter((d) => d.total > 0);
  const overallSatisfaction = satisfactionData.length > 0
    ? Math.round(satisfactionData.reduce((s, d) => s + (d.pct ?? 0), 0) / satisfactionData.length)
    : null;

  return (
    <PageShell>
      {/* Stats row */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Tool Calls (30d)', value: totalCalls.toLocaleString() },
          { label: 'Avg Tool Success', value: `${avgSuccessRate}%` },
          { label: 'Prompt Version', value: activePrompt ? `v${activePrompt.version}` : '—' },
          { label: 'Satisfaction (30d)', value: overallSatisfaction !== null ? `${overallSatisfaction}%` : '—' },
        ].map(({ label, value }) => (
          <motion.div key={label} variants={fadeUp}>
            <div className="rounded-xl p-5 border" style={CARD_STYLE}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
              <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{value}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Satisfaction trend */}
        <motion.div variants={fadeUp} initial="hidden" animate="show"
          className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Satisfaction % (30d)</p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={satisfaction_trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} formatter={(v: number | null) => [v !== null ? `${v}%` : '—', 'Satisfaction']} />
              <Line type="monotone" dataKey="pct" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Fallback trend */}
        <motion.div variants={fadeUp} initial="hidden" animate="show"
          className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Fallback Responses (30d)</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={fallback_trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Fallbacks" />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Latency trend */}
        <motion.div variants={fadeUp} initial="hidden" animate="show"
          className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Avg Tool Latency (30d)</p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={latency_trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} unit="ms" />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} formatter={(v: number) => [`${v}ms`, 'Avg latency']} />
              <Line type="monotone" dataKey="avg_ms" stroke="#6366f1" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </motion.div>
      </div>

      {/* Tools table */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl border" style={CARD_STYLE}>
        <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <p className="text-[13px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>Tool Performance (30d)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Tool Name', 'Calls', 'Successes', 'Success Rate', 'Avg Latency'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tools.map((t, idx) => (
                <tr key={t.name}
                  style={{
                    background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                  }}>
                  <td className="px-4 py-2.5 font-mono text-xs text-foreground">{t.name}</td>
                  <td className="px-4 py-2.5 tabular-nums text-foreground">{t.calls.toLocaleString()}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{t.successes.toLocaleString()}</td>
                  <td className="px-4 py-2.5"><SuccessRateBadge rate={t.success_rate} /></td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{t.avg_latency_ms}ms</td>
                </tr>
              ))}
              {tools.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-sm">No tool data for the last 30 days</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Prompt history */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl border" style={CARD_STYLE}>
        <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
          <p className="text-[13px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>Prompt History</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Version', 'Date', 'Status', 'Notes'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prompts.map((p, idx) => (
                <tr key={p.version}
                  style={{
                    background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                  }}>
                  <td className="px-4 py-2.5 tabular-nums text-foreground font-semibold">v{p.version}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">
                    {format(new Date(p.created_at), 'MMM d, yyyy')}
                  </td>
                  <td className="px-4 py-2.5">
                    {p.active
                      ? <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: 'rgba(16,185,129,0.12)', color: 'rgb(110,231,183)' }}>Active</span>
                      : <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: 'rgba(255,255,255,0.06)', color: 'hsl(215 16% 50%)' }}>Draft</span>}
                    {p.auto_generated && (
                      <span className="ml-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ background: 'rgba(99,102,241,0.12)', color: 'rgb(165,180,252)' }}>Auto</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-xs truncate">
                    {p.notes ?? '—'}
                  </td>
                </tr>
              ))}
              {prompts.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground text-sm">No prompts yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </PageShell>
  );
}
