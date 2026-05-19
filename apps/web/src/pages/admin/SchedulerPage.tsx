import { useQuery } from '@tanstack/react-query';
import { api, type SchedulerUser } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw } from 'lucide-react';

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

const stagger = { show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

function relativeTime(ts: string | null): string {
  if (!ts) return '—';
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return '—';
  }
}

function userStatus(u: SchedulerUser): 'paid' | 'pro' | 'trial' | 'expired' {
  if (u.is_pro) return 'pro';
  if (u.is_paid) return 'paid';
  if (!u.trial_start) return 'trial';
  const msElapsed = Date.now() - new Date(u.trial_start).getTime();
  return msElapsed < 3 * 24 * 3_600_000 ? 'trial' : 'expired';
}

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  paid:    { bg: 'rgba(99,102,241,0.15)',  text: 'rgb(165,180,252)', label: 'Paid' },
  pro:     { bg: 'rgba(16,185,129,0.15)',  text: 'rgb(110,231,183)', label: 'Pro' },
  trial:   { bg: 'rgba(251,191,36,0.15)',  text: 'rgb(253,224,71)',  label: 'Trial' },
  expired: { bg: 'rgba(239,68,68,0.15)',   text: 'rgb(252,165,165)', label: 'Expired' },
};

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl">
      {children}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <PageShell>
      <Skeleton className="h-10 w-72 rounded-lg" />
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </PageShell>
  );
}

export default function SchedulerPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['scheduler-status'],
    queryFn: api.schedulerStatus,
    refetchInterval: 30_000,
  });

  if (isLoading) return <LoadingSkeleton />;
  if (error || !data) return (
    <PageShell>
      <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
        Failed to load scheduler status. Check API connectivity.
      </div>
    </PageShell>
  );

  const users = data.users;
  const inInjectionFlow = users.filter((u) => u.injection_flow_stage && u.injection_flow_stage !== 'idle').length;
  const inSideEffectFlow = users.filter((u) => u.side_effect_flow).length;

  return (
    <PageShell>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Scheduler Status</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Real-time state for all users</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          Auto-refreshing every 30s
        </div>
      </div>

      {/* Stats row */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <motion.div variants={fadeUp}>
          <div className="rounded-xl p-5 border" style={CARD_STYLE}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Total Users</p>
            <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{users.length}</p>
          </div>
        </motion.div>
        <motion.div variants={fadeUp}>
          <div className="rounded-xl p-5 border" style={CARD_STYLE}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">In Injection Flow</p>
            <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{inInjectionFlow}</p>
          </div>
        </motion.div>
        <motion.div variants={fadeUp}>
          <div className="rounded-xl p-5 border" style={CARD_STYLE}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Side Effect Flow</p>
            <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{inSideEffectFlow}</p>
          </div>
        </motion.div>
      </motion.div>

      {/* Table */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl border" style={CARD_STYLE}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['User', 'Status', 'Timezone', 'Last Reply', 'Last Morning', 'Last Midday', 'Last Evening', 'Injection Flow', 'Side Effect'].map((h) => (
                  <th key={h} className="text-left px-3 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, idx) => {
                const st = userStatus(u);
                const badge = STATUS_BADGE[st];
                return (
                  <tr key={u.phone}
                    style={{
                      background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="font-medium text-foreground text-xs">{u.first_name ?? '—'}</div>
                      <div className="text-[11px] text-muted-foreground">{u.phone}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{ background: badge.bg, color: badge.text }}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{u.timezone ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{relativeTime(u.last_reply_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{relativeTime(u.last_morning_sent_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{relativeTime(u.last_midday_sent_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{relativeTime(u.last_evening_sent_at)}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {u.injection_flow_stage && u.injection_flow_stage !== 'idle'
                        ? <span className="text-amber-400">{u.injection_flow_stage}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {u.side_effect_flow
                        ? <span className="text-rose-400">{u.side_effect_flow}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground text-sm">No users found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </PageShell>
  );
}
