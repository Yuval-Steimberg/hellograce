import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type FeedbackEntry, type FeedbackFilters } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { ThumbsUp, ThumbsDown, MessageCircle, ChevronDown, ChevronUp, Filter } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

const SIGNAL_BADGE: Record<string, { bg: string; text: string }> = {
  rating:     { bg: 'rgba(99,102,241,0.12)',  text: 'rgb(165,180,252)' },
  comment:    { bg: 'rgba(139,92,246,0.12)',  text: 'rgb(196,181,253)' },
  requery:    { bg: 'rgba(251,191,36,0.12)',  text: 'rgb(253,224,71)' },
  dropoff:    { bg: 'rgba(239,68,68,0.12)',   text: 'rgb(252,165,165)' },
  correction: { bg: 'rgba(52,211,153,0.12)',  text: 'rgb(110,231,183)' },
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

const DATE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d',    label: 'Last 7 days' },
  { value: '30d',   label: 'Last 30 days' },
  { value: 'all',   label: 'All time' },
] as const;

const RATING_OPTIONS = [
  { value: '',   label: 'All ratings' },
  { value: '1',  label: '👍 Positive' },
  { value: '-1', label: '👎 Negative' },
] as const;

const TYPE_OPTIONS = [
  { value: '',        label: 'All types' },
  { value: 'rating',  label: 'Rating' },
  { value: 'comment', label: 'Comment' },
] as const;

