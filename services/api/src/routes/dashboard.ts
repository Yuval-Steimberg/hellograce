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
import { ambiguousEatenFoods, parseFoodImageAnalysis } from '../services/ai.service.js';
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
import { computeUserLoggingDay } from '../nutrition/logging-window.js';
import { HABITS, HABIT_KEYS, type HabitKey } from '../services/habit-checklist.js';
import { checkHabits, uncheckHabit, getTodaysHabits } from '../services/habit-store.js';
import { getDoseEvents, buildDoseTimeline, type DoseEvent } from '../services/medication-timeline.js';
import { buildPremiumCompanion } from '../services/premium-companion.js';
import { extractFood } from '../services/food-extract.js';
import {
  addPendingFood,
  getPendingFood,
  resolvePendingFood,
} from '../services/food-pending-store.js';
import { hasPreciseAmount, isPortionAffirmation } from '../services/food-portion.js';
import { namesSpecificFood } from '../services/meal-lifecycle.js';

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

    const [weightRows, proteinHist, todayFood, moodRows, symptomRows, waterToday, waterHist, habitKeys, doseEvents] = await Promise.all([
      deps.users.getWeightHistory(phone, 90).catch(() => []),
      deps.users.getDailyProteinHistory(phone, 30).catch(() => [] as Array<{ day: string; protein_g: number; calories: number; item_count: number }>),
      deps.users.getTodaysFoodSummary(phone).catch(() => ({ protein_g: 0, calories: 0, items: [] as string[], items_detailed: [] as Array<{ food: string; protein_g: number; calories: number; logged_at: string }> })),
      deps.users.getMoodHistory(phone, 30).catch(() => [] as Array<{ mood_score: number; created_at: Date }>),
      deps.users.getRecentSymptomEpisodes(phone, 80).catch(() => [] as Array<{ symptom: string; days_since_injection: number | null; dose_mg: number | null; remedy_helped: string | null; created_at: Date }>),
      getTodaysWaterOz(deps.pool, phone).catch(() => null),
      getDailyWaterHistory(deps.pool, phone, 7).catch(() => [] as Array<{ day: string; oz: number }>),
      getTodaysHabits(deps.pool, phone, computeUserLoggingDay(user.timezone, user.wake_time, new Date())).catch(() => [] as HabitKey[]),
      getDoseEvents(deps.pool, phone).catch(() => [] as DoseEvent[]),
    ]);

    const episodes = symptomRows.map(toEpisode);
    const weightSeries = [...weightRows]
      .reverse()
      .map((w) => ({ date: new Date(w.created_at).toISOString(), weight: w.weight }));
    const moodSeries = [...moodRows]
      .reverse()
      .map((m) => ({ date: new Date(m.created_at).toISOString(), score: m.mood_score }));

    const proteinGoal = user.protein_goal_grams ?? null;
    const calorieGoal = user.calorie_goal_kcal ?? null;
    const symptomPatterns = summarizeSymptoms(episodes);
    const weeklyStats = computeWeeklyStats({
      proteinHistory7: proteinHist.slice(0, 7).map((d) => ({ day: d.day, protein: Math.round(d.protein_g), itemCount: d.item_count })),
      weightSeries,
      waterHistory: waterHist.map((d) => ({ day: d.day, oz: d.oz })),
      proteinGoal,
      waterGoalMin: WATER_GOAL_MIN_OZ,
    });
    const premium = buildPremiumCompanion({
      isPaid: !!user.is_paid,
      isPro: !!user.is_pro,
      trialStart: user.trial_start,
      medication: plainOrNull(user.medication),
      doseMg: user.dose_mg ?? null,
      injectionDay: user.injection_day ?? null,
      proteinToday: Math.round(todayFood.protein_g),
      proteinGoal,
      caloriesToday: Math.round(todayFood.calories),
      waterTodayOz: waterToday ?? 0,
      daysProteinLogged: weeklyStats.daysProteinLogged,
      avgProtein: weeklyStats.avgProtein,
      weightDeltaLbs: weeklyStats.weightDeltaLbs,
      weeklyInsight: weeklyStats.insight,
      dislikes: user.food_dislikes ?? [],
      symptoms: symptomPatterns,
    });

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
      // Quick-checkmark daily habits. `available` is the list to show (the shot
      // habit only for weekly-injectable users); `checked` are today's ticks.
      habits: {
        available: HABITS.filter((h) => !h.weeklyInjectableOnly || (user.medication_frequency !== 'daily' && !!user.medication)).map((h) => ({ key: h.key, label: h.label, icon: h.icon })),
        checked: habitKeys,
      },
      // Medication / dose timeline — dose periods enriched with GLP-1 week span,
      // weight change, and top symptom per dose. Synthesizes a current-dose period
      // from dose_mg + glp1_start_date when nothing is recorded yet.
      medicationTimeline: buildDoseTimeline(doseEvents, weightRows, symptomRows, {
        medication: plainOrNull(user.medication),
        dose_mg: user.dose_mg ?? null,
        glp1_start_date: user.glp1_start_date ?? null,
      }),
      // Weekly rollup: averages + this-week weight change + plateau signal + one
      // hedged, non-causal insight. Pure derivation from data already fetched.
      weekly: weeklyStats,
      mood: { series: moodSeries },
      symptoms: {
        patterns: symptomPatterns,
        recent: episodes.slice(0, 20).map((e) => ({
          symptom: e.symptom,
          daysSinceInjection: e.days_since_injection,
          remedyHelped: e.remedy_helped,
          date: new Date(e.created_at).toISOString(),
        })),
        total: episodes.length,
      },
      premium,
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
    const logged = await logWater(deps.pool, deps.logger, phone, oz, `${oz} oz (dashboard)`);
    if (!logged) {
      throw new ValidationError("I couldn't save that water entry right now. Please try again.");
    }
    const today = (await getTodaysWaterOz(deps.pool, phone).catch(() => null)) ?? 0;
    deps.logger.info({ phone, oz: parsed.data.oz, today }, 'dashboard.water.logged');
    return { ok: true, today, goalMin: WATER_GOAL_MIN_OZ, goalMax: WATER_GOAL_MAX_OZ };
  });

  // ── POST /dashboard/habit — check / uncheck a daily habit ───────────────────
  // Tappable checklist toggle. `checked:true` ticks it for the user's local day
  // (idempotent), `checked:false` unticks. Returns today's full checked set.
  app.post('/dashboard/habit', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({
      key: z.enum(HABIT_KEYS as unknown as [HabitKey, ...HabitKey[]]),
      checked: z.boolean(),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Pick a valid habit to check.');
    const user = await deps.users.getByPhone(phone);
    const day = computeUserLoggingDay(user?.timezone, user?.wake_time, new Date());
    if (parsed.data.checked) await checkHabits(deps.pool, phone, [parsed.data.key], day, 'dashboard');
    else await uncheckHabit(deps.pool, phone, parsed.data.key, day);
    const checked = await getTodaysHabits(deps.pool, phone, day);
    deps.logger.info({ phone, key: parsed.data.key, checked: parsed.data.checked }, 'dashboard.habit.toggled');
    return { ok: true, checked };
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

  // ── POST /dashboard/food — shared accuracy-first food pipeline ──────────────
  app.post('/dashboard/food', async (req) => {
    const phone = await requireVerifiedPhone(req);
    const parsed = z.object({ text: z.string().trim().min(1).max(280) }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Tell me what you ate.');
    const pendingBefore = await getPendingFood(deps.redis, phone, deps.pool).catch(() => []);
    // Resolve a bare amount ("1 cup") against one durable pending dish without
    // trusting the model to reconnect the two turns. A standard-serving
    // affirmation uses the pending dish itself; the log-food estimator applies
    // its reviewed default and marks it as an estimate.
    const singlePending = pendingBefore.length === 1 ? pendingBefore[0] : null;
    const deterministicResolution =
      singlePending
      && !namesSpecificFood(parsed.data.text)
      && (hasPreciseAmount(parsed.data.text) || isPortionAffirmation(parsed.data.text))
        ? `${hasPreciseAmount(parsed.data.text) ? `${parsed.data.text} of ` : ''}${singlePending.item}`
        : null;
    let extraction = deterministicResolution
      ? {
          intent: 'edit' as const,
          edit_ref: singlePending!.item,
          items: [{
            item: deterministicResolution,
            protein_g: null,
            calories: null,
            status: 'confirmed' as const,
            clarify_question: null,
            confidence: 'high' as const,
            serving_size: hasPreciseAmount(parsed.data.text) ? parsed.data.text : null,
          }],
        }
      : await extractFood(
          deps.llm,
          deps.logger,
          parsed.data.text,
          pendingBefore.map((item) => ({ item: item.item })),
          deps.gemini.model,
        );
    // The structured model occasionally returns `none` for a simple vague log
    // such as "I had pasta". Chat already has a deterministic never-drop
    // fallback for exactly this case; use the same exported detector here so
    // dashboard and messaging create the same durable pending clarification.
    if (extraction.intent === 'none') {
      const fallback = ambiguousEatenFoods(parsed.data.text);
      if (fallback) {
        extraction = {
          intent: 'log',
          edit_ref: null,
          items: fallback.items.map((item) => ({
            item,
            protein_g: null,
            calories: null,
            status: 'pending_portion' as const,
            clarify_question: fallback.clarify,
            confidence: null,
            serving_size: null,
          })),
        };
      }
    }
    if (extraction.intent === 'query' || extraction.intent === 'none' || extraction.intent === 'delete') {
      throw new ValidationError("I couldn't identify an eaten food and portion. Try “2 eggs” or “1 cup of Greek yogurt.”");
    }

    const tool = makeLogFoodTool({ pool: deps.pool, llm: deps.llm, logger: deps.logger, userId: phone, source: 'text', users: deps.users });
    const logged: Array<{ food: string; protein: number | null; calories: number | null }> = [];
    for (const item of extraction.items.filter((candidate) => candidate.status === 'confirmed')) {
      const res = await tool.execute({
        food: item.item,
        ...(item.protein_g != null && item.calories != null
          ? { protein_g: item.protein_g, calories: item.calories }
          : {}),
        ...(item.confidence ? { confidence: item.confidence } : {}),
        ...(item.serving_size ? { serving_size: item.serving_size } : {}),
      }) as Record<string, unknown>;
      if ((res as { ok?: boolean }).ok === false) continue;
      logged.push({
        food: item.item,
        protein: typeof res['protein_g'] === 'number' ? res['protein_g'] : item.protein_g,
        calories: typeof res['calories'] === 'number' ? res['calories'] : item.calories,
      });
      await resolvePendingFood(deps.redis, phone, item.item, deps.pool).catch(() => undefined);
    }

    if (extraction.intent === 'edit' && extraction.edit_ref && logged.length > 0) {
      await resolvePendingFood(deps.redis, phone, extraction.edit_ref, deps.pool).catch(() => undefined);
    }
    const needsPortion = extraction.items.filter((candidate) => candidate.status === 'pending_portion');
    if (needsPortion.length > 0) {
      await addPendingFood(
        deps.redis,
        phone,
        needsPortion.map((item) => ({ item: item.item, clarify_question: item.clarify_question })),
        deps.pool,
      );
    }
    if (logged.length === 0 && needsPortion.length === 0) {
      throw new ValidationError("I couldn't estimate that — try naming the food and portion.");
    }

    const today = await deps.users.getTodaysFoodSummary(phone).catch(() => null);
    deps.logger.info({ phone, logged: logged.length, pending: needsPortion.length }, 'dashboard.food.processed');
    return {
      ok: true,
      logged,
      needsPortion: needsPortion.length > 0,
      ask: needsPortion.map((item) => item.clarify_question).find(Boolean)
        ?? (needsPortion.length > 0
          ? `About how much ${needsPortion.map((item) => item.item).join(' and ')} did you have? A rough amount is enough.`
          : null),
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
        const saved = await tool.execute({
          food: food.items,
          protein_g: food.proteinTotal,
          calories: food.caloriesTotal,
        }).catch(() => null) as Record<string, unknown> | null;
        if (!saved || saved.ok === false) {
          throw new ValidationError("I could read the meal, but couldn't save it right now. Please try again.");
        }
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
    // Sync a weight entered with the photo to the SAME place a normal weight log
    // goes (weight_logs + users.current_weight), so it shows on the chart and
    // reaches chat — otherwise it was stranded on the photo row (unsynced).
    if (weightLbs != null) {
      await deps.users.logWeightEntry(phone, weightLbs).catch(() => undefined);
    }
    deps.logger.info({ phone, id: saved.id, weightSynced: weightLbs != null }, 'dashboard.progress_photo.saved');
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
