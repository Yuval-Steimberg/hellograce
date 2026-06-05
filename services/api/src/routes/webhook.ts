import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import type { AIService } from '../services/ai.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { UserService, GraceUser } from '../user/user.service.js';
import type { MessageTemplatesService } from '../services/message-templates.service.js';
import { isValidTwilioSignature } from '../twilio/signature.js';
import { normalizeTwilio, type RawTwilioPayload } from '../twilio/normalize.js';
import { UnauthorizedError, UpstreamError } from '../errors.js';
import { classifyScope } from '../safety/scope-guard.js';
import { classifyMessage as classifySafety } from '../safety/guard.js';

const DEFAULT_WEB_URL = 'https://grace-admin-silk.vercel.app';

export interface WebhookDeps {
  env: Env;
  ai: AIService;
  sender: TwilioSender;
  users?: UserService;
  redis?: Redis;
  templates?: MessageTemplatesService;
  /** Phase 5: contextual bandit reward update on 👍/👎 feedback. */
  bandit?: import('../services/bandit.service.js').BanditService;
}

// Twilio inbound webhook. Processing order: (1) verify Twilio signature,
// (2) deduplicate by MessageSid, (3) return empty TwiML immediately,
// (4) async: coalesce rapid messages, (5) upsert user, (6) intercept
// special intents (injection done, opt-out, frequency change, injection day
// change, RLHF feedback, upgrade intent), (7) subscription gate,
// (8) AI pipeline → send response via TwilioSender.
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDeps): void {
  app.post('/webhook/twilio', async (req, reply) => {
    const fullUrl = `${deps.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhook/twilio`;
    const signature = req.headers['x-twilio-signature'];
    const sigHeader = Array.isArray(signature) ? signature[0] : signature;
    const params = req.body as Record<string, string>;

    if (deps.env.NODE_ENV === 'production') {
      const ok = isValidTwilioSignature({
        authToken: deps.env.TWILIO_AUTH_TOKEN,
        signatureHeader: sigHeader,
        url: fullUrl,
        params,
      });
      if (!ok) throw new UnauthorizedError('Invalid Twilio signature');
    }

    const normalized = normalizeTwilio(params as unknown as RawTwilioPayload);

    // Deduplicate by Twilio MessageSid — Twilio retries webhooks if our server
    // is slow (e.g. Fly cold start). Without this, a timed-out 8 AM message
    // can replay hours later with the original text instead of answering the
    // current question. TTL 2h covers all realistic retry windows.
    if (deps.redis && normalized.providerMessageId) {
      const dedupKey = `twilio:seen:${normalized.providerMessageId}`;
      const alreadySeen = await deps.redis.set(dedupKey, '1', 'EX', 7200, 'NX');
      if (alreadySeen === null) {
        req.log.warn(
          { msgSid: normalized.providerMessageId, userId: normalized.userId },
          'webhook.duplicate_sid_dropped',
        );
        reply.header('content-type', 'text/xml');
        return reply.send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      }
    }

    req.log.info(
      { userId: normalized.userId, channel: normalized.channel, type: normalized.type },
      'webhook.received',
    );

    // Reply with empty TwiML immediately; AI work + outbound send happens async.
    reply.header('content-type', 'text/xml');
    void reply.send('<?xml version="1.0" encoding="UTF-8"?><Response/>');

    // Fire-and-forget AI processing.
    void (async () => {
      // In-flight lock: prevents TWO concurrent AI pipelines from running for
      // the same user, which would otherwise produce duplicate replies (e.g.
      // both a short refusal AND a long memory-dump in the same minute — the
      // exact bug reported 2026-05-29). 30s TTL covers the slowest realistic
      // turn; release in finally so the next turn isn't blocked.
      // Failure-open: if Redis is down, proceed without the lock rather than
      // dropping the user's message entirely.
      const inflightKey = `inflight:${normalized.userId}`;
      let inflightAcquired = false;
      if (deps.redis) {
        try {
          const ok = await deps.redis.set(inflightKey, '1', 'EX', 30, 'NX');
          if (ok === null) {
            req.log.warn({ userId: normalized.userId }, 'webhook.inflight_skip');
            return;
          }
          inflightAcquired = true;
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'webhook.inflight_lock_failed_proceeding');
        }
      }

      try {
        // Coalesce rapid consecutive text messages (corrections, continuations).
        // If this message is absorbed into a pending window, exit early — the
        // lock-holder will process the merged text. Media messages fire immediately.
        //
        // Fast-path bypass (2026-05-30): pure greetings / brief acks / thanks
        // get an instant deterministic reply, so the 2-second coalesce wait is
        // pure dead time for them. Skip coalesce when the message is short and
        // matches a no-continuation pattern. Real multi-message bursts (food
        // logs, questions, longer content) still go through the buffer.
        if (deps.redis && normalized.type === 'text') {
          if (!shouldSkipCoalesce(normalized.text)) {
            const coalesced = await coalesceMessages(deps.redis, normalized.userId, normalized.text);
            if (coalesced === null) return;
            normalized.text = coalesced;
          }
        }

        let user: GraceUser | null = null;
        // Upsert the user record and update last_reply_at on every inbound message.
        if (deps.users) {
          user = await deps.users.ensureUser(normalized.userId).catch(() => null);

          // Handle injection "done" reply — advance the state machine.
          if (user && user.injection_flow_stage === 'morning_sent') {
            const trimmed = normalized.text.trim().toLowerCase();
            if (trimmed === 'done' || trimmed === 'done!' || trimmed === 'injected') {
              await deps.users.setInjectionStage(user.phone, 'done_confirmed', {
                injection_done_at: new Date(),
              }).catch(() => null);
            }
          }

          // ── Natural-language opt-out (master prompt — OPT-OUT HANDLING).
          // Literal STOP/UNSUBSCRIBE are handled by Twilio at the carrier level;
          // these phrases still need an in-conversation response.
          if (user) {
            const optOutReply = detectNaturalOptOut(normalized.text, deps.env.PUBLIC_WEB_URL);
            if (optOutReply) {
              await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: optOutReply });
              return;
            }
          }

          // ── In-chat check-in frequency change (master prompt — CHECK-IN FREQUENCY).
          // Update the field directly and confirm warmly; do NOT send to settings.
          if (user) {
            const freqChange = detectFrequencyChange(normalized.text, user.checkin_count_per_day ?? 1);
            if (freqChange) {
              await deps.users.update(user.phone, { checkin_count_per_day: freqChange.newCount }).catch(() => null);
              await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: freqChange.reply });
              return;
            }
          }

          // ── In-chat injection day change.
          // Handles typo-tolerant phrasings like "change my injuction day to Sunday".
          if (user) {
            const injDay = detectInjectionDayChange(normalized.text);
            if (injDay) {
              // Reset injection flow stage so the new injection day starts
              // clean. Without this, a leftover stage ('done_confirmed',
              // 'followup_sent') from the previous injection day prevents
              // handleInjectionFlow() from firing the morning reminder on
              // the new day — the `if (!stage ...)` guard stays false forever.
              await deps.users.update(user.phone, { injection_day: injDay }).catch(() => null);
              await deps.users.setInjectionStage(user.phone, null, {
                injection_flow_started_at: null,
                injection_done_at: null,
                injection_evening_followup_due: false,
              }).catch(() => null);
              await deps.sender.send({
                to: normalized.userId,
                channel: normalized.channel,
                body: `Done — your injection day is now set to ${injDay}.`,
              });
              return;
            }
          }

          // RLHF feedback signal — intercept before AI for opted-in users.
          if (user?.rlhf_enabled) {
            const fbResult = parseFeedbackSignal(normalized.text);
            if (fbResult) {
              await deps.users.recordUserFeedback(user.phone, fbResult.rating, fbResult.comment).catch(() => null);
              // Phase 5: feed reward to the contextual bandit. The user's `id`
              // is the bandit key (matches user_bandit_state.user_id). Fire-
              // and-forget — never blocks the ack.
              if (deps.bandit && user.id) {
                void deps.bandit.recordReward(user.id, fbResult.rating > 0).catch(() => {});
              }
              const ack = fbResult.rating > 0
                ? 'Glad that landed well.'
                : fbResult.comment
                  ? 'Got it. I hear you.'
                  : 'Noted.';
              await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: ack });
              return;
            }
          }

          // ── SAFETY GUARD — MUST RUN BEFORE ANY SHORT-CIRCUIT ──────────
          // Crisis / emergency keywords (suicide, self-harm, chest pain,
          // breathing trouble) MUST short-circuit to the unified 988+911
          // safety response BEFORE the pause / upgrade / paywall intercepts.
          // Otherwise a message like "ending it all please pause messages"
          // would land in the pause confirmation and skip the safety reply.
          //
          // This duplicates ai.service.ts's safety check at line 100, but
          // running it here too guarantees the safety reply fires even when
          // a short-circuit would otherwise prevent ai.service from being
          // called at all.
          const safety = classifySafety(normalized.text);
          if (safety.class !== 'safe') {
            req.log.warn({ phone: user?.phone, class: safety.class, matched: safety.matched }, 'webhook.safety.short_circuit');
            await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: safety.response! });
            return;
          }

          // ── In-chat pause intent (Phase 1 coverage expansion) ─────────
          // "pause", "stop sending messages", "I need a break". Flips
          // users.paused = TRUE; scheduler's listActiveUsers() already
          // excludes paused users so proactive messages stop immediately.
          if (user && deps.users && detectPauseIntent(normalized.text)) {
            const phone = user.phone;
            await deps.users.setPaused(phone, true).catch((err: unknown) => {
              req.log.warn({ err: err instanceof Error ? err.message : String(err), phone }, 'pause.set_paused.failed');
            });
            const reply = 'Got it, I\'ll pause the check-ins. Text me anytime you want to pick it back up 🧡';
            await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: reply });
            return;
          }

          // ── Auto-resume from pause ────────────────────────────────────
          // If the user was paused and now sends a non-pause message, treat
          // it as natural re-engagement and silently flip paused back to
          // FALSE. No confirmation message — Grace just answers normally.
          if (user?.paused && deps.users) {
            const phone = user.phone;
            await deps.users.setPaused(phone, false).catch((err: unknown) => {
              req.log.warn({ err: err instanceof Error ? err.message : String(err), phone }, 'pause.auto_resume.failed');
            });
            req.log.info({ phone }, 'pause.auto_resumed');
          }

          // ── In-chat upgrade / manage intent ("upgrade", "go pro", "manage
          // subscription", "pricing" …). The destination URL depends on the
          // user's current subscription state:
          //   - Trial / unpaid users → /upgrade (Stripe checkout flow)
          //   - Paid / Pro users    → /settings (Stripe Customer Portal /
          //                                       cancel / update payment)
          // Wording also adapts so it matches the destination — telling a
          // paid user to "upgrade" sends them through checkout again, which
          // was the production bug here. Telling a trial user to "manage"
          // doesn't fit either.
          if (user && detectUpgradeIntent(normalized.text)) {
            const isPaidUser = user.is_paid || user.is_pro;
            const destinationUrl = isPaidUser
              ? buildSettingsUrl(user.phone, deps.env.PUBLIC_WEB_URL)
              : buildUpgradeUrl(user.phone, deps.env.PUBLIC_WEB_URL);
            const fallbackText = isPaidUser
              ? `You can manage your subscription anytime at ${destinationUrl} 🧡`
              : `You can upgrade your plan anytime at ${destinationUrl} 🧡`;
            const reply = deps.templates
              ? await deps.templates.render(
                  isPaidUser ? 'manage_subscription' : 'upgrade_nudge',
                  { upgrade_url: destinationUrl, first_name: user.first_name ?? '' },
                  fallbackText,
                )
              : fallbackText;
            await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: reply });
            return;
          }

          // Subscription gate — users with an expired trial and no active subscription
          // get a soft paywall nudge instead of the AI response.
          if (user && !isAccessAllowed(user)) {
            const upgradeUrl = buildUpgradeUrl(user.phone, deps.env.PUBLIC_WEB_URL);
            const body = deps.templates
              ? await deps.templates.render(
                  'paywall',
                  { upgrade_url: upgradeUrl, first_name: user.first_name ?? '' },
                  `Your 3-day Grace trial has ended 🧡 To keep your daily check-ins going, head to ${upgradeUrl} to subscribe. Questions? Reply HELP.`,
                )
              : `Your 3-day Grace trial has ended 🧡 To keep your daily check-ins going, head to ${upgradeUrl} to subscribe. Questions? Reply HELP.`;
            await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body });
            return;
          }
        }

        // ── Scope guard ──────────────────────────────────────────────────────
        // Off-topic queries (politics, war, finance, coding, sports, etc.) get
        // a short canned boundary response. This runs BEFORE the AI pipeline
        // so memory retrieval, context summarization, and the orchestrator
        // never see the message — preventing leaks like
        //   User: "Will Trump attack Iran?"
        //   Grace: "I know you're on Ozempic, working towards your weight loss…"
        // Text-only: media (food/body photos, voice notes) is always in-scope.
        if (normalized.type === 'text') {
          const scope = classifyScope(normalized.text);
          if (scope.blocked) {
            req.log.info(
              { userId: normalized.userId, category: scope.category, matched: scope.matched },
              'webhook.scope_blocked',
            );
            // Append RLHF rating prompt for opted-in users — same as the AI
            // handler path. Lets users 👎 a refusal that felt off (e.g. too
            // curt, missed an in-scope follow-up) so we can tune the guard.
            const isRlhfUser = user?.rlhf_enabled ?? false;
            const body = isRlhfUser
              ? `${scope.response!}\n\nRate this: 👍 👎\nOr start your reply with # to share a thought.`
              : scope.response!;
            await deps.sender.send({
              to: normalized.userId,
              channel: normalized.channel,
              body,
            });
            return;
          }
        }

        const result = await withRetry(() => deps.ai.handleMessage(normalized), {
          attempts: 2,
          delayMs: 2000,
          retryIf: (err) => err instanceof UpstreamError || isTransientError(err),
        });

        const responseText = result?.text ?? '';
        if (responseText.length > 0) {
          // RLHF prompt is appended for ALL replies (including safe fallbacks)
          // so users can flag bad fallbacks too — that signal is the most
          // valuable for tuning the safe-fallback trigger thresholds.
          const isRlhfUser = user?.rlhf_enabled ?? false;
          const body = isRlhfUser
            ? `${responseText}\n\nRate this: 👍 👎\nOr start your reply with # to share a thought.`
            : responseText;
          await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body });
        }
      } catch (err) {
        req.log.error({ err }, 'webhook.ai.failed');
        const fallbacks = [
          "I'm here — what's on your mind?",
          "Hey, what would you like to talk about?",
          "I'm listening — go ahead.",
        ];
        const fallback = fallbacks[Math.floor(Math.random() * fallbacks.length)]!;
        await deps.sender
          .send({ to: normalized.userId, channel: normalized.channel, body: fallback })
          .catch(() => null);
      } finally {
        // Release the in-flight lock so this user's next message isn't blocked.
        // Best-effort: a transient Redis failure here is fine because the lock
        // would expire on its own after 30s.
        if (inflightAcquired && deps.redis) {
          await deps.redis.del(inflightKey).catch(() => undefined);
        }
      }
    })();
  });
}

