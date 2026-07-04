import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { LLMProvider } from '@grace/shared';
import { z } from 'zod';
import type { UserService } from '../user/user.service.js';
import { ValidationError, UnauthorizedError, NotFoundError } from '../errors.js';
import { makeLogFoodTool } from '../tools/log-food.js';
import { isEncryptedBlob } from '../crypto/field-encrypt.js';
import { analyzeMedia } from '../multimodal/analyze.js';
import { parseFoodImageAnalysis } from '../services/ai.service.js';
import {
  classifySymptom,
  daysSinceInjection,
  localDayOfWeek,
  type CanonSymptom,
  type SymptomEpisode,
} from '../services/symptom-intelligence.js';
import {
  glp1WeekNumber,
  weightProgress,
  loggingStreak,
  summarizeSymptoms,
} from '../services/dashboard-data.js';
import { kgToLbs } from '../nutrition/units.js';
import { getTodaysWaterOz, getDailyWaterHistory, logWater } from '../services/water-log.js';
import { WATER_GOAL_MIN_OZ, WATER_GOAL_MAX_OZ } from '../nutrition/water.js';
import { computeWeeklyStats } from '../services/weekly-insights.js';

/**
 * Grace user dashboard API (2026-07-02).
 *
 * The "real app behind the messages": a phone-verified progress dashboard the
 * user opens from a link Grace texts them. Read their whole picture (weight,
 * nutrition, mood, and — the differentiator — their personal symptom patterns),
 * and write back to it (log a weight, mood, symptom, meal, or upload a photo).
 *
 * Auth reuses the Settings session token EXACTLY (same Redis `settings:session:`
 * key), so one phone+code verification unlocks both Settings and the dashboard —
 * the user never logs in twice. All reads are best-effort: a missing table (e.g.
 * symptom_episodes before its migration) degrades that section to empty, never a
 * 500.
 */

export interface DashboardRouteDeps {
  redis?: Redis;
  users: UserService;
  pool: Pool;
  llm: LLMProvider;
  logger: Logger;
  gemini: { apiKey: string; model: string; fallbackModel?: string };
}

const SESSION_TTL_SEC = 1800; // mirror settings.ts sliding session

/** Drop an unrecoverable ciphertext blob so the dashboard never renders it. */
const plainOrNull = (v: string | null | undefined): string | null =>
  v && isEncryptedBlob(v) ? null : (v ?? null);

/** Suppress an implausible GLP-1 week (mis-entered start date) — 260 weeks ≈ 5y. */
const saneWeek = (w: number | null): number | null => (w != null && w >= 1 && w <= 260 ? w : null);

const CANON_SYMPTOMS: CanonSymptom[] = [
  'nausea', 'vomiting', 'constipation', 'diarrhea', 'fatigue',
  'headache', 'dizziness', 'heartburn', 'bloating',
];

