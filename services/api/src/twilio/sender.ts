import twilio from 'twilio';
import type { Logger } from 'pino';
import { enforceFormat, checkContent } from '@grace/ai-core';
import { UpstreamError } from '../errors.js';

export interface TwilioSenderConfig {
  accountSid: string;
  authToken: string;
  fromSms?: string;
  fromWhatsapp?: string;
  /** Deployment web URL (PUBLIC_WEB_URL). When set, any `graceglp.com` link in
   *  an outbound message is rewritten to this host so users always get a link
   *  that resolves — covers links echoed by the LLM/system prompt, not just
   *  the deterministic settings-flow redirects. */
  canonicalWebUrl?: string;
}

/**
 * Rewrite the legacy/canonical `graceglp.com` host in any URL to the running
 * deployment's host (preserving the path: /settings, /upgrade, …). No-op when
 * webUrl is absent or already graceglp.com. Applied to EVERY outbound message.
 */
export function rewriteCanonicalLinks(text: string, webUrl?: string): string {
  if (!webUrl) return text;
  const host = webUrl.replace(/\/+$/, '');
  const bareHost = host.replace(/^https?:\/\//, '');
  if (/graceglp\.com/i.test(bareHost)) return text; // deployment IS graceglp.com
  return text
    .replace(/https?:\/\/(?:www\.)?graceglp\.com/gi, host)
    .replace(/\bgraceglp\.com/gi, bareHost);
}

/**
 * Make bare links to known Grace hosts clickable by prefixing `https://`.
 * iMessage / SMS / WhatsApp only auto-link URLs that start with a scheme (or
 * `www.`), so a bare `grace-admin-silk.vercel.app/settings` renders as plain,
 * untappable text. Runs on EVERY outbound AFTER rewriteCanonicalLinks, so it
 * covers both the canonical `graceglp.com` host and the live deployment host,
 * from any source (LLM, system prompt, deterministic templates). Never
 * double-prefixes an already-schemed link.
 */
export function ensureLinkScheme(text: string, webUrl?: string): string {
  const hosts = ['graceglp.com'];
  if (webUrl) {
    const bare = webUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (bare && !hosts.includes(bare)) hosts.push(bare);
  }
  const alt = hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // A bare host (optional www., optional path) NOT already preceded by a scheme
  // slash, an @, a dot (subdomain), or a word char.
  const re = new RegExp(`(?<![\\w/@.])(?:www\\.)?(?:${alt})(?:/\\S*)?`, 'gi');
  return text.replace(re, (match) => {
    if (/^https?:\/\//i.test(match)) return match; // already schemed
    // Keep trailing sentence punctuation OUTSIDE the URL so it isn't swallowed.
    const trailing = match.match(/[.,;:!?)]+$/)?.[0] ?? '';
    const core = trailing ? match.slice(0, match.length - trailing.length) : match;
    return `https://${core.replace(/^www\./i, '')}${trailing}`;
  });
}

export interface OutboundMessage {
  to: string;
  channel: 'whatsapp' | 'sms' | 'imessage';
  body: string;
  /** Skip the AI-text sanitizer. Use for hardcoded admin/report messages. */
  raw?: boolean;
}

/**
 * Transport-agnostic outbound sender. Both TwilioSender (WhatsApp/SMS) and
 * ImessageSender implement it, and ChannelRouter dispatches by channel so the
 * rest of the app (webhook replies, scheduler, admin, settings) depends only on
 * this interface — never a concrete provider. Added 2026-06-17 (multi-channel).
 */
export interface MessageSender {
  send(msg: OutboundMessage): Promise<{ sid: string }>;
}

/**
 * Last-line-of-defense sanitizer applied to EVERY outbound message,
 * regardless of source (AI orchestrator, scheduler, hardcoded webhook
 * replies, safety guard, etc).
 *
 * Catches recurring failure modes that users complain about:
 *  1. Em-dashes / en-dashes / double-dashes — AI-tell punctuation that
 *     slips through when a message bypasses the orchestrator's enforceFormat.
 *  2. Mid-sentence truncation — message ends in a hyphen, single letter,
 *     or stranded preposition/article with no terminal punctuation.
 *  3. Unfilled template placeholders ({first_name}, [link], <url>) that
 *     escape the LLM or template substitution and would be shipped raw.
 *  4. Hallucinated role markers ("System:", "Assistant:", "User:") that
 *     occasionally leak when the LLM mimics its own prompt structure.
 *  5. Empty / whitespace-only bodies — never ship a blank message.
 */
export class EmptyOutboundError extends Error {
  constructor() { super('Outbound body is empty after sanitization'); }
}

export function sanitizeOutbound(input: string, logger?: Logger): string {
  let text = input;

  // ─── Encrypted-field leak guard (2026-06-18) ──────────────────────────
  // crypto/field-encrypt.ts stores PII as `enc:<iv>:<data>:<tag>`. If the
  // running process can't decrypt a field (FIELD_ENCRYPTION_KEY missing or
  // rotated), the raw ciphertext can flow into a reply (observed in prod: a
  // weekly summary printed "enc:0b...:9fc...:..." for the user's medication).
  // Strip any such blob from EVERY outbound, BEFORE enforceFormat mangles the
  // colons into something the regex can't catch. Defense in depth — the
  // summary/source paths also drop encrypted values, but this covers LLM
  // echoes and any other source.
  {
    const encBlob = /\benc:[0-9a-f]{12,}:[0-9a-f]+:[0-9a-f]+/gi;
    if (encBlob.test(text)) {
      text = text.replace(encBlob, '').replace(/\s{2,}/g, ' ').trim();
      logger?.warn({ original: input.slice(0, 200) }, 'twilio.sanitize.encrypted_field_redacted');
    }
  }

  // ─── Universal format-enforcer pass (2026-06-04) ──────────────────────
  // The orchestrator runs enforceFormat on LLM responses, but messages can
  // reach the sender via paths that bypass it: fast-path, food_log_fast,
  // weight_log_fast, query_fast, safety canned responses, vague-food
  // clarifications, scheduler welcomes, emergency LLM fallback, etc. Running
  // it here gives EVERY outbound the same treatment: title-case headers,
  // list intros, label-colon lists, stray colons, em-dashes, markdown — all
  // caught regardless of source. format-enforcer is idempotent (no-op on
  // clean text), so this is safe to run twice for the main orchestrator path.
  try {
    const formatted = enforceFormat(text, {});
    if (formatted.fixes.length > 0 && logger) {
      logger.info(
        { original: text.slice(0, 200), fixes: formatted.fixes },
        'twilio.sanitize.format_enforced',
      );
    }
    text = formatted.text;
  } catch (err) {
    // enforceFormat throwing is a code bug, not a runtime case — log + continue.
    logger?.warn({ err: (err as Error).message }, 'twilio.sanitize.enforce_format_failed');
  }

  // ─── Universal content-checker pass (logging only) ────────────────────
  // checkContent normally drives the regen loop in the orchestrator. Here we
  // run it without opts purely to LOG any violations that slip through canned
  // / fast-path responses, so we can detect bad hardcoded strings or rule
  // gaps. We do NOT regen at this point (the message is on its way out) — but
  // logging gives us a tripwire for production-quality monitoring.
  try {
    const violations = checkContent(text, {});
    if (violations.length > 0 && logger) {
      logger.warn(
        {
          original: text.slice(0, 200),
          violations: violations.map((v) => ({ code: v.code, severity: v.severity ?? 'regen' })),
        },
        'twilio.sanitize.content_violation',
      );
    }
  } catch (err) {
    logger?.warn({ err: (err as Error).message }, 'twilio.sanitize.check_content_failed');
  }

  // ─── Markdown strip (Bug 4 remediation, 2026-05-30) ────────────────────
  // Belt-and-suspenders after enforceFormat (which also strips markdown):
  // these regexes are surgical and idempotent, so re-running is safe.
  //
  // Done BEFORE em-dash collapse so a "**bold**" with em-dash inside is
  // unwrapped first then its content gets the dash treatment.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');           // **bold** → bold
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');  // *italic* → italic
  text = text.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1'); // _italic_ → italic
  text = text.replace(/^#{1,6}\s+/gm, '');                    // # header → header
  text = text.replace(/^\s*[-*•]\s+/gm, '');                  // - bullet → bullet
  text = text.replace(/^\s*\d+\.\s+/gm, '');                  // 1. item → item
  // Backticks for inline code — strip wrapping, keep content.
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Residual-markdown guarantee (2026-06-14): any UNPAIRED asterisk (a stray
  // bullet or unclosed emphasis like "* Greek yogurt power bowl:") and markdown
  // separators (---, ___) survive the paired strips above. Grace never emits a
  // literal "*", so remove every remaining one; collapse separator runs.
  text = text.replace(/(?:^|\n)[ \t]*(?:-{3,}|_{3,})[ \t]*(?=\n|$)/g, '\n');
  text = text.replace(/\*+/g, '');
  text = text.replace(/[ \t]{2,}/g, ' ');

  // Replace em-dash, en-dash, and 2+ hyphens with comma (preserves words).
  text = text.replace(/\s*[—–]\s*/g, ', ');
  text = text.replace(/\s*--+\s*/g, ', ');
  // " - " used as a dash on one line → comma.
  text = text.replace(/(\S)[ \t]+-[ \t]+(\S)/g, '$1, $2');

  // Strip hallucinated role markers (LLM occasionally echoes its own prompt
  // structure: "Assistant: blah" / "System: blah" / "User: blah"). Only at
  // line start — words like "User:" mid-sentence are legitimate prose.
  text = text.replace(/^(System|Assistant|User|Human|Model)\s*:\s*/gim, '');

  // Strip unfilled template placeholders. Two patterns:
  //   {snake_case_var}  — common from string substitution failures
  //   [bracketed]       — common from LLM "[link]" / "[settings link]"
  //   <angle_var>       — common from prompt template leakage
  // For [bracketed]: only strip ones that look like placeholders (lowercase,
  // 2-30 chars, no spaces) — keep legitimate uses like "[laughs]" / "[2/5]".
  text = text.replace(/\{[a-z_][a-z0-9_]{0,30}\}/g, '');
  text = text.replace(/<[a-z_][a-z0-9_]{0,30}>/g, '');
  text = text.replace(/\[(link|settings link|url|here|first_name|name|phone)\]/gi, '');

  // Collapse double spaces left behind by placeholder strips.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1');

  // Mid-sentence truncation repair.
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // After sanitization the body is empty. Signal so the caller can pick a
    // safe fallback instead of shipping whitespace to the user.
    throw new EmptyOutboundError();
  }

  // A message ending in a URL is COMPLETE — never treat it as cut-off and never
  // trim it (the dots in a domain like "vercel.app/settings" look like sentence
  // terminators, so the repair below would chop the link to "…vercel."). This
  // broke every settings/upgrade link, which always ends with a URL.
  // Production failure 2026-06-13: "…grace-admin-silk.vercel" (missing .app/settings).
  const endsWithUrl =
    /https?:\/\/\S+$/i.test(trimmed) ||
    /\b[\w-]+\.(?:com|app|io|org|net|co|dev|ai|me|health|care)(?:\/\S*)?$/i.test(trimmed);

  const endsMidWord =
    !endsWithUrl && (
      /[-–—]$/.test(trimmed) ||
      /\s(the|a|an|of|on|in|to|for|with|and|or|but|so|by|at|as|is|are|was|were|be)$/i.test(trimmed) ||
      !/[.!?…)_]$|[\p{Extended_Pictographic}]$/u.test(trimmed)
    );

  if (endsMidWord) {
    // Find the last complete sentence terminator and trim everything after it.
    const lastTerminator = Math.max(
      trimmed.lastIndexOf('.'),
      trimmed.lastIndexOf('!'),
      trimmed.lastIndexOf('?'),
      trimmed.lastIndexOf('…'),
    );
    if (lastTerminator > 0) {
      text = trimmed.slice(0, lastTerminator + 1);
    } else {
      // No complete sentence at all — append a period rather than ship a stub.
      text = trimmed.replace(/[-–—\s]+$/, '') + '.';
    }
  }

  // Leading orphan punctuation strip (2026-06-16) — comprehensive final guard.
  // Upstream edits (first-name stripping, greeting-prefix removal, em-dash →
  // comma conversion, header/list-intro stripping) can leave a reply starting
  // with stray punctuation: ", what would you like to dig into?" (a name was
  // stripped from "<name>, what…"). A message must never begin with orphaned
  // punctuation. Strip leading whitespace + punctuation (but never a leading
  // emoji), then re-capitalize if the new first character is a lowercase letter.
  const deOrphaned = text.replace(/^[\s.,;:!?)\]}·–—-]+/, '');
  if (deOrphaned.length > 0) {
    text = /^[a-z]/.test(deOrphaned) ? deOrphaned.charAt(0).toUpperCase() + deOrphaned.slice(1) : deOrphaned;
  }

  return text;
}

