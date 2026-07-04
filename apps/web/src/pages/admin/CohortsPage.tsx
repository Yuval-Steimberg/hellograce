import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CohortCount, type CohortGroup } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import CohortUsersPanel from '@/components/admin/CohortUsersPanel';

const CARD_STYLE = { background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' };
const stagger = { show: { transition: { staggerChildren: 0.03 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] } },
};

const GROUP_ORDER: CohortGroup[] = ['lifecycle', 'onboarding', 'trial', 'payment', 'activity', 'engagement', 'profile'];
const GROUP_LABEL: Record<CohortGroup, string> = {
  lifecycle: 'Lifecycle',
  onboarding: 'Onboarding',
  trial: 'Trial',
  payment: 'Payment & Subscription',
  activity: 'Activity',
  engagement: 'Engagement',
  profile: 'Profile completeness',
};

function PageShell({ children, updatedAt }: { children: React.ReactNode; updatedAt?: string }) {
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>User Cohorts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Every user group at a glance — click any cohort to see its members.</p>
        </div>
        {updatedAt && (
          <p className="text-[11px] text-muted-foreground">Updated {formatDistanceToNow(new Date(updatedAt), { addSuffix: true })}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function CohortCard({ c, onClick }: { c: CohortCount; onClick: () => void }) {
  return (
    <motion.button
      variants={fadeUp}
      onClick={onClick}
      className="text-left rounded-xl p-4 border hover:border-indigo-500/40 hover:bg-white/[0.02] transition-colors"
      style={CARD_STYLE}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{c.count}</p>
        <span className="text-[11px] text-muted-foreground tabular-nums">{c.pct}%</span>
      </div>
      <p className="text-sm text-foreground mt-1">{c.label}</p>
      <div className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full bg-indigo-500/70" style={{ width: `${Math.min(c.pct, 100)}%` }} />
      </div>
    </motion.button>
  );
}

export default function CohortsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cohorts'],
    queryFn: () => api.cohorts(),
    refetchInterval: 60_000,
  });
  const [active, setActive] = useState<CohortCount | null>(null);

  if (isLoading) {
    return (
      <PageShell>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </PageShell>
    );
  }
  if (error || !data) {
    return (
      <PageShell>
        <div className="rounded-xl p-4 border bg-destructive/10 border-destructive/20 text-sm text-destructive">
          Failed to load cohorts: {(error as Error)?.message ?? 'unknown error'}
        </div>
      </PageShell>
    );
  }

  const byGroup = (g: CohortGroup) => data.cohorts.filter((c) => c.group === g);

  return (
    <PageShell updatedAt={data.generated_at}>
      {GROUP_ORDER.map((g) => {
        const items = byGroup(g);
        if (items.length === 0) return null;
        return (
          <div key={g}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{GROUP_LABEL[g]}</p>
            <motion.div
              variants={stagger}
              initial="hidden"
              animate="show"
              className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
            >
              {items.map((c) => <CohortCard key={c.key} c={c} onClick={() => setActive(c)} />)}
            </motion.div>
          </div>
        );
      })}

      {active && <CohortUsersPanel cohort={active} onClose={() => setActive(null)} />}
    </PageShell>
  );
}
