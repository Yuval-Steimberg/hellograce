import { useState } from 'react';
import { api, type LiveTestResult } from '@/lib/api';

/**
 * Live Test — the centerpiece of the internal debug platform.
 *
 * Sends a message through the REAL Grace pipeline (AIService.handleMessage)
 * against a real user's real data, but in a fully SAFE dry-run: every DB write,
 * Redis write, outbound send, and background job is captured, never executed.
 * Shows the exact reply, a step-by-step trace, a latency waterfall, and the DB
 * writes Grace WOULD have made.
 */
export default function LiveTestPage() {
  const [userId, setUserId] = useState('');
  const [channel, setChannel] = useState<'imessage' | 'sms' | 'whatsapp'>('imessage');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiveTestResult | null>(null);

  async function run() {
    if (!message.trim() || !userId.trim()) {
      setError('Enter a user phone and a message.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.liveTest({ message: message.trim(), userId: userId.trim(), channel });
      setResult(res.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Live test failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Live Test</h1>
        <p className="text-sm text-slate-400">
          Runs the real Grace pipeline against a real user's real data. Nothing is sent or saved.
        </p>
      </div>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
        🧪 DRY-RUN / TEST MODE — every message, DB write, and background job below is <b>captured, not executed</b>.
        Reads use the user's live data.
      </div>

      {/* Input */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-xs text-slate-400 sm:col-span-2">
            User phone (E.164)
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="+15551234567"
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-400">
            Channel
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as typeof channel)}
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="imessage">iMessage</option>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
        </div>
        <label className="text-xs text-slate-400 block">
          Message
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="e.g. had pizza / feeling nauseous today / when's my next reminder?"
            className="mt-1 w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            onClick={run}
            disabled={loading}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading ? 'Running…' : 'Run (dry-run)'}
          </button>
          {error && <span className="text-sm text-red-400">{error}</span>}
        </div>
      </div>

      {result && <LiveTestResultView result={result} />}
    </div>
  );
}

function LiveTestResultView({ result }: { result: LiveTestResult }) {
  const stages = Object.entries(result.stageTimings).sort((a, b) => b[1] - a[1]);
  const maxStage = stages.length ? Math.max(...stages.map(([, v]) => v)) : 0;
  const slowest = stages[0]?.[0];

  return (
    <div className="space-y-4">
      {/* Final reply */}
      <Section title="Final response" defaultOpen>
        <div className="whitespace-pre-wrap rounded bg-slate-900 p-3 text-sm text-slate-100">{result.reply || '(empty)'}</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <Chip>intent: {result.intent}</Chip>
          <Chip>confidence: {result.confidence}</Chip>
          <Chip>{result.totalLatencyMs} ms total</Chip>
          {result.usedRetrieval && <Chip>RAG</Chip>}
          {result.regenerated && <Chip tone="warn">regenerated</Chip>}
          {result.usedSafeFallback && <Chip tone="warn">safe fallback</Chip>}
          <Chip>reply: {result.model.replyProvider}{result.model.replyModel ? ` (${result.model.replyModel})` : ''}</Chip>
        </div>
      </Section>

      {/* Latency waterfall */}
      <Section title={`Latency waterfall (${stages.length} stages)`} defaultOpen>
        {stages.length === 0 ? (
          <p className="text-sm text-slate-400">No per-stage timings captured for this turn.</p>
        ) : (
          <div className="space-y-1">
            {stages.map(([stage, ms]) => (
              <div key={stage} className="flex items-center gap-2 text-xs">
                <span className={`w-44 shrink-0 truncate ${stage === slowest ? 'font-semibold text-amber-300' : 'text-slate-300'}`}>{stage}</span>
                <div className="h-3 flex-1 rounded bg-slate-900">
                  <div
                    className={`h-3 rounded ${stage === slowest ? 'bg-amber-400' : 'bg-indigo-500'}`}
                    style={{ width: `${maxStage ? (ms / maxStage) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right tabular-nums text-slate-300">{ms} ms</span>
              </div>
            ))}
            {slowest && (
              <p className="pt-1 text-xs text-amber-300/80">Slowest stage: <b>{slowest}</b> ({result.stageTimings[slowest]} ms)</p>
            )}
          </div>
        )}
      </Section>

      {/* Tool calls */}
      <Section title={`Tool calls (${result.toolCalls.length})`}>
        {result.toolCalls.length === 0 ? (
          <p className="text-sm text-slate-400">No tools called.</p>
        ) : (
          <div className="space-y-2">
            {result.toolCalls.map((t, i) => (
              <div key={i} className="rounded border border-slate-700 bg-slate-900 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={t.ok ? 'text-emerald-400' : 'text-red-400'}>{t.ok ? '✓' : '✗'}</span>
                  <b className="text-slate-100">{t.name}</b>
                  {t.latencyMs != null && <span className="text-slate-400">{t.latencyMs} ms</span>}
                </div>
                {t.args != null && <pre className="mt-1 overflow-x-auto text-slate-400">args: {JSON.stringify(t.args)}</pre>}
                {t.output != null && <pre className="mt-1 overflow-x-auto text-slate-400">out: {JSON.stringify(t.output)}</pre>}
                {t.error && <div className="mt-1 text-red-400">error: {t.error}</div>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Would-be DB writes */}
      <Section title={`DB writes Grace WOULD have made (${result.wouldWrite.length}) — captured, not executed`}>
        {result.wouldWrite.length === 0 ? (
          <p className="text-sm text-slate-400">No writes.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-2">
              {result.wouldWriteSummary.map((s, i) => (
                <Chip key={i}>{s.op} {s.table ?? '?'} ×{s.count}</Chip>
              ))}
            </div>
            <div className="space-y-1">
              {result.wouldWrite.map((w, i) => (
                <div key={i} className="rounded border border-slate-700 bg-slate-900 p-2 text-xs">
                  <div className="text-slate-300">
                    <span className="font-semibold uppercase text-amber-300">{w.op}</span> {w.table ?? ''}
                  </div>
                  <pre className="mt-1 overflow-x-auto text-slate-500">{w.sql}</pre>
                  <pre className="overflow-x-auto text-slate-400">params: {JSON.stringify(w.params)}</pre>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      {/* Prompt / model */}
      <Section title="Model & active system prompt">
        <div className="mb-2 flex flex-wrap gap-2 text-xs">
          <Chip>reply: {result.model.replyProvider}{result.model.replyModel ? ` ${result.model.replyModel}` : ''}</Chip>
          <Chip>gemini: {result.model.geminiModel}</Chip>
          {result.model.extractModel && <Chip>extract: {result.model.extractModel}</Chip>}
          <Chip>history turns: {result.historyTurnsCaptured}</Chip>
        </div>
        {result.activeSystemPromptExcerpt && (
          <pre className="max-h-48 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-400">{result.activeSystemPromptExcerpt}…</pre>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm font-medium text-slate-200">
        <span>{title}</span>
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="border-t border-slate-700 px-4 py-3">{children}</div>}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${tone === 'warn' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700/60 text-slate-300'}`}>
      {children}
    </span>
  );
}
