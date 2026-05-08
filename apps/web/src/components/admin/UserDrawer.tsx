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
import { MessageSquare, Scale, Activity, AlertTriangle } from 'lucide-react';

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
                      ] as [keyof typeof detail, string, string][]).map(([field, label]) => (
                        <div key={field} className="flex items-center justify-between">
                          <Label className="text-sm">{label}</Label>
                          <Switch
                            checked={!!(detail as Record<string, unknown>)?.[field]}
                            onCheckedChange={(val) => toggleMutation.mutate({ [field]: val })}
                            disabled={toggleMutation.isPending}
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
    </Sheet>
  );
}
