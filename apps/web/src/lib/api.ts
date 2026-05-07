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

export interface Metrics {
  messages_last_24h: number;
  tools: { tool_name: string; count: string; ok_rate: string; p95_ms: number }[];
  feedback_last_7d: { signal_type: string; count: string; avg_rating: number | null }[];
  cache: { hits: number; misses: number; hitRate: number } | null;
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
  injection_day: string | null;
  injection_count: number;
  last_morning_sent_at: string | null;
  last_reply_at: string | null;
  created_at: string;
}

// ─── API calls ────────────────────────────────────────────────────────────────

export const api = {
  metrics: () => apiFetch<Metrics>('/admin/metrics'),

  conversations: () => apiFetch<{ conversations: Conversation[] }>('/admin/conversations'),

  messages: (userId: string) =>
    apiFetch<{ messages: Message[] }>(`/admin/conversations/${userId}/messages`),

  feedback: {
    list: () => apiFetch<{ feedback: FeedbackEntry[] }>('/admin/feedback'),
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
};
