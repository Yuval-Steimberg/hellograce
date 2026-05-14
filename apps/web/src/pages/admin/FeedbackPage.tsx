import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type FeedbackEntry } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ThumbsUp, ThumbsDown, MessageCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
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

export default function FeedbackPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['feedback'],
    queryFn: api.feedback.list,
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

  const signalCounts: Record<string, number> = {};
  for (const e of entries) {
    signalCounts[e.signal_type] = (signalCounts[e.signal_type] ?? 0) + 1;
  }
  const chartData = Object.entries(signalCounts).map(([name, count]) => ({ name, count }));

  const ratingEntries = entries.filter((e) => e.signal_type === 'rating' && e.rating !== null);
  const avgRating =
    ratingEntries.length > 0
      ? ratingEntries.reduce((s, e) => s + (e.rating ?? 0), 0) / ratingEntries.length
      : null;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>
          RLHF Feedback
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Reinforcement learning signals from users</p>
      </div>

      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        {[
          { label: 'Total signals', value: entries.length },
          { label: 'Avg rating', value: avgRating !== null ? avgRating.toFixed(2) : '—' },
          { label: 'Rating entries', value: ratingEntries.length },
        ].map(({ label, value }) => (
          <motion.div
            key={label}
            variants={fadeUp}
            className="rounded-xl p-5 border"
            style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
            <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>
              {value}
            </p>
          </motion.div>
        ))}
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Chart */}
        <div className="rounded-xl p-5 border" style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}>
          <p className="text-sm font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>
            Signal breakdown
          </p>
          {chartData.length === 0 ? (
            <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">
              No feedback yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(215 16% 50%)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Recent feedback */}
        <div className="rounded-xl border overflow-hidden" style={{ background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-sm font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>
              Recent feedback
            </p>
          </div>
          <ScrollArea className="max-h-[280px]">
            <div className="p-4 space-y-2">
              {entries.length === 0 && (
                <div className="py-8 text-center">
                  <MessageCircle className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No feedback yet.</p>
                </div>
              )}
              {entries.slice(0, 50).map((e) => (
                <FeedbackRow
                  key={e.id}
                  entry={e}
                  onRate={(rating) =>
                    rateMutation.mutate({ userId: e.user_id, messageId: e.message_id ?? e.id, rating })
                  }
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function FeedbackRow({ entry, onRate }: { entry: FeedbackEntry; onRate: (r: number) => void }) {
  const badge = SIGNAL_BADGE[entry.signal_type] ?? SIGNAL_BADGE['comment'];
  return (
    <div
      className="flex items-start gap-2.5 p-3 rounded-xl text-sm transition-colors duration-150"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold"
            style={{ background: badge.bg, color: badge.text }}
          >
            {entry.signal_type}
          </span>
          {entry.rating !== null && (
            <span className={`text-xs font-semibold ${entry.rating >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {entry.rating > 0 ? '+1' : entry.rating < 0 ? '−1' : '0'}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">
            {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
          </span>
        </div>
        {entry.comment && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.comment}</p>
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
  );
}

function FeedbackSkeleton() {
  return (
    <div className="p-6">
      <Skeleton className="h-7 w-40 mb-1" />
      <Skeleton className="h-4 w-64 mb-6" />
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-xl border p-5" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
