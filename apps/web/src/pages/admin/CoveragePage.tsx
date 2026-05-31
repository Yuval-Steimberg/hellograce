import { useEffect, useState } from 'react';
import { getToken } from '@/lib/api';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Play, Loader2, BarChart3, AlertTriangle, History } from 'lucide-react';

interface IntentSummary {
  id: string;
  domain: string;
  subtopic: string;
  expected_intent: string;
  safety_level: 'informational' | 'clinical_redirect' | 'emergency';
  variation_count: number;
  source: string;
}

interface IntentsResponse {
  version: number;
  total: number;
  by_domain: Record<string, number>;
  intents: IntentSummary[];
}

interface GradeFailure {
  type: string;
  detail: string;
}

interface CoverageRunCase {
  case_id: string;
  intent_id: string;
  domain: string;
  subtopic: string;
  user_message: string;
  expected_intent: string;
  expected_tool_calls: string[];
  safety_level: string;
  actual_intent: string;
  actual_tool_names: string[];
  response_text: string;
  grade: {
    case_id: string;
    passed: boolean;
    intent_pass: boolean;
    tool_calls_pass: boolean;
    content_pass: boolean;
    failures: GradeFailure[];
  };
  latency_ms: number;
  error?: string;
}

interface CoverageStats {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number;
  intent_pass_rate: number;
  tool_calls_pass_rate: number;
  content_pass_rate: number;
  by_domain: Record<string, { total: number; passed: number; pass_rate: number }>;
  by_safety_level: Record<string, { total: number; passed: number; pass_rate: number }>;
  median_latency_ms: number;
}

interface RunResponse {
  ok: boolean;
  run_id: string;
  stats: CoverageStats;
  path: string;
  delta: {
    regressions: Array<{ case_id: string; reason: string }>;
    recoveries: string[];
    pass_rate_delta: number;
  } | null;
}

interface RunSummary {
  run_id: string;
  started_at: string;
  pass_rate: number;
  total: number;
}

