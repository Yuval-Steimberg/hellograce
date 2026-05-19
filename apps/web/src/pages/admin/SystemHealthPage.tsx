import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { CheckCircle, XCircle, RefreshCw, Database, Cpu, Zap } from 'lucide-react';

const TooltipStyle = {
  backgroundColor: 'hsl(217 33% 13%)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  fontSize: 12,
  color: 'hsl(214 32% 91%)',
};

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

const stagger = { show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>System Health</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Infrastructure status and message volume — last 24h</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          Auto-refreshing every 30s
        </div>
      </div>
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <PageShell>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </PageShell>
  );
}

function StatusIndicator({ ok, label, sub }: { ok: boolean; label: string; sub?: string }) {
  return (
    <div className="rounded-xl p-5 border" style={CARD_STYLE}>
      <div className="flex items-center gap-2 mb-2">
        {ok
          ? <CheckCircle className="h-4 w-4 text-emerald-400" />
          : <XCircle className="h-4 w-4 text-rose-400" />}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="text-2xl font-semibold tabular-nums" style={{ letterSpacing: '-0.02em', color: ok ? 'hsl(150 80% 70%)' : 'hsl(0 80% 70%)' }}>
        {ok ? 'Healthy' : 'Down'}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon }: {
  label: string; value: string | number; sub?: string; icon?: React.ElementType;
}) {
  return (
    <div className="rounded-xl p-5 border" style={CARD_STYLE}>
      <div className="flex items-center gap-1.5 mb-2">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['system-health'],
    queryFn: api.systemHealth,
    refetchInterval: 30_000,
  });

  if (isLoading) return <LoadingSkeleton />;
  if (error || !data) return (
    <PageShell>
      <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
        Failed to load system health. Check API connectivity.
      </div>
    </PageShell>
  );

  const {
    db, redis,
    messages_24h, fallbacks_24h, fallback_rate_24h,
    tool_calls_24h, tool_failures_24h, tool_avg_latency_ms,
    message_volume,
  } = data;

  const toolSuccessRate = tool_calls_24h > 0
    ? Math.round(((tool_calls_24h - tool_failures_24h) / tool_calls_24h) * 100)
    : 100;

  return (
    <PageShell>
      {/* Infrastructure status */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Infrastructure</p>
        <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 gap-3">
          <motion.div variants={fadeUp}>
            <StatusIndicator ok={db.ok} label="Database" sub="Postgres / Supabase" />
          </motion.div>
          <motion.div variants={fadeUp}>
            <StatusIndicator
              ok={redis.ok}
              label="Redis"
              sub={redis.latency_ms != null ? `${redis.latency_ms}ms ping` : 'Upstash'}
            />
          </motion.div>
        </motion.div>
      </div>

      {/* 24h stats */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Last 24 Hours</p>
        <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <motion.div variants={fadeUp}>
            <StatCard label="Messages" value={messages_24h.toLocaleString()} icon={Zap} />
          </motion.div>
          <motion.div variants={fadeUp}>
            <StatCard
              label="Fallback Rate"
              value={`${fallback_rate_24h}%`}
              sub={`${fallbacks_24h} of ${messages_24h} messages`}
              icon={Cpu}
            />
          </motion.div>
          <motion.div variants={fadeUp}>
            <StatCard label="Tool Calls" value={tool_calls_24h.toLocaleString()} sub={`${tool_failures_24h} failed`} icon={Database} />
          </motion.div>
          <motion.div variants={fadeUp}>
            <StatCard
              label="Tool Success"
              value={`${toolSuccessRate}%`}
              sub={tool_avg_latency_ms != null ? `${tool_avg_latency_ms}ms avg` : undefined}
            />
          </motion.div>
        </motion.div>
      </div>

      {/* Message volume chart */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl p-5 border" style={CARD_STYLE}>
        <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Message Volume (24h by hour)</p>
        {message_volume.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">No messages in last 24 hours</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={message_volume} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="hour"
                tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: string) => v.slice(11, 16)}
              />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={TooltipStyle}
                labelFormatter={(v: string) => v.slice(11, 16) + ' UTC'}
                formatter={(v: number) => [v, 'Messages']}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#volumeGradient)"
                name="Messages"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </motion.div>

      {/* Health summary card */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl p-5 border" style={CARD_STYLE}>
        <p className="text-[13px] font-semibold text-foreground mb-3" style={{ letterSpacing: '-0.01em' }}>System Summary</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-8 text-sm">
          {[
            { label: 'Database', value: db.ok ? '✓ Connected' : '✗ Unreachable', ok: db.ok },
            { label: 'Cache (Redis)', value: redis.ok ? `✓ ${redis.latency_ms ?? '?'}ms` : '✗ Unreachable', ok: redis.ok },
            { label: 'Messages (24h)', value: messages_24h.toLocaleString(), ok: true },
            { label: 'Fallback rate', value: `${fallback_rate_24h}%`, ok: fallback_rate_24h < 10 },
            { label: 'Tool calls (24h)', value: tool_calls_24h.toLocaleString(), ok: true },
            { label: 'Tool failure rate', value: tool_calls_24h > 0 ? `${100 - toolSuccessRate}%` : '—', ok: toolSuccessRate >= 90 },
          ].map(({ label, value, ok }) => (
            <div key={label} className="flex items-center justify-between py-1"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <span className="text-muted-foreground text-xs">{label}</span>
              <span className={`text-xs font-medium tabular-nums ${ok ? 'text-foreground' : 'text-rose-400'}`}>{value}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </PageShell>
  );
}
