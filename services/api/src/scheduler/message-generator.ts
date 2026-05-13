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
  'injection_dayafter' | 'side_effect_nausea' | 'side_effect_fatigue' | 'side_effect_constipation' | 'welcome';

/**
 * Fallback proactive messages. Tone: lightweight, supportive, NEVER interrogative.
 * One thought per message. Either no question, or one tiny optional one.
 * The user can always reply if they want to, but they shouldn't feel quizzed.
 */
const FALLBACKS: Record<MsgType, (user: GraceUser) => string> = {
  morning: (u) => {
    const name = u.first_name ?? 'there';
    const goal = u.goals[0];
    const mode = goal ? (GOAL_MODE_MAP[goal] ?? 'protein') : 'protein';
    if (mode === 'protein') {
      const target = u.protein_goal_grams ?? 80;
      return `Morning ${name} 🌿 Gentle nudge — try to land protein early today. ${target}g feels easier when you front-load it.`;
    }
    if (mode === 'hydration') return `Morning ${name} 🌿 Pouring a glass of water this morning sets the whole day up nicely.`;
    if (mode === 'side_effects') return `Morning ${name} 🌿 Take it easy on yourself today. I'm here if anything feels off.`;
    if (mode === 'fiber') return `Morning ${name} 🌿 A little fiber early (oats, berries, chia) makes the rest of the day kinder to your gut.`;
    return `Morning ${name} 🌿 Hope today's a soft one. I'm here whenever you want to chat.`;
  },
  midday: (u) => {
    const name = u.first_name ?? 'there';
    return `Hey ${name} — quick midday hello. No pressure to reply, just rooting for you over here 🤍`;
  },
  evening: (u) => {
    const name = u.first_name ?? 'there';
    return `Wrapping the day, ${name}? Hope it had a good moment in it somewhere. Rest well 🌙`;
  },
  injection_morning: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'your medication';
    return `It's ${med} day, ${name} 💉 Rotate your spot, take your time. Reply "done" when you're set — no rush.`;
  },
  injection_followup: (u) => {
    const name = u.first_name ?? 'there';
    return `Hey ${name} — just thinking about you a few hours post-shot. Hope you're feeling okay. If anything's up, I'm here.`;
  },
  injection_dayafter: (u) => {
    const name = u.first_name ?? 'there';
    return `Morning ${name} — day after your shot. Be gentle with yourself today 🤍`;
  },
  side_effect_nausea: (u) => {
    const name = u.first_name ?? 'there';
    return `Checking in softly, ${name} — hope the nausea's easing. Ginger tea and tiny sips help a lot of people 🤍`;
  },
  side_effect_fatigue: (u) => {
    const name = u.first_name ?? 'there';
    return `Hey ${name} — fatigue is real on this med. Rest if you can, and a bit of protein + water often helps. I'm here.`;
  },
  side_effect_constipation: (u) => {
    const name = u.first_name ?? 'there';
    return `Hey ${name} — just a soft check-in. Water, fiber, and a short walk are the usual gentle helpers if things are still slow.`;
  },
  welcome: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'your GLP-1';
    return `Hi ${name} — I'm Grace, your ${med} companion 🤍 I'll check in lightly each day, never overwhelm you. Text me anything, anytime — even just "tired" works.`;
  },
};

export class MessageGenerator {
  constructor(private llm: LLMProvider) {}

  async generate(type: MsgType, user: GraceUser, extra?: string): Promise<string> {
    const fallback = FALLBACKS[type](user);
    try {
      const userCtx = this.buildUserCtx(user);
      const prompt = this.buildPrompt(type, user, extra);

      const resp = await this.llm.generate({
        messages: [
          { role: 'system', content: GRACE_SYSTEM_PROMPT + '\n\n' + userCtx },
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
    if (user.food_dislikes.length > 0) lines.push(`Food dislikes: ${user.food_dislikes.join(', ')}`);
    if (user.current_weight && user.goal_weight) {
      lines.push(`Weight: ${user.current_weight} lbs (goal: ${user.goal_weight} lbs)`);
    }
    if (user.protein_goal_grams) {
      lines.push(`Personal daily protein target: ${user.protein_goal_grams}g`);
    }
    return lines.length > 0 ? `User context:\n${lines.join('\n')}` : '';
  }

  private buildPrompt(type: MsgType, user: GraceUser, extra?: string): string {
    const name = user.first_name ?? 'the user';
    const goal = user.goals[0] ?? 'general wellness';

    // Universal pacing rules — applied to every proactive message.
    const RULES = `RULES — non-negotiable:
- 1 sentence is best. 2 max. NEVER more.
- ZERO questions ideal. ONE tiny optional question max. NEVER ask multiple things.
- Tone is a kind friend, not a coach quizzing. No "how's X?, how's Y?, what did you...?" stacking.
- Don't ask for numerical reports ("rate 1-10", "how many oz"). Just be present.
- Warm, calm, brief. No motivational speeches.`;

    const base = `Generate a single short SMS for ${name}.\n${RULES}\n\n`;

    const instructions: Record<MsgType, string> = {
      morning: `${base}Context: it's their gentle morning hello. ${user.protein_goal_grams ? `Their personal protein target is ${user.protein_goal_grams}g.` : ''} Make it feel like a soft nudge from a friend, not a coach. No questions.`,
      midday: `${base}Context: a brief midday check-in. NO questions. Just a soft "thinking of you" type message. They can reply if they want.`,
      evening: `${base}Context: wind-down before sleep. Warm goodnight tone. Optional ONE-WORD-answer question max (or none at all).`,
      injection_morning: `${base}Context: injection day reminder. Their medication is ${user.medication ?? 'a GLP-1'}. Tell them to reply "done" when injected. No questions about feelings — that comes later.`,
      injection_followup: `${base}Context: ~3 hours after their shot. Just check in softly — no interrogation. One brief opening for them to share if they want.`,
      injection_dayafter: `${base}Context: morning after injection. Acknowledge that day-after can be tough, be gentle. No checklist questions.`,
      side_effect_nausea: `${base}Context: they reported nausea earlier. Soft follow-up only — no question stack. Offer one practical tip in passing.`,
      side_effect_fatigue: `${base}Context: they reported fatigue. Validate it's real, suggest one gentle helper. No quiz.`,
      side_effect_constipation: `${base}Context: they reported constipation. Soft check-in with one tip woven in. No question barrage.`,
      welcome: `${base}Context: their very first message. Welcome them warmly. Name them, mention their medication (${user.medication ?? 'GLP-1'}) and their main goal (${goal}). Make clear you'll be light-touch, not overwhelming. ONE warm sentence is enough.`,
    };

    return instructions[type] + (extra ? `\n\nExtra context: ${extra}` : '');
  }
}
