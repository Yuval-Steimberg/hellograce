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
import { classifyMessage as classifySafety, classifySymptomCategory } from '../safety/guard.js';
import { recordSymptom, shouldEscalate, clearStack } from '../safety/symptom-stack.js';
import { getCrisisResourcesForUser, buildSafetyResponse } from '../safety/crisis-resources.js';
import { tryHandleSettings } from '../services/settings-flow.js';

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
      // Coalesce rapid consecutive text messages (corrections, continuations)
      // BEFORE the in-flight lock. Order matters: the buffer append must come
      // first — when the lock check ran first (2026-06-04 → 2026-06-10), a
      // follow-up arriving while a turn was processing failed the lock and was
      // dropped before it could ever reach the buffer, which made coalescing
      // dead code and silently lost burst messages.
      //
      // If this message is absorbed into a pending window, exit early — the
      // window-holder will process the merged text. Media messages fire
      // immediately.
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

      // In-flight lock: prevents TWO concurrent AI pipelines from running for
      // the same user, which would otherwise produce duplicate replies (e.g.
      // both a short refusal AND a long memory-dump in the same minute — the
      // exact bug reported 2026-05-29). 30s TTL covers the slowest realistic
      // turn; release in finally so the next turn isn't blocked.
      //
      // A message that arrives while a previous turn is still processing WAITS
      // for the lock (bounded retries) instead of being dropped — losing a
      // user's message is strictly worse than answering it a few seconds late.
      // Only if the lock never frees within the retry budget do we drop, with
      // a warning, as the last resort.
      // Failure-open: if Redis is down, proceed without the lock rather than
      // dropping the user's message entirely.
      const inflightKey = `inflight:${normalized.userId}`;
      let inflightAcquired = false;
      if (deps.redis) {
        const slot = await acquireInflightSlot(deps.redis, inflightKey, (event) => {
          if (event === 'waiting') req.log.info({ userId: normalized.userId }, 'webhook.inflight_waiting');
          if (event === 'skip') req.log.warn({ userId: normalized.userId }, 'webhook.inflight_skip');
          if (event === 'redis_failed') req.log.warn({ userId: normalized.userId }, 'webhook.inflight_lock_failed_proceeding');
        });
        if (slot === 'busy') return;
        inflightAcquired = slot === 'acquired';
      }

      try {
        let user: GraceUser | null = null;
        // Upsert the user record and update last_reply_at on every inbound message.
        if (deps.users) {
          user = await deps.users.ensureUser(normalized.userId).catch(() => null);

          // Handle injection "done" reply — advance the state machine and
          // reply with an injection-aware acknowledgment. Without the explicit
          // reply + return, the message fell through to the fast-path brief-ack
          // pool and the user got a generic "Got it 👍" for completing their
          // injection (state was correct, reply wasn't — fixed 2026-06-10).
          if (user && user.injection_flow_stage === 'morning_sent') {
            const trimmed = normalized.text.trim().toLowerCase();
            if (trimmed === 'done' || trimmed === 'done!' || trimmed === 'injected') {
              await deps.users.setInjectionStage(user.phone, 'done_confirmed', {
                injection_done_at: new Date(),
              }).catch(() => null);
              await deps.sender.send({
                to: normalized.userId,
                channel: normalized.channel,
                body: pickInjectionDoneAck(normalized.userId),
              });
              return;
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

          // ── In-chat reminder / check-in frequency change.
          // Reminder preferences are owned by the Settings page (single source
          // of truth). Grace must NOT change the cadence from chat — detect the
          // request and redirect. Never write checkin_count_per_day here.
          if (user && isFrequencyChangeRequest(normalized.text)) {
            await deps.sender.send({
              to: normalized.userId,
              channel: normalized.channel,
              body: REMINDER_REDIRECT_REPLY,
            });
            return;
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

          // ── Settings & Profile Update Flow (2026-06-06).
          // Centralized read/update handler for every other profile field
          // — timezone, medication, dose, weight, goal weight, height, sex,
          // food dislikes, name, age, primary goal. Update requests stage
          // a Redis-backed pending update and ask for confirmation; the
          // user's "yes" applies it, "no" cancels it. Runs AFTER the
          // existing short-circuits above so their immediate-update UX
          // for injection day / frequency / opt-out stays unchanged.
          if (user) {
            try {
              const settingsReply = await tryHandleSettings(normalized.text, user, {
                logger: app.log,
              });
              if (settingsReply) {
                await deps.sender.send({
                  to: normalized.userId,
                  channel: normalized.channel,
                  body: settingsReply,
                });
                return;
              }
            } catch (err) {
              app.log.warn(
                { err: err instanceof Error ? err.message : String(err), userId: normalized.userId },
                'settings_flow.unexpected_error',
              );
            }
          }

          // RLHF feedback signal — intercept before AI for opted-in users.
          // 2026-06-05 production failure: "yes" was being parsed as positive
          // feedback EVEN WHEN Grace had just asked a yes/no question
          // ("want me to walk you through the numbers?"). User said "yes"
          // meaning "yes, walk me through" → got "Glad that landed well."
          //
          // Tight gate: a bare-word signal (yes/no/good/bad/etc.) only counts
          // as feedback if the previous Grace message contained the RLHF
          // prompt (👍 👎 emoji or "to rate" text). Without that prompt,
          // "yes" is a conversational reply. Emoji thumbs and explicit
          // "#"/"FEEDBACK:" prefixes always count.
          if (user?.rlhf_enabled) {
            const fbResult = parseFeedbackSignal(normalized.text);
            let shouldProcessAsFeedback = fbResult !== null;
            if (fbResult) {
              const isBareWordSignal = /^(yes|good|helpful|great|positive|no|bad|not\s+helpful|negative|thumbs[\s-]?(up|down))$/i
                .test(normalized.text.trim());
              if (isBareWordSignal) {
                // Verify the previous Grace message contained the RLHF prompt.
                const recentTurns = await deps.ai.getRecentTurnsForUser?.(normalized.userId, 2).catch(() => []) ?? [];
                const lastAssistant = [...recentTurns].reverse().find((t: { role: string }) => t.role === 'assistant');
                const lastContent = lastAssistant && typeof (lastAssistant as { content?: unknown }).content === 'string'
                  ? (lastAssistant as { content: string }).content
                  : '';
                const lastHadRlhfPrompt = /👍|👎|to rate|rate this|share a thought/i.test(lastContent);
                if (!lastHadRlhfPrompt) {
                  app.log.info(
                    { userId: normalized.userId, text: normalized.text.slice(0, 40) },
                    'webhook.feedback_signal_rejected_no_prompt',
                  );
                  shouldProcessAsFeedback = false;
                }
              }
            }
            if (fbResult && shouldProcessAsFeedback) {
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
            // Record emergencies into the symptom stack (so a future-fired
            // mild signal in a different category still adds context) and
            // clear the stack so we don't escalate twice in a row on the
            // same conversation. Best-effort — never blocks the safety reply.
            if (user && deps.redis && safety.class === 'emergency' && safety.symptomCategory) {
              try {
                await recordSymptom(user.phone, safety.symptomCategory, { redis: deps.redis, logger: app.log });
                await clearStack(user.phone, { redis: deps.redis, logger: app.log });
              } catch { /* non-fatal */ }
            }
            // Crisis-resource localization gate (2026-06-06). When
            // CRISIS_RESOURCES_REVIEWED is false (default), the resolver
            // returns US_DEFAULT and buildSafetyResponse produces the
            // exact verbatim US text — byte-identical to the previous
            // hard-coded SAFETY_RESPONSE constant. Only flips behavior
            // for non-US users when the env flag is true AND the user
            // has a country_code (or inferable timezone).
            const resources = getCrisisResourcesForUser(user ?? null, { reviewed: deps.env.CRISIS_RESOURCES_REVIEWED });
            const localizedResponse = buildSafetyResponse(resources);
            // Crisis classification + medical-advice use their own dedicated
            // wording, not the safety hotline template — preserve those.
            const bodyToSend = safety.class === 'medical_advice' ? safety.response! : localizedResponse;
            await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body: bodyToSend });
            return;
          }

          // ── Cross-turn symptom-stack accumulator (2026-06-06) ─────────
          // The message didn't trigger a standalone emergency. If it carries
          // a sub-emergency-threshold symptom signal AND the user has already
          // mentioned a DIFFERENT-category symptom within the last 2 hours,
          // force-escalate to SAFETY_RESPONSE. Mitigates the "three turns
          // describing one escalating emergency" gap flagged in the audit.
          if (user && deps.redis) {
            const subCategory = classifySymptomCategory(normalized.text);
            if (subCategory) {
              try {
                const stack = await recordSymptom(user.phone, subCategory, { redis: deps.redis, logger: app.log });
                if (shouldEscalate(stack)) {
                  req.log.warn(
                    { phone: user.phone, categories: stack.categories, count: stack.count },
                    'webhook.symptom_stack.escalate',
                  );
                  await clearStack(user.phone, { redis: deps.redis, logger: app.log });
                  const stackResources = getCrisisResourcesForUser(user, { reviewed: deps.env.CRISIS_RESOURCES_REVIEWED });
                  await deps.sender.send({
                    to: normalized.userId,
                    channel: normalized.channel,
                    body: buildSafetyResponse(stackResources),
                  });
                  return;
                }
              } catch { /* non-fatal — fall through to normal pipeline */ }
            }
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
            const body = shouldAppendRlhfPrompt(scope.response!, isRlhfUser)
              ? `${scope.response!}\n\n👍 👎 to rate · # to add a thought`
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
        // 2026-06-05 production failure: empty response was being shipped
        // along with the RLHF appendage, producing user-visible garbage:
        //   "For 👍 👎 to rate · # to add a thought."
        // (The "For" leftover from a prior appendage format suggests this
        // path is shipping NOTHING + appendage.) Tight check: response must
        // have actual word content (alphanumeric), not just punctuation /
        // emoji / whitespace. If empty/junk, log + drop the send entirely.
        const hasUsefulContent = /[A-Za-z0-9]{3,}/.test(responseText.trim());
        // 2026-06-05 production failure: "GLP-1 medications can sometimes
        // lead to a loss" shipped (truncated mid-sentence) because the
        // direct-path's endsMidWord check caught it and the path returned
        // null, but the orchestrator fallback shipped truncated text
        // anyway. Final sender-level gate: any response over 40 chars must
        // end with terminal punctuation or emoji. If not, drop the send.
        const trimmedResp = responseText.trim();
        const looksTruncated = trimmedResp.length > 40 &&
          !/[.!?…"')\]}]\s*$/.test(trimmedResp) &&
          !/\p{Extended_Pictographic}\s*$/u.test(trimmedResp);
        if (responseText.trim().length > 0 && hasUsefulContent && !looksTruncated) {
          const isRlhfUser = user?.rlhf_enabled ?? false;
          const body = shouldAppendRlhfPrompt(responseText, isRlhfUser)
            ? `${responseText}\n\n👍 👎 to rate · # to add a thought`
            : responseText;
          await deps.sender.send({ to: normalized.userId, channel: normalized.channel, body });
        } else if (looksTruncated) {
          app.log.warn(
            { responseText: trimmedResp.slice(-80), userId: normalized.userId },
            'webhook.truncated_response_blocked',
          );
        } else if (responseText.length > 0) {
          app.log.warn(
            { responseText: responseText.slice(0, 80), userId: normalized.userId },
            'webhook.empty_response_blocked',
          );
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

// Reminder preferences (check-in cadence) live ONLY on the Settings page —
// the single source of truth. Grace detects a cadence-change request and
// sends this redirect; she never writes checkin_count_per_day from chat.
const REMINDER_REDIRECT_REPLY =
  `Reminder preferences can only be managed through the Settings page. Please ` +
  `update them there and the system will apply your changes: https://graceglp.com/settings`;

// True when the message is any attempt to change check-in / reminder cadence
// (digit-based, "once a day", "text me less/more", "every other day", etc.).
// All such requests redirect to Settings — there is no in-chat cadence write.
function isFrequencyChangeRequest(text: string): boolean {
  return (
    FREQ_DIGIT.test(text) ||
    FREQ_ONCE.test(text) ||
    FREQ_TWICE.test(text) ||
    FREQ_EVERY_OTHER.test(text) ||
    FREQ_LESS.test(text) ||
    FREQ_MORE.test(text)
  );
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
// Optional "I" and "just" prefixes compose: "ate X", "I ate X", "just ate X",
// AND "I just ate X" — the original alternation matched the first three but
// missed "I just had …", the single most common food-log phrasing, costing
// those messages a flat +2s coalesce wait (2026-06-11 verification finding).
const FOOD_LOG_SKIP_RE = /^(?:i\s+)?(?:just\s+)?(?:ate|had|drank|made|grabbed|finished|enjoyed)\s+[a-z0-9].{0,28}$/i;

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

// 2026-06-05 — was always appending a 60-char "Rate this: 👍 👎 Or start
// your reply with # to share a thought." regardless of how long Grace's
// reply was. For "Logged." that's 8.5x the response itself. The rule
// now: only append on substantive replies AND for opted-in users.
const RLHF_MIN_RESPONSE_CHARS = 25;
export function shouldAppendRlhfPrompt(responseText: string, isRlhfUser: boolean): boolean {
  if (!isRlhfUser) return false;
  if (responseText.trim().length < RLHF_MIN_RESPONSE_CHARS) return false;
  return true;
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
  // Release the window lock explicitly. Before 2026-06-10 the lock was left
  // to expire on its own (EX 5), so a message arriving 2-5s after the first
  // was "absorbed" into a window that had already drained — and lost. With
  // the explicit release, the next message simply opens a new window.
  // (A sub-millisecond race remains between lrange and the two dels; an
  // rpush landing in that gap is absorbed-and-dropped. Acceptable vs. the
  // guaranteed 3-second loss window this replaces.)
  await redis.del(lockKey);
  return parts.join(' ').trim() || text;
}

// In-flight lock retry budget: 15 × 1s ≈ 15s of waiting, comfortably longer
// than a slow AI turn (p99 ~10s) and shorter than the 30s lock TTL.
const INFLIGHT_MAX_ATTEMPTS = 15;
const INFLIGHT_RETRY_MS = 1000;

/**
 * Acquire the per-user in-flight slot, WAITING (bounded retries) when a
 * previous turn for the same user is still processing rather than dropping
 * the message. Returns:
 *   'acquired'    — caller holds the lock and must release it in finally
 *   'busy'        — retry budget exhausted; caller should drop with a warning
 *   'unavailable' — Redis errored; caller proceeds WITHOUT the lock
 *                   (failure-open: losing dedup is better than losing a message)
 */
export async function acquireInflightSlot(
  redis: Redis,
  key: string,
  onEvent: (event: 'waiting' | 'skip' | 'redis_failed') => void,
): Promise<'acquired' | 'busy' | 'unavailable'> {
  try {
    for (let attempt = 0; attempt < INFLIGHT_MAX_ATTEMPTS; attempt++) {
      const ok = await redis.set(key, '1', 'EX', 30, 'NX');
      if (ok !== null) return 'acquired';
      if (attempt === 0) onEvent('waiting');
      await new Promise((r) => setTimeout(r, INFLIGHT_RETRY_MS));
    }
    onEvent('skip');
    return 'busy';
  } catch {
    onEvent('redis_failed');
    return 'unavailable';
  }
}

// ─── Injection "done" acknowledgment ─────────────────────────────────────────
// Deterministic, injection-aware replies for the state-machine advance. The
// "few hours" phrasing matches the scheduler's injection_followup, which fires
// 3h after injection_done_at. Persona rules: no user name, one emoji max,
// statement not question.
const INJECTION_DONE_ACKS = [
  "Injection done ✅ Nice work. I'll check in with you in a few hours, take it easy in the meantime.",
  "Shot done, logged ✅ I'll check on you later today. Water and something light if you feel up to it.",
  "Done ✅ That's the hard part of the week handled. I'll check in this afternoon, be kind to yourself today.",
];

export function pickInjectionDoneAck(userId: string): string {
  let hash = 0;
  const seed = `${userId}|${new Date().toISOString().slice(0, 10)}`;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return INJECTION_DONE_ACKS[Math.abs(hash) % INJECTION_DONE_ACKS.length]!;
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
