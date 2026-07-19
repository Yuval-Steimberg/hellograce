// User-facing settings API client — phone + verification-code flow against the
// v2 API (no admin token, no Supabase dependency). Used by the Settings page.

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

export interface SettingsProfile {
  phone: string;
  first_name: string | null;
  medication: string | null;
  medication_frequency: string | null;
  dose_mg: number | null;
  injection_day: string | null;
  timezone: string | null;
  wake_time: string | null;
  sleep_time: string | null;
  current_weight: number | null;
  goal_weight: number | null;
  starting_weight: number | null;
  height_cm: number | null;
  age: number | null;
  sex: string | null;
  primary_goal: string | null;
  activity_level: string | null;
  protein_goal_grams: number | null;
  calorie_goal_kcal: number | null;
  dietary_pattern: string | null;
  dietary_restriction: string | null;
  food_dislikes: string[];
  goals: string[];
  checkin_count_per_day: number | null;
  checkin_days_interval: number | null;
  sms_consent: boolean;
  glp1_start_date: string | null;
  medication_time: string | null;
  biggest_challenge: string | null;
  why_started: string | null;
  support_style: string | null;
  exercise_habits: string | null;
  is_paid: boolean;
  is_pro: boolean;
  trial_start: string | null;
}

export type SettingsUpdate = Partial<Omit<SettingsProfile, 'phone' | 'is_paid' | 'is_pro' | 'trial_start'>>;

const TOKEN_KEY = 'grace_settings_token';
export const getSettingsToken = (): string | null => sessionStorage.getItem(TOKEN_KEY);
export const setSettingsToken = (t: string): void => sessionStorage.setItem(TOKEN_KEY, t);
export const clearSettingsToken = (): void => sessionStorage.removeItem(TOKEN_KEY);

async function call<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
  if (init.auth) {
    const token = getSettingsToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (body.message as string) || (body.error as string) || `HTTP ${res.status}`;
    const e = new Error(msg) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return body as T;
}

export const settingsApi = {
  requestCode: (phone: string) =>
    call<{ ok: boolean; sent: boolean; devCode?: string }>('/settings/request-code', { method: 'POST', body: JSON.stringify({ phone }) }),

  verifyCode: (phone: string, code: string) =>
    call<{ ok: boolean; token: string; profile: SettingsProfile }>('/settings/verify-code', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    }),

  me: () => call<{ profile: SettingsProfile }>('/settings/me', { auth: true }),

  update: (fields: SettingsUpdate) =>
    call<{ ok: boolean; profile: SettingsProfile }>('/settings/me', {
      method: 'PUT',
      auth: true,
      body: JSON.stringify(fields),
    }),
};