const TRIAL_DAYS = 3;

function isAccessAllowed(user: { is_paid: boolean; is_pro: boolean; trial_start: Date | null }): boolean {
  if (user.is_paid || user.is_pro) return true;
  if (!user.trial_start) return true; // no trial_start = not yet onboarded via v2, allow
  const msElapsed = Date.now() - new Date(user.trial_start).getTime();
  return msElapsed < TRIAL_DAYS * 24 * 3_600_000;
}

// ─── Natural-language opt-out ────────────────────────────────────────────────
// Literal STOP/UNSUBSCRIBE/QUIT/CANCEL/END are intercepted by Twilio at the
// carrier level. These phrases still reach Grace and must redirect warmly to
// the settings link with no retention attempt (master prompt — OPT-OUT HANDLING).
const OPT_OUT_PHRASES: RegExp[] = [
  /\b(stop\s+texting|stop\s+messaging|stop\s+contacting)\s+me\b/i,
  /\bdon'?t\s+(want|need)\s+(any\s+)?(more\s+)?(messages|texts|reminders)\b/i,
  /\bi\s+want\s+to\s+(cancel|unsubscribe|quit|stop)\b/i,
  /\bplease\s+stop\b/i,
  /\b(cancel|delete)\s+my\s+(account|subscription)\b/i,
  /\bturn\s+(this|these|the\s+messages)\s+off\b/i,
];

