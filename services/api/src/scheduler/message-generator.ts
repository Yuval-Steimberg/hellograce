import type { LLMProvider, DbContentRule } from '@grace/shared';
import { GRACE_SYSTEM_PROMPT, checkContent } from '@grace/ai-core';
import type { GraceUser } from '../user/user.service.js';
import type { ContentRulesService } from '../services/content-rules.service.js';
import type { MessageTemplatesService } from '../services/message-templates.service.js';
import { inferMedicationType } from '../services/ai.service.js';

const DEFAULT_UPGRADE_URL = 'https://graceglp.com/upgrade';

function buildUpgradeUrl(phone: string): string {
  return `${DEFAULT_UPGRADE_URL}?phone=${encodeURIComponent(phone)}`;
}

const GOAL_MODE_MAP: Record<string, string> = {
  'Losing weight': 'protein',
  'Eating enough protein': 'protein',
  'Staying hydrated': 'hydration',
  'Managing side effects': 'side_effects',
  'Hitting my fiber goals': 'fiber',
  'Feeling less alone in this': 'connection',
  'Building better habits': 'habits',
  'Protecting my muscle': 'muscle',
};

type MsgType = 'morning' | 'midday' | 'evening' | 'injection_morning' | 'injection_followup' |
  'injection_dayafter' | 'side_effect_nausea' | 'side_effect_fatigue' | 'side_effect_constipation' |
  'welcome' | 'trial_expiry_reminder';

export interface GenerateOpts {
  extra?: string;
  isWednesday?: boolean;  // forces mood check regardless of goals
  lowMoodMode?: boolean;  // evening → encouragement over reflection
}

const FALLBACKS: Record<MsgType, (user: GraceUser, opts?: GenerateOpts) => string> = {
  morning: (u, opts) => {
    if (opts?.isWednesday) {
      return `Morning 🌿 Mid-week check — how are you actually feeling today? No wrong answers.`;
    }
    const goal = u.goals[0];
    const mode = goal ? (GOAL_MODE_MAP[goal] ?? 'protein') : 'protein';
    if (mode === 'protein') {
      const target = u.protein_goal_grams ?? 80;
      return `Morning 🌿 Gentle nudge — try to land protein early today. ${target}g feels easier when you front-load it.`;
    }
    if (mode === 'hydration') return `Morning 🌿 Pouring a glass of water first thing sets the whole day up nicely.`;
    if (mode === 'side_effects') return `Morning 🌿 Take it easy on yourself today. I'm here if anything feels off.`;
    if (mode === 'fiber') return `Morning 🌿 A little fiber early (oats, berries, chia) makes the rest of the day kinder to your gut.`;
    if (mode === 'connection') return `Morning 🌿 Just wanted to check in — you're not doing this alone.`;
    if (mode === 'habits') return `Morning 🌿 One small thing today. That's all it takes.`;
    if (mode === 'muscle') return `Morning 🌿 Protecting muscle on ${u.medication ?? 'GLP-1'} — even a bit of protein early helps a lot.`;
    return `Morning 🌿 Hope today's a soft one. I'm here whenever you want to chat.`;
  },
  midday: () => {
    return `Quick midday hello. No pressure to reply — just rooting for you over here 🤍`;
  },
  evening: (u, opts) => {
    if (opts?.lowMoodMode) {
      return `Just thinking of you tonight. You're doing something genuinely hard, and it counts even on the quiet days 🤍`;
    }
    if (u.current_weight && u.goal_weight) {
      const diff = Math.abs(u.current_weight - u.goal_weight);
      return `Wrapping up? You're ${diff.toFixed(0)} lbs from your goal — every consistent day moves the needle 🌙`;
    }
    return `Wrapping the day. Hope it had a good moment in it somewhere. Rest well 🌙`;
  },
  injection_morning: (u) => {
    const med = u.medication ?? 'your medication';
    return `${med} day 💉 Rotate your spot, take your time. Reply "done" when you're set — no rush.`;
  },
  injection_followup: () => {
    return `Just thinking about you a few hours post-shot. Hope you're feeling okay. I'm here if anything's up.`;
  },
  injection_dayafter: () => {
    return `Morning — day after your shot. Be gentle with yourself today 🤍`;
  },
  side_effect_nausea: () => {
    return `Checking in softly — hope the nausea's easing. Ginger tea and tiny sips help a lot of people 🤍`;
  },
  side_effect_fatigue: () => {
    return `Fatigue is real on this med. Rest if you can — a bit of protein + water often helps. I'm here.`;
  },
  side_effect_constipation: () => {
    return `Soft check-in. Water, fiber, and a short walk are the usual gentle helpers if things are still slow.`;
  },
  welcome: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'your GLP-1';
    return `Hi ${name} — I'm Grace, your ${med} companion 🤍 I'll check in lightly each day, never overwhelm you. Text me anything, anytime — even just "tired" works.`;
  },
  trial_expiry_reminder: () => {
    return `Your Grace trial ends tomorrow 🧡 Head to graceglp.com anytime to keep your check-ins going — no pressure, whenever you're ready.`;
  },
};

