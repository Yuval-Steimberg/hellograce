import type { LLMProvider, DbContentRule } from '@grace/shared';
import { GRACE_SYSTEM_PROMPT, checkContent, endsMidWord, trimToLastCompleteSentence } from '@grace/ai-core';
import type { GraceUser } from '../user/user.service.js';
import type { ContentRulesService } from '../services/content-rules.service.js';
import type { MessageTemplatesService } from '../services/message-templates.service.js';
import { inferMedicationType } from '../services/ai.service.js';

const DEFAULT_WEB_URL = 'https://grace-admin-silk.vercel.app';

function buildUpgradeUrl(phone: string, webUrl: string = DEFAULT_WEB_URL): string {
  const base = webUrl.replace(/\/$/, '');
  return `${base}/upgrade?phone=${encodeURIComponent(phone)}`;
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

// ─── Daily variation engine ───────────────────────────────────────────────────
// Deterministic by phone + date so retries within a day get the same message,
// but the selection rotates every day automatically.

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

function dailySeed(phone: string): number {
  const today = new Date().toISOString().slice(0, 10);
  let h = 0;
  for (const c of `${phone}:${today}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function pick<T>(arr: readonly T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length]!;
}

// Angles rotate daily — forces Gemini to approach the topic from a different
// direction each day even when the goal/medication context is identical.
const MORNING_ANGLES = [
  'Lead with one tiny specific action they can do in the next 10 minutes.',
  'Quiet acknowledgment — mornings on GLP-1 can be slow and that\'s okay.',
  'Warm and sensory — like a text from a close friend who thought of them first thing.',
  'One micro-insight about how protein timing works on GLP-1 meds.',
  'Give them permission — they don\'t have to be perfect today.',
  'Reference the progress already made — they\'re still here, still doing it.',
  'Keep it playful and light. Something that makes them smile, not nod dutifully.',
  'Anchor it in a feeling — how do they want to feel by tonight? Work backward.',
  'Be brief and punchy — under 10 words, like a good morning text from someone who gets it.',
  'Offer one practical tip that\'s easy to skip if they\'re not in the mood.',
  'Acknowledge the week they\'re in on their GLP-1 journey.',
  'Focus purely on the one habit they care about most given their stated goal.',
] as const;

const MIDDAY_ANGLES = [
  'Pure warmth — no agenda, just "I\'m thinking of you" energy.',
  'Acknowledge the afternoon energy dip is real and GLP-1 can amplify it.',
  'Focus on the next 2 hours, not the whole day.',
  'One quiet permission: it\'s okay if the morning didn\'t go perfectly.',
  'The most casual version possible — like a friend\'s 3-word text.',
  'A soft practical nudge that doesn\'t feel like a checklist.',
  'Curiosity over advice — one gentle observation about how they might be feeling.',
  'Celebrate that they\'re halfway through the day. No ask required.',
] as const;

const EVENING_ANGLES = [
  'Close the day with warmth — not a review, just presence.',
  'Acknowledge the quiet courage of continuing on hard days.',
  'Reference how long they\'ve been on their GLP-1 journey — every week is something.',
  'Make it about tomorrow, not today — soft anticipation.',
  'Pure comfort — like a warm blanket message, nothing more.',
  'Validation that rest counts as progress.',
  'Brief and loving — the text equivalent of a quiet nod.',
  'Invite reflection only if they want it — make it feel optional, not required.',
  'Specific acknowledgment of what\'s genuinely hard about evenings on this med.',
  'Reference their goal and how simply showing up today connects to it.',
] as const;

const BONUS_ANGLES = [
  'A hydration nudge — GLP-1s suppress thirst alongside hunger.',
  'One quick protein idea they haven\'t heard yet. Surprise them.',
  'Permission to rest — movement counts even if it\'s a short walk.',
  'A small GLP-1 fact they probably didn\'t know. Make it interesting, not clinical.',
  'A "you\'re doing this" moment — no tips, just quiet acknowledgment.',
  'One easy meal or snack idea based on their dislikes and medication.',
  'A gentle body-care nudge — hydration, sleep, or stretching.',
  'Something about their specific medication that\'s useful and non-obvious.',
  'A micro-goal for the next hour. Concrete, tiny, achievable.',
  'Acknowledge something specific about their week number on GLP-1.',
] as const;

const BONUS_CATEGORIES = [
  'hydration', 'protein_tip', 'movement', 'self_care',
  'glp1_knowledge', 'meal_idea', 'body_care', 'micro_goal',
  'acknowledgment', 'mindfulness',
] as const;

// Rotating banned openers — by banning 2 different words each day we prevent
// the model from falling back on its 3-4 favourite opening words.
const OPENER_POOL = [
  'Gentle', 'Just', 'Quick', 'Hey', 'Hi', 'Morning', 'Evening',
  'Small', 'Soft', 'Simply', 'Remember', 'Today', 'Tomorrow',
  'Checking', 'Popping', 'Wanted', 'Hope', 'Thinking', 'Sending',
  'Taking', 'Making', 'Keeping', 'Staying', 'Feeling', 'Starting',
] as const;

type MsgType = 'morning' | 'midday' | 'evening' | 'bonus' | 'injection_morning' | 'injection_followup' |
  'injection_dayafter' | 'side_effect_nausea' | 'side_effect_fatigue' | 'side_effect_constipation' |
  'welcome' | 'trial_expiry_reminder';

export interface GenerateOpts {
  extra?: string;
  isWednesday?: boolean;  // forces mood check regardless of goals
  lowMoodMode?: boolean;  // evening → encouragement over reflection
  /** REAL yesterday food data (morning reminders) — from getDailyProteinHistory. */
  yesterdayFood?: { protein_g: number; calories: number; itemCount: number; proteinGoal: number | null };
  /** REAL same-day food data (evening reminders) — from getTodaysFoodSummary. */
  todayFood?: { protein_g: number; calories: number; itemCount: number; proteinGoal: number | null };
  /** Texts of the last few reminders sent to this user — the new message must
   *  not repeat any of them. Also used for a post-generation duplicate check. */
  recentMessages?: string[];
  /** The user's own recent messages (most recent last) — lets the reminder
   *  reference a topic they actually raised. Woven in only if clearly relevant;
   *  never invented. */
  conversationContext?: string[];
}

const FALLBACKS: Record<MsgType, (user: GraceUser, opts?: GenerateOpts) => string> = {
  morning: (u, opts) => {
    if (opts?.isWednesday) {
      const pool = [
        `Mid-week check — how are you actually feeling today? No wrong answers 🌿`,
        `Halfway through the week. How are you holding up — honestly?`,
        `Wednesday already. Softer question today: what's actually going on with you?`,
        `Mid-week. No agenda — just genuinely curious how you're doing 🌿`,
      ];
      return pick(pool, dailySeed(u.phone));
    }
    const goal = u.goals[0];
    const mode = goal ? (GOAL_MODE_MAP[goal] ?? 'protein') : 'protein';
    const target = u.protein_goal_grams ?? 80;
    const med = u.medication ?? 'GLP-1';
    const seed = dailySeed(u.phone);
    if (mode === 'protein') {
      return pick([
        `Protein first today. Front-load it before appetite fades — ${target}g is easier when you start early 🌿`,
        `${target}g of protein by noon makes the rest of the day feel lighter. Start early if you can 🌿`,
        `Early protein on ${med} protects muscle and steadies energy. Even 20g before 10am counts 🌿`,
        `One thing that consistently helps on ${med}: landing protein in the morning. ${target}g is the target 🌿`,
        `Your body is doing a lot on ${med}. Protein early keeps muscle and energy stable — front-load it today 🌿`,
      ], seed);
    }
    if (mode === 'hydration') return pick([
      `A glass of water before coffee sets the whole day up differently. Start there 🌿`,
      `Hydration on ${med} matters more than most people realize. First glass — right now 🌿`,
      `Before anything else today: water. It's the easiest win on the list 🌿`,
    ], seed);
    if (mode === 'side_effects') return pick([
      `Take it easy on yourself today. I'm here if anything feels off 🤍`,
      `${med} can make mornings unpredictable. No pressure today — just check in if you need to 🌿`,
      `Soft morning. You know your body. Rest what needs resting, do what feels okay 🤍`,
    ], seed);
    if (mode === 'fiber') return pick([
      `A little fiber early (oats, berries, chia) makes the rest of the day kinder to your gut 🌿`,
      `Fiber in the morning is quiet protection. Oats or berries if you can manage it 🌿`,
      `Gut-friendly morning: something fibrous early helps a lot on ${med} 🌿`,
    ], seed);
    if (mode === 'connection') return pick([
      `You're not doing this alone. I'm here whenever 🤍`,
      `Checking in — not because I have to, because I'm actually thinking about you 🌿`,
      `This journey is genuinely hard. You're still showing up. That's worth noting 🤍`,
    ], seed);
    if (mode === 'habits') return pick([
      `One small thing today. That's enough 🌿`,
      `Habits compound quietly. Whatever small thing you do today — it counts 🌿`,
      `No pressure to be perfect. One tiny intention is a whole thing 🌿`,
    ], seed);
    if (mode === 'muscle') return pick([
      `Muscle protection on ${med}: protein early, even a small amount, makes a real difference 🌿`,
      `${target}g today keeps muscle loss at bay on ${med}. Start early if you can 🌿`,
      `Protecting muscle is one of the most important things on ${med}. Protein first this morning 🌿`,
    ], seed);
    return pick([
      `Hope today's a soft one. I'm here whenever you want to chat 🌿`,
      `Good morning. No agenda — just rooting for you today 🤍`,
      `A quiet one or a full one, I'm here either way. Morning 🌿`,
    ], seed);
  },
  midday: (u) => {
    return pick([
      `Midday. No pressure to reply — just rooting for you over here 🤍`,
      `Quick hello from the middle of the day. Hope it's treating you okay 🌿`,
      `Halfway through — you're doing it 🤍`,
      `Afternoon check-in. Nothing required from you. Just thinking of you 🌿`,
      `The day's half done. Be kind to yourself for the rest of it 🤍`,
      `Midday nudge: water if you haven't had any. That's it 🌿`,
    ], dailySeed(u.phone));
  },
  evening: (u, opts) => {
    const seed = dailySeed(u.phone);
    if (opts?.lowMoodMode) {
      return pick([
        `Thinking of you tonight. You're doing something genuinely hard, and it counts even on the quiet days 🤍`,
        `Hard days still count. You're still here. That's something 🤍`,
        `Whatever today was — you got through it. Rest well 🌙`,
        `Some days the win is just making it to evening. Tonight counts 🤍`,
      ], seed);
    }
    if (u.current_weight && u.goal_weight) {
      const diff = Math.abs(u.current_weight - u.goal_weight).toFixed(0);
      return pick([
        `Wrapping up? You're ${diff} lbs from your goal — every consistent day moves the needle 🌙`,
        `${diff} lbs from where you want to be. Today was another step 🌙`,
        `You're closer than you were. ${diff} lbs to go — rest well tonight 🌙`,
      ], seed);
    }
    return pick([
      `Wrapping the day. Hope it had a good moment in it somewhere. Rest well 🌙`,
      `Evening. Whatever you managed today — it was enough 🌙`,
      `The day's done. You showed up. Rest well 🌙`,
      `Good evening. No recap needed — just rest well tonight 🌙`,
      `End of day. Be gentle with yourself tonight 🤍`,
    ], seed);
  },
  injection_morning: (u) => {
    const med = u.medication ?? 'your medication';
    const seed = dailySeed(u.phone);
    return pick([
      `${med} day 💉 Rotate your spot, take your time. Reply "done" when you're set — no rush.`,
      `Injection day 💉 No hurry. Rotate sites, breathe through it. Just reply "done" when it's done.`,
      `${med} day 💉 You've got this. Rotate your site, go slow. "Done" when you're ready.`,
      `Injection day. Take your time with it — rotate the spot, breathe. Reply "done" after 💉`,
    ], seed);
  },
  injection_followup: (u) => {
    return pick([
      `A few hours post-shot — hope you're feeling okay. I'm here if anything's up 🤍`,
      `Checking in after your injection. How's your body feeling?`,
      `Post-shot check-in. Nausea, fatigue, or anything off? Or all good so far?`,
      `Just thinking about you after your injection today. How are you doing?`,
    ], dailySeed(u.phone));
  },
  injection_dayafter: (u) => {
    return pick([
      `Day after your shot — be gentle with yourself today 🤍`,
      `Morning after injection day. If you're feeling the effects, that's normal. Rest if you need to 🤍`,
      `Post-injection morning. Your body's adjusting — take it slow today 🌿`,
      `The day after can feel different. Be soft with yourself today 🤍`,
    ], dailySeed(u.phone));
  },
  side_effect_nausea: (u) => {
    return pick([
      `Hope the nausea's easing. Ginger tea and tiny sips help a lot of people 🤍`,
      `Checking in softly — nausea on ${u.medication ?? 'GLP-1'} is real and it passes. Tiny sips, cold water, rest 🤍`,
      `How's the nausea now? Ginger, cold water, and horizontal help most. Here if you need to talk through it 🤍`,
    ], dailySeed(u.phone));
  },
  side_effect_fatigue: (u) => {
    return pick([
      `Fatigue is real on this med. Rest if you can — a bit of protein + water often helps. I'm here 🤍`,
      `The tiredness on ${u.medication ?? 'GLP-1'} is legitimate. Rest isn't giving up. Protein + water when you can 🤍`,
      `Checking in on the fatigue. Your body's working hard adjusting. Rest as much as you need 🤍`,
    ], dailySeed(u.phone));
  },
  side_effect_constipation: (u) => {
    return pick([
      `Soft check-in. Water, fiber, and a short walk are the usual gentle helpers if things are still slow 🌿`,
      `How are things moving? Water + fiber + gentle movement is the standard trio that helps most people 🌿`,
      `Checking in on that side effect. Magnesium, water, and walking help a lot — let me know if you want more specifics 🌿`,
    ], dailySeed(u.phone));
  },
  welcome: (u) => {
    const name = u.first_name ?? 'there';
    // Deterministic, compliance-correct welcome (2026-06-14). NOT LLM-generated:
    // the STOP/HELP + "Msg & data rates may apply" footer is an A2P requirement
    // and must ship verbatim — an LLM would paraphrase or drop it. generate()
    // short-circuits 'welcome' to this template so the exact wording always ships.
    return `Hi ${name}, it's Grace, your new GLP-1 sidekick. I'll check in daily with meal ideas, protein tips, and encouragement. Text me what you ate (or snap a pic) and I'll log it. Ask me anything, anytime. Save this number so you never miss a check-in. Reply STOP to cancel, HELP for help. Msg & data rates may apply.`;
  },
  trial_expiry_reminder: (u) => {
    const upgradeUrl = buildUpgradeUrl(u.phone);
    return `Your Grace trial ends tomorrow 🧡 Head to ${upgradeUrl} anytime to keep your check-ins going — no pressure, whenever you're ready.`;
  },
  bonus: (u) => {
    const seed = dailySeed(u.phone);
    const pool = [
      'Water check — GLP-1s quiet your thirst alongside hunger. One glass right now helps more than you think.',
      `Quick protein thought: ${u.protein_goal_grams ?? 80}g is your daily target. A Greek yogurt or handful of nuts gets you closer without effort.`,
      'Movement doesn\'t have to be a workout. A 10-minute walk after a meal helps digestion and steadies blood sugar.',
      'Rest is part of the process. If your body says slow down today, listen.',
      'GLP-1 tip: eating protein first in a meal helps absorption and keeps you full longer.',
      'Hydration affects everything — energy, skin, digestion, mood. One extra glass today.',
      `Reminder that week by week on ${u.medication ?? 'your medication'}, your body is adjusting. Patience is progress.`,
      'Small win for the next hour: one protein-rich snack or a full glass of water.',
      'Your body is doing a lot right now. Give it something nourishing, even if appetite is low.',
      'Muscle protection matters on GLP-1. Every bit of protein and movement counts toward keeping what you\'ve built.',
    ];
    return pick(pool, seed, 5);
  },
};