export class TwilioSender implements MessageSender {
  private client: twilio.Twilio;
  constructor(private cfg: TwilioSenderConfig, private logger: Logger) {
    this.client = twilio(cfg.accountSid, cfg.authToken);
  }

  async send(msg: OutboundMessage): Promise<{ sid: string }> {
    const useWhatsapp = msg.channel === 'whatsapp' && !!this.cfg.fromWhatsapp;
    const from = useWhatsapp ? `whatsapp:${this.cfg.fromWhatsapp!.replace(/^whatsapp:/, '')}` : this.cfg.fromSms;
    if (!from) throw new UpstreamError('No Twilio sender configured for channel');
    const to = useWhatsapp && !msg.to.startsWith('whatsapp:') ? `whatsapp:${msg.to}` : msg.to;

    let body: string;
    if (msg.raw) {
      body = msg.body;
    } else {
      try {
        body = sanitizeOutbound(msg.body, this.logger);
      } catch (err) {
        if (err instanceof EmptyOutboundError) {
          // Sanitizer produced an empty body — log and substitute a neutral
          // fallback so the user is not left with silence. The fallback itself
          // gets re-sanitized (defense in depth) so an em-dash in it would
          // still be caught.
          this.logger.warn({ original: msg.body }, 'twilio.send.empty_after_sanitize');
          body = sanitizeOutbound("I'm here. Tell me what's going on.", this.logger);
        } else {
          throw err;
        }
      }
    }

    // Final pass on EVERY outbound (raw + sanitized): point any graceglp.com
    // link at the running deployment so the link the user taps actually works,
    // then ensure it carries an https:// scheme so clients render it as a
    // tappable link (bare "host.com/settings" is not auto-linked).
    body = rewriteCanonicalLinks(body, this.cfg.canonicalWebUrl);
    body = ensureLinkScheme(body, this.cfg.canonicalWebUrl);

    try {
      const result = await this.client.messages.create({ from, to, body });
      this.logger.info({ sid: result.sid, channel: useWhatsapp ? 'whatsapp' : 'sms' }, 'twilio.send.ok');
      return { sid: result.sid };
    } catch (err) {
      this.logger.error({ err }, 'twilio.send.failed');
      throw new UpstreamError('Failed to send Twilio message', err);
    }
  }
}