function buildOptOutReply(webUrl: string): string {
  const base = webUrl.replace(/\/$/, '');
  return `Done — you can manage your preferences here: ${base}/settings. And if you ever want to come back, I'll be here.`;
}

function detectNaturalOptOut(text: string, webUrl: string): string | null {
  for (const re of OPT_OUT_PHRASES) if (re.test(text)) return buildOptOutReply(webUrl);
  return null;
}

// ─── In-chat check-in frequency change ───────────────────────────────────────
// Master prompt — CHECK-IN FREQUENCY: handle in-chat, never redirect to settings.
// Patterns cover direct ("text me less"), indirect ("you message too much"),
// and softer phrasings ("tone it down"). Bounded to [1, 4] daily messages.
const FREQ_LESS = new RegExp([
  /\b(text|message|msg)\s+me\s+less\b/,
  /\bless\s+(often|reminders?|messages?|texts?|check[\s-]?ins?|nudges?)\b/,
  /\bfewer\s+(reminders?|check[\s-]?ins?|messages?|texts?|nudges?)\b/,
  /\btoo\s+(many|much)\s+(messages?|texts?|reminders?|check[\s-]?ins?|nudges?)\b/,
  /\bstop\s+texting\s+(me\s+)?so\s+much\b/,
  /\b(tone|dial)\s+(it|things|the\s+(messages|texts|reminders))\s+(down|back)\b/,
  /\byou\s+(text|message)\s+(me\s+)?too\s+much\b/,
  /\bback\s+off\s+(a\s+bit|with\s+the\s+(texts|messages|reminders))\b/,
  /\b(reduce|cut\s+down|lower)\s+(the\s+)?(messages?|texts?|reminders?|check[\s-]?ins?)\b/,
].map((r) => r.source).join('|'), 'i');

