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

const FALLBACKS: Record<MsgType, (user: GraceUser) => string> = {
  morning: (u) => {
    const name = u.first_name ?? 'there';
    const goal = u.goals[0];
    const mode = goal ? (GOAL_MODE_MAP[goal] ?? 'protein') : 'protein';
    const med = u.medication ?? 'your medication';
    if (mode === 'protein') return `Morning ${name}! Quick check: what's your protein plan today? ${med} can curb appetite, so protein gets missed fast.`;
    if (mode === 'hydration') return `Morning ${name}! Water check — GLP-1 can make it easy to forget hydration. How many glasses since you woke up?`;
    if (mode === 'side_effects') return `Morning ${name}! How's your body feeling today? Any nausea, fatigue, or anything off?`;
    if (mode === 'fiber') return `Morning ${name}! Fiber focus today — aim for 25g. Constipation is common on ${med}.`;
    return `Morning ${name}! How are you feeling today — body and brain? Rate 1–10?`;
  },
  midday: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'GLP-1';
    return `Hey ${name}, how's your afternoon going? ${med} can reduce appetite, so protein gets missed fast. What did you eat for lunch?`;
  },
  evening: (u) => {
    const name = u.first_name ?? 'there';
    return `Before you wind down ${name} — how did today go? Even just one word: hard, okay, good, or great.`;
  },
  injection_morning: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'your medication';
    const count = u.injection_count;
    if (count === 0) return `Today's your first ${med} injection day, ${name}! Rotate your injection site — stomach and thigh are most common. Reply 'done' when you've injected 💉`;
    if (count < 4) return `It's ${med} day, ${name}! Injection #${count + 1} — rotate your site. Reply 'done' when you're set 💉`;
    return `${med} day, ${name}! Injection #${count + 1}. You're a pro at this. Rotate your site and reply 'done' 💉`;
  },
  injection_followup: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'the medication';
    return `How are you feeling, ${name}? Some people feel totally normal after ${med}, some get a little nauseous or tired — both are normal. What's going on for you right now?`;
  },
  injection_dayafter: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'your medication';
    return `Morning after ${med} day! How are you feeling today, ${name}? Sometimes the second day is actually tougher than the first. Just checking in 🧡`;
  },
  side_effect_nausea: (u) => {
    const name = u.first_name ?? 'there';
    const med = u.medication ?? 'GLP-1';
    return `Just checking in, ${name} — are you feeling any better? ${med} nausea usually peaks then fades. Try ginger tea, plain crackers, or small sips of water if you haven't already 🧡`;
  },
  side_effect_fatigue: (u) => {
    const name = u.first_name ?? 'there';
    return `Hey ${name} — how's your energy today? Make sure you're eating enough (even small amounts) and staying hydrated — low calories + dehydration = double fatigue. How are you feeling?`;
  },
  side_effect_constipation: (u) => {
    const name = u.first_name ?? 'there';
    return `Hey ${name} — checking back on the constipation. It's really common on GLP-1. Prunes, apple with skin, oatmeal, and 80oz+ of water help most people. How are things going?`;
  },
  welcome: (u) => {
    const name = u.first_name ?? 'there';
    const goal = u.goals[0] ?? 'your wellness';
    const med = u.medication ?? 'your GLP-1';
    return `Hi ${name}! I'm Grace, your ${med} companion 🧡 You told me "${goal}" matters to you — so that's what I'll focus on. I'll check in with you throughout the day. You're not doing this alone anymore.`;
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
        temperature: 0.85,
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
    return lines.length > 0 ? `User context:\n${lines.join('\n')}` : '';
  }

  private buildPrompt(type: MsgType, user: GraceUser, extra?: string): string {
    const name = user.first_name ?? 'the user';
    const goal = user.goals[0] ?? 'general wellness';
    const mode = GOAL_MODE_MAP[goal] ?? 'general';
    const base = `Generate a single warm, concise SMS message (max 2 sentences, no markdown) for ${name}.`;

    const instructions: Record<MsgType, string> = {
      morning: `${base} It's their morning check-in. Focus on ${mode}. Their medication is ${user.medication ?? 'a GLP-1'}. Be encouraging and specific.`,
      midday: `${base} It's a midday check-in (Mon/Wed/Fri). Focus on ${mode} — ask about their lunch/protein/water. Keep it light and friendly.`,
      evening: `${base} It's their evening wind-down. Ask how their day went or invite reflection. Warm and gentle.`,
      injection_morning: `${base} Today is their injection day (injection #${user.injection_count + 1}). Remind them to inject and rotate the site. Tell them to reply 'done'.`,
      injection_followup: `${base} It's 3 hours after their injection. Ask how they're feeling — nausea, fatigue, or totally fine — both are normal.`,
      injection_dayafter: `${base} It's the morning after their injection day. Check how they're feeling today.`,
      side_effect_nausea: `${base} They reported nausea. Check if it's improving and offer practical tips (ginger tea, crackers, small sips).`,
      side_effect_fatigue: `${base} They reported fatigue. Check on their energy and remind about food + hydration.`,
      side_effect_constipation: `${base} They reported constipation. Check on it and mention fiber + water.`,
      welcome: `${base} This is their very first message. Welcome them to Grace. Mention their goal: ${goal} and their medication: ${user.medication ?? 'GLP-1'}. Be warm and human.`,
    };

    return instructions[type] + (extra ? `\n\nExtra context: ${extra}` : '');
  }
}
