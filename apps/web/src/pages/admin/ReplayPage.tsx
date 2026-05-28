import { useState } from 'react';
import { getToken } from '@/lib/api';
import { toast } from 'sonner';
import { Play, GitCompare, Loader2, AlertCircle } from 'lucide-react';

interface ReplayTurn {
  role: 'user' | 'grace';
  text: string;
  latencyMs: number;
  bannedPhrases: string[];
}

interface ReplayResult {
  turns: ReplayTurn[];
  totalLatencyMs: number;
}

interface DiffResult {
  versionA: number;
  versionB: number;
  replayA: ReplayResult;
  replayB: ReplayResult;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

type Mode = 'replay' | 'diff';

export default function ReplayPage() {
  const [mode, setMode] = useState<Mode>('replay');
  const [messagesText, setMessagesText] = useState('');
  const [persona, setPersona] = useState({
    firstName: 'Sarah',
    medication: 'Wegovy',
    dietaryRestriction: '',
    foodDislikes: '',
    proteinGoalGrams: '100',
  });
  const [versionA, setVersionA] = useState('');
  const [versionB, setVersionB] = useState('');
  const [running, setRunning] = useState(false);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);

  const token = getToken();

  const parseMessages = (): string[] =>
    messagesText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

  const personaContext = {
    firstName: persona.firstName.trim() || undefined,
    medication: persona.medication.trim() || undefined,
    dietaryRestriction: persona.dietaryRestriction.trim() || undefined,
    foodDislikes: persona.foodDislikes.split(',').map((s) => s.trim()).filter(Boolean),
    proteinGoalGrams: Number(persona.proteinGoalGrams) || 100,
  };

