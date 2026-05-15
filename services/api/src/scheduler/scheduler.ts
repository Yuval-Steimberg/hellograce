import cron from 'node-cron';
import type { Logger } from 'pino';
import type { UserService, GraceUser } from '../user/user.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { MessageGenerator, GenerateOpts } from './message-generator.js';
import type { PromptOptimizer } from './prompt-optimizer.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MIDDAY_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
const EVENING_DAYS = new Set([2, 4, 0]); // Tue, Thu, Sun

interface SchedulerDeps {
  users: UserService;
  sender: TwilioSender;
  generator: MessageGenerator;
  logger: Logger;
  promptOptimizer?: PromptOptimizer;
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
    // Prompt optimizer runs DAILY at 4am UTC so every signal that lands in
    // the feedback table gets analyzed within 24h. Strict isSafe() gates
    // auto-activation; failures save as inactive drafts for admin review.
    if (this.deps.promptOptimizer) {
      this.tasks.push(
        cron.schedule('0 4 * * *', () => void this.deps.promptOptimizer!.run()),
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
      await Promise.allSettled(users.map((u) => this.processUser(u)));
    } catch (err) {
      this.deps.logger.error({ err }, 'scheduler.tick.error');
    }
  }

  private async processUser(user: GraceUser): Promise<void> {
    const now = localNow(user.timezone);
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const todayStr = toDateStr(now);

    // ── Quiet hours: never send proactive messages between 21:00 and 07:00 local
    if (hour >= 21 || hour < 7) return;

    // ── Injection day flow (runs any day matching injection_day)
    if (user.injection_day && user.injection_day === DAYS[dayOfWeek]) {
      await this.handleInjectionFlow(user, hour);
      return; // Skip regular check-ins on injection day
    }

    // ── Day-after injection (stage = followup_sent → next morning message)
    if (user.injection_flow_stage === 'followup_sent' && user.injection_flow_started_at) {
      const flowDay = localNow(user.timezone, new Date(user.injection_flow_started_at));
      if (toDateStr(flowDay) !== todayStr && hour >= parseInt(user.wake_time.split(':')[0]!, 10)) {
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
    const wakeHour = parseInt(user.wake_time.split(':')[0]!, 10);
    const isMorningWindow = hour >= wakeHour && hour <= wakeHour + 1;
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

    // ── Midday nudge (Mon/Wed/Fri, 11am–2pm local)
    if (
      MIDDAY_DAYS.has(dayOfWeek) &&
      hour >= 11 && hour <= 14 &&
      !user.midday_skip &&
      (!user.last_midday_sent_at || toDateStr(localNow(user.timezone, new Date(user.last_midday_sent_at))) !== todayStr) &&
      // Skip if user replied within last 3h — they're already in active chat
      (!user.last_reply_at || Date.now() - new Date(user.last_reply_at).getTime() > 3 * 3_600_000) &&
      // Engagement dampener: skip midday after >1 day of silence
      (engagedToday || silentDays < 1)
    ) {
      // Only send midday if morning was sent today (don't double-cold-start)
      const morningToday = user.last_morning_sent_at &&
        toDateStr(localNow(user.timezone, new Date(user.last_morning_sent_at))) === todayStr;
      if (morningToday) {
        await this.sendAndRecord(user, 'midday');
        await this.deps.users.update(user.phone, { last_midday_sent_at: new Date() });
        return;
      }
    }

    // ── Evening wind-down (Tue/Thu/Sun, 90 min before sleep)
    const sleepHour = parseInt(user.sleep_time.split(':')[0]!, 10);
    const isEveningWindow =
      EVENING_DAYS.has(dayOfWeek) &&
      ((hour === sleepHour - 2 && minute >= 30) || (hour === sleepHour - 1 && minute === 0));
    if (
      isEveningWindow &&
      // Hard cap: never send evening to a user who hasn't actively chatted today
      engagedToday
    ) {
      if (!user.last_evening_sent_at || toDateStr(localNow(user.timezone, new Date(user.last_evening_sent_at))) !== todayStr) {
        await this.sendAndRecord(user, 'evening', { lowMoodMode: user.low_mood_mode ?? false });
        await this.deps.users.update(user.phone, { last_evening_sent_at: new Date() });
      }
    }
  }

  private async handleInjectionFlow(user: GraceUser, hour: number): Promise<void> {
    const stage = user.injection_flow_stage;
    const wakeHour = parseInt(user.wake_time.split(':')[0]!, 10);

    // Stage 0: Send injection morning message at user's wake time
    if (!stage && hour >= wakeHour) {
      await this.sendAndRecord(user, 'injection_morning');
      await this.deps.users.setInjectionStage(user.phone, 'morning_sent', {
        injection_flow_started_at: new Date(),
      });
      return;
    }

    // Stage 1: Send followup 3 hours after morning message
    if (stage === 'morning_sent' && user.injection_flow_started_at) {
      const elapsed = (Date.now() - new Date(user.injection_flow_started_at).getTime()) / 3_600_000;
      if (elapsed >= 3) {
        await this.sendAndRecord(user, 'injection_followup');
        await this.deps.users.setInjectionStage(user.phone, 'followup_sent', {
          injection_evening_followup_due: true,
        });
      }
    }

    // 'done_confirmed' is set when user replies 'done' in the webhook handler
    if (stage === 'done_confirmed') {
      const elapsed = user.injection_done_at
        ? (Date.now() - new Date(user.injection_done_at).getTime()) / 3_600_000
        : 3;
      if (elapsed >= 3) {
        await this.sendAndRecord(user, 'injection_followup');
        await this.deps.users.setInjectionStage(user.phone, 'followup_sent', {
          injection_evening_followup_due: true,
        });
      }
    }
  }

  private async sendAndRecord(user: GraceUser, type: Parameters<MessageGenerator['generate']>[0], opts?: GenerateOpts): Promise<void> {
    try {
      const message = await this.deps.generator.generate(type, user, opts);
      await this.deps.sender.send({ to: user.phone, body: message, channel: 'whatsapp' });
      await this.deps.users.recordCheckIn({
        userId: user.phone,
        phone: user.phone,
        type,
        messageSent: message,
      });
      this.deps.logger.info({ phone: user.phone, type }, 'scheduler.sent');
    } catch (err) {
      this.deps.logger.error({ err, phone: user.phone, type }, 'scheduler.send.failed');
    }
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
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
    return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`);
  } catch {
    return date;
  }
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
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