export class MessageGenerator {
  private activeSystemPrompt: string | undefined;
  private rulesService: ContentRulesService | undefined;
  private templatesService: MessageTemplatesService | undefined;

  constructor(private llm: LLMProvider) {}

  updateRulesService(rs: ContentRulesService): void {
    this.rulesService = rs;
  }

  /**
   * Optional templates service used to substitute the welcome / trial-reminder
   * fallbacks with the admin-editable versions from message_templates table.
   * Falls back to the static FALLBACKS[type] map if not provided or template
   * lookup fails.
   */
  updateTemplatesService(ts: MessageTemplatesService): void {
    this.templatesService = ts;
  }

  /**
   * Update the system prompt used for proactive (scheduled) messages.
   * Called on startup with the DB-active prompt and again whenever the
   * PromptOptimizer auto-activates a new version, so RLHF improvements
   * affect every channel — reactive AND proactive.
   */
  updateSystemPrompt(prompt: string | undefined): void {
    this.activeSystemPrompt = prompt;
  }

  async generate(type: MsgType, user: GraceUser, opts?: GenerateOpts): Promise<string> {
    // For subscription-related messages (welcome, trial reminder) ops can
    // override the canned fallback via the message_templates table. If the
    // template lookup fails for any reason, fall through to the hard-coded
    // FALLBACKS map so the user is never left silent.
    const fallback = await this.resolveFallback(type, user, opts);
    try {
      const userCtx = this.buildUserCtx(user);
      const prompt = this.buildPrompt(type, user, opts);
      const systemPrompt = this.activeSystemPrompt ?? GRACE_SYSTEM_PROMPT;

      const resp = await this.llm.generate({
        messages: [
          { role: 'system', content: systemPrompt + '\n\n' + userCtx },
          { role: 'user', content: prompt },
        ],
        temperature: 0.75,
        // 120 was too tight for Gemini 2.5 Flash — thinking tokens + final text
        // sometimes truncated mid-sentence ("Midday reminder: your" bug).
        maxOutputTokens: 280,
      });

      const sanitized = sanitizeProactiveOutput(resp.text, type === 'welcome' ? null : user.first_name);
      if (!sanitized) return fallback;

      // Full content check on proactive messages — same coverage as the
      // reactive path. Until this was added, only DB rules ran here while the
      // reactive AIService had a 4-layer checker (banned phrases, dietary
      // violations, food dislikes, medication contradiction). Now both paths
      // share the same final guard. Any block/regen violation falls back to
      // the canned response since proactive messages can't regen with chat
      // history context.
      const rules: DbContentRule[] = this.rulesService
        ? await this.rulesService.getActive('scheduler').catch(() => [])
        : [];
      const cleanDislikes = (user.food_dislikes ?? [])
        .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
        .filter(Boolean);
      const violations = checkContent(sanitized, {
        foodDislikes: cleanDislikes,
        medicationType: inferMedicationType(user.medication),
        responseMode: 'text',
        dbRules: rules,
      });
      const actionable = violations.filter(
        (v) => v.severity === 'block' || v.severity === 'regen' || !v.severity,
      );
      if (actionable.length > 0) return fallback;

      return sanitized;
    } catch {
      return fallback;
    }
  }