export default function FeedbackPage() {
  const qc = useQueryClient();

  const [filters, setFilters] = useState<FeedbackFilters>({ date: 'all' });
  const [userInput, setUserInput] = useState('');

  // Apply user filter with debounce-style: only filter when user clears or after commit
  const activeFilters: FeedbackFilters = {
    ...filters,
    userId: userInput.trim() || undefined,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['feedback', activeFilters],
    queryFn: () => api.feedback.list(activeFilters),
    refetchInterval: 30_000,
  });

  const rateMutation = useMutation({
    mutationFn: ({ userId, messageId, rating }: { userId: string; messageId: string; rating: number }) =>
      api.feedback.post({ userId, messageId, signalType: 'rating', rating }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['feedback'] });
      toast.success('Rating saved');
    },
  });

  if (isLoading) return <FeedbackSkeleton />;

  const entries = data?.feedback ?? [];

  // Stats over the filtered set
  const ratingEntries = entries.filter((e) => e.signal_type === 'rating' && e.rating !== null);
  const positiveCount = ratingEntries.filter((e) => (e.rating ?? 0) > 0).length;
  const negativeCount = ratingEntries.filter((e) => (e.rating ?? 0) < 0).length;
  const satisfactionPct = ratingEntries.length > 0
    ? Math.round((positiveCount / ratingEntries.length) * 100)
    : null;

  const signalCounts: Record<string, number> = {};
  for (const e of entries) signalCounts[e.signal_type] = (signalCounts[e.signal_type] ?? 0) + 1;
  const chartData = Object.entries(signalCounts).map(([name, count]) => ({ name, count }));

  // Group by day for the "by day" column
  const byDay: Record<string, FeedbackEntry[]> = {};
  for (const e of entries) {
    const day = format(new Date(e.created_at), 'yyyy-MM-dd');
    (byDay[day] ??= []).push(e);
  }
  const dayKeys = Object.keys(byDay).sort((a, b) => b.localeCompare(a));

  // Unique users for the user list
  const byUser: Record<string, FeedbackEntry[]> = {};
  for (const e of entries) (byUser[e.user_id] ??= []).push(e);
  const userKeys = Object.keys(byUser).sort((a, b) =>
    (byUser[b]?.length ?? 0) - (byUser[a]?.length ?? 0),
  );

  const [view, setView] = useState<'all' | 'by-user' | 'by-day'>('all');

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
            RLHF Feedback
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Reinforcement learning signals from users</p>
        </div>
        <span className="text-xs text-muted-foreground self-end">
          {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
        </span>
      </div>

      {/* ── Filters ── */}
      <div
        className="rounded-xl p-4 mb-5 flex flex-wrap gap-3 items-end"
        style={{ background: 'hsl(217 33% 11%)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <Filter className="h-4 w-4 text-muted-foreground self-center flex-shrink-0" />

        {/* User search */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">User (phone)</label>
          <input
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            placeholder="+1555…"
            className="text-xs rounded-lg px-2.5 py-1.5 w-36 outline-none"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'hsl(214 32% 91%)',
            }}
          />
        </div>

        {/* Date range */}
        <FilterSelect
          label="Date"
          options={DATE_OPTIONS}
          value={filters.date ?? 'all'}
          onChange={(v) => setFilters((f) => ({ ...f, date: v as FeedbackFilters['date'] }))}
        />

        {/* Signal type */}
        <FilterSelect
          label="Type"
          options={TYPE_OPTIONS}
          value={filters.signalType ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, signalType: v || undefined }))}
        />

        {/* Rating */}
        <FilterSelect
          label="Rating"
          options={RATING_OPTIONS}
          value={filters.rating ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, rating: (v || undefined) as FeedbackFilters['rating'] }))}
        />

        {/* Reset */}
        {(userInput || filters.date !== 'all' || filters.signalType || filters.rating) && (
          <button
            onClick={() => { setFilters({ date: 'all' }); setUserInput(''); }}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors self-end pb-1.5"
          >
            Reset
          </button>
        )}
      </div>

      {/* ── Stats ── */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Total signals',  value: entries.length },
          { label: '👍 Positive',    value: positiveCount },
          { label: '👎 Negative',    value: negativeCount },
          { label: 'Satisfaction',   value: satisfactionPct !== null ? `${satisfactionPct}%` : '—' },
        ].map(({ label, value }) => (
          <motion.div
            key={label}
            variants={fadeUp}
            className="rounded-xl p-4 border"
            style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</p>
            <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>
              {value}
            </p>
          </motion.div>
        ))}
      </motion.div>

      {/* ── Chart ── */}
      {chartData.length > 0 && (
        <div
          className="rounded-xl p-5 border mb-5"
          style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}
        >
          <p className="text-sm font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>
            Signal breakdown
          </p>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── View toggle ── */}
      <div className="flex gap-2 mb-4">
        {(['all', 'by-user', 'by-day'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-150"
            style={view === v
              ? { background: 'rgba(99,102,241,0.2)', color: 'rgb(165,180,252)', border: '1px solid rgba(99,102,241,0.3)' }
              : { background: 'rgba(255,255,255,0.04)', color: 'hsl(215 16% 50%)', border: '1px solid rgba(255,255,255,0.07)' }
            }
          >
            {v === 'all' ? 'All entries' : v === 'by-user' ? `By user (${userKeys.length})` : `By day (${dayKeys.length})`}
          </button>
        ))}
      </div>

      {/* ── Entries ── */}
      {entries.length === 0 ? (
        <div
          className="rounded-xl border py-16 text-center"
          style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}
        >
          <MessageCircle className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No feedback matching filters.</p>
        </div>
      ) : view === 'all' ? (
        <FeedbackList
          entries={entries}
          onRate={(e, r) => rateMutation.mutate({ userId: e.user_id, messageId: e.message_id ?? e.id, rating: r })}
        />
      ) : view === 'by-user' ? (
        <div className="space-y-3">
          {userKeys.map((uid) => (
            <UserGroup
              key={uid}
              userId={uid}
              entries={byUser[uid] ?? []}
              onRate={(e, r) => rateMutation.mutate({ userId: e.user_id, messageId: e.message_id ?? e.id, rating: r })}
              onFilterUser={() => setUserInput(uid)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {dayKeys.map((day) => (
            <DayGroup
              key={day}
              day={day}
              entries={byDay[day] ?? []}
              onRate={(e, r) => rateMutation.mutate({ userId: e.user_id, messageId: e.message_id ?? e.id, rating: r })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Filter select ────────────────────────────────────────────────────────────

function FilterSelect({
  label, options, value, onChange,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs rounded-lg px-2.5 py-1.5 outline-none cursor-pointer"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: 'hsl(214 32% 91%)',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ background: 'hsl(217 33% 13%)' }}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── All entries flat list ────────────────────────────────────────────────────

function FeedbackList({
  entries, onRate,
}: {
  entries: FeedbackEntry[];
  onRate: (e: FeedbackEntry, r: number) => void;
}) {
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const paged = entries.slice(0, (page + 1) * PAGE);

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}
    >
      <div className="p-4 space-y-2">
        {paged.map((e) => (
          <FeedbackRow key={e.id} entry={e} onRate={(r) => onRate(e, r)} showUser />
        ))}
      </div>
      {entries.length > paged.length && (
        <div className="px-4 pb-4 text-center">
          <button
            onClick={() => setPage((p) => p + 1)}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Load more ({entries.length - paged.length} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Group by user ────────────────────────────────────────────────────────────

function UserGroup({
  userId, entries, onRate, onFilterUser,
}: {
  userId: string;
  entries: FeedbackEntry[];
  onRate: (e: FeedbackEntry, r: number) => void;
  onFilterUser: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pos = entries.filter((e) => (e.rating ?? 0) > 0).length;
  const neg = entries.filter((e) => (e.rating ?? 0) < 0).length;

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">{userId}</span>
          <span className="text-[11px] text-muted-foreground">{entries.length} signals</span>
          {pos > 0 && <span className="text-[11px] text-emerald-400">👍 {pos}</span>}
          {neg > 0 && <span className="text-[11px] text-red-400">👎 {neg}</span>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={(ev) => { ev.stopPropagation(); onFilterUser(); }}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 px-2 py-0.5 rounded-md transition-colors"
            style={{ background: 'rgba(99,102,241,0.1)' }}
          >
            Filter
          </button>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {entries.map((e) => (
            <FeedbackRow key={e.id} entry={e} onRate={(r) => onRate(e, r)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Group by day ─────────────────────────────────────────────────────────────

function DayGroup({
  day, entries, onRate,
}: {
  day: string;
  entries: FeedbackEntry[];
  onRate: (e: FeedbackEntry, r: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const pos = entries.filter((e) => (e.rating ?? 0) > 0).length;
  const neg = entries.filter((e) => (e.rating ?? 0) < 0).length;
  const label = format(new Date(day), 'EEE, MMM d yyyy');

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground">{entries.length} signals</span>
          {pos > 0 && <span className="text-[11px] text-emerald-400">👍 {pos}</span>}
          {neg > 0 && <span className="text-[11px] text-red-400">👎 {neg}</span>}
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {entries.map((e) => (
            <FeedbackRow key={e.id} entry={e} onRate={(r) => onRate(e, r)} showUser />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Single feedback row ──────────────────────────────────────────────────────

function FeedbackRow({
  entry, onRate, showUser,
}: {
  entry: FeedbackEntry;
  onRate: (r: number) => void;
  showUser?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = SIGNAL_BADGE[entry.signal_type] ?? SIGNAL_BADGE['comment'];
  const hasMessage = !!entry.assistant_message;

  return (
    <div
      className="rounded-xl text-sm"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="flex items-start gap-2.5 p-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold"
              style={{ background: badge.bg, color: badge.text }}
            >
              {entry.signal_type}
            </span>
            {entry.rating !== null && (
              <span className={`text-xs font-semibold ${(entry.rating ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {entry.rating > 0 ? '+1' : entry.rating < 0 ? '−1' : '0'}
              </span>
            )}
            {showUser && (
              <span className="text-[11px] text-muted-foreground font-mono">{entry.user_id}</span>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto">
              {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
            </span>
          </div>
          {entry.comment && (
            <p className="text-xs text-muted-foreground mt-1">{entry.comment}</p>
          )}
          {hasMessage && (
            <button
              onClick={() => setExpanded((x) => !x)}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 mt-1 flex items-center gap-0.5 transition-colors"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {expanded ? 'Hide response' : 'See Grace\'s response'}
            </button>
          )}
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={() => onRate(1)}
            className="p-1.5 rounded-lg transition-all duration-150 text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 active:scale-90"
            title="Thumbs up"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onRate(-1)}
            className="p-1.5 rounded-lg transition-all duration-150 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 active:scale-90"
            title="Thumbs down"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {expanded && entry.assistant_message && (
        <div
          className="px-3 pb-3"
          style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
        >
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-wrap">
            {entry.assistant_message}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function FeedbackSkeleton() {
  return (
    <div className="p-6">
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-64 mb-6" />
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border p-4" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
