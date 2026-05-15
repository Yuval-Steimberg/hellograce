import type { LLMProvider } from '@grace/shared';
import { GRACE_SYSTEM_PROMPT } from '@grace/ai-core';
import type { GraceUser } from '../user/user.service.js';

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

  constructor(private llm: LLMProvider) {}

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
    const fallback = FALLBACKS[type](user, opts);
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
        maxOutputTokens: 120,
      });

      const text = resp.text.trim();
      return text.length > 20 ? text : fallback;
    } catch {
      return fallback;
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
- NEVER label the message ("morning check-in", "midday nudge", "evening wind-down") — those are internal names.`;

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
