import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type FeedbackEntry } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

const SIGNAL_COLORS: Record<string, string> = {
  rating: 'bg-blue-100 text-blue-700',
  comment: 'bg-purple-100 text-purple-700',
  requery: 'bg-amber-100 text-amber-700',
  dropoff: 'bg-red-100 text-red-700',
  correction: 'bg-green-100 text-green-700',
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

  if (isLoading) return <PageShell><p className="text-muted-foreground">Loading…</p></PageShell>;

  const entries = data?.feedback ?? [];

  // Build signal type summary for chart
  const signalCounts: Record<string, number> = {};
  for (const e of entries) {
    signalCounts[e.signal_type] = (signalCounts[e.signal_type] ?? 0) + 1;
  }
  const chartData = Object.entries(signalCounts).map(([name, count]) => ({ name, count }));

  // Rating average
  const ratingEntries = entries.filter((e) => e.signal_type === 'rating' && e.rating !== null);
  const avgRating =
    ratingEntries.length > 0
      ? ratingEntries.reduce((s, e) => s + (e.rating ?? 0), 0) / ratingEntries.length
      : null;

  return (
    <PageShell>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total signals</p>
            <p className="text-3xl font-semibold">{entries.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Avg rating</p>
            <p className="text-3xl font-semibold">
              {avgRating !== null ? avgRating.toFixed(2) : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Rating entries</p>
            <p className="text-3xl font-semibold">{ratingEntries.length}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Signal breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No feedback yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 0, right: 8, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#c97b5c" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent feedback</CardTitle>
          </CardHeader>
          <ScrollArea className="flex-1 max-h-64">
            <CardContent className="space-y-2">
              {entries.slice(0, 50).map((e) => (
                <FeedbackRow
                  key={e.id}
                  entry={e}
                  onRate={(rating) =>
                    rateMutation.mutate({ userId: e.user_id, messageId: e.message_id ?? e.id, rating })
                  }
                />
              ))}
              {entries.length === 0 && (
                <p className="text-sm text-muted-foreground">No feedback yet.</p>
              )}
            </CardContent>
          </ScrollArea>
        </Card>
      </div>
    </PageShell>
  );
}

function FeedbackRow({ entry, onRate }: { entry: FeedbackEntry; onRate: (r: number) => void }) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-lg bg-muted/40 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Badge className={SIGNAL_COLORS[entry.signal_type] ?? ''} variant="outline">
            {entry.signal_type}
          </Badge>
          {entry.rating !== null && (
            <span className={entry.rating >= 0 ? 'text-green-600' : 'text-red-500'}>
              {entry.rating > 0 ? '+1' : entry.rating < 0 ? '-1' : '0'}
            </span>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
          </span>
        </div>
        {entry.comment && <p className="text-xs text-muted-foreground truncate">{entry.comment}</p>}
      </div>
      <div className="flex gap-1 flex-shrink-0">
        <button
          onClick={() => onRate(1)}
          className="p-1 rounded hover:bg-green-100 text-muted-foreground hover:text-green-600 transition-colors"
          title="Thumbs up"
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onRate(-1)}
          className="p-1 rounded hover:bg-red-100 text-muted-foreground hover:text-red-500 transition-colors"
          title="Thumbs down"
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6">
      <h1 className="font-serif text-2xl mb-6">RLHF Feedback</h1>
      {children}
    </div>
  );
}
