import { useEffect, useState } from 'react';
import { getToken } from '@/lib/api';
import { toast } from 'sonner';
import {
  Microscope,
  Play,
  Loader2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Upload,
  Wrench,
} from 'lucide-react';

interface CorpusRow {
  id: number;
  source_type: string;
  source_url: string | null;
  source_subreddit: string | null;
  source_score: number | null;
  scraped_at: string;
  raw_text: string;
  classified_intent: string | null;
  intent_id_match: string | null;
  is_covered: boolean | null;
  grade_passed: boolean | null;
  eval_overall: number | null;
  admin_status: string;
}

interface CorpusListResponse {
  rows: CorpusRow[];
  total: number;
}

interface ScrapeResponse {
  ok: boolean;
  scraped_subreddits?: string[];
  scrape_errors?: Array<{ subreddit: string; error?: string }>;
  scraped_posts?: number;
  inserted?: number;
  deduped?: number;
  classified?: number;
  replayed?: number;
  evaluated?: number;
}

interface CorpusRowDetail extends CorpusRow {
  raw_text: string;
  grace_response: string | null;
  grace_response_intent: string | null;
  grade_failures: Array<{ type: string; detail: string }> | null;
  eval_scores: Record<string, number> | null;
  eval_weaknesses: string[] | null;
  replay_latency_ms: number | null;
  content_hash: string;
  notes: string | null;
}

interface AutoFixReport {
  postsAnalyzed: number;
  stillFailing: number;
  alreadyFixed: number;
  contentRulesGenerated: number;
  syntheticFeedbackInjected: number;
  topPatterns: Array<{ pattern: string; count: number; action: string }>;
  weakestDimensions: Array<{ dim: string; avgScore: number }>;
  runAt: string;
}

