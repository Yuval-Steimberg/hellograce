import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ContentRule } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Plus, ChevronDown, ChevronUp, Play, BookOpen } from 'lucide-react';

const CARD_STYLE = {
  background: 'hsl(217 33% 11%)',
  borderColor: 'rgba(255,255,255,0.07)',
};

const stagger = { show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } },
};

const SEVERITY_BADGE: Record<string, { bg: string; text: string }> = {
  block: { bg: 'rgba(239,68,68,0.15)',   text: 'rgb(252,165,165)' },
  regen: { bg: 'rgba(251,191,36,0.15)',  text: 'rgb(253,224,71)' },
  log:   { bg: 'rgba(100,116,139,0.15)', text: 'rgb(148,163,184)' },
};

const RULE_TYPES = ['banned_phrase', 'medication_safety', 'medical_authority', 'emotional_safety', 'privacy'];

function SeverityBadge({ sev }: { sev: string }) {
  const badge = SEVERITY_BADGE[sev] ?? SEVERITY_BADGE.log;
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize"
      style={{ background: badge.bg, color: badge.text }}>
      {sev}
    </span>
  );
}

function FieldInput({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-white/5 border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        style={{ borderColor: 'rgba(255,255,255,0.1)' }}
      />
    </div>
  );
}

function SelectInput({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white/5 border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        style={{ borderColor: 'rgba(255,255,255,0.1)' }}
      >
        {options.map((o) => <option key={o.value} value={o.value} className="bg-slate-900">{o.label}</option>)}
      </select>
    </div>
  );
}

const BLANK_FORM: Partial<ContentRule> = {
  rule_type: 'banned_phrase',
  pattern: '',
  is_regex: true,
  flags: 'i',
  reason: '',
  severity: 'regen',
  applies_to: 'all',
  is_active: true,
};

interface RuleExample {
  title: string;
  reason: string;
  pattern: string;
  flags: string;
  severity: 'block' | 'regen' | 'log';
  rule_type: string;
  applies_to: 'ai' | 'scheduler' | 'all';
  note: string;
}

const RULE_EXAMPLES: RuleExample[] = [
  {
    title: 'Block dangerous dosing advice',
    reason: 'Never tell users to take extra/double doses — could cause hypoglycemia or other serious harm.',
    pattern: '\\btake\\s+(an?\\s+)?(extra|another|double)\\s+(dose|injection|shot|pill)\\b',
    flags: 'i',
    severity: 'block',
    rule_type: 'medication_safety',
    applies_to: 'all',
    note: 'Severity "block" → message is dropped immediately, no regen attempt. Use only when there is no safe rewrite.',
  },
  {
    title: 'Regen prescriptive language',
    reason: 'Grace should never command — phrases like "you must eat" / "you need to drink" feel coercive.',
    pattern: '\\byou\\s+(must|need\\s+to|have\\s+to|should)\\s+(eat|drink|take|stop|start)\\b',
    flags: 'i',
    severity: 'regen',
    rule_type: 'banned_phrase',
    applies_to: 'all',
    note: 'Severity "regen" → the model is asked to rewrite without the banned phrase. Safe fallback if retry still fails.',
  },
  {
    title: 'Regen overused doctor deflection',
    reason: 'Sending users to a doctor for every small question feels dismissive. Use only for true medical escalations.',
    pattern: "\\b(see|ask|consult|talk\\s+to)\\s+(your|a)\\s+(doctor|provider|physician)\\b",
    flags: 'i',
    severity: 'regen',
    rule_type: 'medical_authority',
    applies_to: 'ai',
    note: '"applies_to: ai" → only applied to reactive AI replies, not scheduler proactive messages.',
  },
];

function CodePill({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-white/10 text-[11px] font-mono text-amber-200 break-all">
      {children}
    </code>
  );
}

