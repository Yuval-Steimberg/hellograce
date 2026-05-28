import { useState } from 'react';
import { getToken } from '@/lib/api';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Play, Loader2, AlertTriangle } from 'lucide-react';

interface RegressionScenario {
  id: string;
  bugDescription: string;
  triggerMessage: string;
  bannedInResponse: string[];
  requiredBehavior: string[];
  fixedAt: string;
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
      </div>

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
                  <div style={{ fontSize: '13px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.5)' }}>{r.scenarioId}</div>
                  <div style={{ fontSize: '14px', color: 'white' }}>{r.bugDescription}</div>
                </div>
                {r.latencyMs > 0 && (
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)' }}>{r.latencyMs}ms</div>
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