  const runReplay = async () => {
    const messages = parseMessages();
    if (messages.length === 0) {
      toast.error('Add at least one user message');
      return;
    }
    setRunning(true);
    setReplay(null);
    setDiff(null);
    try {
      const r = await fetch(`${API}/admin/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages, personaContext }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `HTTP ${r.status}`);
      }
      const data = await r.json() as ReplayResult;
      setReplay(data);
      const totalBanned = data.turns.reduce((s, t) => s + t.bannedPhrases.length, 0);
      if (totalBanned > 0) {
        toast.error(`${totalBanned} banned phrase(s) detected — see results below`);
      } else {
        toast.success('Replay complete — no banned phrases detected');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Replay failed');
    } finally {
      setRunning(false);
    }
  };

  const runDiff = async () => {
    const messages = parseMessages();
    if (messages.length === 0 || !versionA || !versionB) {
      toast.error('Need messages and both prompt versions');
      return;
    }
    setRunning(true);
    setReplay(null);
    setDiff(null);
    try {
      const r = await fetch(`${API}/admin/replay/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages,
          promptVersionA: Number(versionA),
          promptVersionB: Number(versionB),
          personaContext,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message ?? `HTTP ${r.status}`);
      }
      const data = await r.json() as DiffResult;
      setDiff(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Diff failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ padding: '32px', maxWidth: '1400px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '28px', fontWeight: 600, color: 'white', marginBottom: '8px' }}>
        Replay & Diff
      </h1>
      <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '14px', marginBottom: '24px' }}>
        Paste WhatsApp messages, replay through Grace, see exactly what she'd say. Use diff mode to compare two prompt versions side-by-side.
      </p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        <button
          onClick={() => setMode('replay')}
          style={{
            padding: '8px 16px',
            background: mode === 'replay' ? 'rgb(99,102,241)' : 'rgba(99,102,241,0.15)',
            color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}
        >
          <Play className="w-4 h-4" /> Single replay
        </button>
        <button
          onClick={() => setMode('diff')}
          style={{
            padding: '8px 16px',
            background: mode === 'diff' ? 'rgb(99,102,241)' : 'rgba(99,102,241,0.15)',
            color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}
        >
          <GitCompare className="w-4 h-4" /> Diff two versions
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
        <div style={{ background: 'hsl(217 33% 11%)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '20px' }}>
          <label style={{ display: 'block', fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
            USER MESSAGES (one per line, # for comments)
          </label>
          <textarea
            value={messagesText}
            onChange={(e) => setMessagesText(e.target.value)}
            placeholder={'# Example regression: protein left query\nI ate a banana, a Big Mac, and drank Coke\nHow much protein is left for today?'}
            rows={10}
            style={{
              width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px', padding: '12px', color: 'white', fontSize: '14px',
              fontFamily: 'monospace', resize: 'vertical',
            }}
          />
        </div>

        <div style={{ background: 'hsl(217 33% 11%)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '20px' }}>
          <label style={{ display: 'block', fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '8px' }}>
            PERSONA CONTEXT
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {(['firstName', 'medication', 'dietaryRestriction', 'foodDislikes', 'proteinGoalGrams'] as const).map((key) => (
              <div key={key}>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '4px', textTransform: 'capitalize' }}>
                  {key.replace(/([A-Z])/g, ' $1').trim()}
                </div>
                <input
                  value={persona[key]}
                  onChange={(e) => setPersona((p) => ({ ...p, [key]: e.target.value }))}
                  style={{
                    width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '6px', padding: '8px', color: 'white', fontSize: '13px',
                  }}
                />
              </div>
            ))}
          </div>

          {mode === 'diff' && (
            <div style={{ marginTop: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>PROMPT VERSION A</div>
                <input
                  type="number" value={versionA} onChange={(e) => setVersionA(e.target.value)}
                  placeholder="e.g. 25"
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '8px', color: 'white', fontSize: '13px' }}
                />
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>PROMPT VERSION B</div>
                <input
                  type="number" value={versionB} onChange={(e) => setVersionB(e.target.value)}
                  placeholder="e.g. 28"
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '8px', color: 'white', fontSize: '13px' }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={mode === 'replay' ? runReplay : runDiff}
        disabled={running}
        style={{
          padding: '10px 24px', background: running ? 'rgba(99,102,241,0.3)' : 'rgb(99,102,241)',
          color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 500,
          cursor: running ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
        }}
      >
        {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {running ? 'Running...' : mode === 'replay' ? 'Run replay' : 'Run diff'}
      </button>

      {replay && (
        <div style={{ marginTop: '32px' }}>
          <h2 style={{ fontSize: '18px', color: 'white', marginBottom: '16px' }}>Replay results</h2>
          <TurnList turns={replay.turns} />
        </div>
      )}

      {diff && (
        <div style={{ marginTop: '32px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          <div>
            <h2 style={{ fontSize: '18px', color: 'white', marginBottom: '12px' }}>Prompt v{diff.versionA}</h2>
            <TurnList turns={diff.replayA.turns} />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', color: 'white', marginBottom: '12px' }}>Prompt v{diff.versionB}</h2>
            <TurnList turns={diff.replayB.turns} />
          </div>
        </div>
      )}
    </div>
  );
}

function TurnList({ turns }: { turns: ReplayTurn[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {turns.map((t, i) => (
        <div
          key={i}
          style={{
            padding: '12px 14px', borderRadius: '8px',
            background: t.role === 'user' ? 'rgba(34,197,94,0.1)' : 'hsl(217 33% 11%)',
            border: t.bannedPhrases.length > 0 ? '1px solid rgb(251,113,133)' : '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '4px', textTransform: 'uppercase' }}>
            {t.role} {t.latencyMs > 0 && `· ${t.latencyMs}ms`}
          </div>
          <div style={{ fontSize: '14px', color: 'white', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{t.text}</div>
          {t.bannedPhrases.length > 0 && (
            <div style={{ marginTop: '8px', padding: '6px 10px', background: 'rgba(251,113,133,0.1)', borderRadius: '6px', fontSize: '12px', color: 'rgb(251,113,133)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <AlertCircle className="w-3 h-3" /> Banned: {t.bannedPhrases.map((b) => `"${b}"`).join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
