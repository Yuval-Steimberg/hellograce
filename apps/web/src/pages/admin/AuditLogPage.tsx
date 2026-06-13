import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AuditLogEntry, type FlaggedResponse, type StripeEvent } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollText, Flag, CreditCard, RefreshCw, Check } from 'lucide-react';

const CARD_STYLE = { background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' };

type Tab = 'audit' | 'flagged' | 'stripe';

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Audit &amp; Ops</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Admin action history, flagged responses, and Stripe webhook events</p>
      </div>
      {children}
    </div>
  );
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'processed' || status === 'reviewed' ? 'text-emerald-400 bg-emerald-400/10'
    : status === 'failed' ? 'text-rose-400 bg-rose-400/10'
    : status === 'skipped' ? 'text-slate-400 bg-slate-400/10'
    : 'text-amber-400 bg-amber-400/10';
  return <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${color}`}>{status}</span>;
}

function AuditTab() {
  const [date, setDate] = useState<'today' | '7d' | '30d' | ''>('7d');
  const [action, setAction] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', date, action],
    queryFn: () => api.auditLogs({ ...(date ? { date } : {}), ...(action ? { action } : {}), limit: 200 }),
    refetchInterval: 30_000,
  });
  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  const logs: AuditLogEntry[] = data?.logs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select value={date} onChange={(e) => setDate(e.target.value as typeof date)}
          className="text-sm rounded-lg px-3 py-1.5 border bg-transparent text-foreground" style={CARD_STYLE}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="">All time</option>
        </select>
        <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Filter by action (e.g. admin.user_update)"
          className="text-sm rounded-lg px-3 py-1.5 border bg-transparent text-foreground flex-1 min-w-[220px]" style={CARD_STYLE} />
      </div>
      {logs.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No audit entries for this filter.</p>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={CARD_STYLE}>
          {logs.map((l) => (
            <div key={l.id} className="px-4 py-3 border-b last:border-b-0" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{l.action}</span>
                  {l.target_user && <span className="text-xs text-muted-foreground">→ {l.target_user}</span>}
                </div>
                <div className="text-xs text-muted-foreground">{l.actor ?? 'admin'} · {fmt(l.created_at)}</div>
              </div>
              {(l.before || l.after) && (
                <div className="mt-1.5 grid md:grid-cols-2 gap-2 text-[11px] font-mono">
                  {l.before && Object.keys(l.before).length > 0 && (
                    <div className="text-rose-300/80 break-words">before: {JSON.stringify(l.before)}</div>
                  )}
                  {l.after && Object.keys(l.after).length > 0 && (
                    <div className="text-emerald-300/80 break-words">after: {JSON.stringify(l.after)}</div>
                  )}
                </div>
              )}
              {l.reason && <div className="mt-1 text-xs text-amber-300/80">reason: {l.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlaggedTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'reviewed'>('open');
  const { data, isLoading } = useQuery({
    queryKey: ['flagged', status],
    queryFn: () => api.flags.list(status),
    refetchInterval: 30_000,
  });
  const resolve = useMutation({
    mutationFn: (id: number) => api.flags.resolve(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flagged'] }),
  });
  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  const flags: FlaggedResponse[] = data?.flags ?? [];
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(['open', 'reviewed'] as const).map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`text-sm px-3 py-1.5 rounded-lg border ${status === s ? 'text-primary bg-primary/15' : 'text-muted-foreground'}`}
            style={CARD_STYLE}>{s}</button>
        ))}
      </div>
      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">No {status} flags.</p>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={CARD_STYLE}>
          {flags.map((f) => (
            <div key={f.id} className="px-4 py-3 border-b last:border-b-0 flex items-start justify-between gap-3" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{f.reason}</span>
                  <span className="text-xs text-muted-foreground">{f.user_id}</span>
                  <StatusPill status={f.status} />
                </div>
                {f.note && <div className="text-xs text-muted-foreground mt-1">{f.note}</div>}
                <div className="text-[11px] text-muted-foreground mt-1">
                  by {f.created_by} · {fmt(f.created_at)}{f.message_id ? ` · msg ${f.message_id.slice(0, 8)}` : ''}
                </div>
              </div>
              {f.status === 'open' && (
                <button onClick={() => resolve.mutate(f.id)} disabled={resolve.isPending}
                  className="text-xs px-2.5 py-1.5 rounded-lg text-emerald-400 bg-emerald-400/10 flex items-center gap-1 flex-shrink-0">
                  <Check className="h-3 w-3" /> Resolve
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StripeTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['stripe-events', status],
    queryFn: () => api.stripe.events({ ...(status ? { status } : {}), limit: 200 }),
    refetchInterval: 30_000,
  });
  const retry = useMutation({
    mutationFn: (id: number) => api.stripe.retryEvent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stripe-events'] }),
  });
  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  const events: StripeEvent[] = data?.events ?? [];
  return (
    <div className="space-y-3">
      <select value={status} onChange={(e) => setStatus(e.target.value)}
        className="text-sm rounded-lg px-3 py-1.5 border bg-transparent text-foreground" style={CARD_STYLE}>
        <option value="">All statuses</option>
        <option value="processed">Processed</option>
        <option value="failed">Failed</option>
        <option value="skipped">Skipped</option>
      </select>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No Stripe events recorded. Point your Stripe webhook at <code>/webhook/stripe</code> and set STRIPE_WEBHOOK_SECRET.
        </p>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={CARD_STYLE}>
          {events.map((e) => (
            <div key={e.id} className="px-4 py-3 border-b last:border-b-0 flex items-start justify-between gap-3" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{e.type}</span>
                  <StatusPill status={e.status} />
                  {e.target_user && <span className="text-xs text-muted-foreground">{e.target_user}</span>}
                  {e.attempts > 1 && <span className="text-[11px] text-muted-foreground">×{e.attempts}</span>}
                </div>
                {e.error && <div className="text-xs text-rose-300/80 mt-1 break-words">{e.error}</div>}
                <div className="text-[11px] text-muted-foreground mt-1">{e.stripe_event_id} · {fmt(e.created_at)}</div>
              </div>
              {e.status === 'failed' && (
                <button onClick={() => retry.mutate(e.id)} disabled={retry.isPending}
                  className="text-xs px-2.5 py-1.5 rounded-lg text-amber-400 bg-amber-400/10 flex items-center gap-1 flex-shrink-0">
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const [tab, setTab] = useState<Tab>('audit');
  const tabs: { id: Tab; label: string; icon: typeof ScrollText }[] = [
    { id: 'audit', label: 'Audit Log', icon: ScrollText },
    { id: 'flagged', label: 'Flagged', icon: Flag },
    { id: 'stripe', label: 'Stripe Events', icon: CreditCard },
  ];
  return (
    <PageShell>
      <div className="flex gap-2 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground'
            }`}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
      {tab === 'audit' && <AuditTab />}
      {tab === 'flagged' && <FlaggedTab />}
      {tab === 'stripe' && <StripeTab />}
    </PageShell>
  );
}