export class MessageGenerator {
  private activeSystemPrompt: string | undefined;
  private rulesService: ContentRulesService | undefined;
  private templatesService: MessageTemplatesService | undefined;
  private webUrl: string = DEFAULT_WEB_URL;

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

  /** Set the public web URL used for upgrade + settings links in scheduled messages. */
  updateWebUrl(url: string): void {
    this.webUrl = url;
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
    // The welcome is deterministic — it carries the A2P compliance footer
    // (STOP/HELP, "Msg & data rates may apply") which must ship verbatim, so we
    // never route it through the LLM. resolveFallback still lets ops override it
    // via the message_templates 'welcome' row without a deploy.
    if (type === 'welcome') return fallback;
    try {
      const userCtx = this.buildUserCtx(user);
      const prompt = this.buildPrompt(type, user, opts);
      const systemPrompt = this.activeSystemPrompt ?? GRACE_SYSTEM_PROMPT;

      const resp = await this.llm.generate({
        messages: [
          { role: 'system', content: systemPrompt + '\n\n' + userCtx },
          { role: 'user', content: prompt },
        ],
        temperature: 0.85,
        maxOutputTokens: 280,
        model: 'gemini-2.5-flash',
        disableThinking: true,
      });

      // 'welcome' is handled deterministically above and never reaches here,
      // so every message at this point should have the user's name stripped.
      const sanitized = sanitizeProactiveOutput(resp.text, user.first_name);
      if (!sanitized) return fallback;

      // Anti-repetition: never ship a reminder that duplicates one of the
      // last few sent to this user. The prompt already lists them as banned;
      // this is the deterministic backstop. Fallbacks rotate daily by seed,
      // so the fallback itself won't repeat yesterday's fallback.
      if (opts?.recentMessages?.some((prev) => isNearDuplicate(sanitized, prev))) {
        return fallback;
      }

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
          upgrade_url: buildUpgradeUrl(user.phone, this.webUrl),
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
    const cleanDislikes = user.food_dislikes
      .map((d) => d.replace(/^(i\s+(don'?t|do\s+not|hate|can'?t\s+stand|dislike)\s+(like\s+)?|no\s+|avoid\s+)/i, '').trim())
      .filter(Boolean);
    const dislikes = cleanDislikes.length > 0
      ? `NEVER suggest these foods (paraphrase naturally, don't quote raw text): ${cleanDislikes.join(', ')}.`
      : '';

    // Daily variation — deterministic by user + date so retries stay consistent
    // but each new day gets a fresh angle and different banned openers.
    const seed = dailySeed(user.phone);
    const angleMap: Record<string, readonly string[]> = {
      morning: MORNING_ANGLES, midday: MIDDAY_ANGLES, evening: EVENING_ANGLES, bonus: BONUS_ANGLES,
    };
    const anglePool = angleMap[type] ?? MORNING_ANGLES;
    const todayAngle = pick(anglePool, seed);
    const bannedOpener1 = pick(OPENER_POOL, seed, 0);
    const bannedOpener2 = pick(OPENER_POOL, seed, 3);
    const bannedOpener3 = pick(OPENER_POOL, seed, 7);

    const VARIATION_BLOCK = `TODAY'S VARIATION DIRECTIVE (changes daily — follow exactly):
- Angle: ${todayAngle}
- Banned first word today: "${bannedOpener1}", "${bannedOpener2}", "${bannedOpener3}" — your message MUST NOT start with any of these.
- Every message must feel written for today, not copy-pasted from yesterday. If the same user got a message yesterday, this one must read differently — different structure, different opening word, different rhythm.`;

    const RULES = `RULES — proactive (scheduled) messages, written like a friend who actually knows them:
- This should feel like a warm, personal check-in from someone in their corner — NOT a system notification, a coach, or a generic health app. Casual, human, specific to them.
- It still has to stand on its own and land a little warmth or value (a gentle nudge, a kind observation, one small idea). They didn't ask for it, so make it feel like a thoughtful text, not a task.
- Keep it short: 1 sentence is best, 2 max. Easy to read at a glance. Contractions always.
- Mostly land on a warm statement. A single soft, low-pressure question is fine when it genuinely reads like a friend checking in ("did you have anything else you want me to add?") — but NEVER stack questions, quiz them ("how's X? how's Y?"), or ask for numbers ("rate 1-10", "how many oz").
- Warm, calm, real. No motivational speeches, no hype, no exclamation-point energy unless it truly fits.
- Make it personal: lean on what's actually true for them today (the REAL DATA + recent conversation below) so it never reads like a template. If there's no data, a simple warm note is perfect — NEVER invent food logs, protein numbers, symptoms, goals, or injection details.
- The vibe (✓): "morning — even one protein-first meal early can make the whole day feel easier." / "quick thought: a few sips of water now help more than it sounds, especially if your appetite's been weird lately." / "hope you're noticing the little wins today — more energy, clothes fitting better. the scale's never the whole story." / "thinking of you tonight — no pressure, just glad you're in this."
- NOT this (✗): "Prioritizing protein can help maintain steady energy." (corporate) / "Reminder: please log your meals." (robotic) / "How's your eating? Any cravings? What did you have?" (a quiz, not a friend).
- WRITE AS IF TEXTING THEM DIRECTLY. NEVER address the user by name. NEVER open with "For <name>," / "Dear <name>" / "To <name>" / "Hi <name>" / "Dear user" / "As your assistant" — those read like a mail-merge template, not a text from a friend.
- ZERO TOLERANCE — NEVER start the message with a label or category prefix. ALL of the following are strictly forbidden as openers:
  ✗ "Midday reminder:" / "Morning reminder:" / "Evening reminder:"
  ✗ "Daily check-in:" / "Check-in:" / "Reminder:" / "Note:"
  ✗ "Morning check-in —" / "Midday nudge —" / "Evening wind-down —"
  Start DIRECTLY with the actual message content. No preambles, no categories.`;

    // Anti-repeat block: list the texts of recent reminders so the model
    // writes something genuinely new (deterministic backstop in generate()).
    const recent = (opts?.recentMessages ?? []).filter((m) => m && m.trim().length > 0).slice(0, 5);
    const ANTI_REPEAT = recent.length > 0
      ? `\nRECENTLY SENT (do NOT repeat any of these — not the wording, not the structure, not a close variant):\n${recent.map((m) => `- "${m.slice(0, 160)}"`).join('\n')}\n`
      : '';

    // Conversation relevance: surface what the user recently said so the
    // reminder can follow up on a real topic instead of reading generic. The
    // model MAY weave in ONE relevant thread; it must never invent or force it,
    // and must still obey DATA ACCURACY (no fabricated numbers/symptoms).
    const convo = (opts?.conversationContext ?? []).filter((m) => m && m.trim().length > 0).slice(-5);
    const CONVO_CONTEXT = convo.length > 0
      ? `\nRECENT CONVERSATION (the user's own recent messages — most recent last):\n${convo.map((m) => `- "${m.slice(0, 140)}"`).join('\n')}\nIf ONE of these is clearly worth a gentle follow-up (a symptom they mentioned, a goal, something they were working on), you MAY reference it naturally — but only if it genuinely fits, and NEVER invent details beyond what they said. Otherwise ignore it and send a normal reminder.\n`
      : '';

    const base = `Write the next short proactive SMS from Grace to this user. Output ONLY the message text.\n${VARIATION_BLOCK}\n\n${RULES}\n${ANTI_REPEAT}${CONVO_CONTEXT}\n`;

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
        // REAL yesterday data → the morning reminder can reference actual
        // behavior ("yesterday you were a little short on protein") instead
        // of a generic template. Absent data → plain warm reminder, never
        // invented numbers.
        const y = opts?.yesterdayFood;
        let dataBlock = '';
        if (y) {
          if (y.itemCount === 0) {
            dataBlock = `\nREAL DATA — yesterday: no food was logged. If you reference it, keep it shame-free ("fresh start today" energy, never scolding about not logging).`;
          } else {
            const goalPart = y.proteinGoal
              ? y.protein_g >= y.proteinGoal
                ? `they HIT their ${y.proteinGoal}g protein target (${y.protein_g}g) — a brief genuine acknowledgment is welcome`
                : `they reached ${y.protein_g}g of their ${y.proteinGoal}g protein target (${Math.max(0, y.proteinGoal - y.protein_g)}g short) — today is a good day to plan one solid protein meal early`
              : `they logged ${y.protein_g}g protein`;
            dataBlock = `\nREAL DATA — yesterday: ${goalPart}. ${y.itemCount} food${y.itemCount === 1 ? '' : 's'} logged. Use this naturally if helpful; don't recite all the numbers.`;
          }
        }
        return `${base}Context: gentle morning hello. Today's focus: ${modeHint}${dataBlock} No questions.`;
      })(),
      bonus: (() => {
        const catIdx = (seed + dayOfYear(new Date())) % BONUS_CATEGORIES.length;
        const category = BONUS_CATEGORIES[catIdx]!;
        const catHints: Record<string, string> = {
          hydration: 'a hydration nudge — GLP-1s suppress thirst. One practical water tip.',
          protein_tip: `a protein idea they haven't heard. Target: ${user.protein_goal_grams ?? 80}g daily. Something surprising or easy.`,
          movement: 'a gentle movement reminder — not a workout plan, just encouragement to move a little.',
          self_care: 'a body-care or self-care thought — sleep, skin, stretching, rest. Something nurturing.',
          glp1_knowledge: `one interesting fact about ${user.medication ?? 'GLP-1 medication'} that's useful and non-obvious. Not clinical.`,
          meal_idea: `one specific easy meal or snack idea. ${dislikes} Filter by their dislikes. Protein-focused.`,
          body_care: 'acknowledge what their body is going through — the adjustment, the changes. Be warm, not medical.',
          micro_goal: 'suggest one tiny concrete thing for the next hour. Achievable, no pressure.',
          acknowledgment: 'pure acknowledgment — they\'re showing up and that matters. No tips, no advice.',
          mindfulness: 'a gentle mindfulness moment — one breath, one pause, noticing how the body feels. Brief.',
        };
        return `${base}Context: spontaneous check-in at an unexpected time. Today's theme: ${catHints[category] ?? 'warm presence.'} This is a BONUS touch point — extra brief, extra casual. Must feel like a random thoughtful text from a friend, not a scheduled message. ONE sentence only.`;
      })(),
      midday: `${base}Context: midday nudge (Mon/Wed/Fri). Keep it brief — a soft "thinking of you." ${dislikes} If you mention food, it must be something practical and filtered by their dislikes. NO questions.`,
      evening: (() => {
        const weightCtx = user.current_weight && user.goal_weight
          ? `They're ${Math.abs(user.current_weight - user.goal_weight).toFixed(0)} lbs from their goal (currently ${user.current_weight} lbs, aiming for ${user.goal_weight} lbs). Gently acknowledge progress if it feels natural.`
          : '';
        const moodCtx = opts?.lowMoodMode
          ? 'Their recent mood data shows they\'ve been struggling. Lead with encouragement and warmth — no reflection prompts, no "how did today go?". Just presence.'
          : 'Soft wind-down tone. Optional one-word-answer question max, or none.';
        // REAL same-day data → the evening reminder is a daily wrap-up
        // grounded in what actually happened TODAY ("you're at 82g — eggs or
        // yogurt tonight would close the gap"), never a repeat of the
        // morning message and never invented numbers.
        const t = opts?.todayFood;
        let dataBlock = '';
        if (t) {
          if (t.itemCount === 0) {
            dataBlock = `\nREAL DATA — today: nothing logged yet. A gentle, shame-free nudge that they can still text you what they ate is welcome. Do NOT pretend to know what they ate.`;
          } else {
            const goalPart = t.proteinGoal
              ? t.protein_g >= t.proteinGoal
                ? `they're at ${t.protein_g}g protein — target (${t.proteinGoal}g) already hit. Acknowledge it; no food suggestion needed`
                : `they're at ${t.protein_g}g of their ${t.proteinGoal}g protein target. If they're still eating tonight, ONE simple suggestion (eggs, Greek yogurt, cottage cheese — filtered by dislikes) could close the gap`
              : `they're at ${t.protein_g}g protein today`;
            dataBlock = `\nREAL DATA — today: ${goalPart}. ${t.itemCount} food${t.itemCount === 1 ? '' : 's'} logged so far.`;
          }
        }
        return `${base}Context: evening wind-down — a daily check-in that wraps the day, NOT a repeat of this morning's message. ${weightCtx} ${moodCtx}${dataBlock} ${dislikes} If suggesting evening food, filter by dislikes.`;
      })(),
      injection_morning: `${base}Context: injection day reminder. Their medication is ${user.medication ?? 'a GLP-1'}. Tell them to reply "done" when injected. No questions about feelings — that comes later.`,
      injection_followup: `${base}Context: ~3 hours after their shot. Just check in softly — no interrogation. One brief opening for them to share if they want.`,
      injection_dayafter: `${base}Context: morning after injection. Acknowledge that day-after can be tough, be gentle. No checklist questions.`,
      side_effect_nausea: `${base}Context: they reported nausea earlier. Soft follow-up only — no question stack. Offer one practical tip in passing.`,
      side_effect_fatigue: `${base}Context: they reported fatigue. Validate it's real, suggest one gentle helper. No quiz.`,
      side_effect_constipation: `${base}Context: they reported constipation. Soft check-in with one tip woven in. No question barrage.`,
      welcome: `${base}Context: their very first message ever from Grace. This sets the tone for the whole relationship — make it count.

Structure (2-3 short paragraphs, separated by blank lines):
1. Warm greeting using their first name ONCE + mention their medication (${user.medication ?? 'GLP-1'})
2. Explain what Grace does: 1-2 light check-ins per day, plus they can text anytime about food, symptoms, weight, or feelings. Photos and voice notes work.
3. Set expectations: no pressure to reply, even short replies work, you're here when needed

Tone: confident, warm, human. Not gushing or salesy. Make them feel supported immediately.
${dislikes ? `If you reference food dislikes, paraphrase naturally — never echo their text verbatim.` : ''}
Do NOT ask a question. Do NOT send a second follow-up.`,
      trial_expiry_reminder: (() => {
        const upgradeUrl = buildUpgradeUrl(user.phone, this.webUrl);
        return `${base}Context: this is Day 2 of the user's 3-day free trial — their trial ends tomorrow. Send a warm, pressure-free reminder that their trial ends tomorrow and they can subscribe at ${upgradeUrl}. ALWAYS include the literal URL ${upgradeUrl} — never write a placeholder. NEVER use their name. NEVER use "upgrade" language — say "continue" or "keep going." NEVER exclamation marks. NEVER salesy tone. ONE or TWO short sentences max. Example: "Your Grace trial ends tomorrow 🧡 Head to ${upgradeUrl} anytime to keep your check-ins going."`;
      })(),
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
const FORBIDDEN_LABEL_PREFIX = /^(morning|midday|afternoon|evening|night|daily|weekly|injection|protein|hydration|side[\s-]?effect|bonus|spontaneous)\s+(reminder|check[\s-]?in|nudge|note|update|message|hello|hi|thought)[\s:.\-—–,]+/i;
const GENERIC_LABEL_PREFIX = /^(reminder|check[\s-]?in|note|update|hey there)[\s:,.\-—–]+/i;
// Note: COMPLETE_ENDING regex was replaced by the shared endsMidWord guard
// imported from @grace/ai-core (2026-06-04 unification).

// Production failure (2026-06-11): a reminder shipped as "For Yuval, Hope
// you're having a good day…" — the LLM echoed the prompt's addressing line
// as a mail-merge-style salutation. These catch that whole class of opener
// regardless of which name the model used (covers nicknames that don't match
// users.first_name).
// Capitalized-name requirement is deliberate (no `i` flag on the name): it
// distinguishes "For Yuval," (salutation → strip) from a legitimate
// "For breakfast, try…" (lowercase noun → keep).
const ADDRESSED_OPENER_RE = /^(For|Dear|To|for|dear|to)\s+[A-Z][\w'’-]*\s*[,:;.!—–-]+\s*/;
const ROLE_OPENER_RE = /^(dear\s+(user|friend|there)|as your (ai\s+)?(assistant|companion|coach|nutritionist)|this is grace[,:]?|grace here[,:]?)\s*[,:;.!—–-]*\s*/i;

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
  // Mail-merge salutations ("For Yuval,", "Dear user,", "As your assistant,")
  // — strip whatever name the model used, then the role-style openers.
  text = text.replace(ADDRESSED_OPENER_RE, '').replace(ROLE_OPENER_RE, '').trim();
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

  // 2026-06-04 unified mid-sentence check: use the same endsMidWord guard
  // the orchestrator uses, so proactive messages get the SAME protection
  // against (approx., unclosed brackets, stranded hedge words, etc.
  // Iterative trim — same logic as the orchestrator's final safety net.
  if (endsMidWord(text)) {
    let candidate = text;
    let cleaned = false;
    for (let i = 0; i < 6; i++) {
      const { trimmed, wasTrimmed } = trimToLastCompleteSentence(candidate);
      if (!wasTrimmed || trimmed.length < 15) break;
      candidate = trimmed;
      if (!endsMidWord(candidate)) { cleaned = true; break; }
    }
    if (cleaned) return candidate;
    return null;
  }

  return text;
}

// trimToLastCompleteSentence is now imported from @grace/ai-core (2026-06-04
// unification), so the proactive path uses the EXACT SAME completeness check
// as the orchestrator.

// ─── Near-duplicate detection ────────────────────────────────────────────────
// A reminder must never repeat one of the last few sent to the same user.
// Exact match after normalization, or ≥85% token overlap (Jaccard) — catches
// "Protein first today 🌿" vs "Protein first today 🤍" style trivial rewrites.
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.85;
}

// Test-only exports — let unit tests drive the sanitizer directly without a
// real LLM round-trip.
export const __testing = {
  sanitizeProactiveOutput,
};