interface CoverageRunReport {
  run_id: string;
  started_at: string;
  completed_at: string;
  cases: CoverageRunCase[];
  stats: CoverageStats;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

const DOMAINS = [
  'medication', 'side_effects', 'weight_loss', 'food', 'progress',
  'emotional', 'exercise', 'social', 'safety', 'motivation',
];
const SAFETY_LEVELS: Array<'informational' | 'clinical_redirect' | 'emergency'> = [
  'informational', 'clinical_redirect', 'emergency',
];

export default function CoveragePage() {
  const [intents, setIntents] = useState<IntentsResponse | null>(null);
  const [pastRuns, setPastRuns] = useState<RunSummary[]>([]);
  const [running, setRunning] = useState(false);
  const [latestRun, setLatestRun] = useState<RunResponse | null>(null);
  const [activeReport, setActiveReport] = useState<CoverageRunReport | null>(null);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [selectedSafetyLevels, setSelectedSafetyLevels] = useState<string[]>([]);
  const [limit, setLimit] = useState<number>(50);
  const [concurrency, setConcurrency] = useState<number>(4);

  const token = getToken();

  useEffect(() => {
    void loadIntents();
    void loadRuns();
  }, []);

  const loadIntents = async () => {
    try {
      const r = await fetch(`${API}/admin/coverage/intents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as IntentsResponse;
      setIntents(data);
    } catch (err) {
      toast.error(`Failed to load intents: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loadRuns = async () => {
    try {
      const r = await fetch(`${API}/admin/coverage/runs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const data = (await r.json()) as { runs: RunSummary[] };
      setPastRuns(data.runs);
    } catch {
      /* non-critical */
    }
  };

  const loadRunDetail = async (runId: string) => {
    try {
      const r = await fetch(`${API}/admin/coverage/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as CoverageRunReport;
      setActiveReport(data);
    } catch (err) {
      toast.error(`Failed to load run: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runCoverage = async () => {
    setRunning(true);
    setLatestRun(null);
    setActiveReport(null);
    try {
      const body: Record<string, unknown> = { concurrency };
      if (selectedDomains.length > 0) body.domains = selectedDomains;
      if (selectedSafetyLevels.length > 0) body.safety_levels = selectedSafetyLevels;
      if (limit > 0) body.limit = limit;

      const r = await fetch(`${API}/admin/coverage/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as RunResponse;
      setLatestRun(data);
      toast.success(`Coverage run complete: ${data.stats.pass_rate}% (${data.stats.passed}/${data.stats.total})`);
      await loadRuns();
      await loadRunDetail(data.run_id);
    } catch (err) {
      toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const toggleDomain = (d: string) => {
    setSelectedDomains((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  const toggleSafety = (s: string) => {
    setSelectedSafetyLevels((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="h-6 w-6" />
        <h1 className="text-2xl font-semibold">Coverage Suite</h1>
        {intents && (
          <span className="ml-2 rounded bg-slate-800/50 px-2 py-0.5 text-xs text-slate-300">
            {intents.total} intents · {Object.keys(intents.by_domain).length} domains
          </span>
        )}
      </div>

      {/* Run config */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-4">
        <h2 className="text-sm font-medium text-slate-300">Configure run</h2>

        <div>
          <div className="text-xs text-slate-400 mb-2">Domains (empty = all)</div>
          <div className="flex flex-wrap gap-2">
            {DOMAINS.map((d) => (
              <button
                key={d}
                onClick={() => toggleDomain(d)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  selectedDomains.includes(d)
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {d}
                {intents?.by_domain[d] != null && (
                  <span className="ml-1.5 opacity-60">·{intents.by_domain[d]}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-2">Safety levels (empty = all)</div>
          <div className="flex flex-wrap gap-2">
            {SAFETY_LEVELS.map((s) => (
              <button
                key={s}
                onClick={() => toggleSafety(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  selectedSafetyLevels.includes(s)
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-end gap-4">
          <label className="block">
            <span className="text-xs text-slate-400">Limit (0 = all variations)</span>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="mt-1 block w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
              min={0}
              max={2000}
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Concurrency</span>
            <input
              type="number"
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="mt-1 block w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
              min={1}
              max={16}
            />
          </label>
          <button
            onClick={() => void runCoverage()}
            disabled={running}
            className="ml-auto inline-flex items-center gap-2 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? 'Running...' : 'Run coverage'}
          </button>
        </div>
      </div>

      {/* Latest run summary */}
      {latestRun && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-300">Last run · {latestRun.run_id}</h2>
            {latestRun.delta && (
              <span className={`text-xs ${latestRun.delta.pass_rate_delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {latestRun.delta.pass_rate_delta >= 0 ? '+' : ''}{latestRun.delta.pass_rate_delta.toFixed(1)}% vs previous
              </span>
            )}
          </div>
          <StatsBlock stats={latestRun.stats} />
          {latestRun.delta && latestRun.delta.regressions.length > 0 && (
            <div className="mt-3 rounded bg-rose-950/30 border border-rose-800/50 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-rose-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                {latestRun.delta.regressions.length} regression{latestRun.delta.regressions.length === 1 ? '' : 's'} vs previous run
              </div>
              <ul className="mt-2 space-y-1">
                {latestRun.delta.regressions.slice(0, 8).map((r) => (
                  <li key={r.case_id} className="text-xs text-rose-200">
                    {r.case_id} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Active run detail (case-by-case) */}
      {activeReport && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Cases ({activeReport.cases.length})</h2>
          <div className="max-h-[600px] overflow-y-auto space-y-2">
            {activeReport.cases.map((c) => (
              <div
                key={c.case_id}
                className={`rounded border p-3 text-xs ${
                  c.grade.passed
                    ? 'border-emerald-800/50 bg-emerald-950/20'
                    : 'border-rose-800/50 bg-rose-950/20'
                }`}
              >
                <div className="flex items-center gap-2">
                  {c.grade.passed ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-rose-400" />
                  )}
                  <span className="font-mono text-slate-300">{c.case_id}</span>
                  <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {c.domain}/{c.subtopic}
                  </span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {c.latency_ms}ms
                  </span>
                </div>
                <div className="mt-2 text-slate-400">
                  <div>
                    <span className="font-medium text-slate-300">User:</span> {c.user_message}
                  </div>
                  <div className="mt-1">
                    <span className="font-medium text-slate-300">Grace:</span>{' '}
                    {c.response_text.slice(0, 240)}
                    {c.response_text.length > 240 && '…'}
                  </div>
                  <div className="mt-1 text-slate-500">
                    intent: {c.actual_intent}
                    {c.actual_intent !== c.expected_intent && (
                      <span className="text-rose-400"> (expected {c.expected_intent})</span>
                    )}
                    {c.actual_tool_names.length > 0 && (
                      <span> · tools: {c.actual_tool_names.join(', ')}</span>
                    )}
                  </div>
                  {c.grade.failures.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-rose-300">
                      {c.grade.failures.map((f, i) => (
                        <li key={i}>
                          ✗ {f.type}: {f.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Past runs */}
      {pastRuns.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <History className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-medium text-slate-300">Past runs</h2>
          </div>
          <div className="space-y-1">
            {pastRuns.slice(0, 10).map((r) => (
              <button
                key={r.run_id}
                onClick={() => void loadRunDetail(r.run_id)}
                className="block w-full text-left rounded px-3 py-2 text-xs hover:bg-slate-800"
              >
                <span className="font-mono text-slate-300">{r.run_id}</span>
                <span className="ml-3 text-slate-400">{r.started_at}</span>
                <span className="ml-3 text-slate-500">·</span>
                <span className={`ml-3 ${r.pass_rate >= 90 ? 'text-emerald-400' : r.pass_rate >= 70 ? 'text-amber-400' : 'text-rose-400'}`}>
                  {r.pass_rate}% ({r.total} cases)
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatsBlock({ stats }: { stats: CoverageStats }) {
  return (
    <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="Pass rate" value={`${stats.pass_rate}%`} accent={stats.pass_rate >= 90 ? 'emerald' : stats.pass_rate >= 70 ? 'amber' : 'rose'} />
      <Stat label="Passed" value={`${stats.passed}/${stats.total}`} />
      <Stat label="Intent" value={`${stats.intent_pass_rate}%`} />
      <Stat label="Tool calls" value={`${stats.tool_calls_pass_rate}%`} />
      <Stat label="Content" value={`${stats.content_pass_rate}%`} />
      <Stat label="Errored" value={String(stats.errored)} accent={stats.errored > 0 ? 'rose' : 'slate'} />
      <Stat label="Median latency" value={`${stats.median_latency_ms}ms`} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'emerald' | 'amber' | 'rose' | 'slate' }) {
  const colorClasses: Record<string, string> = {
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    rose: 'text-rose-400',
    slate: 'text-slate-200',
  };
  const valueClass = accent ? colorClasses[accent] : 'text-slate-200';
  return (
    <div className="rounded border border-slate-700 bg-slate-900/50 p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
