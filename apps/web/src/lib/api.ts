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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
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
  active: boolean;
  paused: boolean;
  blocked: boolean;
  is_paid: boolean;
  is_pro: boolean;
  rlhf_enabled: boolean;
  trial_start: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessData {
  totals: { users: number; paid: number; pro: number; trial_active: number; mrr: number; conversion_pct: number };
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

// ─── API calls ────────────────────────────────────────────────────────────────

export const api = {
  metrics: () => apiFetch<Metrics>('/admin/metrics'),

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
};
