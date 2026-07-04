import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AdminUser, type CohortUserRow } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { Input } from '../../components/ui/input';
import UserDrawer from '../../components/admin/UserDrawer';
import CreateUserModal from '../../components/admin/CreateUserModal';
import { UserPlus, Search, Users } from 'lucide-react';
import { motion } from 'framer-motion';

const PAGE_SIZE = 50;

type BadgeStyle = { bg: string; text: string; label: string };

function statusStyle(user: AdminUser): BadgeStyle {
  if (user.blocked) return { bg: 'rgba(239,68,68,0.12)', text: 'rgb(252,165,165)', label: 'Blocked' };
  if (user.paused) return { bg: 'rgba(148,163,184,0.1)', text: 'rgb(148,163,184)', label: 'Paused' };
  if (!user.active) return { bg: 'rgba(100,116,139,0.1)', text: 'rgb(100,116,139)', label: 'Inactive' };
  if (user.is_pro) return { bg: 'rgba(139,92,246,0.12)', text: 'rgb(196,181,253)', label: 'Pro' };
  if (user.is_paid) return { bg: 'rgba(99,102,241,0.12)', text: 'rgb(165,180,252)', label: 'Paid' };
  return { bg: 'rgba(52,211,153,0.12)', text: 'rgb(110,231,183)', label: 'Active' };
}

function AlphaBadge({ style }: { style: BadgeStyle }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold"
      style={{ background: style.bg, color: style.text }}
    >
      {style.label}
    </span>
  );
}

function GoalBadge({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium"
      style={{ background: 'rgba(99,102,241,0.1)', color: 'rgb(165,180,252)' }}
    >
      {label}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

const stagger = { show: { transition: { staggerChildren: 0.03 } } };
const row = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] } },
};

/** Map a cohort user row into the AdminUser shape the table renders. Fields the
 *  cohort query doesn't return (goals, injection_count, rlhf) render as empty. */
