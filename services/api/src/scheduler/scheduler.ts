import cron from 'node-cron';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { UserService, GraceUser } from '../user/user.service.js';
import type { MessageSender } from '../twilio/sender.js';
import type { MemoryService } from '../memory/memory.service.js';
import type { MessageGenerator, GenerateOpts } from './message-generator.js';
import type { PromptOptimizer } from './prompt-optimizer.js';
import type { AnomalyDetectorService } from './anomaly-detector.service.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MIDDAY_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
const EVENING_DAYS = new Set([2, 4, 0]); // Tue, Thu, Sun

interface SchedulerDeps {
  users: UserService;
  sender: MessageSender;
  generator: MessageGenerator;
  logger: Logger;
  redis: Redis;
  /** Conversation history source — lets proactive reminders reference what the
   *  user has actually been talking about (symptoms, goals, struggles). Optional
   *  so tests can omit it; when absent, reminders fall back to food-only context. */
  memory?: MemoryService;
  promptOptimizer?: PromptOptimizer;
  /** Phase 4: behavioral anomaly detector. Runs nightly at 4:30am UTC. */
  anomalyDetector?: AnomalyDetectorService;
  /** Phase 17: research scrape (Reddit → corpus → classify → replay → grade).
   *  Runs every Sunday 5am UTC. Best-effort; failures logged but don't block. */
  researchScrape?: () => Promise<void>;
  /** Phase 18: research auto-fix (re-replay corpus failures → generate content
   *  rules + inject synthetic feedback). Runs every 3 days at 1am UTC. */
  researchAutoFix?: () => Promise<void>;
  /** Engagement cooldown window in hours. After a user sends a message,
   *  all non-critical proactive reminders are suppressed for this window.
   *  Default 2h. Set to 0 to disable. Configurable via ENGAGEMENT_COOLDOWN_HOURS. */
  engagementCooldownHours?: number;
  /** Master switch for the background optimizer crons (prompt optimizer,
   *  anomaly detector, research scrape, research auto-fix). When false, none of
   *  them are scheduled. Does NOT affect the per-minute proactive tick or the
   *  daily personalization engine. Default true. Set via OPTIMIZERS_ENABLED. */
  optimizersEnabled?: boolean;
}