const FREQ_MORE = new RegExp([
  /\b(text|message|msg)\s+me\s+more\b/,
  /\bmore\s+(check[\s-]?ins?|messages?|texts?|reminders?|nudges?)\b/,
  /\bcheck\s+(on\s+me\s+|in\s+(on\s+me\s+)?)?more(\s+often)?\b/,
  /\b(increase|bump\s+up)\s+(the\s+)?(messages?|texts?|reminders?|check[\s-]?ins?)\b/,
  /\b(text|message|check\s+in)\s+more\s+often\b/,
].map((r) => r.source).join('|'), 'i');

const FREQ_ONCE = /\bonce\s+(a\s+day|per\s+day|daily)\b|\bjust\s+one\s+(message|text|check.?in)\s+(a|per)\s+day\b|\bone\s+(message|text|check.?in)\s+(a|per)\s+day\b/i;
const FREQ_TWICE = /\btwice\s+(a\s+day|per\s+day)\b|\btwo\s+(messages?|texts?|check.?ins?|checking)\s+(a|per)\s+day\b/i;
const FREQ_EVERY_OTHER = /\bevery\s+other\s+day\b|\bnot\s+every\s+day\b|\bskip\s+(a\s+)?days?\b/i;

// Matches any explicit digit-based frequency request. Captures the number in
// group 1; caller clamps to [1, 4]. Covers every realistic user phrasing:
//   "send me 2 checking per day"   "2 times a day"   "make it 3"
//   "change to 2 a day"            "give me 4"        "3 per day please"
//   "I want 2 check-ins"           "set to 3 a day"   "can I get 2 per day"
const FREQ_DIGIT = new RegExp([
  // N + frequency unit + per-day: "2 check-ins per day", "3 times a day", "4x a day"
  /\b([1-9])\s*(?:x\s+|times?\s+|check[\s-]?ins?\s+|checking\s+|messages?\s+|texts?\s+|reminders?\s+|nudges?\s+)?(?:a|per)\s+day\b/,
  // "send me N" + optional unit: "send me 2 checking", "send me 3 check-ins a day"
  /\bsend\s+me\s+([1-9])\s*(?:check[\s-]?ins?|checking|messages?|texts?|reminders?|nudges?|times?)?\b/,
  // "give me / get N": "give me 2 check-ins", "can I get 3 per day"
  /\b(?:give\s+me|(?:can\s+i\s+)?get)\s+([1-9])\s*(?:check[\s-]?ins?|checking|messages?|texts?|reminders?|nudges?|times?)?\b/,
  // "make it / set to / change to N": "make it 2", "set it to 3 a day"
  /\b(?:make\s+it|set\s+(?:it\s+)?to|change\s+(?:it\s+)?to|switch\s+to|update\s+(?:it\s+)?to|bump\s+(?:it\s+)?(?:up\s+)?to|drop\s+(?:it\s+)?to)\s+([1-9])\b/,
  // "I want N" / "I'd like N": "I want 2 per day", "I'd like 3 check-ins"
  /\bi(?:'d)?\s+(?:want|like|need|prefer)\s+([1-9])\s*(?:check[\s-]?ins?|checking|messages?|texts?|reminders?|nudges?|times?)?\b/,
  // Bare "N per day / N a day": "3 per day", "2 a day"
  /\b([1-9])\s+(?:a|per)\s+day\b/,
].map((r) => r.source).join('|'), 'i');

const FREQ_LABEL: Record<number, string> = {
  1: 'once a day',
  2: 'twice a day',
  3: '3 times a day',
  4: '4 times a day',
};

function detectFrequencyChange(text: string, current: number): { newCount: number; reply: string } | null {
  // Digit-based check first — most explicit signal.
  // Find the first non-undefined capture group across all alternatives.
  const digitMatch = FREQ_DIGIT.exec(text);
  if (digitMatch) {
    const captured = digitMatch.slice(1).find((g) => g !== undefined);
    const raw = parseInt(captured ?? '0', 10);
    if (raw >= 1) {
      const n = Math.min(4, Math.max(1, raw));
      const label = FREQ_LABEL[n] ?? `${n} times a day`;
      return { newCount: n, reply: `Done — ${label} from now on. Just let me know if you want to adjust it.` };
    }
  }
  if (FREQ_ONCE.test(text)) {
    return { newCount: 1, reply: 'Done — I\'ll check in once a day from now on. Just tell me if you want to change it again.' };
  }
  if (FREQ_TWICE.test(text)) {
    return { newCount: 2, reply: 'Got it — twice a day from now on. Let me know if it feels like too much or too little.' };
  }
  if (FREQ_EVERY_OTHER.test(text)) {
    return { newCount: 1, reply: 'Easy — I\'ll lighten it up. You\'ll mostly hear from me once a day, sometimes less.' };
  }
  if (FREQ_LESS.test(text)) {
    const next = Math.max(1, current - 1);
    return next === current
      ? null
      : { newCount: next, reply: `Done — I'll drop it to ${next === 1 ? 'once' : next + ' times'} a day. Let me know if you want to change it again.` };
  }
  if (FREQ_MORE.test(text)) {
    const next = Math.min(4, current + 1);
    return next === current
      ? null
      : { newCount: next, reply: `Got it — bumping it up to ${next} times a day. Tell me if it ever feels like too much.` };
  }
  return null;
}

// ─── Injection day change ─────────────────────────────────────────────────────
// Typo-tolerant: "injuction", "injution", "injetion" all match \binj\w+.
// Also covers "shot day", "dose day", "jab day".
// Requires a day-of-week AND a change verb to avoid false positives.
const INJECTION_WORD_RE = /\binj\w+|shot\s+day|dose\s+day|jab\s+day/i;
const INJECTION_CHANGE_VERB_RE = /\b(change|move|switch|set|update|shift)\b/i;
const INJECTION_DAY_NAME_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i;
const INJECTION_DAY_MAP: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

function detectInjectionDayChange(text: string): string | null {
  if (!INJECTION_WORD_RE.test(text)) return null;
  if (!INJECTION_CHANGE_VERB_RE.test(text)) return null;
  const dayMatch = text.match(INJECTION_DAY_NAME_RE);
  if (!dayMatch) return null;
  const key = dayMatch[1]?.toLowerCase() ?? '';
  return INJECTION_DAY_MAP[key] ?? null;
}

// Detect messages that don't need the coalesce window. Pure greetings, brief
// acks, thanks, farewells, goodnights, laughter, apologies, appreciation, and
// short positive/negative feelings are complete in one message — users don't
// send "Hi" or "goodnight" followed by a correction. Skipping the 2-second
// buffer for these brings perceived latency from ~3-4s down to ~200-500ms.
//
// This list mirrors the fast-path categories in services/fast-path.ts. Keep
// it broad on these no-continuation patterns — false positives here just mean
// a 2-second wait was skipped, no behavioral change.
const COALESCE_SKIP_RE = /^(?:hi|hey|hello|hii+|heyy+|good\s+morning|good\s+afternoon|good\s+evening|morning|evening|sup|yo|howdy|whats?\s*up|hiya|ok|okay|kk|k|got\s+it|noted|cool|sweet|solid|nice|alright|sure|yep|yup|yes|nope|nah|no|will\s+do|sounds?\s+good|copy\s+that|gotcha|thanks|thank\s+you|thx|ty|tysm|appreciate\s+(?:it|you|that)|thanks\s+so\s+much|thank\s+you\s+so\s+much|much\s+appreciated|goodnight|good\s+night|night|nighty|nite|gn|nighty\s+night|sweet\s+dreams|heading\s+to\s+bed|going\s+to\s+bed|off\s+to\s+bed|going\s+to\s+sleep|bedtime|bye|byee+|goodbye|see\s+you|see\s+ya|see\s+you\s+(?:later|tomorrow)|talk\s+(?:later|tomorrow)|catch\s+you\s+later|ttyl|ttys|later|peace|cya|gtg|gotta\s+go|have\s+to\s+go|brb|lol|lolol|haha+|hehe+|hahah+a*|lmao+|lmfao+|rofl|hah|heh|sorry|sry|i'?m\s+sorry|im\s+sorry|so\s+sorry|my\s+bad|my\s+apologies|apologies|sorry\s+about\s+(?:that|it)|oops|oof|mb|wow|woah|whoa|woww+|omg|oh\s+my|gosh|oh\s+gosh|huh|hmm+|interesting|oh|oh\s+wow|oh\s+okay|oh\s+ok|geez|sheesh|dang|damn|love\s+you|love\s+ya|i\s+love\s+you|you'?re\s+the\s+best|you\s+rock|you'?re\s+amazing|you'?re\s+great|you'?re\s+awesome|best\s+ever|amazing|you'?re\s+helpful|so\s+helpful|love\s+(?:it|that|this)|like\s+(?:it|that)|that'?s\s+(?:helpful|great|perfect)|that\s+helps|helpful|perfect|yes|yeah|yep|yup|absolutely|definitely|for\s+sure|of\s+course|certainly|right|exactly|true|correct|indeed|100%|i'?m\s+good|i'?m\s+ok|i'?m\s+okay|i'?m\s+fine\s+thanks|no\s+thanks|no\s+thank\s+you|not\s+really|i'?m\s+(?:feeling\s+|doing\s+)?(?:strong|great|good|amazing|wonderful|fantastic|awesome|excellent|fine|okay|ok|alright|well|happy|grateful|blessed|energized|motivated|focused|positive|chill|calm|peaceful|content|relaxed|refreshed|hopeful|optimistic|proud|tired|exhausted|drained|wiped|spent|done|knackered|rough|stressed|anxious|overwhelmed|frustrated|sad|down|low|blue|lonely|defeated|burned\s+out|burnt\s+out|meh|blah|off|terrible|awful)|feeling\s+(?:strong|great|good|amazing|tired|exhausted|sad|rough|stressed|anxious|overwhelmed|frustrated|down|low|blue|lonely|meh|blah)|(?:not\s+great|not\s+good|not\s+okay|not\s+ok|rough\s+day|long\s+day|hard\s+day|tough\s+day|rough\s+night|the\s+worst)|👍|👌|🤍|🧡|❤️|💛|💚|💙|💜|🙏|😄|😆|😅|🤣|😂|😆|💯)\s*[.!?]?\s*$/i;

// Short food-log openers — extremely common, no ambiguity, no continuation
// (the food name is part of the same message). Skipping the 2s coalesce wait
// here saves 2 seconds off every "I ate X" / "Just had Y" type message.
// Length-capped at 35 chars so compound multi-food logs still get the coalesce
// window in case the user is about to send a follow-up.
const FOOD_LOG_SKIP_RE = /^(?:(?:i|just)\s+(?:ate|had|drank|made)|ate|had|drank|just\s+(?:ate|had|drank|made)|made|grabbed|finished|enjoyed)\s+[a-z0-9].{0,28}$/i;

// Clear knowledge / recommendation questions — single-turn, self-contained,
// no continuation expected. "What causes hair loss on Ozempic?" / "How much
// protein per day?" / "What should I eat for lunch?" These are 95% of the
// knowledge-question and food-recommendation traffic, and they shouldn't
// pay the 2-second coalesce tax. Multi-message bursts ("I'm tired" / "and
// hungry too") don't match this shape (they don't end with '?'), so they
// still get the coalesce buffer.
//
// Guard rails:
//   • length ≤ 120 chars (real follow-up questions are short)
//   • must end with '?' (the question-mark IS the no-continuation signal)
//   • must start with a question word OR a known GLP-1 query pattern
const COALESCE_SKIP_KNOWLEDGE_RE = /^(?:what|how|why|is|are|can|could|do|does|did|when|where|should|will|would|any\b)\b[^?]{4,118}\?$/i;

export function shouldSkipCoalesce(text: string): boolean {
  // Normalize iOS smart-quote apostrophes (U+2019) → ASCII before matching.
  const t = text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .trim();
  if (t.length === 0) return false;
  // Greetings / acks / thanks / etc. — original short list
  if (t.length <= 40 && COALESCE_SKIP_RE.test(t)) return true;
  // Short food logs (also skips coalesce — "I ate two eggs" needs no buffer)
  if (FOOD_LOG_SKIP_RE.test(t)) return true;
  // Clear knowledge / recommendation questions — single-turn, ends with '?'
  if (t.length <= 120 && COALESCE_SKIP_KNOWLEDGE_RE.test(t)) return true;
  return false;
}

// ─── Message coalescing ───────────────────────────────────────────────────────
// WhatsApp users send corrections/continuations within seconds ("Will i go
// bold?" → "Bald"). This buffers text messages for 2s in Redis; the first
// arrival holds a lock and waits, follow-ups append to a list, then all parts
// are merged into one turn. Prevents duplicate replies. Media fires immediately.
// Window tightened from 3.5s → 2s (2026-05-30 latency pass) — 2s still catches
// genuine multi-message bursts while shaving 1.5s off median response time.
export async function coalesceMessages(redis: Redis, phone: string, text: string): Promise<string | null> {
  const bufKey = `coalesce:buf:${phone}`;
  const lockKey = `coalesce:lock:${phone}`;

  // Append this message; set a safety TTL so stale keys don't accumulate.
  await redis.rpush(bufKey, text);
  await redis.expire(bufKey, 30);

  // Only the first arrival in the window does the waiting + processing.
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!acquired) return null; // absorbed — the lock-holder will pick this up

  await new Promise<void>((resolve) => setTimeout(resolve, 2000));

  const parts = await redis.lrange(bufKey, 0, -1);
  await redis.del(bufKey);
  return parts.join(' ').trim() || text;
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONN|ETIMEDOUT|timeout|connection|socket hang up|EPIPE|EAI_AGAIN/i.test(msg);
}