function cohortRowToAdminUser(r: CohortUserRow): AdminUser {
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

export default function UsersPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [cohort, setCohort] = useState(''); // '' = all users (default list)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Cohort catalogue for the filter dropdown.
  const { data: cohortsData } = useQuery({ queryKey: ['cohorts-catalog'], queryFn: () => api.cohorts() });

  // Default (unfiltered) list — unchanged behaviour, only enabled when no cohort filter.
  const { data, isLoading: listLoading } = useQuery({
    queryKey: ['admin-users', page],
    queryFn: () => api.users(PAGE_SIZE, page * PAGE_SIZE),
    placeholderData: (prev) => prev,
    enabled: cohort === '',
  });

  // Cohort-filtered list — only fetched when a cohort is selected.
  const { data: cohortData, isLoading: cohortLoading } = useQuery({
    queryKey: ['admin-users-cohort', cohort, search],
    queryFn: () => api.cohortUsers(cohort, { limit: 500, search: search || undefined }),
    enabled: cohort !== '',
  });

  const isLoading = cohort === '' ? listLoading : cohortLoading;

  const sourceUsers: AdminUser[] = cohort === ''
    ? (data?.users ?? [])
    : (cohortData?.users ?? []).map(cohortRowToAdminUser);

  const filtered = sourceUsers.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.phone.includes(q) ||
      (u.first_name ?? '').toLowerCase().includes(q) ||
      (u.medication ?? '').toLowerCase().includes(q)
    );
  });

  const totalCount = cohort === '' ? (data?.total ?? 0) : (cohortData?.total ?? 0);
  const totalPages = cohort === '' ? Math.ceil((data?.total ?? 0) / PAGE_SIZE) : 1;

  return (
    <>
      <div className="p-4 md:p-6 space-y-4 md:space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
              Users
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {cohort === ''
                ? (data?.total !== undefined ? `${data.total} total` : '—')
                : `${totalCount} in cohort`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={cohort}
              onChange={(e) => { setCohort(e.target.value); setPage(0); }}
              className="h-9 rounded-lg bg-secondary/50 border border-border text-sm px-2 text-foreground max-w-[190px]"
              title="Filter by cohort"
            >
              <option value="">All users</option>
              {(cohortsData?.cohorts ?? [])
                .filter((c) => c.key !== 'all_users')
                .map((c) => (
                  <option key={c.key} value={c.key}>{c.label} ({c.count})</option>
                ))}
            </select>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="w-64 pl-9 h-9 text-sm bg-secondary/50 border-border"
                placeholder="Search phone, name, medication…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold transition-all duration-200 hover:brightness-110 active:scale-[0.97] min-h-[36px] shadow-lg shadow-primary/20"
              style={{ letterSpacing: '-0.01em' }}
            >
              <UserPlus className="h-3.5 w-3.5" />
              Add user
            </button>
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <UserTableSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyUsers search={search} onAdd={() => setCreateOpen(true)} />
        ) : (
          <div
            className="rounded-xl overflow-hidden border"
            style={{ borderColor: 'rgba(255,255,255,0.07)' }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left"
                  style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}
                >
                  {['User', 'Medication', 'Goals', 'Injection day', 'Last reply', 'Joined', 'Status', 'RLHF'].map((h) => (
                    <th key={h} className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <motion.tbody variants={stagger} initial="hidden" animate="show">
                {filtered.map((user) => (
                  <motion.tr
                    key={user.phone}
                    variants={row}
                    className="cursor-pointer transition-colors duration-150"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onClick={() => setSelectedUser(user)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{user.first_name ?? 'Unknown'}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">{user.phone}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-[13px]">{user.medication ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(user.goals ?? []).slice(0, 2).map((g) => (
                          <GoalBadge key={g} label={g} />
                        ))}
                        {(user.goals ?? []).length > 2 && (
                          <GoalBadge label={`+${user.goals.length - 2}`} />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-[13px]">
                      {user.injection_day ?? '—'}
                      {user.injection_count > 0 && (
                        <span className="text-xs ml-1 opacity-60">(#{user.injection_count})</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-[13px] tabular-nums">
                      {formatDate(user.last_reply_at)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-[13px] tabular-nums">
                      {formatDate(user.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <AlphaBadge style={statusStyle(user)} />
                    </td>
                    <td className="px-4 py-3">
                      {user.rlhf_enabled && (
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold"
                          style={{ background: 'rgba(251,191,36,0.12)', color: 'rgb(253,224,71)' }}
                        >
                          RLHF
                        </span>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="text-xs"
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="text-xs"
            >
              Next
            </Button>
          </div>
        )}
      </div>

      <UserDrawer
        user={selectedUser}
        onClose={() => {
          setSelectedUser(null);
          void qc.invalidateQueries({ queryKey: ['admin-users'] });
        }}
      />

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function UserTableSkeleton() {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.03)' }}>
        <Skeleton className="h-4 w-full" />
      </div>
      {[...Array(8)].map((_, i) => (
        <div key={i} className="px-4 py-3 flex items-center gap-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
          <div className="flex-1">
            <Skeleton className="h-4 w-28 mb-1.5" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-16 rounded-md" />
          <Skeleton className="h-4 w-12 ml-auto" />
        </div>
      ))}
    </div>
  );
}

function EmptyUsers({ search, onAdd }: { search: string; onAdd: () => void }) {
  return (
    <div className="rounded-xl border py-16 flex flex-col items-center gap-4" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Users className="h-6 w-6 text-primary" />
      </div>
      <div className="text-center">
        <p className="font-semibold text-foreground mb-1">
          {search ? 'No users match your search' : 'No users yet'}
        </p>
        <p className="text-sm text-muted-foreground">
          {search ? 'Try a different search term.' : 'Add your first user to get started.'}
        </p>
      </div>
      {!search && (
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold transition-all duration-200 hover:brightness-110 active:scale-[0.97] shadow-lg shadow-primary/20"
        >
          <UserPlus className="h-4 w-4" />
          Add first user
        </button>
      )}
    </div>
  );
}
