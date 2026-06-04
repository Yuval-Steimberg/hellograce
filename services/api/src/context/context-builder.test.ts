import { describe, it, expect } from 'vitest';
import { __testing } from './context-builder.js';

const {
  buildUserProfile,
  buildMemoryContext,
  buildNutritionContext,
  buildGoalsContext,
  buildConversationContext,
  buildIntentContext,
  buildScheduleContext,
  computeWeekNumber,
  computeTrialDay,
  parsePrimaryGoal,
} = __testing;

describe('ContextBuilder — pure builders', () => {
  describe('computeWeekNumber', () => {
    it('returns null when start date is null', () => {
      expect(computeWeekNumber(null)).toBeNull();
    });

    it('returns week 1 on the start date', () => {
      expect(computeWeekNumber(new Date())).toBe(1);
    });

    it('returns week 8 after 7 weeks', () => {
      const weeksAgo = new Date(Date.now() - 7 * 7 * 24 * 60 * 60 * 1000);
      expect(computeWeekNumber(weeksAgo)).toBe(8);
    });

    it('returns null for a future start date', () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      expect(computeWeekNumber(future)).toBeNull();
    });
  });

  describe('computeTrialDay', () => {
    it('returns null if paid', () => {
      expect(computeTrialDay(new Date(), true)).toBeNull();
    });

    it('returns null if no trial start', () => {
      expect(computeTrialDay(null, false)).toBeNull();
    });

    it('returns day 1 on the start date', () => {
      expect(computeTrialDay(new Date(), false)).toBe(1);
    });

    it('returns null after day 3 (trial expired)', () => {
      const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
      expect(computeTrialDay(fourDaysAgo, false)).toBeNull();
    });

    it('returns day 2 mid-trial', () => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(computeTrialDay(oneDayAgo, false)).toBe(2);
    });
  });

  describe('parsePrimaryGoal', () => {
    it.each([
      ['fat loss', 'fat_loss'],
      ['Fat Loss', 'fat_loss'],
      ['recomp', 'recomp'],
      ['body recomposition', 'recomp'],
      ['maintenance', 'maintenance'],
      ['maintain weight', 'maintenance'],
      ['muscle gain', 'muscle_gain'],
      ['gain weight', 'muscle_gain'],
      ['something else', null],
      [null, null],
    ])('%s → %s', (input, expected) => {
      expect(parsePrimaryGoal(input)).toBe(expected);
    });
  });

  describe('buildUserProfile', () => {
    it('returns safe defaults when user is null', () => {
      const p = buildUserProfile(null);
      expect(p.firstName).toBeNull();
      expect(p.medicationType).toBe('unknown');
      expect(p.weekNumber).toBeNull();
      expect(p.foodDislikes).toEqual([]);
    });

    it('strips "I dont like" prefix from food dislikes', () => {
      const u = makeUser({
        food_dislikes: ['I dont like fish', 'avoid chicken', 'no broccoli', 'tomatoes'],
      });
      const p = buildUserProfile(u);
      expect(p.foodDislikes).toEqual(['fish', 'chicken', 'broccoli', 'tomatoes']);
    });

    it('computes weekNumber from glp1_start_date', () => {
      const u = makeUser({
        glp1_start_date: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000),
      });
      const p = buildUserProfile(u);
      expect(p.weekNumber).toBe(4);
    });

    it('classifies Ozempic as weekly_injection', () => {
      const u = makeUser({ medication: 'Ozempic 1mg' });
      expect(buildUserProfile(u).medicationType).toBe('weekly_injection');
    });

    it('classifies Rybelsus as daily_pill', () => {
      const u = makeUser({ medication: 'Rybelsus 7mg' });
      expect(buildUserProfile(u).medicationType).toBe('daily_pill');
    });
  });

  describe('buildNutritionContext', () => {
    it('rounds protein and calories', () => {
      const n = buildNutritionContext({
        protein_g: 48.7, calories: 1234.6, items: ['eggs', 'tuna'],
      });
      expect(n.proteinG).toBe(49);
      expect(n.calories).toBe(1235);
      expect(n.itemsLoggedToday).toEqual(['eggs', 'tuna']);
    });

    it('handles missing items_detailed', () => {
      const n = buildNutritionContext({ protein_g: 0, calories: 0, items: [] });
      expect(n.itemsDetailed).toEqual([]);
    });
  });

  describe('buildGoalsContext', () => {
    it('computes lbsToGo when current > goal', () => {
      const g = buildGoalsContext(makeUser({ current_weight: 200, goal_weight: 175 }));
      expect(g.lbsToGo).toBe(25);
    });

    it('returns null lbsToGo when at or below goal', () => {
      const g = buildGoalsContext(makeUser({ current_weight: 170, goal_weight: 175 }));
      expect(g.lbsToGo).toBeNull();
    });

    it('returns nulls when user is null', () => {
      const g = buildGoalsContext(null);
      expect(g.proteinTargetG).toBeNull();
      expect(g.lbsToGo).toBeNull();
      expect(g.primaryGoal).toBeNull();
    });
  });

  describe('buildConversationContext', () => {
    it('extracts last assistant message from history', () => {
      const c = buildConversationContext({
        activeTopic: null,
        responseMode: 'normal',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hey' },
          { role: 'user', content: 'how are you' },
          { role: 'assistant', content: 'good thanks' },
        ],
      });
      expect(c.lastAssistantMessage).toBe('good thanks');
    });

    it('finds the previous user message (the one before current)', () => {
      const c = buildConversationContext({
        activeTopic: null,
        responseMode: 'normal',
        history: [
          { role: 'user', content: 'first ask' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second ask' },
        ],
      });
      expect(c.previousUserMessage).toBe('first ask');
    });

    it('returns null lastAssistant when no assistant turn yet', () => {
      const c = buildConversationContext({
        activeTopic: null, responseMode: 'normal',
        history: [{ role: 'user', content: 'hi' }],
      });
      expect(c.lastAssistantMessage).toBeNull();
    });
  });

  describe('buildIntentContext', () => {
    it('classifies a food log', () => {
      const i = buildIntentContext({
        userMessage: 'I just ate two eggs',
        lastAssistantMessage: null,
      });
      expect(i.type).toBe('food_log');
      expect(i.isQuestion).toBe(false);
    });

    it('marks question messages', () => {
      const i = buildIntentContext({
        userMessage: "What's my protein goal?",
        lastAssistantMessage: null,
      });
      expect(i.isQuestion).toBe(true);
    });

    it('detects multi-part messages (two questions)', () => {
      const i = buildIntentContext({
        userMessage: "What's my goal? And how much protein have I had today?",
        lastAssistantMessage: null,
      });
      expect(i.isMultiPart).toBe(true);
    });

    it('detects reasoning request', () => {
      const i = buildIntentContext({
        userMessage: 'why?',
        lastAssistantMessage: 'Your protein goal is 120g.',
      });
      expect(i.isReasoningRequest).toBe(true);
    });
  });

  describe('buildMemoryContext', () => {
    it('computes hoursSinceLastReply correctly', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      const m = buildMemoryContext({
        relevantMemories: [], history: [], knownFacts: [],
        summary: null, isNewUser: false,
        lastReplyAt: twoHoursAgo,
      });
      expect(m.hoursSinceLastReply).toBeGreaterThanOrEqual(1.99);
      expect(m.hoursSinceLastReply).toBeLessThanOrEqual(2.01);
    });

    it('returns 0 hours when no last reply', () => {
      const m = buildMemoryContext({
        relevantMemories: [], history: [], knownFacts: [],
        summary: null, isNewUser: true, lastReplyAt: null,
      });
      expect(m.hoursSinceLastReply).toBe(0);
    });
  });

  describe('buildScheduleContext', () => {
    it('defaults to 2 check-ins per day when user is null', () => {
      const s = buildScheduleContext({ user: null, checkinsSentToday: 0 });
      expect(s.checkinsPerDay).toBe(2);
      expect(s.checkinsSentToday).toBe(0);
    });

    it('detects active injection flow stage', () => {
      const s = buildScheduleContext({
        user: makeUser({ injection_flow_stage: 'morning_sent' }),
        checkinsSentToday: 1,
      });
      expect(s.injectionFlowStage).toBe('morning_sent');
      expect(s.inSideEffectFlow).toBe(false);
    });

    it('detects active side-effect flow', () => {
      const s = buildScheduleContext({
        user: makeUser({ side_effect_flow: 'nausea' }),
        checkinsSentToday: 0,
      });
      expect(s.inSideEffectFlow).toBe(true);
    });
  });
});