  /**
   * Pick the right fallback string for the message type. For subscription
   * messages (welcome, trial reminder) we consult the message_templates
   * table so admins can edit them without a deploy. Variable substitution:
   *   {first_name} -> user.first_name (or "there")
   *   {medication} -> user.medication (or "your GLP-1")
   *   {goal}       -> user.goals[0]   (or "general wellness")
   *   {upgrade_url} -> https://graceglp.com/upgrade?phone={phone}
   */
  private async resolveFallback(type: MsgType, user: GraceUser, opts?: GenerateOpts): Promise<string> {
    const staticFallback = FALLBACKS[type](user, opts);
    if (!this.templatesService) return staticFallback;
    const templateKey = type === 'welcome' ? 'welcome'
      : type === 'trial_expiry_reminder' ? 'trial_reminder'
      : null;
    if (!templateKey) return staticFallback;
    try {
      return await this.templatesService.render(
        templateKey,
        {
          first_name: user.first_name ?? 'there',
          medication: user.medication ?? 'your GLP-1',
          goal: user.goals[0] ?? 'general wellness',
          upgrade_url: buildUpgradeUrl(user.phone),
        },
        staticFallback,
      );
    } catch {
      return staticFallback;
    }
  }

  private buildUserCtx(user: GraceUser): string {
    const lines = [];
    if (user.first_name) lines.push(`Name: ${user.first_name}`);
    if (user.medication) lines.push(`Medication: ${user.medication}`);
    if (user.goals.length > 0) lines.push(`Goals: ${user.goals.join(', ')}`);
    if (user.food_dislikes.length > 0) {
      const clean = user.food_dislikes
        .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
        .filter(Boolean);
      lines.push(`Food dislikes (paraphrase naturally — NEVER quote verbatim): ${clean.join(', ')}`);
    }
    if (user.current_weight && user.goal_weight) {
      lines.push(`Weight: ${user.current_weight} lbs (goal: ${user.goal_weight} lbs, gap: ${Math.abs(user.current_weight - user.goal_weight).toFixed(0)} lbs)`);
    }
    if (user.protein_goal_grams) {
      lines.push(`Personal daily protein target: ${user.protein_goal_grams}g — use THIS, not 80g`);
    }
    return lines.length > 0 ? `User context:\n${lines.join('\n')}` : '';
  }

