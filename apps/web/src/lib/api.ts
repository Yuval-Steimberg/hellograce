const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

export function getToken(): string | null {
  return localStorage.getItem('grace_admin_token');
}
export function setToken(token: string): void {
  localStorage.setItem('grace_admin_token', token);
}
export function clearToken(): void {
  localStorage.removeItem('grace_admin_token');
}

// Admin actor label (e.g. the operator's name/email). Sent as X-Admin-Actor so
// every audited action is attributed to a person, not just "admin". Optional —
// defaults server-side to 'admin' when unset.
export function getActor(): string | null {
  return localStorage.getItem('grace_admin_actor');
}
export function setActor(actor: string): void {
  localStorage.setItem('grace_admin_actor', actor);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const actor = getActor();
  const hasBody = init?.body != null;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(actor ? { 'X-Admin-Actor': actor } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
    throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserStats {
  total: number;
  paid: number;
  pro: number;
  trial: number;
  paused: number;
  new_this_week: number;
}

export interface Metrics {
  messages_last_24h: number;
  tools: { tool_name: string; count: string; ok_rate: string; p95_ms: number }[];
  feedback_last_7d: { signal_type: string; count: string; avg_rating: number | null }[];
  cache: { hits: number; misses: number; hitRate: number } | null;
  user_stats: UserStats;
}

// ─── Admin analytics (cohorts / funnel / overview) ────────────────────────────

export type CohortGroup =
  | 'lifecycle' | 'onboarding' | 'trial' | 'payment' | 'activity' | 'engagement' | 'profile';

export interface CohortCount {
  key: string;
  label: string;
  group: CohortGroup;
  description: string;
  count: number;
  pct: number;
}
export interface CohortCountsResult {
  total: number;
  generated_at: string;
  cohorts: CohortCount[];
}
export interface CohortUserRow {
  phone: string;
  first_name: string | null;
  medication: string | null;
  is_paid: boolean;
  is_pro: boolean;
  paused: boolean;
  blocked: boolean;
  injection_day: string | null;
  onboarding_state: string | null;
  trial_start: string | null;
  last_reply_at: string | null;
  created_at: string;
  msgs_total: number;
  food_total: number;
  channel: string | null;
}
export interface CohortUsersResult {
  key: string;
  label: string;
  total: number;
  users: CohortUserRow[];
}
export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  from_prev_pct: number | null;
  drop_pct: number | null;
  of_total_pct: number;
  cohort_key: string | null;
  tracked: boolean;
}
export interface FunnelResult {
  generated_at: string;
  steps: FunnelStep[];
  note: string;
}
export interface CampaignPreview {
  cohort_key: string | null;
  matched: number;
  eligible_count: number;
  excluded_count: number;
  excluded_breakdown: { paused: number; blocked: number; inactive: number };
  sample: string[];
  over_cap: boolean;
  cap: number;
}
export interface CampaignSummary {
  id: number;
  actor: string;
  cohort_key: string | null;
  cohort_label: string | null;
  message: string;
  channel: string | null;
  status: string;
  audience_size: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  note: string | null;
  created_at: string;
  sent_at: string | null;
}
export interface CampaignDetail extends CampaignSummary {
  recipients: { phone: string; status: string; error: string | null; sent_at: string | null }[];
}
export interface CampaignSendResult {
  campaign_id: number;
  audience_size: number;
  sent: number;
  failed: number;
  skipped: number;
  status: string;
}

export interface AnalyticsOverview {
  generated_at: string;
  users: { total: number; new_today: number; new_7d: number; new_30d: number };
  active: { dau: number; wau: number; mau: number; series: { date: string; count: number }[] };
  rates: {
    onboarding_completion_pct: number;
    trial_start_pct: number;
    trial_conversion_pct: number;
    paid_conversion_pct: number;
    churn_pct: number;
    reminders_enabled_pct: number;
  };
  averages: { messages_per_user: number; food_logs_per_user: number };
  missing_onboarding_fields: { field: string; count: number }[];
  dropoff_slots: { slot: string; count: number }[];
  tracking: { website_visits: boolean; dashboard_opens: boolean; voice_usage: boolean };
}

export interface Conversation {
  id: string;
  user_id: string;
  message_count: string;
  last_message_at: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface FeedbackEntry {
  id: string;
  user_id: string;
  message_id: string | null;
  signal_type: string;
  rating: number | null;
  comment: string | null;
  created_at: string;
  assistant_message?: string | null;
}

export interface FeedbackFilters {
  userId?: string;
  date?: 'today' | '7d' | '30d' | 'all';
  signalType?: string;
  rating?: '1' | '-1';
  limit?: number;
  offset?: number;
}

export interface Prompt {
  id: string;
  version: number;
  content: string;
  active: boolean;
  created_at: string;
}

export interface ToolSetting {
  tool_name: string;
  enabled: boolean;
  priority: number;
  updated_at: string;
}

export interface AdminUser {
  phone: string;
  first_name: string | null;
  medication: string | null;
  goals: string[];
  timezone: string;
  active: boolean;
  paused: boolean;
  blocked: boolean;
  is_paid: boolean;
  is_pro: boolean;
  rlhf_enabled: boolean;
  injection_day: string | null;
  injection_count: number;
  last_morning_sent_at: string | null;
  last_reply_at: string | null;
  created_at: string;
}

export interface CheckIn {
  type: string;
  message_sent: string;
  user_reply: string | null;
  mood_score: number | null;
  created_at: string;
}

export interface StripeBillingSnapshot {
  customer_id: string | null;
  customer_dashboard_url: string | null;
  subscription: {
    id: string;
    status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired' | 'paused';
    plan_name: string | null;
    current_period_end: number | null;
    amount: number | null;
    currency: string | null;
    cancel_at_period_end: boolean;
    canceled_at: number | null;
  } | null;
  payment_method: {
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
  } | null;
}

export interface WeightLog {
  weight: number;
  created_at: string;
}

export interface UserDetail {
  phone: string;
  first_name: string | null;
  medication: string | null;
  medication_frequency: string;
  injection_day: string | null;
  injection_count: number;
  goals: string[];
  food_dislikes: string[];
  timezone: string;
  wake_time: string;
  sleep_time: string;
  current_weight: number | null;
  goal_weight: number | null;
  starting_weight: number | null;
  height_cm: number | null;
  dose_mg: number | null;
  sex: string | null;
  activity_level: string | null;
  primary_goal: string | null;
  active: boolean;
  paused: boolean;
  blocked: boolean;
  is_paid: boolean;
  is_pro: boolean;
  rlhf_enabled: boolean;
  daily_summary_enabled: boolean;
  trial_start: string | null;
  age: number | null;
  protein_goal_grams: number | null;
  calorie_goal_kcal: number | null;
  dietary_pattern: string | null;
  dietary_restriction: string | null;
  glp1_start_date: string | null;
  checkin_count_per_day: number | null;
  checkin_days_interval: number | null;
  created_at: string;
  updated_at: string;
  // Stripe sync state (migration 20260613000001). Optional — absent on an
  // un-migrated DB.
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
  subscription_plan?: string | null;
  stripe_synced_at?: string | null;
  stripe_sync_error?: string | null;
}

export interface AdminNote {
  id: number;
  target_user: string;
  author: string;
  note: string;
  created_at: string;
}

export interface FlaggedResponse {
  id: number;
  message_id: string | null;
  user_id: string;
  reason: string;
  note: string | null;
  status: 'open' | 'reviewed';
  created_by: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actor: string | null;
  target_user: string | null;
  admin_ip: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface StripeEvent {
  id: number;
  stripe_event_id: string;
  type: string;
  status: string;
  target_user: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  processed_at: string | null;
}

export interface BusinessData {
  totals: {
    users: number; paid: number; pro: number; trial_active: number; mrr: number;
    mrr_source?: 'stripe' | 'estimated'; mrr_currency?: string | null; active_subscriptions?: number | null;
    conversion_pct: number;
  };
  active: { active_7d: number; active_30d: number };
  weekly_signups: { week: string; count: number }[];
  retention: { cohort: string; signed_up: number; retained: number; pct: number }[];
}

export interface SchedulerUser {
  phone: string; first_name: string | null; timezone: string | null;
  wake_time: number | null; sleep_time: number | null;
  injection_day: string | null; injection_flow_stage: string | null;
  last_morning_sent_at: string | null; last_midday_sent_at: string | null;
  last_evening_sent_at: string | null; last_reply_at: string | null;
  is_paid: boolean; is_pro: boolean; trial_start: string | null;
  checkin_count_per_day: number | null; side_effect_flow: string | null;
}

export interface AIQualityData {
  tools: { name: string; calls: number; successes: number; success_rate: number; avg_latency_ms: number }[];
  fallback_trend: { day: string; count: number }[];
  satisfaction_trend: { day: string; positive: number; negative: number; total: number; pct: number | null }[];
  latency_trend: { day: string; avg_ms: number }[];
  prompts: { version: number; active: boolean; created_at: string; notes: string | null; auto_generated: boolean | null }[];
}

export interface SystemHealth {
  db: { ok: boolean };
  redis: { ok: boolean; latency_ms: number | null };
  messages_24h: number;
  fallbacks_24h: number;
  fallback_rate_24h: number;
  tool_calls_24h: number;
  tool_failures_24h: number;
  tool_avg_latency_ms: number | null;
  message_volume: { hour: string; count: number }[];
}

export interface MessageTemplate {
  id: number;
  key: string;
  template: string;
  description: string | null;
  variables: string[];
  is_active: boolean;
  updated_at: string;
}

export interface ContentRule {
  id: number;
  rule_type: string;
  pattern: string;
  is_regex: boolean;
  flags: string;
  reason: string;
  severity: 'block' | 'regen' | 'log';
  applies_to: 'ai' | 'scheduler' | 'all';
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

// ─── Auto-Eval Types ─────────────────────────────────────────────────────────

export interface AutoEvalReport {
  runId: string;
  timestamp: string;
  model: string;
  totalConversations: number;
  totalTurns: number;
  overallScore: number;
  passRate: number;
  scoreByCategory: Record<string, { avg: number; count: number; passRate: number; worstScore: number }>;
  scoreByDimension: Record<string, { avg: number; failRate: number }>;
  topPatterns: Array<{ pattern: string; frequency: number; avgScoreImpact: number; category: string }>;
  regressions: Array<{ dimension: string; previousAvg: number; currentAvg: number; delta: number; significance: string }>;
  improvementSuggestions: string[];
  preferencePairsGenerated: number;
}

export interface AutoEvalConversationSummary {
  id: string;
  scenarioId: string;
  personaId: string;
  personaName: string;
  category: string;
  scenarioDescription: string;
  overallScore: number;
  turnCount: number;
}

export interface AutoEvalTurnDetail {
  turnIndex: number;
  userMessage: string;
  graceResponse: string;
  overallScore: number;
  dimensions: Array<{ name: string; score: number; reasoning: string }>;
  strengths: string[];
  weaknesses: string[];
  criticalIssues: string[];
  adminReviewed?: boolean;
  adminOverrides?: Array<{ dimension: string; originalScore: number; newScore: number; adminNote: string }>;
}

export interface AutoEvalConversationDetail {
  conversation: {
    id: string;
    scenarioId: string;
    personaId: string;
    persona: { name: string; communicationStyle: string; backstory: string };
    scenario: { description: string; category: string; challenges: string[] };
    turns: Array<{ role: string; text: string }>;
  };
  evaluation: {
    overallScore: number;
    summary: string;
    conversationLevelIssues: string[];
    memoryUsageScore: number;
    consistencyScore: number;
    turnEvaluations: AutoEvalTurnDetail[];
  };
}

export interface AutoEvalPreferencePair {
  id: string;
  conversationId: string;
  turnIndex: number;
  userMessage: string;
  chosen: string;
  rejected: string;
  chosenScore: number;
  rejectedScore: number;
  dimension: string;
  reasoning: string;
}

export interface AutoEvalRunStatus {
  running: boolean;
  phase: 'simulating' | 'evaluating' | 'analyzing' | 'preference_pairs' | 'reporting' | 'done' | 'error';
  progress: number;
  total: number;
  completed: number;
  startedAt: string;
  error?: string;
}

export interface AutoEvalProgressEvent {
  phase: string;
  progress: number;
  total: number;
  completed: number;
  message: string;
  score?: number;
  error?: string;
}

// ─── API calls ────────────────────────────────────────────────────────────────

export interface LatencyStats {
  window: string;
  overall: { n: string; p50: string; p95: string; p99: string; max: string; avg: string } | null;
  by_intent: { intent: string; n: string; p50: string; p95: string; p99: string; avg: string }[];
  by_stage: { stage: string; avg_ms: string; p95_ms: string; n: string }[];
  slow_samples: { intent: string; latency_ms: number; created_at: string; content: string }[];
}

export const api = {
  metrics: () => apiFetch<Metrics>('/admin/metrics'),
  latency: (window = '24h') => apiFetch<LatencyStats>(`/admin/latency?window=${encodeURIComponent(window)}`),

  // Admin analytics (cohorts / funnel / business overview)
  cohorts: () => apiFetch<CohortCountsResult>('/admin/cohorts'),
  cohortUsers: (key: string, opts?: { limit?: number; offset?: number; search?: string }) => {
    const p = new URLSearchParams();
    if (opts?.limit) p.set('limit', String(opts.limit));
    if (opts?.offset) p.set('offset', String(opts.offset));
    if (opts?.search) p.set('search', opts.search);
    const qs = p.toString();
    return apiFetch<CohortUsersResult>(`/admin/cohorts/${encodeURIComponent(key)}/users${qs ? `?${qs}` : ''}`);
  },
  funnel: () => apiFetch<FunnelResult>('/admin/funnel'),
  analytics: () => apiFetch<AnalyticsOverview>('/admin/analytics'),

  // Admin group messaging (campaigns)
  campaigns: {
    preview: (body: { cohort_key?: string; phones?: string[] }) =>
      apiFetch<CampaignPreview>('/admin/campaigns/preview', { method: 'POST', body: JSON.stringify(body) }),
    send: (body: { cohort_key?: string; cohort_label?: string; phones?: string[]; message: string; channel?: string; note?: string; confirm: true }) =>
      apiFetch<CampaignSendResult>('/admin/campaigns/send', { method: 'POST', body: JSON.stringify(body) }),
    draft: (body: { cohort_key?: string; cohort_label?: string; message: string; channel?: string; note?: string }) =>
      apiFetch<{ id: number }>('/admin/campaigns/draft', { method: 'POST', body: JSON.stringify(body) }),
    enhance: (body: { message: string; tone?: 'warm' | 'concise' | 'motivating' | 'friendly'; audience_label?: string }) =>
      apiFetch<{ enhanced: string }>('/admin/campaigns/enhance', { method: 'POST', body: JSON.stringify(body) }),
    list: (limit = 50) => apiFetch<{ campaigns: CampaignSummary[] }>(`/admin/campaigns?limit=${limit}`),
    get: (id: number) => apiFetch<CampaignDetail>(`/admin/campaigns/${id}`),
    sendDraft: (id: number) =>
      apiFetch<CampaignSendResult>(`/admin/campaigns/${id}/send`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  },

  conversations: () => apiFetch<{ conversations: Conversation[] }>('/admin/conversations'),

  messages: (userId: string) =>
    apiFetch<{ messages: Message[] }>(`/admin/conversations/${userId}/messages`),

  feedback: {
    list: (filters?: FeedbackFilters) => {
      const params = new URLSearchParams();
      if (filters?.userId) params.set('userId', filters.userId);
      if (filters?.date && filters.date !== 'all') params.set('date', filters.date);
      if (filters?.signalType) params.set('signalType', filters.signalType);
      if (filters?.rating) params.set('rating', filters.rating);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return apiFetch<{ feedback: FeedbackEntry[] }>(`/admin/feedback${qs ? `?${qs}` : ''}`);
    },
    post: (body: {
      userId: string;
      signalType: string;
      messageId?: string;
      rating?: number;
      comment?: string;
    }) => apiFetch<{ ok: boolean }>('/admin/feedback', { method: 'POST', body: JSON.stringify(body) }),
  },

  prompts: {
    list: () => apiFetch<{ prompts: Prompt[] }>('/admin/prompts'),
    create: (content: string) =>
      apiFetch<{ prompt: Prompt }>('/admin/prompts', { method: 'POST', body: JSON.stringify({ content }) }),
    activate: (id: string) =>
      apiFetch<{ ok: boolean }>(`/admin/prompts/${id}/activate`, { method: 'PUT' }),
    autoImprove: () =>
      apiFetch<{ ok: boolean; prompt: Prompt; stats: { total: number; positive: number; negative: number; approvalRate: number | null } }>(
        '/admin/prompts/auto-improve',
        { method: 'POST' },
      ),
  },

  toolSettings: {
    list: () => apiFetch<{ tools: ToolSetting[] }>('/admin/tool-settings'),
    update: (name: string, enabled: boolean, priority: number) =>
      apiFetch<{ ok: boolean }>(`/admin/tool-settings/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled, priority }),
      }),
  },

  users: (limit = 100, offset = 0) =>
    apiFetch<{ users: AdminUser[]; total: number }>(`/admin/users?limit=${limit}&offset=${offset}`),

  userDetail: (phone: string) =>
    apiFetch<{ user: UserDetail; check_ins: CheckIn[]; weight_logs: WeightLog[]; message_count: number }>(
      `/admin/users/${encodeURIComponent(phone)}`,
    ),

  updateUser: (phone: string, fields: Partial<Omit<UserDetail, 'phone' | 'created_at' | 'updated_at'>>) =>
    apiFetch<{ ok: boolean }>(`/admin/users/${encodeURIComponent(phone)}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    }),

  deleteUser: (phone: string) =>
    apiFetch<{ ok: boolean }>(`/admin/users/${encodeURIComponent(phone)}`, { method: 'DELETE' }),

  resetMemory: (phone: string) =>
    apiFetch<{ ok: boolean }>(`/admin/users/${encodeURIComponent(phone)}/reset-memory`, { method: 'POST' }),

  toggleRlhf: (phone: string, enabled: boolean) =>
    apiFetch<{ ok: boolean }>(`/admin/users/${encodeURIComponent(phone)}/rlhf`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  stripeBilling: (phone: string) =>
    apiFetch<StripeBillingSnapshot>(`/admin/users/${encodeURIComponent(phone)}/stripe`),

  cancelStripeSubscription: (phone: string) =>
    apiFetch<{ ok: boolean; subscription_id: string; cancel_at: number | null }>(
      `/admin/users/${encodeURIComponent(phone)}/cancel-subscription`,
      { method: 'POST' },
    ),

  stripe: {
    sync: (phone: string) =>
      apiFetch<{ ok: boolean; customer_id: string | null; status: string | null; is_paid: boolean | null; is_pro: boolean | null; error?: string }>(
        `/admin/users/${encodeURIComponent(phone)}/stripe/sync`,
        { method: 'POST' },
      ),
    reactivate: (phone: string) =>
      apiFetch<{ ok: boolean; subscription_id: string }>(
        `/admin/users/${encodeURIComponent(phone)}/stripe/reactivate`,
        { method: 'POST' },
      ),
    changePlan: (phone: string, plan: 'base' | 'pro') =>
      apiFetch<{ ok: boolean; subscription_id: string; plan: string }>(
        `/admin/users/${encodeURIComponent(phone)}/stripe/change-plan`,
        { method: 'POST', body: JSON.stringify({ plan }) },
      ),
    events: (params?: { status?: string; limit?: number; offset?: number }) => {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return apiFetch<{ events: StripeEvent[] }>(`/admin/stripe/events${qs}`);
    },
    retryEvent: (id: number) =>
      apiFetch<{ ok: boolean; status: string; target_user: string | null }>(
        `/admin/stripe/events/${id}/retry`,
        { method: 'POST' },
      ),
  },

  sendMessage: (phone: string, text: string, channel?: 'whatsapp' | 'sms') =>
    apiFetch<{ ok: boolean; sid: string }>(`/admin/users/${encodeURIComponent(phone)}/send-message`, {
      method: 'POST',
      body: JSON.stringify({ text, ...(channel ? { channel } : {}) }),
    }),

  pauseUser: (phone: string) =>
    apiFetch<{ ok: boolean; paused: boolean }>(`/admin/users/${encodeURIComponent(phone)}/pause`, { method: 'POST' }),
  resumeUser: (phone: string) =>
    apiFetch<{ ok: boolean; paused: boolean }>(`/admin/users/${encodeURIComponent(phone)}/resume`, { method: 'POST' }),

  notes: {
    list: (phone: string) =>
      apiFetch<{ notes: AdminNote[] }>(`/admin/users/${encodeURIComponent(phone)}/notes`),
    add: (phone: string, note: string) =>
      apiFetch<{ ok: boolean; note: AdminNote }>(`/admin/users/${encodeURIComponent(phone)}/notes`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    remove: (id: number) =>
      apiFetch<{ ok: boolean }>(`/admin/notes/${id}`, { method: 'DELETE' }),
  },

  flags: {
    flag: (messageId: string, body: { user_id: string; reason: string; note?: string }) =>
      apiFetch<{ ok: boolean; flag: FlaggedResponse }>(`/admin/messages/${messageId}/flag`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    list: (status: 'open' | 'reviewed' = 'open') =>
      apiFetch<{ flags: FlaggedResponse[] }>(`/admin/flagged?status=${status}`),
    resolve: (id: number) =>
      apiFetch<{ ok: boolean }>(`/admin/flagged/${id}/resolve`, { method: 'PUT' }),
  },

  auditLogs: (params?: { action?: string; target_user?: string; date?: 'today' | '7d' | '30d'; limit?: number; offset?: number }) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return apiFetch<{ logs: AuditLogEntry[] }>(`/admin/audit-logs${qs}`);
  },

  onboard: (body: {
    firstName: string; phone: string; medication: string;
    medicationFrequency?: string; injectionDay?: string | null;
    wakeTime?: string; sleepTime?: string; foodDislikes?: string | null;
    currentWeight?: number | null; goalWeight?: number | null;
    goals?: string[]; timezone?: string;
    checkinCountPerDay?: number; checkinDaysInterval?: number;
  }) => apiFetch<{ ok: boolean; userId: string; phone: string }>('/users/onboard', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  business: () => apiFetch<BusinessData>('/admin/business'),
  schedulerStatus: () => apiFetch<{ users: SchedulerUser[] }>('/admin/scheduler-status'),
  aiQuality: () => apiFetch<AIQualityData>('/admin/ai-quality'),
  systemHealth: () => apiFetch<SystemHealth>('/admin/system-health'),
  contentRules: {
    list: (params?: { type?: string; severity?: string; active?: string }) => {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return apiFetch<{ rules: ContentRule[]; total: number }>(`/admin/content-rules${qs}`);
    },
    create: (body: Partial<ContentRule>) =>
      apiFetch<{ rule: ContentRule }>('/admin/content-rules', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: Partial<ContentRule>) =>
      apiFetch<{ rule: ContentRule }>(`/admin/content-rules/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    deactivate: (id: number) =>
      apiFetch<{ ok: boolean }>(`/admin/content-rules/${id}`, { method: 'DELETE' }),
    test: (text: string) =>
      apiFetch<{ violations: unknown[]; clean: boolean }>('/admin/content-rules/test', {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  },
  messageTemplates: {
    list: () => apiFetch<{ templates: MessageTemplate[] }>('/admin/message-templates'),
    update: (key: string, template: string) =>
      apiFetch<{ ok: true; template: MessageTemplate }>(`/admin/message-templates/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ template }),
      }),
    preview: (key: string, variables: Record<string, string>) =>
      apiFetch<{ rendered: string }>(`/admin/message-templates/${key}/preview`, {
        method: 'POST',
        body: JSON.stringify({ variables }),
      }),
  },

  autoEval: {
    reports: () => apiFetch<{ reports: AutoEvalReport[] }>('/admin/auto-eval/reports'),
    conversations: () => apiFetch<{ conversations: AutoEvalConversationSummary[] }>('/admin/auto-eval/conversations'),
    conversation: (id: string) => apiFetch<AutoEvalConversationDetail>(`/admin/auto-eval/conversations/${id}`),
    preferencePairs: () => apiFetch<{ pairs: AutoEvalPreferencePair[] }>('/admin/auto-eval/preference-pairs'),
    updateTurnEval: (conversationId: string, turnIndex: number, body: {
      overrides: Array<{ dimension: string; newScore: number; adminNote: string }>;
      adminApproved?: boolean;
    }) => apiFetch<{ ok: boolean }>(`/admin/auto-eval/evaluations/${conversationId}/turns/${turnIndex}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    learn: () => apiFetch<{ ok: boolean; evaluationsProcessed: number; preferencePairsGenerated: number; contentRulesGenerated: number }>(
      '/admin/auto-eval/learn', { method: 'POST' }
    ),
    autoGenRules: () => apiFetch<{ ok: boolean; rulesGenerated: number; rulesInserted: number; message: string }>(
      '/admin/content-rules/auto-generate', { method: 'POST' }
    ),
    startRun: (opts?: { scenarioCount?: number; concurrency?: number; categories?: string[] }) =>
      apiFetch<{ ok: boolean; message: string }>('/admin/auto-eval/run', {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }),
    status: () => apiFetch<{ running: boolean; state: AutoEvalRunStatus | null }>('/admin/auto-eval/status'),
  },
};
