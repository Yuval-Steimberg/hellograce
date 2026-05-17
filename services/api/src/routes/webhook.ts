import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import type { AIService } from '../services/ai.service.js';
import type { TwilioSender } from '../twilio/sender.js';
import type { UserService, GraceUser } from '../user/user.service.js';
import { isValidTwilioSignature } from '../twilio/signature.js';
import { normalizeTwilio, type RawTwilioPayload } from '../twilio/normalize.js';
import { UnauthorizedError, UpstreamError } from '../errors.js';

export interface WebhookDeps {
  env: Env;
  ai: AIService;
  sender: TwilioSender;
  users?: UserService;
}

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
    req.log.info(
      { userId: normalized.userId, channel: normalized.channel, type: normalized.type },
      'webhook.received',
    );

    // Reply with empty TwiML immediately; AI work + outbound send happens async.
    reply.header('content-type', 'text/xml');
    void reply.send('<?xml version="1.0" encoding="UTF-8"?><Response/>');

    // Fire-and-forget AI processing.
    void (async () => {
      try {
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
            const optOutReply = detectNaturalOptOut(normalized.text);
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
              await deps.users.update(user.phone, { injection_day: injDay }).catch(() => null);
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
              const ack = fbResult.rating > 0
                ? 'Thanks for the thumbs up — I\'ll keep that in mind! 💪'
                : fbResult.comment
                  ? 'Thanks for the feedback — I\'ll work on that!'
                  : 'Thanks for letting me know. Feel free to tell me more about what could be better.';
              await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: ack });
              return;
            }
          }

          // Subscription gate — users with an expired trial and no active subscription
          // get a soft paywall nudge instead of the AI response.
          if (user && !isAccessAllowed(user)) {
            await deps.sender.send({
              to: normalized.userId,
              channel: normalized.channel,
              body: `Your 3-day Grace trial has ended 🧡 To keep your daily check-ins going, head to graceglp.com to subscribe. Questions? Reply HELP.`,
            });
            return;
          }
        }

        const result = await withRetry(() => deps.ai.handleMessage(normalized), {
          attempts: 3,
          delayMs: 1500,
          retryIf: (err) => err instanceof UpstreamError,
        });

        const responseText = result?.text ?? '';
        if (responseText.length > 0) {
          const isRlhfUser = user?.rlhf_enabled ?? false;
          const isFallback = !!(result?.usedSafeFallback);
          const body = (isRlhfUser && !isFallback)
            ? `${responseText}\n\nRate this: 👍 👎`
            : responseText;
          await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body });
        }
      } catch (err) {
        req.log.error({ err }, 'webhook.ai.failed');
        // Send a warm fallback so the user isn't left with silence.
        const fallbacks = [
          'My connection blipped — what were you saying?',
          'Sorry, I missed that one. Can you resend?',
          'Something went sideways on my end. What did you say?',
        ];
        const fallback = fallbacks[Math.floor(Math.random() * fallbacks.length)]!;
        await deps.sender
          .send({ to: normalized.userId, channel: normalized.channel, body: fallback })
          .catch(() => null);
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

const OPT_OUT_REPLY =
  'Done — you can manage your preferences here: https://graceglp.com/settings. And if you ever want to come back, I\'ll be here.';

function detectNaturalOptOut(text: string): string | null {
  for (const re of OPT_OUT_PHRASES) if (re.test(text)) return OPT_OUT_REPLY;
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
