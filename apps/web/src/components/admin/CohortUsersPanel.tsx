import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CohortUserRow, type AdminUser } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import UserDrawer from '@/components/admin/UserDrawer';

export interface CohortRef {
  key: string;
  label: string;
  description?: string;
  count?: number;
  pct?: number;
}

/** Map a cohort user row into the AdminUser shape UserDrawer expects (it re-fetches
 *  full detail from the phone; these are just header/badge seeds). */
function toAdminUser(r: CohortUserRow): AdminUser {
  return {
    phone: r.phone,
    first_name: r.first_name,
    medication: r.medication,
    goals: [],
    timezone: '',
    active: true,
    paused: r.paused,
    blocked: r.blocked,
    is_paid: r.is_paid,
    is_pro: r.is_pro,
    rlhf_enabled: false,
    injection_day: r.injection_day,
    injection_count: 0,
    last_morning_sent_at: null,
    last_reply_at: r.last_reply_at,
    created_at: r.created_at,
  };
}

function statusBadge(r: CohortUserRow) {
  if (r.blocked) return <Badge variant="destructive" className="text-[10px]">Blocked</Badge>;
  if (r.is_pro) return <Badge className="text-[10px] bg-indigo-500/20 text-indigo-300 border-indigo-500/30">Pro</Badge>;
  if (r.is_paid) return <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/30">Paid</Badge>;
  if (r.trial_start) return <Badge className="text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/30">Trial</Badge>;
  return <Badge variant="secondary" className="text-[10px]">Free</Badge>;
}

/** Right slide-over listing the members of one cohort, with search + drill-down
 *  into the full UserDrawer. Shared by CohortsPage and the funnel drill-down. */
export default function CohortUsersPanel({ cohort, onClose }: { cohort: CohortRef; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['cohort-users', cohort.key, search],
    queryFn: () => api.cohortUsers(cohort.key, { limit: 200, search: search || undefined }),
  });

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="admin-shell w-full sm:max-w-2xl overflow-y-auto" style={{ background: 'hsl(222 47% 6%)' }}>
        <SheetHeader>
          <SheetTitle className="text-foreground">{cohort.label}</SheetTitle>
          {cohort.description && <p className="text-xs text-muted-foreground">{cohort.description}</p>}
          <p className="text-sm text-foreground tabular-nums mt-1">
            {data?.total ?? cohort.count ?? 0} users{cohort.pct != null ? ` · ${cohort.pct}% of total` : ''}
          </p>
        </SheetHeader>

        <div className="mt-4">
          <Input
            placeholder="Search by phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-3"
          />
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
          ) : !data || data.users.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No users in this cohort.</p>
          ) : (
            <div className="space-y-1">
              {data.users.map((u) => (
                <button
                  key={u.phone}
                  onClick={() => setSelected(toAdminUser(u))}
                  className="w-full text-left rounded-lg px-3 py-2 border hover:bg-white/[0.03] transition-colors flex items-center justify-between gap-3"
                  style={{ borderColor: 'rgba(255,255,255,0.06)' }}
                >
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{u.first_name || u.phone}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{u.phone}{u.medication ? ` · ${u.medication}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-muted-foreground tabular-nums hidden sm:inline">{u.msgs_total} msg · {u.food_total} food</span>
                    {statusBadge(u)}
                    <span className="text-[10px] text-muted-foreground tabular-nums w-16 text-right">
                      {u.last_reply_at ? formatDistanceToNow(new Date(u.last_reply_at), { addSuffix: false }) : 'never'}
                    </span>
                  </div>
                </button>
              ))}
              {data.total > data.users.length && (
                <p className="text-[11px] text-muted-foreground pt-2 text-center">
                  Showing first {data.users.length} of {data.total}. Refine with search.
                </p>
              )}
            </div>
          )}
        </div>

        <UserDrawer user={selected} onClose={() => setSelected(null)} />
      </SheetContent>
    </Sheet>
  );
}