// ── Test helpers ─────────────────────────────────────────────────────────

function makeUser(overrides: Partial<import('../user/user.service.js').GraceUser> = {}): import('../user/user.service.js').GraceUser {
  return {
    id: 'u1', phone: '+15551234567', first_name: 'Test',
    medication: 'Ozempic', medication_frequency: 'weekly',
    injection_day: 'Sunday', medication_time: '08:00',
    sms_consent: true, injection_count: 1, goals: [],
    food_dislikes: [], timezone: 'America/New_York',
    wake_time: '07:00', sleep_time: '23:00',
    current_weight: 200, goal_weight: 175, height_cm: 165, age: 45, sex: 'F',
    primary_goal: 'fat loss', protein_goal_grams: 120, calorie_goal_kcal: 1600,
    activity_level: 'light', dietary_pattern: null,
    protein_focus_boost: false, hydration_struggle: false,
    low_mood_mode: false, midday_skip: false,
    injection_flow_stage: null, injection_flow_started_at: null,
    injection_done_at: null, injection_side_effect_free: true,
    injection_evening_followup_due: false,
    side_effect_flow: null, side_effect_flow_started_at: null,
    side_effect_followup_sent: false,
    last_morning_sent_at: null, last_midday_sent_at: null, last_evening_sent_at: null,
    last_reply_at: null, messages_sent_today: 0, messages_sent_today_date: null,
    checkin_frequency: 'twice_daily', checkin_count_per_day: 2, checkin_days_interval: 1,
    glp1_start_date: null, grace_notes: null,
    active: true, paused: false, blocked: false,
    is_paid: false, is_pro: false, trial_start: null,
    rlhf_enabled: false,
    created_at: new Date(), updated_at: new Date(),
    dose_mg: 1, dietary_restriction: null, biggest_challenge: null,
    why_started: null, support_style: null, exercise_habits: null,
    ...overrides,
  };
}
