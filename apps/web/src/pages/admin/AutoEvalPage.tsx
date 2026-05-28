import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  getToken,
  type AutoEvalReport,
  type AutoEvalConversationSummary,
  type AutoEvalConversationDetail,
  type AutoEvalTurnDetail,
  type AutoEvalPreferencePair,
  type AutoEvalProgressEvent,
} from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  BookOpen,
  Loader2,
  Save,
  ArrowRight,
  Play,
  Zap,
} from 'lucide-react';

// ─── Style constants ─────────────────────────────────────────────────────────

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

const stagger = { show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

// ─── Score helpers ───────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 3.5) return 'rgb(52,211,153)';   // emerald-400
  if (score >= 2.5) return 'rgb(251,191,36)';    // amber-400
  return 'rgb(251,113,133)';                      // rose-400
}

function scoreBg(score: number): string {
  if (score >= 3.5) return 'rgba(16,185,129,0.12)';
  if (score >= 2.5) return 'rgba(251,191,36,0.12)';
  return 'rgba(239,68,68,0.12)';
}

function ScoreBadge({ score, large }: { score: number; large?: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold tabular-nums ${large ? 'px-3 py-1 text-base' : 'px-2 py-0.5 text-[11px]'}`}
      style={{ background: scoreBg(score), color: scoreColor(score) }}
    >
      {score.toFixed(2)}
    </span>
  );
}

function ScorePill({ name, score }: { name: string; score: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
      style={{ background: scoreBg(score), color: scoreColor(score) }}
    >
      {name}: {score.toFixed(1)}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ background: 'rgba(99,102,241,0.12)', color: 'rgb(165,180,252)' }}
    >
      {category.replace(/_/g, ' ')}
    </span>
  );
}

// ─── Shell / skeleton ────────────────────────────────────────────────────────

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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </PageShell>
  );
}

// ─── Tab definition ──────────────────────────────────────────────────────────

type Tab = 'overview' | 'conversations' | 'pairs';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'pairs', label: 'Preference Pairs' },
];

// ─── Overview tab ────────────────────────────────────────────────────────────

function OverviewTab({ report }: { report: AutoEvalReport }) {
  const qc = useQueryClient();

  const learnMut = useMutation({
    mutationFn: () => api.autoEval.learn(),
    onSuccess: (d) => {
      toast.success(`Learned from ${d.evaluationsProcessed} evals. Generated ${d.preferencePairsGenerated} pairs, ${d.contentRulesGenerated} rules.`);
      void qc.invalidateQueries({ queryKey: ['auto-eval-reports'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const autoGenMut = useMutation({
    mutationFn: () => api.autoEval.autoGenRules(),
    onSuccess: (d) => {
      toast.success(d.message || `Generated ${d.rulesGenerated} rules, inserted ${d.rulesInserted}.`);
      void qc.invalidateQueries({ queryKey: ['content-rules'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const catEntries = useMemo(() =>
    Object.entries(report.scoreByCategory).sort((a, b) => a[1].avg - b[1].avg),
    [report.scoreByCategory],
  );

  const dimEntries = useMemo(() =>
    Object.entries(report.scoreByDimension).sort((a, b) => b[1].failRate - a[1].failRate),
    [report.scoreByDimension],
  );

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Summary KPIs */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Overall Score', value: report.overallScore.toFixed(2), color: scoreColor(report.overallScore), big: true },
          { label: 'Pass Rate', value: `${(report.passRate * 100).toFixed(1)}%`, color: scoreColor(report.passRate * 5) },
          { label: 'Conversations', value: String(report.totalConversations) },
          { label: 'Turns', value: String(report.totalTurns) },
          { label: 'Pref Pairs', value: String(report.preferencePairsGenerated) },
        ].map(({ label, value, color, big }) => (
          <motion.div key={label} variants={fadeUp}>
            <div className="rounded-xl p-5 border" style={CARD_STYLE}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
              <p
                className={`font-semibold tabular-nums ${big ? 'text-3xl' : 'text-2xl'} text-foreground`}
                style={{ letterSpacing: '-0.02em', ...(color ? { color } : {}) }}
              >
                {value}
              </p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Score by category (horizontal bars) */}
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl p-5 border" style={CARD_STYLE}>
        <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Score by Category</p>
        <div className="space-y-2.5">
          {catEntries.map(([cat, stats]) => (
            <div key={cat} className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-32 md:w-40 truncate flex-shrink-0">{cat.replace(/_/g, ' ')}</span>
              <div className="flex-1 h-5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, (stats.avg / 5) * 100)}%`,
                    background: scoreColor(stats.avg),
                    opacity: 0.7,
                  }}
                />
              </div>
              <ScoreBadge score={stats.avg} />
              <span className="text-[10px] text-muted-foreground tabular-nums w-14 text-right flex-shrink-0">
                {stats.count} conv
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums w-16 text-right flex-shrink-0">
                {(stats.passRate * 100).toFixed(0)}% pass
              </span>
            </div>
          ))}
          {catEntries.length === 0 && (
            <p className="text-sm text-muted-foreground">No category data available.</p>
          )}
        </div>
      </motion.div>

      {/* Score by dimension */}
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl border" style={CARD_STYLE}>
        <p className="text-[13px] font-semibold text-foreground px-5 pt-5 mb-3" style={{ letterSpacing: '-0.01em' }}>Score by Dimension</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Dimension', 'Avg Score', 'Fail Rate'].map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dimEntries.map(([dim, stats], idx) => (
                <tr
                  key={dim}
                  style={{
                    background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                  }}
                >
                  <td className="px-5 py-2.5 text-xs text-foreground">{dim.replace(/_/g, ' ')}</td>
                  <td className="px-5 py-2.5"><ScoreBadge score={stats.avg} /></td>
                  <td className="px-5 py-2.5">
                    <span
                      className="px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums"
                      style={{
                        background: stats.failRate > 0.3 ? 'rgba(239,68,68,0.12)' : stats.failRate > 0.1 ? 'rgba(251,191,36,0.12)' : 'rgba(16,185,129,0.12)',
                        color: stats.failRate > 0.3 ? 'rgb(252,165,165)' : stats.failRate > 0.1 ? 'rgb(253,224,71)' : 'rgb(110,231,183)',
                      }}
                    >
                      {(stats.failRate * 100).toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
              {dimEntries.length === 0 && (
                <tr><td colSpan={3} className="px-5 py-6 text-center text-muted-foreground text-sm">No dimension data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Top patterns */}
      {report.topPatterns.length > 0 && (
        <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Top Patterns</p>
          <div className="space-y-2">
            {report.topPatterns.map((p, i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-lg p-3 border"
                style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">{p.pattern}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums" style={{ background: 'rgba(99,102,241,0.12)', color: 'rgb(165,180,252)' }}>
                    {p.frequency}x
                  </span>
                  <CategoryBadge category={p.category} />
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    impact: {p.avgScoreImpact.toFixed(2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Regressions */}
      {report.regressions.length > 0 && (
        <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl p-5 border" style={{ ...CARD_STYLE, borderColor: 'rgba(239,68,68,0.2)' }}>
          <p className="text-[13px] font-semibold text-foreground mb-4 flex items-center gap-2" style={{ letterSpacing: '-0.01em' }}>
            <AlertTriangle className="h-4 w-4 text-rose-400" />
            Regressions
          </p>
          <div className="space-y-2">
            {report.regressions.map((r, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-lg p-3 border"
                style={{ background: 'rgba(239,68,68,0.04)', borderColor: 'rgba(239,68,68,0.12)' }}
              >
                <span className="text-sm text-foreground flex-1">{r.dimension.replace(/_/g, ' ')}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{r.previousAvg.toFixed(2)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs tabular-nums" style={{ color: scoreColor(r.currentAvg) }}>{r.currentAvg.toFixed(2)}</span>
                <span
                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums"
                  style={{
                    background: r.significance === 'high' ? 'rgba(239,68,68,0.15)' : 'rgba(251,191,36,0.12)',
                    color: r.significance === 'high' ? 'rgb(252,165,165)' : 'rgb(253,224,71)',
                  }}
                >
                  {r.delta > 0 ? '+' : ''}{r.delta.toFixed(2)} ({r.significance})
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Improvement suggestions */}
      {report.improvementSuggestions.length > 0 && (
        <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-3 flex items-center gap-2" style={{ letterSpacing: '-0.01em' }}>
            <Sparkles className="h-4 w-4 text-amber-400" />
            Improvement Suggestions
          </p>
          <ul className="space-y-1.5">
            {report.improvementSuggestions.map((s, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/60 mt-0.5 flex-shrink-0">{i + 1}.</span>
                {s}
              </li>
            ))}
          </ul>
        </motion.div>
      )}

      {/* Actions */}
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => learnMut.mutate()}
          disabled={learnMut.isPending}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
        >
          {learnMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookOpen className="h-4 w-4" />}
          {learnMut.isPending ? 'Learning...' : 'Learn from Reviews'}
        </button>
        <button
          onClick={() => autoGenMut.mutate()}
          disabled={autoGenMut.isPending}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
        >
          {autoGenMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {autoGenMut.isPending ? 'Generating...' : 'Auto-generate Content Rules'}
        </button>
      </motion.div>

      {/* Run metadata */}
      <div className="text-xs text-muted-foreground/60 pt-2">
        Run: {report.runId} | Model: {report.model} | {new Date(report.timestamp).toLocaleString()}
      </div>
    </div>
  );
}

// ─── Turn editor ─────────────────────────────────────────────────────────────

interface TurnOverride {
  dimension: string;
  newScore: number;
  adminNote: string;
}

function TurnEditor({
  turn,
  conversationId,
  onClose,
}: {
  turn: AutoEvalTurnDetail;
  conversationId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState<TurnOverride[]>(() =>
    turn.dimensions.map((d) => ({
      dimension: d.name,
      newScore: d.score,
      adminNote: '',
    })),
  );
  const [approved, setApproved] = useState(turn.adminReviewed ?? false);

  const saveMut = useMutation({
    mutationFn: () =>
      api.autoEval.updateTurnEval(conversationId, turn.turnIndex, {
        overrides: overrides.filter((o) => {
          const orig = turn.dimensions.find((d) => d.name === o.dimension);
          return orig && (o.newScore !== orig.score || o.adminNote.trim());
        }),
        adminApproved: approved,
      }),
    onSuccess: () => {
      toast.success('Scores saved');
      void qc.invalidateQueries({ queryKey: ['auto-eval-conversation', conversationId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateOverride = useCallback((dim: string, field: 'newScore' | 'adminNote', value: number | string) => {
    setOverrides((prev) =>
      prev.map((o) => (o.dimension === dim ? { ...o, [field]: value } : o)),
    );
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="border-t mt-3 pt-3"
      style={{ borderColor: 'rgba(255,255,255,0.06)' }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Edit Dimension Scores</p>
      <div className="space-y-2">
        {overrides.map((o) => {
          const orig = turn.dimensions.find((d) => d.name === o.dimension);
          return (
            <div key={o.dimension} className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-foreground w-36 truncate flex-shrink-0">{o.dimension.replace(/_/g, ' ')}</span>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => updateOverride(o.dimension, 'newScore', n)}
                    className="w-7 h-7 rounded text-xs font-semibold transition-colors"
                    style={{
                      background: o.newScore === n ? scoreBg(n) : 'rgba(255,255,255,0.04)',
                      color: o.newScore === n ? scoreColor(n) : 'rgb(148,163,184)',
                      border: `1px solid ${o.newScore === n ? scoreColor(n) + '40' : 'rgba(255,255,255,0.06)'}`,
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {orig && o.newScore !== orig.score && (
                <span className="text-[10px] text-muted-foreground tabular-nums">was {orig.score}</span>
              )}
              <input
                type="text"
                value={o.adminNote}
                onChange={(e) => updateOverride(o.dimension, 'adminNote', e.target.value)}
                placeholder="Note (optional)"
                className="flex-1 min-w-[120px] bg-white/5 border rounded-lg px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                style={{ borderColor: 'rgba(255,255,255,0.08)' }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mt-4">
        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
            className="rounded border-white/20"
          />
          Admin Approved
        </label>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
        >
          {saveMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          {saveMut.isPending ? 'Saving...' : 'Save Overrides'}
        </button>
      </div>
    </motion.div>
  );
}

// ─── Conversation detail ─────────────────────────────────────────────────────

function ConversationDetailView({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['auto-eval-conversation', id],
    queryFn: () => api.autoEval.conversation(id),
  });

  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [editingTurn, setEditingTurn] = useState<number | null>(null);

  const toggleTurn = useCallback((idx: number) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  if (isLoading) return <div className="p-4"><Skeleton className="h-40 rounded-xl" /></div>;
  if (error || !data) return <div className="p-4 text-sm text-rose-400">Failed to load conversation.</div>;

  const { conversation: conv, evaluation: evalData } = data;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="px-4 py-4 space-y-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {/* Persona and scenario info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Persona</p>
            <p className="text-sm text-foreground font-medium">{conv.persona.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Style: {conv.persona.communicationStyle}</p>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{conv.persona.backstory}</p>
          </div>
          <div className="rounded-lg p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Scenario</p>
            <p className="text-sm text-foreground">{conv.scenario.description}</p>
            {conv.scenario.challenges.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {conv.scenario.challenges.map((c, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Eval summary */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Overall</span>
            <ScoreBadge score={evalData.overallScore} large />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Memory</span>
            <ScoreBadge score={evalData.memoryUsageScore} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Consistency</span>
            <ScoreBadge score={evalData.consistencyScore} />
          </div>
        </div>

        {evalData.summary && (
          <p className="text-xs text-muted-foreground italic">{evalData.summary}</p>
        )}

        {evalData.conversationLevelIssues.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-400">Issues</p>
            {evalData.conversationLevelIssues.map((issue, i) => (
              <p key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                <AlertTriangle className="h-3 w-3 text-rose-400 mt-0.5 flex-shrink-0" />
                {issue}
              </p>
            ))}
          </div>
        )}

        {/* Turns */}
        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Conversation Turns</p>
          {evalData.turnEvaluations.map((turn) => (
            <div
              key={turn.turnIndex}
              className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              {/* User message */}
              <div className="px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">User</p>
                <p className="text-sm text-foreground">{turn.userMessage}</p>
              </div>

              {/* Grace response */}
              <div className="px-4 py-3" style={{ background: 'rgba(99,102,241,0.04)' }}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/70">Grace</p>
                  <div className="flex items-center gap-1.5">
                    <ScoreBadge score={turn.overallScore} />
                    {turn.adminReviewed && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    )}
                  </div>
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap">{turn.graceResponse}</p>

                {/* Dimension pills */}
                <div className="flex flex-wrap gap-1 mt-2">
                  {turn.dimensions.map((d) => (
                    <ScorePill key={d.name} name={d.name.replace(/_/g, ' ')} score={d.score} />
                  ))}
                </div>

                {/* Expand button */}
                <button
                  onClick={() => toggleTurn(turn.turnIndex)}
                  className="flex items-center gap-1 mt-2 text-xs text-primary/70 hover:text-primary transition-colors"
                >
                  {expandedTurns.has(turn.turnIndex) ? (
                    <><ChevronUp className="h-3 w-3" /> Hide details</>
                  ) : (
                    <><ChevronDown className="h-3 w-3" /> Show strengths/weaknesses</>
                  )}
                </button>

                <AnimatePresence>
                  {expandedTurns.has(turn.turnIndex) && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-2 space-y-2 overflow-hidden"
                    >
                      {turn.strengths.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/70 mb-1">Strengths</p>
                          {turn.strengths.map((s, i) => (
                            <p key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <CheckCircle2 className="h-3 w-3 text-emerald-400/50 mt-0.5 flex-shrink-0" />
                              {s}
                            </p>
                          ))}
                        </div>
                      )}
                      {turn.weaknesses.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/70 mb-1">Weaknesses</p>
                          {turn.weaknesses.map((w, i) => (
                            <p key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <AlertTriangle className="h-3 w-3 text-amber-400/50 mt-0.5 flex-shrink-0" />
                              {w}
                            </p>
                          ))}
                        </div>
                      )}
                      {turn.criticalIssues.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-400/70 mb-1">Critical Issues</p>
                          {turn.criticalIssues.map((c, i) => (
                            <p key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <AlertTriangle className="h-3 w-3 text-rose-400/50 mt-0.5 flex-shrink-0" />
                              {c}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* Dimension reasoning */}
                      <div className="border-t pt-2 mt-2" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">Dimension Details</p>
                        <div className="space-y-1.5">
                          {turn.dimensions.map((d) => (
                            <div key={d.name} className="flex items-start gap-2">
                              <ScorePill name={d.name.replace(/_/g, ' ')} score={d.score} />
                              <span className="text-[11px] text-muted-foreground/80 flex-1">{d.reasoning}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Admin overrides display */}
                      {turn.adminOverrides && turn.adminOverrides.length > 0 && (
                        <div className="border-t pt-2 mt-2" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/60 mb-1.5">Admin Overrides</p>
                          <div className="space-y-1">
                            {turn.adminOverrides.map((ao, i) => (
                              <div key={i} className="text-[11px] text-muted-foreground flex items-center gap-2">
                                <span>{ao.dimension.replace(/_/g, ' ')}:</span>
                                <span className="line-through tabular-nums">{ao.originalScore}</span>
                                <ArrowRight className="h-3 w-3" />
                                <span className="font-semibold tabular-nums" style={{ color: scoreColor(ao.newScore) }}>{ao.newScore}</span>
                                {ao.adminNote && <span className="text-muted-foreground/60 italic">- {ao.adminNote}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Edit button */}
                      <button
                        onClick={() => setEditingTurn(editingTurn === turn.turnIndex ? null : turn.turnIndex)}
                        className="text-xs text-primary hover:text-primary/80 transition-colors mt-1"
                      >
                        {editingTurn === turn.turnIndex ? 'Close Editor' : 'Edit Scores'}
                      </button>

                      <AnimatePresence>
                        {editingTurn === turn.turnIndex && (
                          <TurnEditor
                            turn={turn}
                            conversationId={id}
                            onClose={() => setEditingTurn(null)}
                          />
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Conversations tab ───────────────────────────────────────────────────────

function ConversationsTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['auto-eval-conversations'],
    queryFn: () => api.autoEval.conversations(),
    refetchInterval: 60_000,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('');

  const conversations = data?.conversations ?? [];

  const categories = useMemo(() => {
    const cats = new Set(conversations.map((c) => c.category));
    return Array.from(cats).sort();
  }, [conversations]);

  const filtered = useMemo(() =>
    filterCategory ? conversations.filter((c) => c.category === filterCategory) : conversations,
    [conversations, filterCategory],
  );

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (error) return <div className="text-sm text-rose-400">Failed to load conversations.</div>;

  if (conversations.length === 0) {
    return (
      <div className="rounded-xl p-8 border text-center" style={CARD_STYLE}>
        <p className="text-muted-foreground">No conversations yet. Run <code className="text-primary">pnpm --filter @grace/api auto-eval</code> first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-3">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="bg-white/5 border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          style={{ borderColor: 'rgba(255,255,255,0.1)' }}
        >
          <option value="" className="bg-slate-900">All categories ({conversations.length})</option>
          {categories.map((c) => (
            <option key={c} value={c} className="bg-slate-900">
              {c.replace(/_/g, ' ')} ({conversations.filter((cv) => cv.category === c).length})
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{filtered.length} conversations</span>
      </div>

      {/* Table */}
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl border" style={CARD_STYLE}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Persona', 'Category', 'Scenario', 'Score', 'Turns', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((conv, idx) => (
                <ConversationRow
                  key={conv.id}
                  conv={conv}
                  idx={idx}
                  isExpanded={expandedId === conv.id}
                  onToggle={() => setExpandedId(expandedId === conv.id ? null : conv.id)}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">No conversations match filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}

function ConversationRow({
  conv,
  idx,
  isExpanded,
  onToggle,
}: {
  conv: AutoEvalConversationSummary;
  idx: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-white/[0.03] transition-colors"
        onClick={onToggle}
        style={{
          background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
          borderBottom: isExpanded ? 'none' : '1px solid rgba(255,255,255,0.04)',
        }}
      >
        <td className="px-4 py-2.5 text-xs text-foreground font-medium">{conv.personaName}</td>
        <td className="px-4 py-2.5"><CategoryBadge category={conv.category} /></td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-xs truncate">{conv.scenarioDescription}</td>
        <td className="px-4 py-2.5"><ScoreBadge score={conv.overallScore} /></td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">{conv.turnCount}</td>
        <td className="px-4 py-2.5">
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr style={{ background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
          <td colSpan={6} className="p-0">
            <AnimatePresence>
              <ConversationDetailView id={conv.id} />
            </AnimatePresence>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Preference pairs tab ────────────────────────────────────────────────────

function PreferencePairsTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['auto-eval-pairs'],
    queryFn: () => api.autoEval.preferencePairs(),
    refetchInterval: 60_000,
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (error) return <div className="text-sm text-rose-400">Failed to load preference pairs.</div>;

  const pairs = data?.pairs ?? [];

  if (pairs.length === 0) {
    return (
      <div className="rounded-xl p-8 border text-center" style={CARD_STYLE}>
        <p className="text-muted-foreground">No preference pairs generated yet. Run auto-eval first.</p>
      </div>
    );
  }

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" className="rounded-xl border" style={CARD_STYLE}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              {['User Message', 'Dimension', 'Chosen', 'Rejected', 'Scores', ''].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair, idx) => (
              <PairRow
                key={pair.id}
                pair={pair}
                idx={idx}
                isExpanded={expandedId === pair.id}
                onToggle={() => setExpandedId(expandedId === pair.id ? null : pair.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

function PairRow({
  pair,
  idx,
  isExpanded,
  onToggle,
}: {
  pair: AutoEvalPreferencePair;
  idx: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-white/[0.03] transition-colors"
        onClick={onToggle}
        style={{
          background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
          borderBottom: isExpanded ? 'none' : '1px solid rgba(255,255,255,0.04)',
        }}
      >
        <td className="px-4 py-2.5 text-xs text-foreground max-w-[200px] truncate">{pair.userMessage}</td>
        <td className="px-4 py-2.5"><CategoryBadge category={pair.dimension} /></td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[180px] truncate">{pair.chosen}</td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[180px] truncate">{pair.rejected}</td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums" style={{ background: 'rgba(16,185,129,0.12)', color: 'rgb(110,231,183)' }}>
              {pair.chosenScore.toFixed(1)}
            </span>
            <span className="text-muted-foreground/40">/</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums" style={{ background: 'rgba(239,68,68,0.12)', color: 'rgb(252,165,165)' }}>
              {pair.rejectedScore.toFixed(1)}
            </span>
          </div>
        </td>
        <td className="px-4 py-2.5">
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
      </tr>
      <AnimatePresence>
        {isExpanded && (
          <motion.tr
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <td colSpan={6} className="px-4 py-4">
              <div className="space-y-3">
                {/* User message full */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">User Message</p>
                  <p className="text-sm text-foreground">{pair.userMessage}</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Chosen */}
                  <div className="rounded-lg p-3 border" style={{ background: 'rgba(16,185,129,0.04)', borderColor: 'rgba(16,185,129,0.15)' }}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Chosen (score: {pair.chosenScore.toFixed(1)})</p>
                    </div>
                    <p className="text-sm text-foreground whitespace-pre-wrap">{pair.chosen}</p>
                  </div>

                  {/* Rejected */}
                  <div className="rounded-lg p-3 border" style={{ background: 'rgba(239,68,68,0.04)', borderColor: 'rgba(239,68,68,0.15)' }}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-400">Rejected (score: {pair.rejectedScore.toFixed(1)})</p>
                    </div>
                    <p className="text-sm text-foreground whitespace-pre-wrap">{pair.rejected}</p>
                  </div>
                </div>

                {/* Reasoning */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Reasoning</p>
                  <p className="text-xs text-muted-foreground">{pair.reasoning}</p>
                </div>
              </div>
            </td>
          </motion.tr>
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Run progress panel ─────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  simulating: 'Simulating conversations',
  evaluating: 'Evaluating responses',
  analyzing: 'Analyzing patterns',
  preference_pairs: 'Generating preference pairs',
  reporting: 'Building report',
  done: 'Complete',
  error: 'Failed',
};

function RunProgressPanel() {
  const qc = useQueryClient();
  const [events, setEvents] = useState<AutoEvalProgressEvent[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [scenarioCount, setScenarioCount] = useState(10);
  const [concurrency, setConcurrency] = useState(2);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showConfig, setShowConfig] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const ALL_CATEGORIES = [
    'onboarding', 'food_logging', 'emotional_support', 'medical_question',
    'topic_switching', 'correction', 'frustration', 'multi_question',
    'slang_typos', 'long_term_memory', 'injection_day', 'side_effects',
    'weight_tracking', 'proactive_response', 'edge_case',
  ];

  const PRESETS = [
    { label: 'Quick smoke (5 scenarios)', count: 5, concurrency: 2, categories: [] as string[] },
    { label: 'Standard (15 scenarios)', count: 15, concurrency: 2, categories: [] },
    { label: 'Food + protein focus', count: 12, concurrency: 2, categories: ['food_logging', 'multi_question', 'correction'] },
    { label: 'Emotional / medical focus', count: 12, concurrency: 2, categories: ['emotional_support', 'medical_question', 'side_effects'] },
    { label: 'Edge cases only', count: 10, concurrency: 2, categories: ['topic_switching', 'slang_typos', 'edge_case'] },
    { label: 'Full sweep (43+ scenarios)', count: 50, concurrency: 4, categories: [] },
  ];

  const toggleCategory = (cat: string) => {
    setSelectedCategories((cur) => cur.includes(cat) ? cur.filter((c) => c !== cat) : [...cur, cat]);
  };

  const applyPreset = (preset: typeof PRESETS[number]) => {
    setScenarioCount(preset.count);
    setConcurrency(preset.concurrency);
    setSelectedCategories(preset.categories);
  };

  // Check initial status
  const { data: statusData } = useQuery({
    queryKey: ['auto-eval-status'],
    queryFn: () => api.autoEval.status(),
    refetchInterval: isRunning ? undefined : 10_000,
  });

  useEffect(() => {
    if (statusData?.running && !isRunning) {
      setIsRunning(true);
      connectSSE();
    }
  }, [statusData]);

  const connectSSE = () => {
    const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
    const token = getToken();
    // EventSource doesn't support headers, so we pass token as query param
    const url = `${base}/admin/auto-eval/progress${token ? `?token=${token}` : ''}`;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener('progress', (e) => {
      const event = JSON.parse(e.data) as AutoEvalProgressEvent;
      setEvents((prev) => [...prev.slice(-50), event]);
      if (event.phase === 'done') {
        setIsRunning(false);
        es.close();
        void qc.invalidateQueries({ queryKey: ['auto-eval-reports'] });
        void qc.invalidateQueries({ queryKey: ['auto-eval-conversations'] });
        toast.success(`Auto-eval complete! Score: ${event.score?.toFixed(2) ?? 'N/A'}`);
      }
      if (event.phase === 'error') {
        setIsRunning(false);
        es.close();
        toast.error(`Auto-eval failed: ${event.error ?? event.message}`);
      }
    });

    es.addEventListener('status', (e) => {
      const state = JSON.parse(e.data) as { running: boolean; phase?: string; progress?: number };
      if (state.running) {
        setIsRunning(true);
      }
    });

    es.addEventListener('error', () => {
      // SSE disconnected — if we were running, try to reconnect
      if (isRunning) {
        setTimeout(connectSSE, 2000);
      }
    });
  };

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const startMut = useMutation({
    mutationFn: () => api.autoEval.startRun({
      scenarioCount,
      concurrency,
      ...(selectedCategories.length > 0 ? { categories: selectedCategories } : {}),
    }),
    onSuccess: () => {
      setIsRunning(true);
      setEvents([]);
      connectSSE();
      toast.success('Auto-eval run started');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const progress = lastEvent?.progress ?? statusData?.state?.progress ?? 0;
  const phase = lastEvent?.phase ?? statusData?.state?.phase ?? '';

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show"
      className="rounded-xl p-5 border" style={CARD_STYLE}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Zap className="h-4 w-4 text-primary" />
          <p className="text-[13px] font-semibold text-foreground" style={{ letterSpacing: '-0.01em' }}>
            Run Auto-Eval
          </p>
          {isRunning && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium"
              style={{ background: 'rgba(99,102,241,0.12)', color: 'rgb(165,180,252)' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              {PHASE_LABELS[phase] ?? phase}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isRunning && (
            <button
              onClick={() => setShowConfig((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Config
            </button>
          )}
          <button
            onClick={() => startMut.mutate()}
            disabled={isRunning || startMut.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
          >
            {isRunning ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running...</>
            ) : startMut.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting...</>
            ) : (
              <><Play className="h-3.5 w-3.5" /> Start Run</>
            )}
          </button>
        </div>
      </div>

      {/* Config panel */}
      <AnimatePresence>
        {showConfig && !isRunning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-4 mb-4 pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {/* Presets */}
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Presets</label>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className="px-3 py-1.5 text-xs rounded-lg bg-white/5 hover:bg-white/10 border transition-colors text-foreground"
                      style={{ borderColor: 'rgba(255,255,255,0.1)' }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Manual settings */}
              <div className="flex items-center gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Scenarios</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={scenarioCount}
                    onChange={(e) => setScenarioCount(Number(e.target.value))}
                    className="w-20 bg-white/5 border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    style={{ borderColor: 'rgba(255,255,255,0.1)' }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Concurrency</label>
                  <select
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                    className="bg-white/5 border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    style={{ borderColor: 'rgba(255,255,255,0.1)' }}
                  >
                    <option value={1} className="bg-slate-900">1 (slow, gentle)</option>
                    <option value={2} className="bg-slate-900">2 (default)</option>
                    <option value={4} className="bg-slate-900">4 (faster)</option>
                    <option value={8} className="bg-slate-900">8 (max, may hit rate limits)</option>
                  </select>
                </div>
                <p className="text-xs text-muted-foreground mt-4 flex-1">
                  Estimated time: ~{Math.ceil((scenarioCount * 30) / concurrency / 60)} min for {scenarioCount} scenarios at concurrency {concurrency}.
                </p>
              </div>

              {/* Category filter */}
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block mb-2">
                  Categories ({selectedCategories.length === 0 ? 'all' : `${selectedCategories.length} selected`})
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_CATEGORIES.map((cat) => {
                    const active = selectedCategories.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => toggleCategory(cat)}
                        className="px-2.5 py-1 text-xs rounded-lg border transition-colors"
                        style={{
                          background: active ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.03)',
                          borderColor: active ? 'rgb(99,102,241)' : 'rgba(255,255,255,0.08)',
                          color: active ? 'rgb(165,180,252)' : 'rgba(255,255,255,0.6)',
                        }}
                      >
                        {cat.replace(/_/g, ' ')}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">
                  Empty = run all categories. Click to toggle individual categories.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Progress bar */}
      {(isRunning || progress > 0) && (
        <div className="space-y-2">
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: phase === 'error' ? 'rgb(239,68,68)' : phase === 'done' ? 'rgb(16,185,129)' : 'rgb(99,102,241)' }}
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{progress}%</span>
            {lastEvent && <span className="text-muted-foreground">{lastEvent.completed}/{lastEvent.total}</span>}
          </div>
        </div>
      )}

      {/* Live log */}
      {events.length > 0 && (
        <div
          className="mt-3 max-h-40 overflow-y-auto rounded-lg p-3 font-mono text-[11px] space-y-0.5"
          style={{ background: 'rgba(0,0,0,0.3)' }}
        >
          {events.map((ev, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-muted-foreground/50 shrink-0 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
              <span className={ev.phase === 'error' ? 'text-rose-400' : ev.phase === 'done' ? 'text-emerald-400' : 'text-foreground/80'}>
                {ev.message}
              </span>
              {ev.score !== undefined && (
                <span className="ml-auto shrink-0" style={{ color: scoreColor(ev.score) }}>{ev.score.toFixed(2)}</span>
              )}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </motion.div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function AutoEvalPage() {
  const [tab, setTab] = useState<Tab>('overview');

  const { data: reportsData, isLoading, error } = useQuery({
    queryKey: ['auto-eval-reports'],
    queryFn: () => api.autoEval.reports(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <LoadingSkeleton />;

  const reports = reportsData?.reports ?? [];
  const latestReport = reports.length > 0 ? reports[0] : null;

  return (
    <PageShell>
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Auto-Eval</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Automated multi-turn conversation evaluation with LLM-powered scoring
        </p>
      </div>

      {/* Run progress panel */}
      <RunProgressPanel />

      {/* Tab bar */}
      <div className="flex items-center gap-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="relative px-4 py-2.5 text-sm font-medium transition-colors"
            style={{ color: tab === key ? 'rgb(165,180,252)' : 'rgb(148,163,184)' }}
          >
            {label}
            {tab === key && (
              <motion.div
                layoutId="auto-eval-tab"
                className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                style={{ background: 'rgb(99,102,241)' }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
          Failed to load auto-eval data. Check API connectivity.
        </div>
      )}

      {/* Tab content */}
      {tab === 'overview' && (
        latestReport ? (
          <OverviewTab report={latestReport} />
        ) : (
          <div className="rounded-xl p-8 border text-center" style={CARD_STYLE}>
            <p className="text-muted-foreground mb-2">No auto-eval reports found.</p>
            <p className="text-xs text-muted-foreground/60">
              Run <code className="text-primary px-1.5 py-0.5 rounded bg-primary/10">pnpm --filter @grace/api auto-eval</code> to generate the first report.
            </p>
          </div>
        )
      )}

      {tab === 'conversations' && <ConversationsTab />}
      {tab === 'pairs' && <PreferencePairsTab />}
    </PageShell>
  );
}