// ─── Retry helper ────────────────────────────────────────────────────────────
// Retries an async fn up to `attempts` times with a fixed delay between tries.
// Only retries when `retryIf` returns true — non-transient errors throw immediately.
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; retryIf: (err: unknown) => boolean },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!opts.retryIf(err)) throw err;
      lastErr = err;
      if (i < opts.attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/** Returns { rating, comment? } when the message is a recognised feedback signal, null otherwise. */
function parseFeedbackSignal(text: string): { rating: number; comment?: string } | null {
  const t = text.trim();
  // Match 👍 in all skin tones (base + Fitzpatrick modifier U+1F3FB–U+1F3FF)
  if (/^\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?$/u.test(t) || /^(thumbs[\s-]?up|good|helpful|great|yes|positive)$/i.test(t)) {
    return { rating: 1 };
  }
  // Match 👎 in all skin tones
  if (/^\u{1F44E}[\u{1F3FB}-\u{1F3FF}]?$/u.test(t) || /^(thumbs[\s-]?down|bad|not helpful|no|negative)$/i.test(t)) {
    return { rating: -1 };
  }
  // "#<comment>" shortcut — faster than typing "FEEDBACK:"
  const hashMatch = t.match(/^#\s*(.+)/s);
  if (hashMatch?.[1]) {
    return { rating: -1, comment: hashMatch[1].trim() };
  }
  const commentMatch = t.match(/^feedback:\s*(.+)/is);
  if (commentMatch?.[1]) {
    return { rating: -1, comment: commentMatch[1].trim() };
  }
  return null;
}

// ─── Upgrade intent ──────────────────────────────────────────────────────────
// Catches "upgrade", "go pro", "subscribe", "pricing", "how much", etc. Limited
// to short messages (≤8 words) so questions like "what would I have to do to
// upgrade my workout routine" don't match. Long sentences that include the
// word "upgrade" are out of scope — Grace handles those conversationally.
const UPGRADE_PHRASES: RegExp[] = [
  // Unambiguous subscription verbs — always intent.
  /\b(upgrade|subscribe|subscription|go\s+pro|grace\s+pro|pro\s+plan|upgrade\s+me|upgrade\s+now)\b/i,
  // "pricing" is a specific business word, rare in GLP-1 chat.
  /\bpricing\b/i,
  // Cost/price/plan terms must be anchored to the product, not food/dose/medical questions.
  /\b(cost|costs|price|plans?|charges?)\s+(of|for)\s+(grace|pro|the\s+(plan|subscription|service|app|trial))\b/i,
  /\b(grace|pro|the\s+(plan|subscription|service|app|trial))\s+(cost|costs|price|plans?|charges?)\b/i,
  /\b(what'?s|what\s+is)\s+the\s+(cost|price|pricing|plan)\b/i,
  // "how much" only counts when followed by a product anchor — never on its own.
  // Catches "how much does this/it/grace/pro cost" but NOT "how much protein…", "how much weight…", "how much water…".
  /\bhow\s+much\s+(does|is)\s+(this|it|grace|pro)\b/i,
  /\bhow\s+much\s+(per\s+month|a\s+month|monthly|to\s+upgrade|to\s+subscribe|for\s+grace|for\s+pro|to\s+go\s+pro)\b/i,
  // Management
  /\bmanage\s+(my\s+)?(plan|subscription|account)\b/i,
];

export function detectUpgradeIntent(text: string): boolean {
  const trimmed = text.trim();
  // Limit to short messages — long sentences with "upgrade" are usually
  // conversational, not subscription requests.
  if (trimmed.split(/\s+/).length > 8) return false;
  return UPGRADE_PHRASES.some((re) => re.test(trimmed));
}

// ── Pause intent (Phase 1 coverage expansion) ───────────────────────────────
// Stops scheduler proactive messages by flipping users.paused = TRUE.
// Auto-resumes when the user sends any non-pause message (handled in
// handleInbound below). Mirrors the upgrade-intent short-circuit pattern.
const PAUSE_PHRASES: RegExp[] = [
  /^(pause|stop|hold|hold on|hold off|take a break|break)$/i,
  /\b(pause|stop|hold off|take a break from|stop sending) (the )?(messages|texts|reminders|notifications|check.?ins|check ins)\b/i,
  /\bi (need|want) (a |to take a |to )?(break|pause|breather)\b/i,
  /\bgive me (a |some )?(space|break|time|quiet)\b/i,
  /\bdon'?t text me (for|until|this) (a |the |next |this )?(week|few days|month|while)\b/i,
  /\b(taking|on) (a )?break (from|with) (grace|you|texting|messages)\b/i,
];

export function detectPauseIntent(text: string): boolean {
  const trimmed = text.trim();
  // Cap at 12 words — long messages mentioning "pause" are usually
  // conversational ("I want to pause my workouts"), not pause requests.
  if (trimmed.split(/\s+/).length > 12) return false;
  return PAUSE_PHRASES.some((re) => re.test(trimmed));
}

/**
 * Build the Stripe checkout / management URL. Includes the user's phone as
 * a query param so the landing page can pre-fill the form. Hosted by the
 * existing v1 Supabase edge function (create-checkout) which then redirects
 * to Stripe Checkout.
 */
export function buildUpgradeUrl(phone: string, webUrl: string = DEFAULT_WEB_URL): string {
  const encoded = encodeURIComponent(phone);
  const base = webUrl.replace(/\/$/, '');
  return `${base}/upgrade?phone=${encoded}`;
}

/**
 * Settings / Customer-Portal URL. Used for users who already have an
 * active subscription and want to MANAGE it (update payment, cancel,
 * change plan). The settings page hosts the Stripe Customer Portal
 * button — sending them straight to /upgrade would trigger a second
 * checkout flow instead of letting them manage what they already have.
 */
export function buildSettingsUrl(phone: string, webUrl: string = DEFAULT_WEB_URL): string {
  const encoded = encodeURIComponent(phone);
  const base = webUrl.replace(/\/$/, '');
  return `${base}/settings?phone=${encoded}`;
}