export class Scheduler {
  private tasks: cron.ScheduledTask[] = [];

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    // Run every minute — check which users need proactive messages
    this.tasks.push(
      cron.schedule('* * * * *', () => void this.tick()),
    );
    // Personalization engine runs daily at 3am UTC
    this.tasks.push(
      cron.schedule('0 3 * * *', () => void this.runPersonalizationEngine()),
    );
    // Master kill switch (OPTIMIZERS_ENABLED): when off, skip ALL background
    // optimizer crons below (prompt optimizer, anomaly detector, research
    // scrape, research auto-fix). The per-minute proactive tick and the daily
    // personalization engine above keep running — they're core product, not
    // optimizers.
    const optimizersEnabled = this.deps.optimizersEnabled !== false;
    if (!optimizersEnabled) {
      this.deps.logger.warn('scheduler.optimizers_disabled');
      this.deps.logger.info('scheduler.started');
      return;
    }
    // Prompt optimizer runs WEEKLY (Sunday 05:30 UTC). Throttled from daily to
    // weekly (2026-06-08 cost pass) — the optimizer + its post-activation
    // coverage smoke (~50 cases through the full orchestrator) is one of the
    // heaviest Gemini token consumers, and the self-improvement loop is just as
    // effective weekly with no impact on live accuracy or latency. Strict
    // isSafe() still gates auto-activation; failures save as inactive drafts.
    // Catch up on startup if the weekly window was missed (common when Fly
    // machines auto-stop overnight due to no payment method).
    if (this.deps.promptOptimizer) {
      this.tasks.push(
        cron.schedule('30 5 * * 0', () => void this.deps.promptOptimizer!.run()),
      );
      setTimeout(() => void this.deps.promptOptimizer!.runIfMissedToday(), 30_000);
    }
    // Phase 4: behavioral anomaly detection — runs 30 min after the prompt
    // optimizer to keep nightly load spread out. Read-only scan over recent
    // user logs; results go to the user_anomalies table for admin visibility.
    if (this.deps.anomalyDetector) {
      this.tasks.push(
        cron.schedule('30 4 * * *', () => void this.deps.anomalyDetector!.run()),
      );
    }
    // Phase 17: weekly research scrape — every Sunday 5am UTC. Pulls top
    // posts of the past week from the configured subreddits, classifies +
    // checks coverage, sandbox-replays Grace, deterministically grades,
    // LLM-evals failures. Admin reviews in /admin/research.
    if (this.deps.researchScrape) {
      this.tasks.push(
        cron.schedule('0 5 * * 0', () => void this.deps.researchScrape!()),
      );
    }
    // Phase 18: auto-fix — WEEKLY (Sunday 01:00 UTC), 4.5 hours BEFORE the
    // prompt optimizer's 05:30 UTC run on the same day. This ordering matters:
    // auto-fix injects synthetic feedback into the optimizer's in-memory
    // buffer, then the 05:30 cron picks it up alongside real RLHF signals.
    // Throttled from daily to weekly (2026-06-08 cost pass) — re-replaying
    // corpus failures through the orchestrator + 15-dimension LLM evaluator is
    // a heavy Gemini consumer with zero live-quality impact; weekly keeps the
    // autonomous loop running while cutting ~7x its token cost.
    if (this.deps.researchAutoFix) {
      this.tasks.push(
        cron.schedule('0 1 * * 0', () => void this.deps.researchAutoFix!()),
      );
    }
    this.deps.logger.info('scheduler.started');
  }

  stop(): void {
    this.tasks.forEach((t) => t.stop());
    this.tasks = [];
    this.deps.logger.info('scheduler.stopped');
  }

  private async tick(): Promise<void> {
    try {
      const users = await this.deps.users.listActiveUsers();
      const results = await Promise.allSettled(users.map((u) => this.processUser(u)));
      // Surface per-user failures — Promise.allSettled normally swallows them.
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.deps.logger.error(
            { err: r.reason, phone: users[i]?.phone },
            'scheduler.process_user.error',
          );
        }
      });
    } catch (err) {
      this.deps.logger.error({ err }, 'scheduler.tick.error');
    }
  }

  private async processUser(user: GraceUser): Promise<void> {
    const now = localNow(user.timezone || 'America/New_York');
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const todayStr = toDateStr(now);

    // ── Quiet hours: never send proactive messages between 21:00 and 07:00 local
    if (hour >= 21 || hour < 7) return;

    // Guard: skip users missing schedule config — avoids null.split() crash.
    // Defensive defaults so existing users without onboarding data still work.
    const wake_time = user.wake_time || '08:00';
    const sleep_time = user.sleep_time || '22:00';

    // Parse wake/sleep times once — used throughout this function.
    const [wHour = 8, wMin = 0] = wake_time.split(':').map(Number);
    const [sHour = 22, sMin = 0] = sleep_time.split(':').map(Number);
    const wakeBaseMin = wHour * 60 + wMin;
    const sleepBaseMin = sHour * 60 + sMin;
    const nowMin = hour * 60 + minute;

    // ── Post-injection followup (any day, outside quiet hours).
    // Lives OUTSIDE handleInjectionFlow because evening injectors who reply
    // "Done" at 7-8pm have their 3h window fall in quiet hours (21:00+).
    // The next-morning tick is NOT an injection day, so it would never run
    // handleInjectionFlow. Hoisting this check up means the followup fires
    // on the next available day-time tick after the 3h window opens.
    if (
      user.injection_flow_stage === 'done_confirmed' &&
      user.injection_done_at
    ) {
      const elapsed =
        (Date.now() - new Date(user.injection_done_at).getTime()) / 3_600_000;
      if (elapsed >= 3) {
        await this.sendAndRecord(user, 'injection_followup');
        await this.deps.users.setInjectionStage(user.phone, 'followup_sent', {
          injection_evening_followup_due: true,
        });
        return;
      }
    }

    // ── Injection day flow (runs any day matching injection_day)
    if (user.injection_day && user.injection_day === DAYS[dayOfWeek]) {
      await this.handleInjectionFlow(user, hour);
      return; // Skip regular check-ins on injection day
    }

    // ── Day-after injection (stage = followup_sent → next morning message)
    if (user.injection_flow_stage === 'followup_sent' && user.injection_flow_started_at) {
      const flowDay = localNow(user.timezone, new Date(user.injection_flow_started_at));
      if (toDateStr(flowDay) !== todayStr && nowMin >= wakeBaseMin) {
        await this.sendAndRecord(user, 'injection_dayafter');
        await this.deps.users.setInjectionStage(user.phone, null, {
          injection_evening_followup_due: false,
        });
        return;
      }
    }

    // ── Side-effect follow-up
    if (user.side_effect_flow && user.side_effect_flow_started_at && !user.side_effect_followup_sent) {
      const hoursElapsed = (Date.now() - new Date(user.side_effect_flow_started_at).getTime()) / 3_600_000;
      if (hoursElapsed >= 4) {
        const type = `side_effect_${user.side_effect_flow}` as Parameters<MessageGenerator['generate']>[0];
        await this.sendAndRecord(user, type);
        await this.deps.users.update(user.phone, { side_effect_followup_sent: true });
        return;
      }
    }

    // ── Morning window (covers both trial reminder and regular check-in)
    // Humanized timing: each user gets a deterministic per-day offset of 0-55
    // minutes from their wake_time so messages don't all fire at exactly 7:00.
    // Window is 90 min wide so a machine waking late (e.g. after a webhook) still
    // catches up — morningAlreadySent prevents double-sends within the same day.
    const morningOffset = jitterMinutes(`${user.phone}-${todayStr}-morning`, 55);
    const morningTargetMin = wakeBaseMin + morningOffset;
    const isMorningWindow = nowMin >= morningTargetMin && nowMin < morningTargetMin + 90;
    const morningAlreadySent = user.last_morning_sent_at &&
      toDateStr(localNow(user.timezone, new Date(user.last_morning_sent_at))) === todayStr;

    if (isMorningWindow && !morningAlreadySent) {
      // Trial Day 2 reminder fires instead of the regular morning check-in.
      // Sends only once (24–48h after trial_start) for unpaid users.
      if (!user.is_paid && !user.is_pro && user.trial_start) {
        const trialHours = (Date.now() - new Date(user.trial_start).getTime()) / 3_600_000;
        if (trialHours >= 24 && trialHours < 48) {
          await this.sendAndRecord(user, 'trial_expiry_reminder');
          await this.deps.users.update(user.phone, { last_morning_sent_at: new Date() });
          return;
        }
      }
      await this.sendAndRecord(user, 'morning', { isWednesday: dayOfWeek === 3 });
      await this.deps.users.update(user.phone, { last_morning_sent_at: new Date() });
      return;
    }

    // Engagement gate for midday/evening: cap at 2 proactives/day for silent
    // users (morning + 1 nudge max). Once they go fully silent for >1 day, drop
    // to morning only. Engaged users get the full 3-message schedule.
    const engagedToday = userEngagedToday(user);
    const silentDays = userSilentDays(user);

    // ── Midday nudge (Mon/Wed/Fri, randomized within 11am–2pm local)
    // Per-user-per-day offset across the 3-hour window so different users hit
    // at different minutes, and the same user hits at different times day-to-day.
    const middayBaseMin = 11 * 60;
    const middayOffset = jitterMinutes(`${user.phone}-${todayStr}-midday`, 165); // 11:00–13:45
    const middayTargetMin = middayBaseMin + middayOffset;
    const isMiddayWindow =
      MIDDAY_DAYS.has(dayOfWeek) &&
      nowMin >= middayTargetMin && nowMin < middayTargetMin + 15;
    if (
      isMiddayWindow &&
      !user.midday_skip &&
      (!user.last_midday_sent_at || toDateStr(localNow(user.timezone, new Date(user.last_midday_sent_at))) !== todayStr) &&
      (!user.last_reply_at || Date.now() - new Date(user.last_reply_at).getTime() > 3 * 3_600_000) &&
      (engagedToday || silentDays < 1)
    ) {
      await this.sendAndRecord(user, 'midday');
      await this.deps.users.update(user.phone, { last_midday_sent_at: new Date() });
      return;
    }

    // ── Evening wind-down (Tue/Thu/Sun, ~90 min before sleep, randomized ±30)
    // Base = sleep_time - 90 min; jitter shifts slightly later.
    // Cap jitter so the full 15-min delivery window ends before 21:00 quiet hours.
    const eveningBaseMin = sleepBaseMin - 90;
    const eveningMaxJitter = Math.max(0, Math.min(30, 21 * 60 - 16 - eveningBaseMin));
    const eveningOffset = eveningMaxJitter > 0 ? jitterMinutes(`${user.phone}-${todayStr}-evening`, eveningMaxJitter) : 0;
    const eveningTargetMin = eveningBaseMin + eveningOffset;
    const isEveningWindow =
      EVENING_DAYS.has(dayOfWeek) &&
      nowMin >= eveningTargetMin && nowMin < eveningTargetMin + 15;
    if (
      isEveningWindow &&
      // Hard cap: never send evening to a user who hasn't actively chatted today
      engagedToday
    ) {
      if (!user.last_evening_sent_at || toDateStr(localNow(user.timezone, new Date(user.last_evening_sent_at))) !== todayStr) {
        await this.sendAndRecord(user, 'evening', { lowMoodMode: user.low_mood_mode ?? false });
        await this.deps.users.update(user.phone, { last_evening_sent_at: new Date() });
        return;
      }
    }

    // ── Bonus spontaneous nudge (1/day, random time, varies daily per user)
    // Slots into the gap between existing scheduled messages. Only for users
    // who are somewhat engaged (replied within the last 2 days). Uses Redis
    // lock for dedup — no DB column needed.
    if (silentDays > 2) return;

    // Pick a random time between 10:00 and 19:00 local. The seed includes
    // the phone + date so each user gets a different time each day, and the
    // same user gets a consistent time within the same day (survives restarts).
    const bonusTargetMin = 10 * 60 + jitterMinutes(`${user.phone}-${todayStr}-bonus`, 9 * 60);

    // Minimum 60-minute gap from other scheduled messages to feel spontaneous
    const tooCloseToMorning = Math.abs(bonusTargetMin - morningTargetMin) < 60;
    const tooCloseToMidday = MIDDAY_DAYS.has(dayOfWeek) ? Math.abs(bonusTargetMin - middayTargetMin) < 60 : false;
    const tooCloseToEvening = EVENING_DAYS.has(dayOfWeek) ? Math.abs(bonusTargetMin - eveningTargetMin) < 60 : false;
    if (tooCloseToMorning || tooCloseToMidday || tooCloseToEvening) return;

    // 15-minute delivery window
    if (nowMin >= bonusTargetMin && nowMin < bonusTargetMin + 15) {
      await this.sendAndRecord(user, 'bonus');
    }
  }

  private async handleInjectionFlow(user: GraceUser, hour: number): Promise<void> {
    const stage = user.injection_flow_stage;
    const [wHour = 8, wMin = 0] = (user.wake_time || '08:00').split(':').map(Number);
    const wakeBaseMin = wHour * 60 + wMin;
    const todayStr = toDateStr(localNow(user.timezone || 'America/New_York'));
    const minute = localNow(user.timezone || 'America/New_York').getMinutes();
    const injectionOffset = jitterMinutes(`${user.phone}-${todayStr}-injection`, 45);
    const injectionTargetMin = wakeBaseMin + injectionOffset;
    const nowMin = hour * 60 + minute;

    // Safety reset: if the previous injection flow never completed (user
    // never replied "Done"), stage stays stuck at 'morning_sent' indefinitely
    // and blocks next week's injection morning from firing. Reset to null
    // once it's been >24h — today is a fresh injection day for this user.
    if (
      (stage === 'morning_sent' || stage === 'done_confirmed') &&
      user.injection_flow_started_at
    ) {
      const hoursSinceStart =
        (Date.now() - new Date(user.injection_flow_started_at).getTime()) / 3_600_000;
      if (hoursSinceStart >= 24) {
        await this.deps.users.setInjectionStage(user.phone, null, {
          injection_flow_started_at: null,
          injection_done_at: null,
        });
        // Tick will reach the !stage branch below on the next minute.
        return;
      }
    }

    // Stage 0: Send injection morning message during randomized morning window
    if (!stage && nowMin >= injectionTargetMin) {
      await this.sendAndRecord(user, 'injection_morning');
      await this.deps.users.setInjectionStage(user.phone, 'morning_sent', {
        injection_flow_started_at: new Date(),
      });
      return;
    }

    // NOTE: Followup is GATED on user replying "Done" (webhook handler sets
    // stage='done_confirmed' + injection_done_at). It does NOT fire 3h after
    // the morning reminder — that was the pre-2026-05-29 bug, which caused
    // the post-shot check-in to land at 10:29am for users who hadn't
    // injected yet (e.g. evening injectors).
    //
    // The done_confirmed → injection_followup transition is now handled in
    // processUser() so it fires on ANY day, not just the injection day —
    // critical for evening injectors whose 3h window crosses into quiet
    // hours and defers to the next morning's tick.
  }

  private async sendAndRecord(user: GraceUser, type: Parameters<MessageGenerator['generate']>[0], opts?: GenerateOpts): Promise<void> {
    // ─── Cadence guardrails ──────────────────────────────────────────────────
    // Two layers of suppression, applied in order:
    //
    //   LAYER 1 — ENGAGEMENT COOLDOWN (applies to ALL non-critical types)
    //     If the user has sent a message in the last ENGAGEMENT_COOLDOWN_HOURS
    //     (default 2h), suppress the proactive reminder entirely. Grace is a
    //     companion, not a notification system — recent engagement always wins
    //     over a scheduled reminder. Resets automatically on every user reply
    //     because last_reply_at is updated by UserService.ensureUser on each
    //     inbound message.
    //
    //   LAYER 2 — DAILY CADENCE (applies to non-critical, non-injection types)
    //     1. Honor checkin_days_interval (every-N-days users skip off days)
    //     2. Max checkin_count_per_day proactive reminders per user per day
    //        (user Setting, clamped 1..3, default 2)
    //     3. Min 3 hours between reminders
    //
    // Exemptions (truly time-critical health flows):
    //   - injection_morning: today is injection day, the user needs to know
    //   - injection_followup: same-day "did you take it?" check
    //   - trial_expiry_reminder: time-bound to trial-end day
    //
    // injection_dayafter is NOT exempt — it's a check-in, not urgent. An
    // engaged user already knows the injection happened yesterday.
    const todayStr = toDateStr(localNow(user.timezone || 'America/New_York'));
    const CRITICAL_HEALTH_TYPES = new Set([
      'injection_morning',
      'injection_followup',
      'trial_expiry_reminder',
    ]);
    const isCritical = CRITICAL_HEALTH_TYPES.has(type);

    // ─── LAYER 1: Engagement cooldown ─────────────────────────────────────────
    // Applies to EVERY type except truly critical health alerts. Skipping is
    // the right behavior: the user is already talking to Grace, the next
    // scheduled tick will re-check and send if the cooldown has expired.
    const cooldownH = this.deps.engagementCooldownHours ?? 2;
    if (cooldownH > 0 && !isCritical && user.last_reply_at) {
      const hoursSinceUserReply = (Date.now() - new Date(user.last_reply_at).getTime()) / 3_600_000;
      if (hoursSinceUserReply < cooldownH) {
        this.deps.logger.info(
          {
            phone: user.phone,
            type,
            hoursSinceUserReply: hoursSinceUserReply.toFixed(2),
            cooldownH,
          },
          'scheduler.engagement_cooldown_active',
        );
        return;
      }
    }

    // ─── LAYER 2: Daily cadence ───────────────────────────────────────────────
    if (!isCritical) {
      // Honor the user's check-in cadence Settings. Until 2026-06-10 these
      // fields were collected at onboarding, editable on the Settings page,
      // and claimed by the AI context ("CHECKIN FREQUENCY: N") — but never
      // read here, so a user who chose 1/day still got the hard-coded 2/day.
      //
      //   checkin_days_interval: 1 = daily (default), 2 = every other day, …
      //     Phase is the user-local day number mod interval — deterministic
      //     across restarts and across both Fly machines.
      //   checkin_count_per_day: daily cap on non-critical proactive sends,
      //     clamped to [1, 3] (3 = structural max of the weekly schedule;
      //     the previous hard cap of 2 is now simply the default).
      const daysInterval = Math.max(1, user.checkin_days_interval || 1);
      if (daysInterval > 1) {
        const dayNumber = Math.floor(Date.parse(todayStr) / 86_400_000);
        if (dayNumber % daysInterval !== 0) {
          this.deps.logger.info(
            { phone: user.phone, type, daysInterval },
            'scheduler.skipped_days_interval',
          );
          return;
        }
      }
      const dailyCap = Math.min(3, Math.max(1, user.checkin_count_per_day || 2));
      const countKey = `cadence:${user.phone}:${todayStr}`;
      const lastKey = `cadence:last:${user.phone}`;
      try {
        const currentCount = parseInt((await this.deps.redis.get(countKey)) ?? '0', 10);
        if (currentCount >= dailyCap) {
          this.deps.logger.info({ phone: user.phone, type, count: currentCount, dailyCap }, 'scheduler.skipped_daily_cap');
          return;
        }
        const lastSentMs = parseInt((await this.deps.redis.get(lastKey)) ?? '0', 10);
        const hoursSinceLast = (Date.now() - lastSentMs) / 3_600_000;
        if (lastSentMs > 0 && hoursSinceLast < 3) {
          this.deps.logger.info(
            { phone: user.phone, type, hoursSinceLast: hoursSinceLast.toFixed(2) },
            'scheduler.skipped_min_gap',
          );
          return;
        }
      } catch (err) {
        this.deps.logger.warn({ err, phone: user.phone }, 'scheduler.cadence_check_failed_proceeding');
      }
    }

    // Distributed lock: prevent two Fly machines from sending the same
    // message type to the same user on the same day. TTL = 23h so the key
    // expires before tomorrow's window opens. NX means only the first
    // machine to acquire the lock proceeds; the second skips silently.
    // Failure-open: if Redis is unavailable (rate-limited, network error),
    // we proceed without the lock rather than blocking reminders entirely.
    // Worst case: a user gets a duplicate message — vastly better than none.
    const lockKey = `sched:${user.phone}:${type}:${todayStr}`;
    let lockAcquired = false;
    try {
      const acquired = await this.deps.redis.set(lockKey, '1', 'EX', 82800, 'NX');
      if (!acquired) {
        this.deps.logger.debug({ phone: user.phone, type }, 'scheduler.skipped_duplicate');
        return;
      }
      lockAcquired = true;
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, phone: user.phone, type }, 'scheduler.lock_failed_proceeding_without_lock');
      // Continue without lock — DB-level last_*_sent_at gates still prevent same-machine duplicates.
    }

    try {
      const enriched = await this.enrichGenerateOpts(user, type, opts);
      const message = await this.deps.generator.generate(type, user, enriched);
      // 2026-06-05 — shortened from the 60-char "Rate this:..." appendage
      // that was 8.5x longer than short replies like "Logged."
      const body = user.rlhf_enabled && message.trim().length >= 25
        ? `${message}\n\n👍 👎 to rate · # to add a thought`
        : message;
      await this.deps.sender.send({ to: user.phone, body, channel: user.channel ?? 'whatsapp' });
      await this.deps.users.recordCheckIn({
        userId: user.phone,
        phone: user.phone,
        type,
        messageSent: message,
      });
      // Increment cadence counters (skip for critical time-bound flows that
      // don't participate in the daily cap).
      if (!isCritical) {
        try {
          const countKey = `cadence:${user.phone}:${todayStr}`;
          const lastKey = `cadence:last:${user.phone}`;
          await this.deps.redis.incr(countKey);
          await this.deps.redis.expire(countKey, 86400);
          await this.deps.redis.set(lastKey, Date.now().toString(), 'EX', 86400);
        } catch (err) {
          this.deps.logger.warn({ err, phone: user.phone }, 'scheduler.cadence_increment_failed');
        }
      }
      this.deps.logger.info({ phone: user.phone, type }, 'scheduler.sent');
    } catch (err) {
      if (lockAcquired) {
        await this.deps.redis.del(lockKey).catch(() => undefined);
      }
      this.deps.logger.error({ err, phone: user.phone, type }, 'scheduler.send.failed');
    }
  }

  /**
   * Enrich generation opts with REAL user data so reminders are grounded in
   * actual behavior instead of generic templates (2026-06-11 reminders fix):
   *   - morning  → YESTERDAY's food totals (plan today from yesterday's gap)
   *   - evening  → TODAY's running totals (daily wrap-up, "82g so far")
   *   - all generative types → last 5 sent reminder texts (anti-repetition)
   * Every fetch is best-effort: a DB hiccup never blocks the reminder — the
   * generator just falls back to its generic (still safe) prompt.
   */
  private async enrichGenerateOpts(
    user: GraceUser,
    type: Parameters<MessageGenerator['generate']>[0],
    opts?: GenerateOpts,
  ): Promise<GenerateOpts | undefined> {
    const GENERATIVE_TYPES = new Set(['morning', 'midday', 'evening', 'bonus', 'injection_dayafter']);
    if (!GENERATIVE_TYPES.has(type)) return opts;
    const enriched: GenerateOpts = { ...(opts ?? {}) };

    try {
      const recent = await this.deps.users.getRecentCheckIns(user.phone, 5);
      const texts = recent.map((c) => c.message_sent).filter((m): m is string => !!m && m.length > 0);
      if (texts.length > 0) enriched.recentMessages = texts;
    } catch { /* best-effort */ }

    // Conversation relevance — pull what the USER has recently said so the
    // reminder can gently reference a topic they raised (a symptom, a goal, a
    // struggle), not feel generic/canned. Best-effort; only the user's own
    // turns, truncated, most-recent first. The generator is told to weave it in
    // only if clearly relevant and never to invent.
    if (this.deps.memory) {
      try {
        const turns = await this.deps.memory.getRecentTurns(user.phone, 10);
        const userMsgs = turns
          .filter((t) => t.role === 'user' && t.content && t.content.trim().length > 1)
          .slice(-5)
          .map((t) => t.content.trim().replace(/\s+/g, ' ').slice(0, 140));
        if (userMsgs.length > 0) enriched.conversationContext = userMsgs;
      } catch { /* best-effort */ }
    }

    if (type === 'morning') {
      try {
        const hist = await this.deps.users.getDailyProteinHistory(user.phone, 2);
        const todayLocal = toDateStr(localNow(user.timezone || 'America/New_York'));
        const yesterday = hist.find((d) => d.day !== todayLocal);
        if (yesterday) {
          enriched.yesterdayFood = {
            protein_g: Math.round(yesterday.protein_g),
            calories: Math.round(yesterday.calories),
            itemCount: yesterday.item_count,
            proteinGoal: user.protein_goal_grams ?? null,
          };
        } else if (hist.length > 0 || user.last_reply_at) {
          // History query worked but yesterday has no row → nothing was logged.
          enriched.yesterdayFood = { protein_g: 0, calories: 0, itemCount: 0, proteinGoal: user.protein_goal_grams ?? null };
        }
      } catch { /* best-effort */ }
    }

    if (type === 'evening') {
      try {
        const today = await this.deps.users.getTodaysFoodSummary(user.phone);
        enriched.todayFood = {
          protein_g: Math.round(today.protein_g),
          calories: Math.round(today.calories),
          itemCount: today.items.length,
          proteinGoal: user.protein_goal_grams ?? null,
        };
      } catch { /* best-effort */ }
    }

    return enriched;
  }

  private async runPersonalizationEngine(): Promise<void> {
    try {
      const users = await this.deps.users.listActiveUsers();
      let updated = 0;
      for (const user of users) {
        const checkins = await this.deps.users.getRecentCheckIns(user.phone, 20);
        const flags = analyzeUserBehavior(checkins);
        const changed = Object.keys(flags).some((k) => user[k as keyof GraceUser] !== flags[k as keyof typeof flags]);
        if (changed) {
          await this.deps.users.update(user.phone, flags);
          updated++;
        }
      }
      this.deps.logger.info({ total: users.length, updated }, 'personalization.engine.done');
    } catch (err) {
      this.deps.logger.error({ err }, 'personalization.engine.error');
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function localNow(tz: string, date = new Date()): Date {
  const safeTz = tz || 'America/New_York';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
    return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`);
  } catch {
    // Invalid IANA timezone — fall back to America/New_York instead of UTC
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(date);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
      return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`);
    } catch {
      return date;
    }
  }
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic per-user-per-day jitter in minutes (0 to maxMinutes-1).
 * Same seed → same offset, so re-runs of the cron within the same day land
 * in the same window. Different days, users, or message types get different
 * offsets — so deliveries feel naturally varied, never mechanically scheduled.
 * Survives restarts, retries, and timezone resyncs because the seed encodes
 * user + local date + message type, not wall-clock time.
 */
