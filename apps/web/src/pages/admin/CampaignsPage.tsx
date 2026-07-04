import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CampaignPreview, type CampaignSummary, type CampaignDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Send, Eye, Save, AlertTriangle, Users, Sparkles, Undo2 } from 'lucide-react';

type Tone = 'warm' | 'concise' | 'motivating' | 'friendly';

const CARD_STYLE = { background: 'hsl(217 33% 11%)', borderColor: 'rgba(255,255,255,0.07)' };
const LARGE_SEND = 100;

const TEMPLATES: { label: string; text: string }[] = [
  { label: 'Onboarding reminder', text: "Hey, it's Grace 💛 Just checking in — you're almost done setting things up. Finish onboarding so I can personalize your support better." },
  { label: 'Trial ending soon', text: 'Hey, your Grace trial is ending soon. If Grace has been helpful, you can continue with your personalized GLP-1 support and progress tracking.' },
  { label: 'Inactive user', text: "Hey, just checking in 💛 Want to log today's meals or tell me how you're feeling? I'm here to help you stay on track." },
  { label: 'Missing profile data', text: 'Quick question so I can personalize Grace better for you — do you want to finish setting up your profile?' },
  { label: 'Did not convert', text: "Hey, thanks for trying Grace. I'd love to know what was missing or what would make Grace more useful for you." },
];

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground" style={{ letterSpacing: '-0.02em' }}>Campaigns</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Message a whole cohort safely — preview the audience, then confirm before sending.</p>
      </div>
      {children}
    </div>
  );
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    sent: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    sending: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    draft: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
    failed: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  };
  return <Badge className={`text-[10px] ${map[status] ?? map.draft}`}>{status}</Badge>;
}

function CampaignDetailSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useQuery<CampaignDetail>({ queryKey: ['campaign', id], queryFn: () => api.campaigns.get(id) });
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="admin-shell w-full sm:max-w-xl overflow-y-auto" style={{ background: 'hsl(222 47% 6%)' }}>
        <SheetHeader>
          <SheetTitle className="text-foreground">Campaign #{id}</SheetTitle>
        </SheetHeader>
        {isLoading || !data ? (
          <div className="space-y-2 mt-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg p-3 border" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <div className="flex items-center gap-2 mb-2">{statusBadge(data.status)}<span className="text-xs text-muted-foreground">{data.cohort_label ?? data.cohort_key ?? 'ad-hoc'}</span></div>
              <p className="text-sm text-foreground whitespace-pre-wrap">{data.message}</p>
              <p className="text-[11px] text-muted-foreground mt-2 tabular-nums">
                {data.sent_count} sent · {data.failed_count} failed · {data.skipped_count} skipped · by {data.actor}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Recipients</p>
              <div className="space-y-1">
                {data.recipients.map((r) => (
                  <div key={r.phone} className="flex items-center justify-between text-sm rounded px-2 py-1.5 border" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    <span className="text-foreground font-mono text-xs">{r.phone}</span>
                    <span className="flex items-center gap-2">
                      {r.error && <span className="text-[10px] text-rose-400/80 max-w-40 truncate">{r.error}</span>}
                      {statusBadge(r.status)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function CampaignsPage() {
  const qc = useQueryClient();
  const [cohortKey, setCohortKey] = useState('');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [tone, setTone] = useState<Tone>('warm');
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhance, setPreEnhance] = useState<string | null>(null); // for undo
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const cohortsQ = useQuery({ queryKey: ['cohorts-catalog'], queryFn: () => api.cohorts() });
  const historyQ = useQuery({ queryKey: ['campaigns'], queryFn: () => api.campaigns.list(50), refetchInterval: 30_000 });

  const cohortLabel = useMemo(
    () => cohortsQ.data?.cohorts.find((c) => c.key === cohortKey)?.label ?? '',
    [cohortsQ.data, cohortKey],
  );

  // Any change to the audience selection invalidates a stale preview.
  const resetPreview = () => setPreview(null);

  async function doPreview() {
    if (!cohortKey) { toast.error('Pick a cohort first.'); return; }
    setPreviewing(true);
    try {
      const p = await api.campaigns.preview({ cohort_key: cohortKey });
      setPreview(p);
    } catch (e) { toast.error((e as Error).message); }
    finally { setPreviewing(false); }
  }

  async function doEnhance() {
    if (!message.trim()) { toast.error('Write a draft first.'); return; }
    setEnhancing(true);
    const before = message;
    try {
      const r = await api.campaigns.enhance({ message, tone, audience_label: cohortLabel || undefined });
      setPreEnhance(before);
      setMessage(r.enhanced);
      toast.success('Message enhanced with AI.');
    } catch (e) { toast.error((e as Error).message); }
    finally { setEnhancing(false); }
  }

  function undoEnhance() {
    if (preEnhance != null) { setMessage(preEnhance); setPreEnhance(null); }
  }

  async function doSaveDraft() {
    if (!message.trim()) { toast.error('Write a message first.'); return; }
    try {
      await api.campaigns.draft({ cohort_key: cohortKey || undefined, cohort_label: cohortLabel || undefined, message, channel: channel || undefined, note: note || undefined });
      toast.success('Draft saved.');
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) { toast.error((e as Error).message); }
  }

  async function doSend() {
    setSending(true);
    try {
      const r = await api.campaigns.send({
        cohort_key: cohortKey || undefined,
        cohort_label: cohortLabel || undefined,
        message,
        channel: channel || undefined,
        note: note || undefined,
        confirm: true,
      });
      toast.success(`Sent to ${r.sent} · ${r.failed} failed · ${r.skipped} skipped`);
      setConfirmOpen(false);
      setMessage(''); setPreview(null); setNote('');
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
    } catch (e) { toast.error((e as Error).message); }
    finally { setSending(false); }
  }

  const canSend = !!message.trim() && !!preview && preview.eligible_count > 0 && !preview.over_cap;
  const isLarge = preview && preview.eligible_count >= LARGE_SEND;

  return (
    <PageShell>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Composer */}
        <div className="rounded-xl p-4 border space-y-3" style={CARD_STYLE}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Compose</p>

          <div>
            <label className="text-xs text-muted-foreground">Audience (cohort)</label>
            <select
              value={cohortKey}
              onChange={(e) => { setCohortKey(e.target.value); resetPreview(); }}
              className="mt-1 w-full h-9 rounded-lg bg-secondary/50 border border-border text-sm px-2 text-foreground"
            >
              <option value="">Select a cohort…</option>
              {(cohortsQ.data?.cohorts ?? []).map((c) => (
                <option key={c.key} value={c.key}>{c.label} ({c.count})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Template</label>
            <select
              value=""
              onChange={(e) => { const t = TEMPLATES.find((x) => x.label === e.target.value); if (t) setMessage(t.text); }}
              className="mt-1 w-full h-9 rounded-lg bg-secondary/50 border border-border text-sm px-2 text-foreground"
            >
              <option value="">Insert a safe template…</option>
              {TEMPLATES.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">Message ({message.length}/1500)</label>
            <Textarea
              value={message}
              onChange={(e) => { setMessage(e.target.value.slice(0, 1500)); setPreEnhance(null); }}
              rows={5}
              placeholder="Write a supportive, product-related message. No medical or dosing advice."
              className="mt-1 resize-none"
            />
            <div className="flex items-center gap-2 mt-2">
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value as Tone)}
                className="h-8 rounded-lg bg-secondary/50 border border-border text-xs px-2 text-foreground"
                title="AI tone"
              >
                <option value="warm">Warm</option>
                <option value="friendly">Friendly</option>
                <option value="motivating">Motivating</option>
                <option value="concise">Concise</option>
              </select>
              <Button variant="outline" size="sm" onClick={doEnhance} disabled={!message.trim() || enhancing} className="h-8">
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />{enhancing ? 'Enhancing…' : 'Enhance with AI'}
              </Button>
              {preEnhance != null && (
                <Button variant="ghost" size="sm" onClick={undoEnhance} className="h-8 text-muted-foreground">
                  <Undo2 className="h-3.5 w-3.5 mr-1.5" />Undo
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">AI rewrites in Grace's voice and re-checks the safety guard — it can't add medical or dosing content.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Channel</label>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className="mt-1 w-full h-9 rounded-lg bg-secondary/50 border border-border text-sm px-2 text-foreground">
                <option value="">Per-user default</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
                <option value="imessage">iMessage</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Note (internal)</label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 h-9" placeholder="optional" />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={doPreview} disabled={!cohortKey || previewing}>
              <Eye className="h-3.5 w-3.5 mr-1.5" />{previewing ? 'Previewing…' : 'Preview recipients'}
            </Button>
            <Button variant="outline" size="sm" onClick={doSaveDraft} disabled={!message.trim()}>
              <Save className="h-3.5 w-3.5 mr-1.5" />Save draft
            </Button>
            <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!canSend} className="ml-auto">
              <Send className="h-3.5 w-3.5 mr-1.5" />Send
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Opted-out (paused), blocked, and inactive users are always excluded automatically.</p>
        </div>

        {/* Preview */}
        <div className="rounded-xl p-4 border" style={CARD_STYLE}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Audience preview</p>
          {!preview ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Users className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">Pick a cohort and press “Preview recipients” to see exactly who will receive this.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg p-3 border" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <p className="text-2xl font-semibold text-emerald-300 tabular-nums">{preview.eligible_count}</p>
                  <p className="text-[11px] text-muted-foreground">will receive</p>
                </div>
                <div className="rounded-lg p-3 border" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <p className="text-2xl font-semibold text-foreground tabular-nums">{preview.matched}</p>
                  <p className="text-[11px] text-muted-foreground">matched cohort</p>
                </div>
                <div className="rounded-lg p-3 border" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <p className="text-2xl font-semibold text-muted-foreground tabular-nums">{preview.excluded_count}</p>
                  <p className="text-[11px] text-muted-foreground">excluded</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Excluded: {preview.excluded_breakdown.paused} opted-out · {preview.excluded_breakdown.blocked} blocked · {preview.excluded_breakdown.inactive} inactive
              </p>
              {isLarge && (
                <div className="flex items-start gap-2 rounded-lg p-3 border bg-amber-500/10 border-amber-500/30">
                  <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-200">Large send: {preview.eligible_count} users. Double-check the message and cohort before confirming.</p>
                </div>
              )}
              {preview.over_cap && (
                <div className="flex items-start gap-2 rounded-lg p-3 border bg-rose-500/10 border-rose-500/30">
                  <AlertTriangle className="h-4 w-4 text-rose-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-rose-200">Audience exceeds the {preview.cap} safety cap. Narrow the cohort to send.</p>
                </div>
              )}
              {preview.sample.length > 0 && (
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">Sample recipients</p>
                  <div className="flex flex-wrap gap-1">
                    {preview.sample.slice(0, 30).map((p) => (
                      <span key={p} className="text-[10px] font-mono text-muted-foreground px-1.5 py-0.5 rounded border" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>{p}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* History */}
      <div className="rounded-xl p-4 border" style={CARD_STYLE}>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Campaign history</p>
        {historyQ.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
        ) : (historyQ.data?.campaigns ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No campaigns yet.</p>
        ) : (
          <div className="space-y-1">
            {(historyQ.data?.campaigns ?? []).map((c: CampaignSummary) => (
              <button
                key={c.id}
                onClick={() => setDetailId(c.id)}
                className="w-full text-left rounded-lg px-3 py-2.5 border hover:bg-white/[0.03] transition-colors flex items-center justify-between gap-3"
                style={{ borderColor: 'rgba(255,255,255,0.06)' }}
              >
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">{c.message}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {c.cohort_label ?? c.cohort_key ?? 'ad-hoc'} · {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })} · {c.actor}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {c.sent_count}✓ {c.failed_count > 0 ? `${c.failed_count}✗ ` : ''}{c.skipped_count}–
                  </span>
                  {statusBadge(c.status)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Confirmation */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="admin-shell" style={{ background: 'hsl(217 33% 11%)' }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Send to {preview?.eligible_count ?? 0} users?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends the message to <strong>{preview?.eligible_count ?? 0}</strong> eligible users in
              {' '}<strong>{cohortLabel || cohortKey}</strong>{' '}
              ({preview?.excluded_count ?? 0} excluded for opt-out/blocked/inactive). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg p-3 border text-sm text-foreground whitespace-pre-wrap" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            {message}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void doSend(); }} disabled={sending}>
              {sending ? 'Sending…' : `Send to ${preview?.eligible_count ?? 0}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {detailId != null && <CampaignDetailSheet id={detailId} onClose={() => setDetailId(null)} />}
    </PageShell>
  );
}
