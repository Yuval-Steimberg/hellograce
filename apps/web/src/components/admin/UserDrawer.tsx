import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AdminUser } from '@/lib/api';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { MessageSquare, Scale, Activity, AlertTriangle, CreditCard, ExternalLink } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Props {
  user: AdminUser | null;
  onClose: () => void;
}

function trialDaysLeft(trialStart: string | null): number | null {
  if (!trialStart) return null;
  const ms = Date.now() - new Date(trialStart).getTime();
  const days = 3 - Math.floor(ms / 86_400_000);
  return days;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function UserDrawer({ user, onClose }: Props) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['user-detail', user?.phone],
    queryFn: () => api.userDetail(user!.phone),
    enabled: !!user,
  });

  const detail = data?.user;
  const checkIns = data?.check_ins ?? [];
  const weightLogs = data?.weight_logs ?? [];

  // ─── Editable profile fields ────────────────────────────────────────────────

  const [form, setForm] = useState({
    first_name: '',
    medication: '',
    injection_day: '',
    wake_time: '07:00',
    sleep_time: '22:00',
    timezone: 'America/New_York',
    goals: '',
    food_dislikes: '',
    current_weight: '',
    goal_weight: '',
    age: '',
    protein_goal_grams: '',
    glp1_start_date: '',
    checkin_count_per_day: '',
  });

  useEffect(() => {
    if (!detail) return;
    setForm({
      first_name: detail.first_name ?? '',
      medication: detail.medication ?? '',
      injection_day: detail.injection_day ?? '',
      wake_time: detail.wake_time ?? '07:00',
      sleep_time: detail.sleep_time ?? '22:00',
      timezone: detail.timezone ?? 'America/New_York',
      goals: (detail.goals ?? []).join(', '),
      food_dislikes: (detail.food_dislikes ?? []).join(', '),
      current_weight: detail.current_weight?.toString() ?? '',
      goal_weight: detail.goal_weight?.toString() ?? '',
      age: detail.age?.toString() ?? '',
      protein_goal_grams: detail.protein_goal_grams?.toString() ?? '',
      glp1_start_date: detail.glp1_start_date ? detail.glp1_start_date.split('T')[0] : '',
      checkin_count_per_day: detail.checkin_count_per_day?.toString() ?? '',
    });
  }, [detail]);

  const updateMutation = useMutation({
    mutationFn: (fields: Parameters<typeof api.updateUser>[1]) => api.updateUser(user!.phone, fields),
    onSuccess: () => {
      toast.success('Profile saved');
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      void qc.invalidateQueries({ queryKey: ['user-detail', user?.phone] });
    },
    onError: () => toast.error('Save failed'),
  });

  const toggleMutation = useMutation({
    mutationFn: (fields: Parameters<typeof api.updateUser>[1]) => api.updateUser(user!.phone, fields),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: () => toast.error('Update failed'),
  });

  const rlhfMutation = useMutation({
    mutationFn: (enabled: boolean) => api.toggleRlhf(user!.phone, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: () => toast.error('RLHF toggle failed'),
  });

  const resetMutation = useMutation({
    mutationFn: () => api.resetMemory(user!.phone),
    onSuccess: () => {
      toast.success('Memory reset');
      void qc.invalidateQueries({ queryKey: ['user-detail', user?.phone] });
    },
    onError: () => toast.error('Reset failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteUser(user!.phone),
    onSuccess: () => {
      toast.success('User deleted');
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: () => toast.error('Delete failed'),
  });

  // ─── Stripe billing ──────────────────────────────────────────────────────
  // Pulled on demand when the drawer opens. Failures render an inline "Stripe
  // not configured / no customer found" message instead of throwing — the
  // rest of the drawer must still work for trial/comp users without billing.
  const { data: stripeData, isLoading: stripeLoading, error: stripeError } = useQuery({
    queryKey: ['user-stripe', user?.phone],
    queryFn: () => api.stripeBilling(user!.phone),
    enabled: !!user,
    retry: false,
  });

  const cancelStripeMutation = useMutation({
    mutationFn: () => api.cancelStripeSubscription(user!.phone),
    onSuccess: () => {
      toast.success('Stripe subscription will cancel at period end');
      void qc.invalidateQueries({ queryKey: ['user-stripe', user?.phone] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Cancel failed'),
  });

  const syncStripeMutation = useMutation({
    mutationFn: () => api.stripe.sync(user!.phone),
    onSuccess: (r) => {
      toast[r.error ? 'error' : 'success'](r.error ? `Stripe sync error: ${r.error}` : 'Synced from Stripe');
      void qc.invalidateQueries({ queryKey: ['user-stripe', user?.phone] });
      void qc.invalidateQueries({ queryKey: ['user-detail', user?.phone] });
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Sync failed'),
  });

  const reactivateMutation = useMutation({
    mutationFn: () => api.stripe.reactivate(user!.phone),
    onSuccess: () => {
      toast.success('Subscription reactivated');
      void qc.invalidateQueries({ queryKey: ['user-stripe', user?.phone] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Reactivate failed'),
  });

  const changePlanMutation = useMutation({
    mutationFn: (plan: 'base' | 'pro') => api.stripe.changePlan(user!.phone, plan),
    onSuccess: (r) => {
      toast.success(`Plan changed to ${r.plan}`);
      void qc.invalidateQueries({ queryKey: ['user-stripe', user?.phone] });
      void qc.invalidateQueries({ queryKey: ['user-detail', user?.phone] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Change plan failed'),
  });

  const [manualMsg, setManualMsg] = useState('');
  const sendMessageMutation = useMutation({
    mutationFn: (text: string) => api.sendMessage(user!.phone, text),
    onSuccess: () => {
      toast.success('Message sent');
      setManualMsg('');
      void qc.invalidateQueries({ queryKey: ['user-detail', user?.phone] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Send failed'),
  });

  const [noteText, setNoteText] = useState('');
  const notesQuery = useQuery({
    queryKey: ['user-notes', user?.phone],
    queryFn: () => api.notes.list(user!.phone),
    enabled: !!user,
  });
  const addNoteMutation = useMutation({
    mutationFn: (note: string) => api.notes.add(user!.phone, note),
    onSuccess: () => {
      setNoteText('');
      void qc.invalidateQueries({ queryKey: ['user-notes', user?.phone] });
    },
    onError: () => toast.error('Add note failed'),
  });
  const deleteNoteMutation = useMutation({
    mutationFn: (id: number) => api.notes.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['user-notes', user?.phone] }),
  });

  // Confirmation dialog for paid/pro toggle-OFF: ask whether to also cancel
  // the Stripe subscription. Two choices: just override (toggle DB only) or
  // cancel Stripe too. Cancel button to abort entirely.
  const [pendingToggle, setPendingToggle] = useState<null | { field: 'is_paid' | 'is_pro'; label: string }>(null);

  function handleAccountToggle(field: 'is_paid' | 'is_pro' | 'paused' | 'blocked', newValue: boolean) {
    // Toggle ON: just flip the DB field. Toggle OFF for paid/pro: ask first.
    if (newValue || (field !== 'is_paid' && field !== 'is_pro')) {
      toggleMutation.mutate({ [field]: newValue });
      return;
    }
    setPendingToggle({
      field,
      label: field === 'is_paid' ? 'Paid subscriber' : 'Pro subscriber',
    });
  }

  function resolveToggleOff(cancelStripe: boolean) {
    if (!pendingToggle) return;
    toggleMutation.mutate({ [pendingToggle.field]: false });
    if (cancelStripe) {
      cancelStripeMutation.mutate();
    }
    setPendingToggle(null);
  }

  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleSaveProfile() {
    updateMutation.mutate({
      first_name: form.first_name || undefined,
      medication: form.medication || undefined,
      injection_day: form.injection_day || null,
      wake_time: form.wake_time || undefined,
      sleep_time: form.sleep_time || undefined,
      timezone: form.timezone || undefined,
      goals: form.goals ? form.goals.split(',').map((s) => s.trim()).filter(Boolean) : [],
      food_dislikes: form.food_dislikes ? form.food_dislikes.split(',').map((s) => s.trim()).filter(Boolean) : [],
      current_weight: form.current_weight ? Number(form.current_weight) : null,
      goal_weight: form.goal_weight ? Number(form.goal_weight) : null,
      age: form.age ? Number(form.age) : null,
      protein_goal_grams: form.protein_goal_grams ? Number(form.protein_goal_grams) : null,
      glp1_start_date: form.glp1_start_date || null,
      checkin_count_per_day: form.checkin_count_per_day ? Number(form.checkin_count_per_day) : undefined,
    });
  }

  const daysLeft = detail ? trialDaysLeft(detail.trial_start) : null;

  if (!user) return null;

  return (
    <Sheet open={!!user} onOpenChange={(open) => { if (!open) { onClose(); setConfirmDelete(false); } }}>
      <SheetContent side="right" className="w-[520px] sm:max-w-[520px] p-0 flex flex-col">
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="flex items-start justify-between gap-3">
            <div>
              <p className="text-lg font-semibold">{detail?.first_name ?? user.first_name ?? 'Unknown'}</p>
              <p className="text-sm font-mono text-muted-foreground font-normal">{user.phone}</p>
            </div>
            <div className="flex flex-wrap gap-1 justify-end">
              {user.blocked && <Badge variant="destructive">Blocked</Badge>}
              {user.paused && <Badge variant="secondary">Paused</Badge>}
              {user.is_pro && <Badge className="bg-purple-600">Pro</Badge>}
              {user.is_paid && !user.is_pro && <Badge className="bg-blue-600">Paid</Badge>}
              {!user.is_paid && !user.is_pro && daysLeft !== null && daysLeft > 0 && (
                <Badge variant="outline" className="text-amber-600 border-amber-400">Trial ({daysLeft}d left)</Badge>
              )}
              {!user.is_paid && !user.is_pro && (daysLeft === null || daysLeft <= 0) && (
                <Badge variant="outline" className="text-muted-foreground">Free</Badge>
              )}
            </div>
          </SheetTitle>
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.message_count} messages · joined {formatDate(detail?.created_at ?? null)}
            </p>
          )}
        </SheetHeader>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
        ) : (
          <Tabs defaultValue="profile" className="flex-1 flex flex-col min-h-0">
            <TabsList className="mx-6 mt-3 mb-0 self-start">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>

            {/* ── Profile tab ──────────────────────────────────────────── */}
            <TabsContent value="profile" className="flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="px-6 py-4 space-y-6">

                  {/* Account controls */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Account</p>
                    <div className="space-y-3">
                      {([
                        ['is_paid', 'Paid subscriber', 'blue'],
                        ['is_pro', 'Pro subscriber', 'purple'],
                        ['paused', 'Paused (no proactive messages)', 'amber'],
                        ['blocked', 'Blocked (ignores all messages)', 'red'],
                      ] as ['is_paid' | 'is_pro' | 'paused' | 'blocked', string, string][]).map(([field, label]) => (
                        <div key={field} className="flex items-center justify-between">
                          <Label className="text-sm">{label}</Label>
                          <Switch
                            checked={!!(detail as Record<string, unknown>)?.[field]}
                            onCheckedChange={(val) => handleAccountToggle(field, val)}
                            disabled={toggleMutation.isPending || cancelStripeMutation.isPending}
                          />
                        </div>
                      ))}
                      <div className="flex items-center justify-between">
                        <Label className="text-sm">RLHF contributor (sees rating prompts)</Label>
                        <Switch
                          checked={user.rlhf_enabled}
                          onCheckedChange={(val) => rlhfMutation.mutate(val)}
                          disabled={rlhfMutation.isPending}
                        />
                      </div>
                    </div>
                    {detail?.trial_start && (
                      <div className="mt-3 flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Trial started</span>
                        <div className="flex items-center gap-2">
                          <span>{formatDate(detail.trial_start)}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-xs"
                            onClick={() => toggleMutation.mutate({ trial_start: new Date().toISOString() })}
                            disabled={toggleMutation.isPending}
                          >
                            Reset trial
                          </Button>
                        </div>
                      </div>
                    )}
                  </section>

                  <Separator />

                  {/* Editable profile */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Profile</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">First name</Label>
                        <Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Medication</Label>
                        <Input value={form.medication} onChange={(e) => setForm({ ...form, medication: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Injection day</Label>
                        <Input placeholder="Monday" value={form.injection_day} onChange={(e) => setForm({ ...form, injection_day: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Timezone</Label>
                        <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Wake time</Label>
                        <Input type="time" value={form.wake_time} onChange={(e) => setForm({ ...form, wake_time: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Sleep time</Label>
                        <Input type="time" value={form.sleep_time} onChange={(e) => setForm({ ...form, sleep_time: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Current weight (lbs)</Label>
                        <Input type="number" value={form.current_weight} onChange={(e) => setForm({ ...form, current_weight: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Goal weight (lbs)</Label>
                        <Input type="number" value={form.goal_weight} onChange={(e) => setForm({ ...form, goal_weight: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Age</Label>
                        <Input type="number" placeholder="e.g. 42" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Protein goal (g/day)</Label>
                        <Input type="number" placeholder="e.g. 100" value={form.protein_goal_grams} onChange={(e) => setForm({ ...form, protein_goal_grams: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">GLP-1 start date</Label>
                        <Input type="date" value={form.glp1_start_date} onChange={(e) => setForm({ ...form, glp1_start_date: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Check-ins / day (1–4)</Label>
                        <Input type="number" min={1} max={4} placeholder="1" value={form.checkin_count_per_day} onChange={(e) => setForm({ ...form, checkin_count_per_day: e.target.value })} />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-xs">Goals (comma-separated)</Label>
                        <Input placeholder="Losing weight, Eating enough protein" value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })} />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-xs">Food dislikes (comma-separated)</Label>
                        <Input placeholder="broccoli, mushrooms" value={form.food_dislikes} onChange={(e) => setForm({ ...form, food_dislikes: e.target.value })} />
                      </div>
                    </div>
                    <Button className="mt-4 w-full" onClick={handleSaveProfile} disabled={updateMutation.isPending}>
                      {updateMutation.isPending ? 'Saving…' : 'Save profile'}
                    </Button>
                  </section>

                  <Separator />

                  {/* Stripe billing — live view (read-only, source of truth) */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1.5">
                      <CreditCard className="h-3.5 w-3.5" /> Stripe billing
                    </p>
                    {stripeLoading ? (
                      <p className="text-sm text-muted-foreground">Loading Stripe data…</p>
                    ) : stripeError ? (
                      <p className="text-xs text-muted-foreground">
                        {(stripeError as Error).message?.includes('not configured')
                          ? 'Stripe not configured on the API server.'
                          : `Failed to load: ${(stripeError as Error).message}`}
                      </p>
                    ) : !stripeData?.customer_id ? (
                      <p className="text-sm text-muted-foreground">
                        No Stripe customer yet — user is on trial or hasn't started checkout.
                      </p>
                    ) : (
                      <div className="space-y-2 text-sm">
                        {stripeData.subscription ? (
                          <>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Status</span>
                              <Badge variant={
                                stripeData.subscription.status === 'active' ? 'default'
                                  : stripeData.subscription.status === 'trialing' ? 'secondary'
                                  : stripeData.subscription.status === 'past_due' ? 'destructive'
                                  : 'outline'
                              } className="capitalize">
                                {stripeData.subscription.status.replace(/_/g, ' ')}
                              </Badge>
                            </div>
                            {stripeData.subscription.plan_name && (
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Plan</span>
                                <span>{stripeData.subscription.plan_name}</span>
                              </div>
                            )}
                            {stripeData.subscription.amount !== null && (
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">Amount</span>
                                <span>
                                  {(stripeData.subscription.amount / 100).toFixed(2)}{' '}
                                  {stripeData.subscription.currency?.toUpperCase()}
                                </span>
                              </div>
                            )}
                            {stripeData.subscription.current_period_end && (
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">
                                  {stripeData.subscription.cancel_at_period_end ? 'Cancels on' : 'Next billing'}
                                </span>
                                <span>
                                  {formatDate(new Date(stripeData.subscription.current_period_end * 1000).toISOString())}
                                </span>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">No subscription on file.</p>
                        )}
                        {stripeData.payment_method && (
                          <div className="flex justify-between pt-2 border-t">
                            <span className="text-muted-foreground">Card</span>
                            <span className="font-mono text-xs">
                              {stripeData.payment_method.brand?.toUpperCase()} •••• {stripeData.payment_method.last4} (exp{' '}
                              {String(stripeData.payment_method.exp_month).padStart(2, '0')}/{String(stripeData.payment_method.exp_year ?? '').slice(-2)})
                            </span>
                          </div>
                        )}
                        {stripeData.customer_dashboard_url && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full mt-2 h-8 text-xs"
                            onClick={() => window.open(stripeData.customer_dashboard_url!, '_blank', 'noopener,noreferrer')}
                          >
                            <ExternalLink className="h-3 w-3 mr-1.5" />
                            Open in Stripe Dashboard
                          </Button>
                        )}
                      </div>
                    )}

                    {/* Two-way sync actions */}
                    <div className="mt-3 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="h-8 text-xs"
                          disabled={syncStripeMutation.isPending}
                          onClick={() => syncStripeMutation.mutate()}>
                          {syncStripeMutation.isPending ? 'Syncing…' : 'Sync from Stripe'}
                        </Button>
                        {stripeData?.subscription?.cancel_at_period_end && (
                          <Button size="sm" variant="outline" className="h-8 text-xs"
                            disabled={reactivateMutation.isPending}
                            onClick={() => reactivateMutation.mutate()}>
                            Reactivate
                          </Button>
                        )}
                        {stripeData?.subscription && (
                          <Button size="sm" variant="outline" className="h-8 text-xs"
                            disabled={changePlanMutation.isPending}
                            onClick={() => changePlanMutation.mutate(detail?.is_pro ? 'base' : 'pro')}>
                            Switch to {detail?.is_pro ? 'Standard' : 'Pro'}
                          </Button>
                        )}
                      </div>
                      {(detail?.stripe_synced_at || detail?.stripe_sync_error) && (
                        <p className={`text-[11px] ${detail?.stripe_sync_error ? 'text-rose-400' : 'text-muted-foreground'}`}>
                          {detail?.stripe_sync_error
                            ? `Last sync error: ${detail.stripe_sync_error}`
                            : `Last synced ${formatDate(detail?.stripe_synced_at ?? null)}`}
                        </p>
                      )}
                    </div>
                  </section>

                  <Separator />

                  {/* Manual message + internal notes */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1.5">
                      <MessageSquare className="h-3.5 w-3.5" /> Send a message
                    </p>
                    <textarea
                      value={manualMsg}
                      onChange={(e) => setManualMsg(e.target.value)}
                      placeholder="Type a WhatsApp message to send to this user…"
                      rows={3}
                      maxLength={1500}
                      className="w-full text-sm rounded-md border bg-transparent px-3 py-2 resize-y"
                    />
                    <Button
                      className="mt-2 w-full"
                      size="sm"
                      disabled={!manualMsg.trim() || sendMessageMutation.isPending}
                      onClick={() => sendMessageMutation.mutate(manualMsg.trim())}
                    >
                      {sendMessageMutation.isPending ? 'Sending…' : 'Send WhatsApp message'}
                    </Button>

                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-5 mb-2">Internal notes</p>
                    <div className="flex gap-2">
                      <Input
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Add an internal note…"
                        onKeyDown={(e) => { if (e.key === 'Enter' && noteText.trim()) addNoteMutation.mutate(noteText.trim()); }}
                      />
                      <Button size="sm" variant="outline" disabled={!noteText.trim() || addNoteMutation.isPending}
                        onClick={() => addNoteMutation.mutate(noteText.trim())}>
                        Add
                      </Button>
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {(notesQuery.data?.notes ?? []).map((n) => (
                        <div key={n.id} className="text-xs rounded-md border px-3 py-2 flex items-start justify-between gap-2">
                          <div>
                            <p className="text-foreground">{n.note}</p>
                            <p className="text-muted-foreground mt-0.5">{n.author} · {formatDate(n.created_at)}</p>
                          </div>
                          <button className="text-muted-foreground hover:text-destructive" onClick={() => deleteNoteMutation.mutate(n.id)}>×</button>
                        </div>
                      ))}
                      {(notesQuery.data?.notes ?? []).length === 0 && (
                        <p className="text-xs text-muted-foreground">No notes yet.</p>
                      )}
                    </div>
                  </section>

                  <Separator />

                  {/* Danger zone */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-destructive mb-3 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" /> Danger zone
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={resetMutation.isPending} onClick={() => resetMutation.mutate()}>
                        Reset memory
                      </Button>
                      {confirmDelete ? (
                        <>
                          <Button size="sm" variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                            Confirm delete
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                          Delete user
                        </Button>
                      )}
                    </div>
                  </section>
                </div>
              </ScrollArea>
            </TabsContent>

            {/* ── History tab ──────────────────────────────────────────── */}
            <TabsContent value="history" className="flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="px-6 py-4 space-y-6">

                  {/* Weight chart */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1.5">
                      <Scale className="h-3.5 w-3.5" /> Weight history
                    </p>
                    {weightLogs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No weight logs yet.</p>
                    ) : (
                      <>
                        <ResponsiveContainer width="100%" height={160}>
                          <LineChart data={weightLogs.map((w) => ({ date: formatDateShort(w.created_at), weight: w.weight }))}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v: number) => [`${v} lbs`]} />
                            <Line type="monotone" dataKey="weight" stroke="#c97b5c" strokeWidth={2} dot={{ r: 3 }} />
                          </LineChart>
                        </ResponsiveContainer>
                        <div className="mt-2 space-y-1">
                          {weightLogs.slice(-5).reverse().map((w, i) => (
                            <div key={i} className="flex justify-between text-xs text-muted-foreground">
                              <span>{formatDate(w.created_at)}</span>
                              <span className="font-medium tabular-nums">{w.weight} lbs</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </section>

                  <Separator />

                  {/* Check-ins */}
                  <section>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-1.5">
                      <Activity className="h-3.5 w-3.5" /> Recent check-ins
                    </p>
                    {checkIns.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No check-ins yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {checkIns.map((ci, i) => (
                          <div key={i} className="border rounded-lg p-3 space-y-1 text-sm">
                            <div className="flex items-center justify-between">
                              <Badge variant="outline" className="text-xs capitalize">{ci.type.replace(/_/g, ' ')}</Badge>
                              <div className="flex items-center gap-2">
                                {ci.mood_score !== null && (
                                  <span className="text-xs text-muted-foreground">mood {ci.mood_score}/10</span>
                                )}
                                <span className="text-xs text-muted-foreground">{formatDate(ci.created_at)}</span>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground line-clamp-2">{ci.message_sent}</p>
                            {ci.user_reply && (
                              <p className="text-xs flex items-start gap-1">
                                <MessageSquare className="h-3 w-3 mt-0.5 flex-shrink-0 text-muted-foreground" />
                                {ci.user_reply}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
      <AlertDialog
        open={!!pendingToggle}
        onOpenChange={(open) => { if (!open) setPendingToggle(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turning off {pendingToggle?.label.toLowerCase()}</AlertDialogTitle>
            <AlertDialogDescription>
              Cancel the Stripe subscription too? The user's billing record stays in Stripe but
              renewal will be turned off at period end.
              <br /><br />
              <span className="text-foreground font-medium">Just override:</span> revokes access in Grace
              only — Stripe keeps charging.
              <br />
              <span className="text-foreground font-medium">Cancel Stripe too:</span> revokes access AND
              cancels the subscription in Stripe at period end.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel onClick={() => setPendingToggle(null)}>Never mind</AlertDialogCancel>
            <AlertDialogAction
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
              onClick={() => resolveToggleOff(false)}
            >
              Just override
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => resolveToggleOff(true)}
            >
              Cancel Stripe too
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
