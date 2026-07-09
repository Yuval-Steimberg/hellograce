import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { RefreshCw, Timer, Layers, AlertTriangle } from 'lucide-react';

const CARD = { background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' } as const;
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] as const } },
};

const WINDOWS = ['15m', '1h', '6h', '24h', '7d', '30d'];

/** Colour a latency number: green under 2s, amber 2–5s, red over 5s. */
function ms(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s` : `${n}ms`;
}
function tone(v: string | number | null | undefined): string {
  const n = v == null ? 0 : typeof v === 'string' ? parseInt(v, 10) : v;
  if (n >= 5000) return 'text-red-400';
  if (n >= 2000) return 'text-amber-400';
  return 'text-emerald-400';
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border p-4" style={CARD}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${tone(sub === 'raw' ? undefined : value.replace(/[^\d]/g, ''))}`}>{value}</div>
    </div>
  );
}

export default function LatencyPage() {
  const [win, setWin] = useState('24h');
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['latency', win],
    queryFn: () => api.latency(win),
    refetchInterval: 30000,
  });

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Latency</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Response time (P50 / P95 / P99) by intent and per-stage — from real traffic.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWin(w)}
                className={`px-3 py-1.5 text-xs ${win === w ? 'bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {w}
              </button>
            ))}
          </div>
          <button onClick={() => refetch()} className="p-2 rounded-lg border text-muted-foreground hover:text-foreground" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      ) : !data?.overall || data.overall.n === '0' ? (
        <div className="rounded-xl border p-8 text-center text-muted-foreground" style={CARD}>
          No latency data in this window yet. Send a few messages, then refresh.
        </div>
      ) : (
        <motion.div variants={{ show: { transition: { staggerChildren: 0.04 } } }} initial="hidden" animate="show" className="space-y-5">
          {/* Overall percentiles */}
          <motion.div variants={fadeUp} className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="P50 (median)" value={ms(data.overall.p50)} />
            <Stat label="P95" value={ms(data.overall.p95)} />
            <Stat label="P99" value={ms(data.overall.p99)} />
            <Stat label={`Samples (${data.window})`} value={data.overall.n} sub="raw" />
          </motion.div>

          {/* By intent */}
          <motion.div variants={fadeUp} className="rounded-xl border overflow-hidden" style={CARD}>
            <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <Timer className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm">By intent (slowest first)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground text-left">
                    <th className="px-4 py-2 font-normal">Intent</th>
                    <th className="px-4 py-2 font-normal text-right">n</th>
                    <th className="px-4 py-2 font-normal text-right">P50</th>
                    <th className="px-4 py-2 font-normal text-right">P95</th>
                    <th className="px-4 py-2 font-normal text-right">P99</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.by_intent].sort((a, b) => parseInt(b.p95, 10) - parseInt(a.p95, 10)).map((r) => (
                    <tr key={r.intent} className="border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                      <td className="px-4 py-2 font-mono text-xs">{r.intent}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground">{r.n}</td>
                      <td className="px-4 py-2 text-right">{ms(r.p50)}</td>
                      <td className={`px-4 py-2 text-right font-medium ${tone(r.p95)}`}>{ms(r.p95)}</td>
                      <td className={`px-4 py-2 text-right ${tone(r.p99)}`}>{ms(r.p99)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>

          {/* By stage — WHERE the time goes */}
          {data.by_stage.length > 0 && (
            <motion.div variants={fadeUp} className="rounded-xl border overflow-hidden" style={CARD}>
              <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <Layers className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-sm">Per-stage (where the time goes, avg)</span>
              </div>
              <div className="p-4 space-y-2">
                {(() => {
                  const max = Math.max(...data.by_stage.map((s) => parseInt(s.avg_ms, 10) || 0), 1);
                  return data.by_stage.map((s) => (
                    <div key={s.stage} className="flex items-center gap-3">
                      <div className="w-40 shrink-0 font-mono text-xs text-muted-foreground truncate">{s.stage}</div>
                      <div className="flex-1 h-4 rounded bg-white/5 overflow-hidden">
                        <div className="h-full rounded bg-indigo-500/60" style={{ width: `${((parseInt(s.avg_ms, 10) || 0) / max) * 100}%` }} />
                      </div>
                      <div className="w-16 shrink-0 text-right text-xs">{ms(s.avg_ms)}</div>
                    </div>
                  ));
                })()}
              </div>
            </motion.div>
          )}

          {/* Slowest requests */}
          {data.slow_samples.length > 0 && (
            <motion.div variants={fadeUp} className="rounded-xl border overflow-hidden" style={CARD}>
              <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                <span className="font-medium text-sm">Slowest requests</span>
              </div>
              <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                {data.slow_samples.map((s, i) => (
                  <div key={i} className="px-4 py-2 flex items-center gap-3">
                    <span className={`text-sm font-medium w-16 shrink-0 ${tone(s.latency_ms)}`}>{ms(s.latency_ms)}</span>
                    <span className="text-xs font-mono text-muted-foreground w-32 shrink-0 truncate">{s.intent}</span>
                    <span className="text-xs text-muted-foreground truncate flex-1">{s.content}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </motion.div>
      )}
    </div>
  );
}