function RuleHelpPanel() {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="rounded-lg border mb-4"
      style={{ background: 'rgba(99,102,241,0.06)', borderColor: 'rgba(99,102,241,0.25)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <BookOpen className="h-3.5 w-3.5 text-primary" />
          How to write an accurate rule
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 text-[12.5px] leading-relaxed text-muted-foreground">
          {/* Mental model */}
          <div className="space-y-1.5">
            <p className="text-foreground font-semibold">Mental model</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <span className="text-foreground">Pattern</span> is a <strong>JavaScript regex</strong> (case-insensitive by default).
                If you just want to match plain text, you can paste it as-is — but escape any special characters: <CodePill>{`. * + ? ( ) [ ] { } | \\ ^ $`}</CodePill>
              </li>
              <li>
                <span className="text-foreground">Severity</span> decides what happens when a match is found:
                <CodePill>block</CodePill> → drop the message, send safe fallback;
                <CodePill>regen</CodePill> → ask the model to rewrite (one retry, then fallback);
                <CodePill>log</CodePill> → record only, message still sends.
              </li>
              <li>
                <span className="text-foreground">Applies to</span>: <CodePill>ai</CodePill> = reactive replies only,
                <CodePill>scheduler</CodePill> = proactive check-ins only,
                <CodePill>all</CodePill> = both.
              </li>
            </ul>
          </div>

          {/* Core tips */}
          <div className="space-y-1.5">
            <p className="text-foreground font-semibold">Tips for an accurate pattern</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Wrap whole words with <CodePill>{`\\b`}</CodePill> (word boundary) so <CodePill>{`\\bdose\\b`}</CodePill> matches "dose" but NOT "doses" or "overdose".</li>
              <li>Use <CodePill>{`\\s+`}</CodePill> for "one or more spaces" — handles double-spaces, tabs, newlines.</li>
              <li>Use grouping <CodePill>{`(a|b|c)`}</CodePill> to match alternatives — e.g. <CodePill>{`(must|need to|have to)`}</CodePill>.</li>
              <li>Optional pieces use <CodePill>{`?`}</CodePill> — e.g. <CodePill>{`an?`}</CodePill> matches both "a" and "an".</li>
              <li>Always set flag <CodePill>i</CodePill> so capitalization differences don't slip through.</li>
              <li>Write the <span className="text-foreground">reason</span> as a full sentence — it's what the model sees when asked to regenerate.</li>
              <li>Test every new rule with the "Test Text Against Rules" panel above before saving.</li>
            </ul>
          </div>

          {/* Common pitfalls */}
          <div className="space-y-1.5">
            <p className="text-foreground font-semibold">Common pitfalls — avoid</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Patterns that are too broad: <CodePill>doctor</CodePill> would match "I'm a doctor" in a user-quoted message. Always anchor with context.</li>
              <li>Forgetting <CodePill>{`\\b`}</CodePill>: <CodePill>diet</CodePill> matches "dietary", "dieting", "audited" — almost never what you want.</li>
              <li>Using <CodePill>block</CodePill> for soft violations (overused phrases). Block only when no rewrite is acceptable (real safety risks).</li>
              <li>Empty or vague <span className="text-foreground">reason</span>: model can't fix what it doesn't understand.</li>
            </ul>
          </div>

          {/* Worked examples */}
          <div className="space-y-2">
            <p className="text-foreground font-semibold">Worked examples</p>
            {RULE_EXAMPLES.map((ex, i) => (
              <div
                key={i}
                className="rounded-lg p-3 space-y-1.5 border"
                style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}
              >
                <div className="flex items-center gap-2">
                  <SeverityBadge sev={ex.severity} />
                  <span className="text-foreground text-[12.5px] font-medium">{ex.title}</span>
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                  <span className="text-muted-foreground">Type</span>
                  <span className="text-foreground">{ex.rule_type.replace(/_/g, ' ')}</span>
                  <span className="text-muted-foreground">Applies to</span>
                  <span className="text-foreground">{ex.applies_to}</span>
                  <span className="text-muted-foreground">Pattern</span>
                  <CodePill>{ex.pattern}</CodePill>
                  <span className="text-muted-foreground">Flags</span>
                  <CodePill>{ex.flags}</CodePill>
                  <span className="text-muted-foreground">Reason</span>
                  <span className="text-foreground">{ex.reason}</span>
                </div>
                <p className="text-[11.5px] text-muted-foreground italic pt-1">{ex.note}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </PageShell>
  );
}

type Filters = { type?: string; severity?: string; active?: string };

export default function ContentRulesPage() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>({});
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<Partial<ContentRule>>(BLANK_FORM);
  const [editForm, setEditForm] = useState<Partial<ContentRule>>({});
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<{ violations: unknown[]; clean: boolean } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['content-rules', filters],
    queryFn: () => api.contentRules.list(filters),
  });

  const createMut = useMutation({
    mutationFn: (body: Partial<ContentRule>) => api.contentRules.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['content-rules'] });
      toast.success('Rule created');
      setShowCreate(false);
      setForm(BLANK_FORM);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<ContentRule> }) => api.contentRules.update(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['content-rules'] });
      toast.success('Rule updated');
      setEditId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deactivateMut = useMutation({
    mutationFn: (id: number) => api.contentRules.deactivate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['content-rules'] });
      toast.success('Rule deactivated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runTest = async () => {
    if (!testText.trim()) return;
    setTestLoading(true);
    try {
      const result = await api.contentRules.test(testText);
      setTestResult(result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTestLoading(false);
    }
  };

  if (isLoading) return <LoadingSkeleton />;
  if (error || !data) return (
    <PageShell>
      <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-5 py-4 text-sm text-destructive">
        Failed to load content rules. Check API connectivity.
      </div>
    </PageShell>
  );

  const rules = data.rules;
  const total = data.total;
  const blockCount = rules.filter((r) => r.severity === 'block').length;
  const regenCount = rules.filter((r) => r.severity === 'regen').length;

  return (
    <PageShell>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Content Rules</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage guardbands applied to AI and scheduler output</p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Rule
        </button>
      </div>

      {/* Test panel */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl p-5 border" style={CARD_STYLE}>
        <p className="text-[13px] font-semibold text-foreground mb-3" style={{ letterSpacing: '-0.01em' }}>Test Text Against Rules</p>
        <div className="flex gap-3">
          <textarea
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="Enter text to test against all active rules..."
            rows={2}
            className="flex-1 bg-white/5 border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
            style={{ borderColor: 'rgba(255,255,255,0.1)' }}
          />
          <button
            onClick={runTest}
            disabled={testLoading || !testText.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50 self-end"
          >
            <Play className="h-3.5 w-3.5" />
            {testLoading ? 'Testing...' : 'Run Test'}
          </button>
        </div>
        {testResult && (
          <div className="mt-3">
            {testResult.clean
              ? <p className="text-sm text-emerald-400">No violations found — text is clean.</p>
              : (
                <div className="space-y-1.5">
                  <p className="text-sm text-amber-400 font-medium">{(testResult.violations as Array<{ severity: string; reason: string; match: string }>).length} violation(s) found:</p>
                  {(testResult.violations as Array<{ severity: string; reason: string; match: string }>).map((v, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <SeverityBadge sev={v.severity} />
                      <span className="text-muted-foreground">{v.reason}</span>
                      <span className="font-mono text-amber-400/80">"{v.match}"</span>
                    </div>
                  ))}
                </div>
              )}
          </div>
        )}
      </motion.div>

      {/* Stats row */}
      <motion.div variants={stagger} initial="hidden" animate="show" className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Rules', value: total },
          { label: 'Block Rules', value: blockCount },
          { label: 'Regen Rules', value: regenCount },
        ].map(({ label, value }) => (
          <motion.div key={label} variants={fadeUp}>
            <div className="rounded-xl p-5 border" style={CARD_STYLE}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{label}</p>
              <p className="text-2xl font-semibold text-foreground tabular-nums" style={{ letterSpacing: '-0.02em' }}>{value}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Create form */}
      {showCreate && (
        <motion.div variants={fadeUp} initial="hidden" animate="show"
          className="rounded-xl p-5 border" style={CARD_STYLE}>
          <p className="text-[13px] font-semibold text-foreground mb-4" style={{ letterSpacing: '-0.01em' }}>Create New Rule</p>
          <RuleHelpPanel />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
            <SelectInput label="Type" value={form.rule_type ?? 'banned_phrase'}
              onChange={(v) => setForm((f) => ({ ...f, rule_type: v }))}
              options={RULE_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))} />
            <SelectInput label="Severity" value={form.severity ?? 'regen'}
              onChange={(v) => setForm((f) => ({ ...f, severity: v as ContentRule['severity'] }))}
              options={[{ value: 'block', label: 'Block' }, { value: 'regen', label: 'Regen' }, { value: 'log', label: 'Log' }]} />
            <SelectInput label="Applies To" value={form.applies_to ?? 'all'}
              onChange={(v) => setForm((f) => ({ ...f, applies_to: v as ContentRule['applies_to'] }))}
              options={[{ value: 'all', label: 'All' }, { value: 'ai', label: 'AI only' }, { value: 'scheduler', label: 'Scheduler only' }]} />
            <div className="lg:col-span-2">
              <FieldInput label="Pattern" value={form.pattern ?? ''}
                onChange={(v) => setForm((f) => ({ ...f, pattern: v }))} placeholder="Regex or literal text" />
            </div>
            <FieldInput label="Flags" value={form.flags ?? 'i'}
              onChange={(v) => setForm((f) => ({ ...f, flags: v }))} placeholder="i" />
            <div className="lg:col-span-3">
              <FieldInput label="Reason" value={form.reason ?? ''}
                onChange={(v) => setForm((f) => ({ ...f, reason: v }))} placeholder="Why this rule exists" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => createMut.mutate(form)}
              disabled={createMut.isPending || !form.pattern || !form.reason}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
            >
              {createMut.isPending ? 'Creating...' : 'Create Rule'}
            </button>
            <button
              onClick={() => { setShowCreate(false); setForm(BLANK_FORM); }}
              className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </motion.div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <SelectInput label="" value={filters.severity ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, severity: v || undefined }))}
          options={[
            { value: '', label: 'All severities' },
            { value: 'block', label: 'Block' },
            { value: 'regen', label: 'Regen' },
            { value: 'log', label: 'Log' },
          ]} />
        <SelectInput label="" value={filters.type ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, type: v || undefined }))}
          options={[
            { value: '', label: 'All types' },
            ...RULE_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })),
          ]} />
        <SelectInput label="" value={filters.active ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, active: v || undefined }))}
          options={[
            { value: '', label: 'All status' },
            { value: 'true', label: 'Active' },
            { value: 'false', label: 'Inactive' },
          ]} />
      </div>

      {/* Rules table */}
      <motion.div variants={fadeUp} initial="hidden" animate="show"
        className="rounded-xl border" style={CARD_STYLE}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['Pattern', 'Type', 'Severity', 'Applies To', 'Active', 'Actions'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule, idx) => (
                <>
                  <tr key={rule.id}
                    style={{
                      background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                      borderBottom: editId === rule.id ? 'none' : '1px solid rgba(255,255,255,0.04)',
                    }}>
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground max-w-xs truncate">{rule.pattern}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{rule.rule_type.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2.5"><SeverityBadge sev={rule.severity} /></td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{rule.applies_to}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${rule.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => { setEditId(editId === rule.id ? null : rule.id); setEditForm({ ...rule }); }}
                          className="text-xs text-primary hover:text-primary/80 transition-colors"
                        >
                          {editId === rule.id ? 'Close' : 'Edit'}
                        </button>
                        {rule.is_active && (
                          <button
                            onClick={() => deactivateMut.mutate(rule.id)}
                            disabled={deactivateMut.isPending}
                            className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {editId === rule.id && (
                    <tr key={`edit-${rule.id}`}
                      style={{
                        background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                      }}>
                      <td colSpan={6} className="px-4 py-4">
                        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                          <SelectInput label="Severity" value={editForm.severity ?? rule.severity}
                            onChange={(v) => setEditForm((f) => ({ ...f, severity: v as ContentRule['severity'] }))}
                            options={[{ value: 'block', label: 'Block' }, { value: 'regen', label: 'Regen' }, { value: 'log', label: 'Log' }]} />
                          <SelectInput label="Applies To" value={editForm.applies_to ?? rule.applies_to}
                            onChange={(v) => setEditForm((f) => ({ ...f, applies_to: v as ContentRule['applies_to'] }))}
                            options={[{ value: 'all', label: 'All' }, { value: 'ai', label: 'AI only' }, { value: 'scheduler', label: 'Scheduler only' }]} />
                          <div className="lg:col-span-2">
                            <FieldInput label="Pattern" value={editForm.pattern ?? rule.pattern}
                              onChange={(v) => setEditForm((f) => ({ ...f, pattern: v }))} />
                          </div>
                          <div className="lg:col-span-3">
                            <FieldInput label="Reason" value={editForm.reason ?? rule.reason}
                              onChange={(v) => setEditForm((f) => ({ ...f, reason: v }))} />
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => updateMut.mutate({ id: rule.id, body: editForm })}
                            disabled={updateMut.isPending}
                            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-50"
                          >
                            {updateMut.isPending ? 'Saving...' : 'Save Changes'}
                          </button>
                          <button onClick={() => setEditId(null)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {rules.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">No rules match the current filters</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </PageShell>
  );
}
