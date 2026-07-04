// User-facing dashboard API client. Reuses the SAME session token as the
// Settings page (sessionStorage `grace_settings_token`), so one phone+code
// verification unlocks both — the user never logs in twice.

import { getSettingsToken } from "./settingsApi";

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3001";

export interface DashboardSummary {
  generatedAt: string;
  profile: {
    firstName: string | null;
    medication: string | null;
    doseMg: number | null;
    injectionDay: string | null;
    glp1Week: number | null;
    primaryGoal: string | null;
    goals: string[];
    isPro: boolean;
    isPaid: boolean;
  };
  weight: {
    start: number | null;
    current: number | null;
    goal: number | null;
    lostLbs: number | null;
    toGoLbs: number | null;
    pct: number | null;
    series: Array<{ date: string; weight: number }>;
  };
  nutrition: {
    today: {
      protein: number;
      calories: number;
      proteinGoal: number;
      calorieGoal: number | null;
      items: Array<{ food: string; protein: number; calories: number }>;
    };
    proteinGoal: number;
    calorieGoal: number | null;
    history: Array<{ day: string; protein: number; calories: number; itemCount: number }>;
    streak: number;
  };
  hydration: {
    today: number;
    goalMin: number;
    goalMax: number;
    history: Array<{ day: string; oz: number }>;
  };
  weekly: {
    avgProtein: number | null;
    proteinGoal: number | null;
    daysProteinLogged: number;
    avgOz: number | null;
    daysWaterLogged: number;
    daysWaterAtGoal: number;
    waterDaysWindow: number;
    weightDeltaLbs: number | null;
    plateau: { stalled: boolean; days: number; deltaLbs: number } | null;
    insight: string | null;
  };
  mood: { series: Array<{ date: string; score: number }> };
  symptoms: {
    patterns: Array<{ symptom: string; count: number; typicalTiming: string | null; topRemedy: string | null }>;
    recent: Array<{ symptom: string; daysSinceInjection: number | null; remedyHelped: string | null; date: string }>;
    total: number;
  };
}

async function call<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.body ? { "Content-Type": "application/json" } : {}) };
  if (init.auth !== false) {
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

export const dashboardApi = {
  summary: () => call<DashboardSummary>("/dashboard/summary", { auth: true }),

  logWeight: (weight: number, unit: "lbs" | "kg" = "lbs") =>
    call<{ ok: boolean; weight: DashboardSummary["weight"] }>("/dashboard/weight", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ weight, unit }),
    }),

  logMood: (score: number) =>
    call<{ ok: boolean }>("/dashboard/mood", { method: "POST", auth: true, body: JSON.stringify({ score }) }),

  logWater: (oz: number) =>
    call<{ ok: boolean; today: number; goalMin: number; goalMax: number }>(
      "/dashboard/water",
      { method: "POST", auth: true, body: JSON.stringify({ oz }) },
    ),

  logSymptom: (symptom: string, remedy?: string) =>
    call<{ ok: boolean; symptom: string; pattern: DashboardSummary["symptoms"]["patterns"][number] | null }>(
      "/dashboard/symptom",
      { method: "POST", auth: true, body: JSON.stringify({ symptom, remedy: remedy || undefined }) },
    ),

  logFood: (text: string) =>
    call<{ ok: boolean; logged: { food: string; protein: number | null; calories: number | null }; todayProtein: number | null; todayCalories: number | null }>(
      "/dashboard/food",
      { method: "POST", auth: true, body: JSON.stringify({ text }) },
    ),

  uploadPhoto: (dataUrl: string) =>
    call<{ ok: boolean; kind: "food" | "body"; logged: boolean; items?: string; protein?: number; calories?: number; ask?: string | null; analysis?: string; todayProtein?: number | null }>(
      "/dashboard/photo",
      { method: "POST", auth: true, body: JSON.stringify({ dataUrl }) },
    ),

  // Progress photo gallery.
  listPhotos: () => call<{ photos: ProgressPhoto[] }>("/dashboard/photos", { auth: true }),

  getPhoto: (id: string) => call<{ dataUrl: string }>(`/dashboard/photos/${id}`, { auth: true }),

  addProgressPhoto: (dataUrl: string, thumbUrl: string, note?: string, weight?: number) =>
    call<{ ok: boolean; photo: ProgressPhoto }>("/dashboard/progress-photo", {
      method: "POST",
      auth: true,
      body: JSON.stringify({ dataUrl, thumbUrl, note: note || undefined, weight: weight ?? undefined }),
    }),

  deletePhoto: (id: string) =>
    call<{ ok: boolean }>(`/dashboard/photos/${id}`, { method: "DELETE", auth: true }),
};

export interface ProgressPhoto {
  id: string;
  kind: string;
  note: string | null;
  weightLbs: number | null;
  thumbUrl: string | null;
  takenAt: string;
}