  private buildPrompt(type: MsgType, user: GraceUser, opts?: GenerateOpts): string {
    const name = user.first_name ?? 'the user';
    const goal = user.goals[0] ?? 'general wellness';
    const cleanDislikes = user.food_dislikes
      .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter(Boolean);
    const dislikes = cleanDislikes.length > 0
      ? `NEVER suggest these foods (paraphrase naturally, don't quote raw text): ${cleanDislikes.join(', ')}.`
      : '';

    const RULES = `RULES — non-negotiable for proactive (scheduled) messages:
- These are REMINDERS, not conversation starters. They deliver value standalone.
- DEFAULT: end with a STATEMENT, not a question. NO question mark unless absolutely needed.
- 1 sentence is best. 2 max. NEVER more.
- Tone is a kind friend dropping a quick note, NOT a coach quizzing. No "how's X? how's Y? what did you...?" stacking.
- Don't ask for numerical reports ("rate 1-10", "how many oz").
- Reminder style (✓): "Protein first today. Front-load it before appetite fades." / "Hydration reminder — start with a full glass before coffee." / "Muscle protection reminder: protein + movement today."
- Question style (✗): "How's your eating going today?" / "What's your first protein hit today?" / "Any cravings hitting today?"
- Warm, calm, brief. No motivational speeches. No exclamation marks unless absolutely warranted.
- ZERO TOLERANCE — NEVER start the message with a label or category prefix. ALL of the following are strictly forbidden as openers:
  ✗ "Midday reminder:" / "Morning reminder:" / "Evening reminder:"
  ✗ "Daily check-in:" / "Check-in:" / "Reminder:" / "Note:"
  ✗ "Morning check-in —" / "Midday nudge —" / "Evening wind-down —"
  Start DIRECTLY with the actual message content. No preambles, no categories.`;

    const base = `Generate a single short SMS for ${name}.\n${RULES}\n\n`;

    // Wednesday morning: mood check overrides all goal-based routing
    if (type === 'morning' && opts?.isWednesday) {
      return `${base}Context: it's Wednesday — today is always a gentle mood check, regardless of goals. Ask softly how they're feeling mid-week. One warm, open question. No food/protein talk today.`;
    }

    const instructions: Record<MsgType, string> = {
      morning: (() => {
        const mode = user.goals[0] ? (GOAL_MODE_MAP[user.goals[0]] ?? 'protein') : 'protein';
        const modeHint = {
          protein: `nudge them toward getting protein early. Their target is ${user.protein_goal_grams ?? 80}g.`,
          hydration: 'remind them to start hydrated. One glass of water sets the day.',
          side_effects: 'check in gently about how they\'re feeling. Be soft, no questions required.',
          fiber: 'mention one easy fiber option for morning (oats, berries, chia). Keep it light.',
          connection: 'just let them know they\'re not alone in this. Warm presence, nothing more.',
          habits: 'acknowledge one small intention for the day. Very gentle.',
          muscle: `remind them that protein early protects muscle on ${user.medication ?? 'GLP-1'}. Target: ${user.protein_goal_grams ?? 80}g.`,
        }[mode] ?? 'say good morning warmly.';
        return `${base}Context: gentle morning hello. Today's focus: ${modeHint} No questions.`;
      })(),
      midday: `${base}Context: midday nudge (Mon/Wed/Fri). Keep it brief — a soft "thinking of you." ${dislikes} If you mention food, it must be something practical and filtered by their dislikes. NO questions.`,
      evening: (() => {
        const weightCtx = user.current_weight && user.goal_weight
          ? `They're ${Math.abs(user.current_weight - user.goal_weight).toFixed(0)} lbs from their goal (currently ${user.current_weight} lbs, aiming for ${user.goal_weight} lbs). Gently acknowledge progress if it feels natural.`
          : '';
        const moodCtx = opts?.lowMoodMode
          ? 'Their recent mood data shows they\'ve been struggling. Lead with encouragement and warmth — no reflection prompts, no "how did today go?". Just presence.'
          : 'Soft wind-down tone. Optional one-word-answer question max, or none.';
        return `${base}Context: evening wind-down (Tue/Thu/Sun). ${weightCtx} ${moodCtx} ${dislikes} If suggesting evening food, filter by dislikes.`;
      })(),
      injection_morning: `${base}Context: injection day reminder. Their medication is ${user.medication ?? 'a GLP-1'}. Tell them to reply "done" when injected. No questions about feelings — that comes later.`,
      injection_followup: `${base}Context: ~3 hours after their shot. Just check in softly — no interrogation. One brief opening for them to share if they want.`,
      injection_dayafter: `${base}Context: morning after injection. Acknowledge that day-after can be tough, be gentle. No checklist questions.`,
      side_effect_nausea: `${base}Context: they reported nausea earlier. Soft follow-up only — no question stack. Offer one practical tip in passing.`,
      side_effect_fatigue: `${base}Context: they reported fatigue. Validate it's real, suggest one gentle helper. No quiz.`,
      side_effect_constipation: `${base}Context: they reported constipation. Soft check-in with one tip woven in. No question barrage.`,
      welcome: `${base}Context: their very first message. Welcome them warmly. Use their first name ONCE. Mention their medication (${user.medication ?? 'GLP-1'}) and main goal (${goal}). ${dislikes ? `If you reference food dislikes, paraphrase naturally — e.g. "I'll keep [item] off the menu" or "I remember you don't like X". NEVER echo their dislike text verbatim (do not write "you're not a fan of i don't like rice" — that's broken English).` : ''} Make clear you'll be light-touch. ONE or TWO short sentences max. Do NOT send a second follow-up message.`,
      trial_expiry_reminder: `${base}Context: this is Day 2 of the user's 3-day free trial — their trial ends tomorrow. Send a warm, pressure-free reminder that their trial ends tomorrow and they can subscribe at graceglp.com. NEVER use their name. NEVER use "upgrade" language — say "continue" or "keep going." NEVER exclamation marks. NEVER salesy tone. ONE or TWO short sentences max. Example: "Your Grace trial ends tomorrow 🧡 Head to graceglp.com anytime to keep your check-ins going."`,
    };

    return instructions[type] + (opts?.extra ? `\n\nExtra context: ${opts.extra}` : '');
  }
}

// ─── Output sanitizer ────────────────────────────────────────────────────────
// Two failure modes from the LLM that this guards against:
//   1. Forbidden internal labels leaking into the message ("Midday reminder:",
//      "Morning check-in —", etc). The system prompt forbids these but Gemini
//      still emits them ~5% of the time, so we strip them deterministically.
//   2. Truncation mid-sentence (output budget exhausted). We detect by
//      requiring the message ends with punctuation, an emoji, or a closing
//      quote — anything else means it was cut off and we fall back.
const FORBIDDEN_LABEL_PREFIX = /^(morning|midday|afternoon|evening|night|daily|weekly|injection|protein|hydration|side[\s-]?effect)\s+(reminder|check[\s-]?in|nudge|note|update|message|hello|hi)[\s:.\-—–,]+/i;
const GENERIC_LABEL_PREFIX = /^(reminder|check[\s-]?in|note|update|hey there)[\s:,.\-—–]+/i;
// Allow standard sentence punctuation, common Grace emojis, and quote marks.
const COMPLETE_ENDING = /[.!?…"')\]🤍🌿🌙💪💉🧡✨🍃🤍🌱☀️🌞🌤️]$/u;

function sanitizeProactiveOutput(raw: string, firstName: string | null): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;

  // Strip wrapping quotes Gemini sometimes adds.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  // Strip a forbidden label-style prefix if present, then re-trim.
  const before = text;
  text = text.replace(FORBIDDEN_LABEL_PREFIX, '').replace(GENERIC_LABEL_PREFIX, '').trim();
  // Capitalize first letter if the strip left it lowercase mid-word.
  if (before !== text && text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Strip the user's first name wherever it appears — it's forbidden in every
  // proactive message except welcome. The LLM violates this rule ~10% of the
  // time despite the prompt instruction, so we enforce it in code too.
  if (firstName) {
    const n = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "Morning Danni 🌿 ..." → "Morning 🌿 ..."  |  "Hey Danni — ..." → "..."
    text = text.replace(new RegExp(`(Morning|Evening|Hey|Hi|Hello),?\\s+${n}[,\\s—–]\\s*`, 'gi'), '$1 ');
    // Any remaining standalone name occurrence with surrounding punctuation
    text = text.replace(new RegExp(`\\b${n}[,—–]\\s*`, 'gi'), '');
    text = text.replace(/\s{2,}/g, ' ').trim();
  }

  // Reject too-short results (likely the prefix was the entire message).
  if (text.length < 15) return null;

  // Reject if it doesn't end cleanly — most likely truncated by token budget.
  if (!COMPLETE_ENDING.test(text)) return null;

  return text;
}