export function jitterMinutes(seed: string, maxMinutes: number): number {
  if (maxMinutes <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % maxMinutes;
}

/** Has the user actively replied since today's morning message went out? */
function userEngagedToday(user: GraceUser): boolean {
  if (!user.last_reply_at || !user.last_morning_sent_at) return false;
  return new Date(user.last_reply_at) >= new Date(user.last_morning_sent_at);
}

/** Days elapsed since the user last replied (Infinity if they never have). */
function userSilentDays(user: GraceUser): number {
  if (!user.last_reply_at) return Infinity;
  return (Date.now() - new Date(user.last_reply_at).getTime()) / (24 * 3_600_000);
}

function analyzeUserBehavior(checkins: Array<{ type: string; user_reply: string | null; mood_score: number | null }>) {
  const flags: Partial<Pick<GraceUser, 'protein_focus_boost' | 'hydration_struggle' | 'low_mood_mode' | 'midday_skip'>> = {};

  const morningCheckins = checkins.filter((c) => c.type === 'morning');
  const middayCheckins = checkins.filter((c) => c.type === 'midday');
  const moodScores = checkins.filter((c) => c.mood_score !== null).map((c) => c.mood_score!);

  // Low mood: avg < 5 with >= 3 samples
  if (moodScores.length >= 3) {
    const avg = moodScores.reduce((a, b) => a + b, 0) / moodScores.length;
    flags.low_mood_mode = avg < 5;
  }

  // Midday skip: low midday reply rate but high morning reply rate
  if (middayCheckins.length >= 4 && morningCheckins.length >= 4) {
    const middayReplyRate = middayCheckins.filter((c) => c.user_reply).length / middayCheckins.length;
    const morningReplyRate = morningCheckins.filter((c) => c.user_reply).length / morningCheckins.length;
    flags.midday_skip = middayReplyRate < 0.15 && morningReplyRate > 0.5;
  }

  return flags;
}
