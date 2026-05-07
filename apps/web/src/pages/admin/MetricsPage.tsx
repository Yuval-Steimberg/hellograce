import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { MessageSquare, Zap, ThumbsUp, Gauge } from 'lucide-react';

const COLORS = ['#c97b5c', '#b8956a', '#9baf82', '#6e8fa0', '#8a6ea6'];

export default function MetricsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['metrics'],
    queryFn: api.metrics,
    refetchInterval: 30_000,
  });

  if (isLoading) return <PageShell><p className="text-muted-foreground">Loading…</p></PageShell>;
  if (error || !data) return <PageShell><p className="text-destructive">Failed to load metrics.</p></PageShell>;

  const toolChartData = data.tools.map((t) => ({
    name: t.tool_name.replace('_', ' '),
    calls: Number(t.count),
    okRate: Math.round(Number(t.ok_rate) * 100),
    p95: Math.round(t.p95_ms),
  }));

  const feedbackData = data.feedback_last_7d.map((f) => ({
    name: f.signal_type,
    value: Number(f.count),
  }));

  const cacheHitPct = data.cache ? Math.round(data.cache.hitRate * 100) : null;

  return (
    <PageShell>
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard icon={<MessageSquare className="h-4 w-4" />} label="Messages (24h)" value={data.messages_last_24h} />
        <KpiCard icon={<Zap className="h-4 w-4" />} label="Tool calls (24h)" value={data.tools.reduce((s, t) => s + Number(t.count), 0)} />
        <KpiCard icon={<ThumbsUp className="h-4 w-4" />} label="Feedback signals (7d)" value={data.feedback_last_7d.reduce((s, f) => s + Number(f.count), 0)} />
        <KpiCard icon={<Gauge className="h-4 w-4" />} label="Cache hit rate" value={cacheHitPct !== null ? `${cacheHitPct}%` : '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Tool calls bar chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Tool usage (24h)</CardTitle>
          </CardHeader>
          <CardContent>
            {toolChartData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tool calls yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={toolChartData} margin={{ top: 0, right: 8, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    formatter={(val: number, name: string) =>
                      name === 'okRate' ? [`${val}%`, 'ok rate'] : [val, name]
                    }
                  />
                  <Bar dataKey="calls" fill="#c97b5c" radius={[4, 4, 0, 0]} name="calls" />
                  <Bar dataKey="okRate" fill="#9baf82" radius={[4, 4, 0, 0]} name="okRate" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Feedback pie chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Feedback signals (7d)</CardTitle>
          </CardHeader>
          <CardContent>
            {feedbackData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No feedback yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={feedbackData} cx="50%" cy="50%" outerRadius={80} dataKey="value" nameKey="name" label={({ name, percent }: { name: string; percent: number }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false}>
                    {feedbackData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Legend iconSize={10} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Tool p95 latency */}
        {toolChartData.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Tool p95 latency (ms)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={toolChartData} margin={{ top: 0, right: 8, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number) => [`${v}ms`]} />
                  <Bar dataKey="p95" fill="#6e8fa0" radius={[4, 4, 0, 0]} name="p95 ms" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Cache stats */}
        {data.cache && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Cache stats (since last restart)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatRow label="Hits" value={data.cache.hits} />
              <StatRow label="Misses" value={data.cache.misses} />
              <StatRow label="Hit rate" value={`${Math.round(data.cache.hitRate * 100)}%`} />
            </CardContent>
          </Card>
        )}
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6">
      <h1 className="font-serif text-2xl mb-6">Metrics</h1>
      {children}
    </div>
  );
}

function KpiCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          {icon}
          <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        </div>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