interface CoverageGaps {
  by_intent: Record<string, { covered: number; uncovered: number; total: number }>;
  by_subreddit: Record<string, { covered: number; uncovered: number; total: number }>;
  top_uncovered: Array<{ id: number; raw_text: string; classified_intent: string | null; source_url: string | null; source_score: number | null }>;
  weakest_dims: Array<{ dim: string; avg: number; count: number }>;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const TABS = ['corpus', 'gaps'] as const;
type Tab = typeof TABS[number];

const DEFAULT_SUBS = [
  'Ozempic',
  'Mounjaro',
  'Zepbound',
  'WegovyWeightLoss',
  'Semaglutide',
  'GLP1',
  'loseit',
  'WeightLossAdvice',
];

export default function ResearchPage() {
  const [tab, setTab] = useState<Tab>('corpus');
  const [rows, setRows] = useState<CorpusRow[]>([]);
  const [total, setTotal] = useState(0);
  const [gaps, setGaps] = useState<CoverageGaps | null>(null);
  const [selectedRow, setSelectedRow] = useState<CorpusRowDetail | null>(null);
  const [scraping, setScraping] = useState(false);
  const [filterSub, setFilterSub] = useState<string>('');
  const [filterIntent, setFilterIntent] = useState<string>('');
  const [filterCovered, setFilterCovered] = useState<'all' | 'covered' | 'uncovered'>('all');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [scrapeLimit, setScrapeLimit] = useState(20);
  const [scrapeSubs, setScrapeSubs] = useState<string[]>(['Ozempic']);
  const [autoFixing, setAutoFixing] = useState(false);
  const [autoFixReport, setAutoFixReport] = useState<AutoFixReport | null>(null);

  const token = getToken();

  useEffect(() => {
    void loadCorpus();
  }, [filterSub, filterIntent, filterCovered, filterStatus]);

  useEffect(() => {
    if (tab === 'gaps') void loadGaps();
  }, [tab]);

  const loadCorpus = async () => {
    const params = new URLSearchParams();
    if (filterSub) params.set('subreddit', filterSub);
    if (filterIntent) params.set('intent', filterIntent);
    if (filterCovered === 'covered') params.set('covered', 'true');
    if (filterCovered === 'uncovered') params.set('covered', 'false');
    if (filterStatus) params.set('status', filterStatus);
    params.set('limit', '100');
    try {
      const r = await fetch(`${API}/admin/research/corpus?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as CorpusListResponse;
      setRows(data.rows);
      setTotal(data.total);
    } catch (err) {
      toast.error(`Load corpus failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loadGaps = async () => {
    try {
      const r = await fetch(`${API}/admin/research/coverage-gaps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setGaps((await r.json()) as CoverageGaps);
    } catch (err) {
      toast.error(`Load gaps failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loadDetail = async (id: number) => {
    try {
      const r = await fetch(`${API}/admin/research/corpus/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSelectedRow((await r.json()) as CorpusRowDetail);
    } catch (err) {
      toast.error(`Load detail failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runScrape = async () => {
    if (scrapeSubs.length === 0) {
      toast.error('Pick at least one subreddit');
      return;
    }
    setScraping(true);
    try {
      const r = await fetch(`${API}/admin/research/scrape`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subreddits: scrapeSubs, limit: scrapeLimit }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as ScrapeResponse;
      toast.success(
        `Scraped ${data.scraped_posts ?? 0} posts · ${data.inserted ?? 0} new · ${data.classified ?? 0} classified · ${data.evaluated ?? 0} LLM-evaluated`,
      );
      await loadCorpus();
    } catch (err) {
      toast.error(`Scrape failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScraping(false);
    }
  };

  const runAutoFix = async (dryRun = false) => {
    setAutoFixing(true);
    setAutoFixReport(null);
    try {
      const r = await fetch(`${API}/admin/research/auto-fix`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_size: 60, dry_run: dryRun }),
      });
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      const data = (await r.json()) as AutoFixReport;
      setAutoFixReport(data);
      toast.success(
        `Auto-fix: ${data.alreadyFixed} fixed · ${data.stillFailing} still failing · ${data.contentRulesGenerated} new rules · ${data.syntheticFeedbackInjected} feedback injected`,
      );
      if (!dryRun) await loadCorpus();
    } catch (err) {
      toast.error(`Auto-fix failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAutoFixing(false);
    }
  };

  const promote = async (id: number) => {
    try {
      const r = await fetch(`${API}/admin/research/corpus/${id}/promote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = (await r.json()) as { suggested_entry: unknown };
      toast.success('Promoted. Suggested entry copied to clipboard.');
      void navigator.clipboard?.writeText(JSON.stringify(data.suggested_entry, null, 2));
      await loadCorpus();
      setSelectedRow(null);
    } catch (err) {
      toast.error(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const reject = async (id: number) => {
    try {
      const r = await fetch(`${API}/admin/research/corpus/${id}/reject`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(await r.text());
      toast.success('Rejected.');
      await loadCorpus();
      setSelectedRow(null);
    } catch (err) {
      toast.error(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Microscope className="h-6 w-6" />
        <h1 className="text-2xl font-semibold">Research — real-world data</h1>
        <span className="ml-2 rounded bg-slate-800/50 px-2 py-0.5 text-xs text-slate-300">
          {total} posts
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-700">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t
                ? 'border-b-2 border-indigo-500 text-indigo-300'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'corpus' ? 'Corpus' : 'Coverage gaps'}
          </button>
        ))}
      </div>

      {tab === 'corpus' && (
        <>
          {/* Scrape control */}
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3">
            <h2 className="text-sm font-medium text-slate-300">Trigger a scrape</h2>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_SUBS.map((s) => (
                <button
                  key={s}
                  onClick={() =>
                    setScrapeSubs((prev) =>
                      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
                    )
                  }
                  className={`rounded-full px-3 py-1 text-xs ${
                    scrapeSubs.includes(s)
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  r/{s}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-4">
              <label className="block">
                <span className="text-xs text-slate-400">Posts per subreddit</span>
                <input
                  type="number"
                  value={scrapeLimit}
                  onChange={(e) => setScrapeLimit(Number(e.target.value))}
                  className="mt-1 block w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                  min={1}
                  max={100}
                />
              </label>
              <button
                onClick={() => void runScrape()}
                disabled={scraping}
                className="ml-auto inline-flex items-center gap-2 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {scraping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {scraping ? 'Scraping…' : 'Run scrape'}
              </button>
            </div>
          </div>

          {/* Auto-fix panel */}
          <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-medium text-amber-300">Auto-fix (runs every 3 days automatically)</h2>
            </div>
            <p className="text-xs text-slate-400">
              Re-replays failing corpus posts through the current Grace prompt. Generates content rules for
              recurring bad patterns and injects synthetic feedback into the nightly prompt optimizer.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => void runAutoFix(false)}
                disabled={autoFixing}
                className="inline-flex items-center gap-2 rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {autoFixing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                {autoFixing ? 'Running…' : 'Run auto-fix'}
              </button>
              <button
                onClick={() => void runAutoFix(true)}
                disabled={autoFixing}
                className="inline-flex items-center gap-2 rounded border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                Dry-run (analyze only)
              </button>
            </div>
            {autoFixReport && (
              <div className="mt-3 rounded bg-slate-900 p-3 text-xs space-y-1.5">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-slate-300">
                  <span>Posts analyzed: <strong className="text-white">{autoFixReport.postsAnalyzed}</strong></span>
                  <span>Already fixed: <strong className="text-green-400">{autoFixReport.alreadyFixed}</strong></span>
                  <span>Still failing: <strong className="text-red-400">{autoFixReport.stillFailing}</strong></span>
                  <span>Content rules added: <strong className="text-amber-400">{autoFixReport.contentRulesGenerated}</strong></span>
                  <span>Synthetic feedback: <strong className="text-indigo-400">{autoFixReport.syntheticFeedbackInjected}</strong></span>
                  {autoFixReport.weakestDimensions[0] && (
                    <span>Weakest dim: <strong className="text-slate-200">{autoFixReport.weakestDimensions[0].dim} ({autoFixReport.weakestDimensions[0].avgScore}/5)</strong></span>
                  )}
                </div>
                {autoFixReport.topPatterns.length > 0 && (
                  <div className="pt-1.5 border-t border-slate-700">
                    <span className="text-slate-400">Top patterns:</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {autoFixReport.topPatterns.slice(0, 6).map((p) => (
                        <span
                          key={p.pattern}
                          className={`rounded px-2 py-0.5 text-xs ${
                            p.action === 'content_rule'
                              ? 'bg-amber-900/50 text-amber-300'
                              : p.action === 'synthetic_feedback'
                              ? 'bg-indigo-900/50 text-indigo-300'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {p.pattern} ({p.count}×)
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Filters */}
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <div className="flex flex-wrap gap-3">
              <select
                value={filterSub}
                onChange={(e) => setFilterSub(e.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
              >
                <option value="">All subreddits</option>
                {DEFAULT_SUBS.map((s) => (
                  <option key={s} value={s.toLowerCase()}>
                    r/{s}
                  </option>
                ))}
              </select>
              <select
                value={filterIntent}
                onChange={(e) => setFilterIntent(e.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
              >
                <option value="">All intents</option>
                {['food_log', 'food_question', 'knowledge', 'emotional', 'medication_question', 'social_situation', 'weight_log', 'general'].map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
              <select
                value={filterCovered}
                onChange={(e) => setFilterCovered(e.target.value as 'all' | 'covered' | 'uncovered')}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
              >
                <option value="all">Coverage: all</option>
                <option value="covered">Covered</option>
                <option value="uncovered">Uncovered (gap)</option>
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
              >
                <option value="">Any status</option>
                <option value="pending">Pending review</option>
                <option value="reviewed">Reviewed</option>
                <option value="promoted_to_intent">Promoted</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>

          {/* Rows */}
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <div className="max-h-[600px] overflow-y-auto space-y-2">
              {rows.length === 0 && (
                <div className="text-center text-slate-500 py-8">
                  No posts yet. Run a scrape above.
                </div>
              )}
              {rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void loadDetail(r.id)}
                  className="block w-full text-left rounded border border-slate-700 p-3 text-xs hover:bg-slate-800"
                >
                  <div className="flex items-center gap-2">
                    {r.is_covered === true ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : r.is_covered === false ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                    ) : null}
                    <span className="font-mono text-slate-300">#{r.id}</span>
                    {r.source_subreddit && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        r/{r.source_subreddit}
                      </span>
                    )}
                    {r.classified_intent && (
                      <span className="rounded bg-indigo-900/50 px-1.5 py-0.5 text-[10px] text-indigo-300">
                        {r.classified_intent}
                      </span>
                    )}
                    {r.grade_passed === true && (
                      <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        ✓ graded
                      </span>
                    )}
                    {r.grade_passed === false && (
                      <span className="rounded bg-rose-900/50 px-1.5 py-0.5 text-[10px] text-rose-300">
                        ✗ failed
                      </span>
                    )}
                    {r.eval_overall != null && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        eval {r.eval_overall}/5
                      </span>
                    )}
                    {r.source_score != null && (
                      <span className="ml-auto text-slate-500">↑ {r.source_score}</span>
                    )}
                  </div>
                  <div className="mt-1 text-slate-400 line-clamp-2">{r.raw_text.slice(0, 240)}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {tab === 'gaps' && gaps && (
        <div className="space-y-4">
          <Section title="Top uncovered posts (prioritized by upvote count)">
            <div className="space-y-2">
              {gaps.top_uncovered.map((u) => (
                <div key={u.id} className="rounded border border-amber-700/40 bg-amber-950/20 p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-300">#{u.id}</span>
                    {u.classified_intent && (
                      <span className="rounded bg-indigo-900/50 px-1.5 py-0.5 text-[10px] text-indigo-300">
                        {u.classified_intent}
                      </span>
                    )}
                    {u.source_score != null && (
                      <span className="ml-auto text-slate-500">↑ {u.source_score}</span>
                    )}
                    {u.source_url && (
                      <a href={u.source_url} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300">
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="mt-1 text-slate-300 line-clamp-2">{u.raw_text.slice(0, 240)}</div>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Coverage by intent">
            <BreakdownTable data={gaps.by_intent} />
          </Section>
          <Section title="Coverage by subreddit">
            <BreakdownTable data={gaps.by_subreddit} />
          </Section>
          {gaps.weakest_dims.length > 0 && (
            <Section title="Weakest LLM-evaluated dimensions (lower avg = worse)">
              <div className="space-y-1">
                {gaps.weakest_dims.map((d) => (
                  <div key={d.dim} className="flex items-center gap-3 text-xs">
                    <div className="w-48 text-slate-300">{d.dim}</div>
                    <div className="flex-1 h-2 rounded bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-rose-500"
                        style={{ width: `${(d.avg / 5) * 100}%` }}
                      />
                    </div>
                    <div className="w-20 text-right text-slate-400">{d.avg.toFixed(1)}/5</div>
                    <div className="w-16 text-right text-slate-500">{d.count} evals</div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {/* Detail side-panel */}
      {selectedRow && (
        <div
          onClick={() => setSelectedRow(null)}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 bottom-0 w-full max-w-2xl bg-slate-900 border-l border-slate-700 overflow-y-auto"
          >
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Post #{selectedRow.id}</h2>
                <button
                  onClick={() => setSelectedRow(null)}
                  className="rounded p-1 hover:bg-slate-800"
                >
                  <XCircle className="h-5 w-5 text-slate-400" />
                </button>
              </div>
              <DetailRow label="Source">
                {selectedRow.source_subreddit && <span>r/{selectedRow.source_subreddit}</span>}
                {selectedRow.source_url && (
                  <a href={selectedRow.source_url} target="_blank" rel="noreferrer" className="ml-2 text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1">
                    open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </DetailRow>
              <DetailRow label="Raw text">
                <pre className="whitespace-pre-wrap text-xs text-slate-300">{selectedRow.raw_text}</pre>
              </DetailRow>
              <DetailRow label="Classifier">
                <span className="rounded bg-indigo-900/50 px-2 py-0.5 text-xs">
                  {selectedRow.classified_intent ?? '(none)'}
                </span>
                {selectedRow.intent_id_match && (
                  <span className="ml-2 rounded bg-slate-800 px-2 py-0.5 text-xs">
                    matched: {selectedRow.intent_id_match}
                  </span>
                )}
                {selectedRow.is_covered === false && (
                  <span className="ml-2 rounded bg-amber-900/50 px-2 py-0.5 text-xs text-amber-300">
                    UNCOVERED
                  </span>
                )}
              </DetailRow>
              {selectedRow.grace_response && (
                <DetailRow label="Grace's response">
                  <pre className="whitespace-pre-wrap text-xs text-slate-300">{selectedRow.grace_response}</pre>
                </DetailRow>
              )}
              {selectedRow.grade_failures && selectedRow.grade_failures.length > 0 && (
                <DetailRow label="Grade failures">
                  <ul className="space-y-1">
                    {selectedRow.grade_failures.map((f, i) => (
                      <li key={i} className="text-xs text-rose-300">
                        ✗ {f.type}: {f.detail}
                      </li>
                    ))}
                  </ul>
                </DetailRow>
              )}
              {selectedRow.eval_scores && (
                <DetailRow label="LLM evaluation">
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    {Object.entries(selectedRow.eval_scores).map(([k, v]) => (
                      <div key={k} className="flex justify-between rounded bg-slate-800 px-2 py-0.5">
                        <span className="text-slate-400">{k}</span>
                        <span className={v >= 4 ? 'text-emerald-400' : v >= 3 ? 'text-amber-400' : 'text-rose-400'}>
                          {v}/5
                        </span>
                      </div>
                    ))}
                  </div>
                  {selectedRow.eval_weaknesses && selectedRow.eval_weaknesses.length > 0 && (
                    <div className="mt-2">
                      <div className="text-xs text-slate-400 mb-1">Weaknesses:</div>
                      <ul className="text-xs text-slate-300 space-y-0.5">
                        {selectedRow.eval_weaknesses.map((w, i) => (
                          <li key={i}>• {w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </DetailRow>
              )}
              {selectedRow.admin_status === 'pending' && (
                <div className="flex gap-3 pt-4 border-t border-slate-800">
                  <button
                    onClick={() => void promote(selectedRow.id)}
                    className="flex-1 rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
                  >
                    Promote to intent library
                  </button>
                  <button
                    onClick={() => void reject(selectedRow.id)}
                    className="flex-1 rounded bg-rose-700 px-4 py-2 text-sm font-medium hover:bg-rose-600"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
      <h2 className="text-sm font-medium text-slate-300 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function BreakdownTable({ data }: { data: Record<string, { covered: number; uncovered: number; total: number }> }) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b.total - a.total);
  return (
    <div className="space-y-1">
      {entries.map(([key, b]) => {
        const pct = b.total > 0 ? Math.round((b.covered / b.total) * 100) : 0;
        return (
          <div key={key} className="flex items-center gap-3 text-xs">
            <div className="w-40 text-slate-300 font-medium">{key}</div>
            <div className="flex-1 h-2 rounded bg-slate-800 overflow-hidden">
              <div
                className={pct >= 90 ? 'h-full bg-emerald-500' : pct >= 70 ? 'h-full bg-amber-500' : 'h-full bg-rose-500'}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="w-16 text-right text-slate-400">{pct}%</div>
            <div className="w-24 text-right text-slate-500">
              {b.covered}/{b.total}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}
