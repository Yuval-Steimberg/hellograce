import { useState } from 'react';
import { getToken } from '@/lib/api';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Play, Loader2, AlertTriangle, Sparkles, Trash2 } from 'lucide-react';

interface RegressionScenario {
  id: string;
  bugDescription: string;
  triggerMessage: string;
  bannedInResponse: string[];
  requiredBehavior: string[];
  fixedAt: string;
  source?: 'static' | 'manual' | 'replay' | 'feedback';
}

interface DraftScenario {
  id: string;
  bugDescription: string;
  triggerMessage: string;
  bannedPhrases: string[];
  requiredBehavior: string[];
  source: string;
  sourceMeta?: Record<string, unknown>;
}

interface RegressionResult {
  scenarioId: string;
  bugDescription: string;
  passed: boolean;
  graceResponse: string;
  bannedHits: string[];
  missingBehaviors: string[];
  latencyMs: number;
}

interface RegressionReport {
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: RegressionResult[];
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export default function RegressionPage() {
  const [scenarios, setScenarios] = useState<RegressionScenario[]>([]);
  const [report, setReport] = useState<RegressionReport | null>(null);
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [drafts, setDrafts] = useState<DraftScenario[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const token = getToken();

  const loadScenarios = async () => {
    try {
      const r = await fetch(`${API}/admin/regression/scenarios`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json() as { scenarios: RegressionScenario[] };
      setScenarios(data.scenarios);
    } catch {
      toast.error('Failed to load scenarios');
    }
  };

  const runSuite = async () => {
    setRunning(true);
    setReport(null);
    try {
      const r = await fetch(`${API}/admin/regression/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `HTTP ${r.status}`);
      }
      const data = await r.json() as RegressionReport;
      setReport(data);
      if (data.passRate === 100) {
        toast.success(`All ${data.total} regression tests passed`);
      } else {
        toast.error(`${data.failed} of ${data.total} regression tests failed`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  if (scenarios.length === 0 && !report) {
    void loadScenarios();
  }

  const generateFromFeedback = async () => {
    setGenerating(true);
    try {
      const r = await fetch(`${API}/admin/regression/generate-from-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ days: 14, limit: 10 }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `HTTP ${r.status}`);
      }
      const data = await r.json() as { scenarios: DraftScenario[]; message?: string };
      setDrafts(data.scenarios);
      if (data.scenarios.length === 0) {
        toast.info(data.message ?? 'No drafts generated');
      } else {
        toast.success(`Generated ${data.scenarios.length} draft scenarios — review below and save the good ones`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const saveDraft = async (draft: DraftScenario) => {
    try {
      const r = await fetch(`${API}/admin/regression/scenarios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: draft.id,
          bugDescription: draft.bugDescription,
          triggerMessage: draft.triggerMessage,
          bannedPhrases: draft.bannedPhrases,
          requiredBehavior: draft.requiredBehavior,
          source: draft.source,
          sourceMeta: draft.sourceMeta,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('Scenario saved — will run on next regression suite');
      setDrafts((d) => d.filter((x) => x.id !== draft.id));
      void loadScenarios();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const deleteScenario = async (id: string) => {
    if (!confirm(`Delete scenario ${id}?`)) return;
    try {
      const r = await fetch(`${API}/admin/regression/scenarios/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('Scenario deactivated');
      void loadScenarios();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div style={{ padding: '32px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 600, color: 'white', marginBottom: '8px' }}>
          Regression Tests
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '14px', lineHeight: 1.6 }}>
          Replays every known production bug with its exact trigger message. Each scenario checks for
          banned phrases (the literal words Grace said when the bug was reported) and required behaviors
          (semantic checks via LLM judge). Pass rate should be 100% after every deploy.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
        <button
          onClick={runSuite}
          disabled={running}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 20px',
            background: running ? 'rgba(99,102,241,0.3)' : 'rgb(99,102,241)',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {running ? 'Running suite...' : `Run all ${scenarios.length} scenarios`}
        </button>
        <button
          onClick={generateFromFeedback}
          disabled={generating}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '10px 20px',
            background: generating ? 'rgba(251,191,36,0.15)' : 'rgba(251,191,36,0.15)',
            color: 'rgb(251,191,36)',
            border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: generating ? 'not-allowed' : 'pointer',
          }}
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {generating ? 'Generating...' : 'Auto-generate from 👎 feedback'}
        </button>
      </div>

      {drafts.length > 0 && (
        <div style={{
          marginBottom: '24px', padding: '16px', borderRadius: '12px',
          background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)',
        }}>
          <h3 style={{ color: 'rgb(251,191,36)', fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>
            {drafts.length} draft scenario{drafts.length > 1 ? 's' : ''} — review and save
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {drafts.map((d) => (
              <div key={d.id} style={{ padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px' }}>
                <div style={{ fontSize: '13px', color: 'white', marginBottom: '6px' }}>{d.bugDescription}</div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>
                  Trigger: <span style={{ color: 'rgba(255,255,255,0.9)' }}>"{d.triggerMessage}"</span>
                </div>
                {d.bannedPhrases.length > 0 && (
                  <div style={{ fontSize: '11px', color: 'rgb(251,113,133)', marginBottom: '4px' }}>
                    Banned: {d.bannedPhrases.map((p) => `"${p}"`).join(', ')}
                  </div>
                )}
                {d.requiredBehavior.length > 0 && (
                  <div style={{ fontSize: '11px', color: 'rgb(110,231,183)', marginBottom: '8px' }}>
                    Required: {d.requiredBehavior.join('; ')}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => saveDraft(d)}
                    style={{
                      padding: '6px 12px', background: 'rgb(52,211,153)', color: 'black',
                      border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Save scenario
                  </button>
                  <button
                    onClick={() => setDrafts((arr) => arr.filter((x) => x.id !== d.id))}
                    style={{
                      padding: '6px 12px', background: 'transparent', color: 'rgba(255,255,255,0.5)',
                      border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', fontSize: '12px', cursor: 'pointer',
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {report && (
        <div
          style={{
            padding: '20px',
            marginBottom: '24px',
            background: 'hsl(217 33% 11%)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
            <div>
              <div style={{ fontSize: '32px', fontWeight: 600, color: report.passRate === 100 ? 'rgb(52,211,153)' : 'rgb(251,113,133)' }}>
                {report.passRate}%
              </div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Pass rate</div>
            </div>
            <div>
              <div style={{ fontSize: '20px', color: 'rgb(52,211,153)' }}>{report.passed}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Passed</div>
            </div>
            <div>
              <div style={{ fontSize: '20px', color: 'rgb(251,113,133)' }}>{report.failed}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Failed</div>
            </div>
            <div>
              <div style={{ fontSize: '20px', color: 'white' }}>{report.total}</div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Total</div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {(report?.results ?? scenarios.map((s) => ({
          scenarioId: s.id,
          bugDescription: s.bugDescription,
          passed: undefined as boolean | undefined,
          graceResponse: '',
          bannedHits: [],
          missingBehaviors: [],
          latencyMs: 0,
        }))).map((r) => {
          const scenario = scenarios.find((s) => s.id === r.scenarioId);
          const isExpanded = expanded[r.scenarioId];
          return (
            <div
              key={r.scenarioId}
              style={{
                background: 'hsl(217 33% 11%)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '12px',
                overflow: 'hidden',
              }}
            >
              <button
                onClick={() => setExpanded((e) => ({ ...e, [r.scenarioId]: !e[r.scenarioId] }))}
                style={{
                  width: '100%',
                  padding: '16px 20px',
                  background: 'transparent',
                  border: 'none',
                  color: 'white',
                  textAlign: 'left',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                {r.passed === true && <CheckCircle2 className="w-5 h-5" style={{ color: 'rgb(52,211,153)' }} />}
                {r.passed === false && <XCircle className="w-5 h-5" style={{ color: 'rgb(251,113,133)' }} />}
                {r.passed === undefined && <AlertTriangle className="w-5 h-5" style={{ color: 'rgba(255,255,255,0.3)' }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.5)', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {r.scenarioId}
                    {scenario?.source && scenario.source !== 'static' && (
                      <span style={{ padding: '1px 6px', background: 'rgba(251,191,36,0.15)', borderRadius: '4px', color: 'rgb(251,191,36)', fontSize: '10px' }}>
                        {scenario.source}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '14px', color: 'white' }}>{r.bugDescription}</div>
                </div>
                {r.latencyMs > 0 && (
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)' }}>{r.latencyMs}ms</div>
                )}
                {scenario?.source && scenario.source !== 'static' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void deleteScenario(r.scenarioId); }}
                    style={{
                      padding: '4px 8px', background: 'transparent',
                      border: '1px solid rgba(251,113,133,0.3)', borderRadius: '4px',
                      color: 'rgb(251,113,133)', fontSize: '11px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: '4px',
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </button>

              {isExpanded && (
                <div style={{ padding: '0 20px 20px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  {scenario && (
                    <>
                      <div style={{ marginTop: '12px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                        TRIGGER MESSAGE
                      </div>
                      <div style={{ padding: '10px 14px', background: 'rgba(99,102,241,0.1)', borderRadius: '8px', marginTop: '4px', fontSize: '14px', color: 'white' }}>
                        "{scenario.triggerMessage}"
                      </div>
                    </>
                  )}
                  {r.graceResponse && (
                    <>
                      <div style={{ marginTop: '12px', fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>
                        GRACE'S RESPONSE
                      </div>
                      <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', marginTop: '4px', fontSize: '14px', color: 'rgba(255,255,255,0.9)', whiteSpace: 'pre-wrap' }}>
                        {r.graceResponse}
                      </div>
                    </>
                  )}
                  {r.bannedHits.length > 0 && (
                    <>
                      <div style={{ marginTop: '12px', fontSize: '12px', color: 'rgb(251,113,133)' }}>
                        BANNED PHRASES FOUND
                      </div>
                      <ul style={{ marginTop: '4px', paddingLeft: '20px', color: 'rgb(251,113,133)', fontSize: '13px' }}>
                        {r.bannedHits.map((h) => <li key={h}>"{h}"</li>)}
                      </ul>
                    </>
                  )}
                  {r.missingBehaviors.length > 0 && (
                    <>
                      <div style={{ marginTop: '12px', fontSize: '12px', color: 'rgb(251,191,36)' }}>
                        MISSING BEHAVIORS
                      </div>
                      <ul style={{ marginTop: '4px', paddingLeft: '20px', color: 'rgb(251,191,36)', fontSize: '13px' }}>
                        {r.missingBehaviors.map((b) => <li key={b}>{b}</li>)}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