function toEpisode(r: {
  symptom: string; days_since_injection: number | null; dose_mg: number | null;
  remedy_helped: string | null; created_at: Date;
}): SymptomEpisode {
  return {
    symptom: r.symptom,
    days_since_injection: r.days_since_injection,
    dose_mg: r.dose_mg,
    remedy_helped: r.remedy_helped,
    created_at: r.created_at,
  };
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const sessionKey = (token: string) => `settings:session:${token}`;

  /** Resolve the verified phone from the Bearer session token (shared with the
   *  Settings flow), refreshing the sliding TTL — or throw 401. */
  async function requireVerifiedPhone(req: { headers: Record<string, unknown> }): Promise<string> {
    if (!deps.redis) throw new UnauthorizedError('Sessions unavailable');
    const auth = req.headers.authorization;
    const header = Array.isArray(auth) ? auth[0] : (typeof auth === 'string' ? auth : '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedError('Missing session token');
    const phone = await deps.redis.get(sessionKey(token));
    if (!phone) throw new UnauthorizedError('Session expired — verify again');
    await deps.redis.expire(sessionKey(token), SESSION_TTL_SEC).catch(() => undefined);
    return phone;
  }

  // ── GET /dashboard/summary — the whole progress picture ────────────────────
  app.get('/dashboard/summary', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const user = await deps.users.getByPhone(phone);
    if (!user) throw new UnauthorizedError('Account not found');

    const [weightRows, proteinHist, todayFood, moodRows, symptomRows, waterToday, waterHist] = await Promise.all([
      deps.users.getWeightHistory(phone, 90).catch(() => []),
      deps.users.getDailyProteinHistory(phone, 30).catch(() => [] as Array<{ day: string; protein_g: number; calories: number; item_count: number }>),
      deps.users.getTodaysFoodSummary(phone).catch(() => ({ protein_g: 0, calories: 0, items: [] as string[], items_detailed: [] as Array<{ food: string; protein_g: number; calories: number; logged_at: string }> })),
      deps.users.getMoodHistory(phone, 30).catch(() => [] as Array<{ mood_score: number; created_at: Date }>),
      deps.users.getRecentSymptomEpisodes(phone, 80).catch(() => [] as Array<{ symptom: string; days_since_injection: number | null; dose_mg: number | null; remedy_helped: string | null; created_at: Date }>),
      getTodaysWaterOz(deps.pool, phone).catch(() => null),
      getDailyWaterHistory(deps.pool, phone, 7).catch(() => [] as Array<{ day: string; oz: number }>),
    ]);

    const episodes = symptomRows.map(toEpisode);
    const weightSeries = [...weightRows]
      .reverse()
      .map((w) => ({ date: new Date(w.created_at).toISOString(), weight: w.weight }));
    const moodSeries = [...moodRows]
      .reverse()
      .map((m) => ({ date: new Date(m.created_at).toISOString(), score: m.mood_score }));

    const proteinGoal = user.protein_goal_grams ?? 80;
    const calorieGoal = user.calorie_goal_kcal ?? null;

    return {
      generatedAt: new Date().toISOString(),
      profile: {
        // Never surface an unrecoverable ciphertext blob (enc:<iv>:<data>:<tag>)
        // for the two encrypted fields — if the decryption key is absent the
        // decrypt is a no-op, so guard here like the Settings route does.
        firstName: plainOrNull(user.first_name),
        medication: plainOrNull(user.medication),
        doseMg: user.dose_mg ?? null,
        injectionDay: user.injection_day ?? null,
        // Cap the GLP-1 week at a sane range — an implausible value (e.g. 479)
        // means a mis-entered start date, and showing it makes the app look
        // broken. Beyond ~5 years we suppress it rather than display nonsense.
        glp1Week: saneWeek(glp1WeekNumber(user.glp1_start_date)),
        primaryGoal: user.primary_goal ?? null,
        goals: user.goals ?? [],
        isPro: !!user.is_pro,
        isPaid: !!user.is_paid,
      },
      weight: {
        ...weightProgress(user.starting_weight, user.current_weight, user.goal_weight),
        series: weightSeries,
      },
      nutrition: {
        today: {
          protein: Math.round(todayFood.protein_g),
          calories: Math.round(todayFood.calories),
          proteinGoal,
          calorieGoal,
          items: todayFood.items_detailed.map((i) => ({ food: i.food, protein: Math.round(i.protein_g), calories: Math.round(i.calories) })),
        },
        proteinGoal,
        calorieGoal,
        history: proteinHist.map((d) => ({
          day: d.day,
          protein: Math.round(d.protein_g),
          calories: Math.round(d.calories),
          itemCount: d.item_count,
        })),
        streak: loggingStreak(proteinHist),
      },
      hydration: {
        today: waterToday ?? 0,
        goalMin: WATER_GOAL_MIN_OZ,
        goalMax: WATER_GOAL_MAX_OZ,
        // Oldest → newest so the UI reads left-to-right; last 7 days.
        history: [...waterHist].reverse().map((d) => ({ day: d.day, oz: d.oz })),
      },
      // Weekly rollup: averages + this-week weight change + plateau signal + one
      // hedged, non-causal insight. Pure derivation from data already fetched.
      weekly: computeWeeklyStats({
        proteinHistory7: proteinHist.slice(0, 7).map((d) => ({ day: d.day, protein: Math.round(d.protein_g), itemCount: d.item_count })),
        weightSeries,
        waterHistory: waterHist.map((d) => ({ day: d.day, oz: d.oz })),
        proteinGoal,
        waterGoalMin: WATER_GOAL_MIN_OZ,
      }),
      mood: { series: moodSeries },
      symptoms: {
        patterns: summarizeSymptoms(episodes),
        recent: episodes.slice(0, 20).map((e) => ({
          symptom: e.symptom,
          daysSinceInjection: e.days_since_injection,
          remedyHelped: e.remedy_helped,
          date: new Date(e.created_at).toISOString(),
        })),
        total: episodes.length,
      },
    };
  });

  // ── POST /dashboard/weight — log a weight entry ────────────────────────────
  app.post('/dashboard/weight', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({
      weight: z.number().positive().max(2000),
      unit: z.enum(['lbs', 'kg']).optional(),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Enter your weight.');
    // Normalize to pounds (the stored unit) — the user may weigh in kg.
    const lbs = parsed.data.unit === 'kg' ? kgToLbs(parsed.data.weight) : parsed.data.weight;
    if (lbs < 60 || lbs > 700) throw new ValidationError('That weight looks out of range — double-check the number and unit.');
    await deps.users.logWeightEntry(phone, Math.round(lbs * 10) / 10);
    deps.logger.info({ phone }, 'dashboard.weight.logged');
    const user = await deps.users.getByPhone(phone);
    return { ok: true, weight: weightProgress(user?.starting_weight, user?.current_weight, user?.goal_weight) };
  });

  // ── POST /dashboard/mood — log a mood score ────────────────────────────────
  app.post('/dashboard/mood', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({ score: z.number().int().min(1).max(10) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Mood must be a number from 1 to 10.');
    await deps.users.logMoodEntry(phone, parsed.data.score);
    deps.logger.info({ phone, score: parsed.data.score }, 'dashboard.mood.logged');
    return { ok: true };
  });

  // ── POST /dashboard/water — log fluids (oz) ─────────────────────────────────
  // Dashboard twin of the chat water log. Uses the same deterministic logWater
  // insert (dedupe + wake-day total) so chat and dashboard stay in sync, then
  // returns today's total so the card updates without a full reload.
  app.post('/dashboard/water', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({ oz: z.number().positive().max(400) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Enter how many ounces of water to log.');
    const oz = Math.round(parsed.data.oz);
    await logWater(deps.pool, deps.logger, phone, oz, `${oz} oz (dashboard)`).catch(() => null);
    const today = (await getTodaysWaterOz(deps.pool, phone).catch(() => null)) ?? 0;
    deps.logger.info({ phone, oz: parsed.data.oz, today }, 'dashboard.water.logged');
    return { ok: true, today, goalMin: WATER_GOAL_MIN_OZ, goalMax: WATER_GOAL_MAX_OZ };
  });

  // ── POST /dashboard/symptom — log a symptom (+ optional remedy that helped) ─
  // The dashboard twin of the chat symptom intercept: records an episode with
  // its injection timing + dose so the personal pattern compounds, and attaches
  // a named remedy when the user says what settled it.
  app.post('/dashboard/symptom', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({
      symptom: z.string().trim().min(1).max(60),
      remedy: z.string().trim().max(80).optional(),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Pick a symptom to log.');

    // Accept a canonical symptom directly, else classify free text.
    const raw = parsed.data.symptom.toLowerCase();
    const symptom: CanonSymptom | null =
      (CANON_SYMPTOMS as string[]).includes(raw) ? (raw as CanonSymptom) : classifySymptom(parsed.data.symptom);
    if (!symptom) throw new ValidationError("I couldn't recognize that symptom — try nausea, fatigue, constipation, etc.");

    const user = await deps.users.getByPhone(phone);
    const dow = localDayOfWeek(user?.timezone);
    const dsi = daysSinceInjection(user?.injection_day, dow);
    await deps.users.recordSymptomEpisode(phone, { symptom, days_since_injection: dsi, dose_mg: user?.dose_mg ?? null });
    if (parsed.data.remedy) {
      await deps.users.setLastEpisodeRemedy(phone, symptom, parsed.data.remedy).catch(() => undefined);
    }
    deps.logger.info({ phone, symptom, remedy: parsed.data.remedy ?? null }, 'dashboard.symptom.logged');

    // Return the freshened pattern for this symptom so the UI can update the card.
    const episodes = (await deps.users.getSymptomEpisodes(phone, symptom, 24).catch(() => [])).map(toEpisode);
    const patterns = summarizeSymptoms(episodes);
    return { ok: true, symptom, pattern: patterns[0] ?? null };
  });

  // ── POST /dashboard/food — log a meal from free text (real estimator) ───────
  app.post('/dashboard/food', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({ text: z.string().trim().min(1).max(280) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Tell me what you ate.');
    const tool = makeLogFoodTool({ pool: deps.pool, llm: deps.llm, logger: deps.logger, userId: phone, source: 'text', users: deps.users });
    const res = await tool.execute({ food: parsed.data.text }) as Record<string, unknown>;
    if ((res as { ok?: boolean }).ok === false) throw new ValidationError("I couldn't estimate that — try naming the food and portion.");
    const today = await deps.users.getTodaysFoodSummary(phone).catch(() => null);
    deps.logger.info({ phone }, 'dashboard.food.logged');
    return {
      ok: true,
      logged: { food: parsed.data.text, protein: res['protein_g'] ?? null, calories: res['calories'] ?? null },
      todayProtein: today ? Math.round(today.protein_g) : null,
      todayCalories: today ? Math.round(today.calories) : null,
    };
  });

  // ── POST /dashboard/photo — upload a food/progress photo (data URL) ─────────
  // Zero new infra: the browser downscales the image to a data: URL and posts it
  // as JSON; undici's fetch resolves data: URLs, so analyzeMedia runs the exact
  // same vision pipeline as an inbound WhatsApp/iMessage photo. A confidently
  // eaten meal is logged automatically; a body/progress photo returns Grace's
  // warm analysis (not logged). Larger body limit only on this route.
  app.post('/dashboard/photo', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({
      dataUrl: z.string().regex(/^data:image\/(png|jpe?g|webp|heic|heif);base64,/i, 'Upload a photo (PNG, JPG, or WebP).'),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('That file type isn\'t supported — upload a photo (PNG, JPG, or WebP).');

    const contentType = parsed.data.dataUrl.slice(5, parsed.data.dataUrl.indexOf(';'));
    const analysis = await analyzeMedia(
      [{ url: parsed.data.dataUrl, contentType, kind: 'image' }],
      { apiKey: deps.gemini.apiKey, model: deps.gemini.model, fallbackModel: deps.gemini.fallbackModel, logger: deps.logger },
    );
    if (!analysis) throw new ValidationError("I couldn't read that photo — try another one.");

    const isFood = /^IMAGE_TYPE:\s*food/im.test(analysis) || /^MEAL_STATUS:/im.test(analysis);
    if (isFood) {
      const food = parseFoodImageAnalysis(analysis);
      if (food.autoLog && food.proteinTotal != null && food.items) {
        const tool = makeLogFoodTool({ pool: deps.pool, llm: deps.llm, logger: deps.logger, userId: phone, source: 'image', users: deps.users });
        await tool.execute({ food: food.items, protein_g: food.proteinTotal, calories: food.caloriesTotal }).catch(() => undefined);
        const today = await deps.users.getTodaysFoodSummary(phone).catch(() => null);
        deps.logger.info({ phone, protein: food.proteinTotal }, 'dashboard.photo.food_logged');
        return {
          ok: true, kind: 'food', logged: true,
          items: food.items, protein: food.proteinTotal, calories: food.caloriesTotal,
          todayProtein: today ? Math.round(today.protein_g) : null,
        };
      }
      // Ambiguous / low-confidence produce → describe, don't log.
      deps.logger.info({ phone }, 'dashboard.photo.food_ambiguous');
      return { ok: true, kind: 'food', logged: false, items: food.items, ask: food.ask || null };
    }

    // Body / progress / other → return the warm analysis text, never logged.
    const clean = analysis.replace(/^IMAGE_TYPE:.*$/im, '').replace(/^BREAKDOWN:[\s\S]*/im, '').trim();
    deps.logger.info({ phone }, 'dashboard.photo.body');
    return { ok: true, kind: 'body', logged: false, analysis: clean.slice(0, 800) };
  });

  // ── Progress photo gallery ─────────────────────────────────────────────────
  // Stored inline (downscaled data URLs) so there's no object-storage bucket to
  // provision — the browser caps the image to ~1024px + a ~400px thumb before
  // upload. The gallery is a personal before/after record; photos are NEVER
  // logged as food and never leave the user's own account.
  const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|heic|heif);base64,/i;
  const mapPhoto = (p: { id: string; kind: string; note: string | null; weight_lbs: number | null; thumb_data: string | null; taken_at: Date }) => ({
    id: p.id, kind: p.kind, note: p.note, weightLbs: p.weight_lbs,
    thumbUrl: p.thumb_data, takenAt: new Date(p.taken_at).toISOString(),
  });

  // Save a progress photo to the gallery.
  app.post('/dashboard/progress-photo', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({
      dataUrl: z.string().regex(DATA_URL_RE, 'Upload a photo (PNG, JPG, or WebP).'),
      thumbUrl: z.string().regex(DATA_URL_RE).optional(),
      note: z.string().trim().max(400).optional(),
      weight: z.number().positive().max(2000).optional(),
      unit: z.enum(['lbs', 'kg']).optional(),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError("That photo couldn't be saved — try a PNG, JPG, or WebP.");
    const contentType = parsed.data.dataUrl.slice(5, parsed.data.dataUrl.indexOf(';'));
    let weightLbs: number | null = null;
    if (parsed.data.weight != null) {
      const lbs = parsed.data.unit === 'kg' ? kgToLbs(parsed.data.weight) : parsed.data.weight;
      if (lbs >= 60 && lbs <= 700) weightLbs = Math.round(lbs * 10) / 10;
    }
    const saved = await deps.users.saveProgressPhoto(phone, {
      kind: 'progress',
      image_data: parsed.data.dataUrl,
      thumb_data: parsed.data.thumbUrl ?? null,
      content_type: contentType,
      note: parsed.data.note ?? null,
      weight_lbs: weightLbs,
    });
    deps.logger.info({ phone, id: saved.id }, 'dashboard.progress_photo.saved');
    return { ok: true, photo: mapPhoto(saved) };
  });

  // List gallery photos (metadata + thumbnail only).
  app.get('/dashboard/photos', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const photos = await deps.users.listProgressPhotos(phone, 60).catch(() => []);
    return { photos: photos.map(mapPhoto) };
  });

  // Full image for the lightbox (owner-scoped).
  app.get('/dashboard/photos/:id', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const photo = await deps.users.getProgressPhoto(phone, id);
    if (!photo) throw new NotFoundError('Photo not found');
    return { dataUrl: photo.image_data };
  });

  // Delete a gallery photo (owner-scoped).
  app.delete('/dashboard/photos/:id', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ok = await deps.users.deleteProgressPhoto(phone, id);
    if (!ok) throw new NotFoundError('Photo not found');
    deps.logger.info({ phone, id }, 'dashboard.progress_photo.deleted');
    return { ok: true };
  });
}
