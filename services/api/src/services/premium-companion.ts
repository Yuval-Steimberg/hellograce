export type PremiumAccess = 'free' | 'trial' | 'plus' | 'pro';

export interface PremiumCompanionInput {
  isPaid: boolean;
  isPro: boolean;
  trialStart: Date | string | null;
  medication: string | null;
  doseMg: number | null;
  injectionDay: string | null;
  proteinToday: number;
  proteinGoal: number | null;
  caloriesToday: number;
  waterTodayOz: number;
  daysProteinLogged: number;
  avgProtein: number | null;
  weightDeltaLbs: number | null;
  weeklyInsight: string | null;
  dislikes: string[];
  symptoms: Array<{
    symptom: string;
    count: number;
    typicalTiming: string | null;
    topRemedy: string | null;
  }>;
  now?: Date;
}

export interface PremiumCompanion {
  access: PremiumAccess;
  unlocked: boolean;
  upgradePath: string | null;
  weeklyReport: {
    headline: string;
    highlights: string[];
    focus: string;
  } | null;
  injectionInsight: {
    title: string;
    body: string;
    nextStep: string;
  } | null;
  dailyPlan: {
    breakfast: string;
    lunch: string;
    snack: string;
    dinner: string;
    hydration: string;
    movement: string;
  } | null;
  doctorReport: string | null;
  preview: string;
}

const TRIAL_MS = 3 * 24 * 60 * 60 * 1000;

export function premiumAccess(input: Pick<PremiumCompanionInput, 'isPaid' | 'isPro' | 'trialStart' | 'now'>): PremiumAccess {
  if (input.isPro) return 'pro';
  if (input.isPaid) return 'plus';
  if (input.trialStart) {
    const started = new Date(input.trialStart).getTime();
    if (Number.isFinite(started) && (input.now ?? new Date()).getTime() - started < TRIAL_MS) return 'trial';
  }
  return 'free';
}

function avoid(dislikes: string[], food: string): boolean {
  const f = food.toLowerCase();
  return dislikes.some((d) => f.includes(d.toLowerCase()) || d.toLowerCase().includes(f));
}

function foodChoice(dislikes: string[], choices: string[]): string {
  return choices.find((c) => !avoid(dislikes, c)) ?? choices[0]!;
}

export function buildPremiumCompanion(input: PremiumCompanionInput): PremiumCompanion {
  const access = premiumAccess(input);
  const unlocked = access === 'plus' || access === 'pro';
  const preview = input.weeklyInsight
    ?? (input.daysProteinLogged > 0
      ? `Grace found ${input.daysProteinLogged} logged nutrition day${input.daysProteinLogged === 1 ? '' : 's'} this week and can turn them into a personal weekly plan.`
      : 'Keep logging meals, hydration, weight, and symptoms so Grace can build your personal weekly pattern.');

  if (!unlocked) {
    return {
      access,
      unlocked: false,
      upgradePath: '/upgrade',
      weeklyReport: null,
      injectionInsight: null,
      dailyPlan: null,
      doctorReport: null,
      preview,
    };
  }

  const proteinLeft = input.proteinGoal == null
    ? null
    : Math.max(0, Math.round(input.proteinGoal - input.proteinToday));
  const topSymptom = input.symptoms[0] ?? null;
  const weightLine = input.weightDeltaLbs == null
    ? 'No complete weight trend yet'
    : input.weightDeltaLbs < 0
      ? `Weight moved down ${Math.abs(input.weightDeltaLbs)} lb`
      : input.weightDeltaLbs > 0
        ? `Weight moved up ${input.weightDeltaLbs} lb`
        : 'Weight held steady';

  const breakfast = foodChoice(input.dislikes, [
    'Greek yogurt with berries and nuts',
    'eggs with whole-grain toast',
    'a protein smoothie with fruit',
  ]);
  const lunchProtein = foodChoice(input.dislikes, ['grilled chicken', 'tofu', 'salmon']);
  const dinnerProtein = foodChoice(input.dislikes, ['baked salmon', 'turkey meatballs', 'lentils']);
  const snack = foodChoice(input.dislikes, ['a protein shake', 'edamame', 'a hard-boiled egg']);

  const symptomDetail = topSymptom
    ? `${topSymptom.symptom} has appeared ${topSymptom.count} time${topSymptom.count === 1 ? '' : 's'}${topSymptom.typicalTiming ? `, usually ${topSymptom.typicalTiming}` : ''}${topSymptom.topRemedy ? `; ${topSymptom.topRemedy} has helped before` : ''}.`
    : 'No repeat symptom pattern is established yet.';

  const medication = input.medication ?? 'GLP-1';
  const dose = input.doseMg != null ? ` ${input.doseMg} mg` : '';
  const injection = input.injectionDay ? `${input.injectionDay} injection` : 'injection day';

  return {
    access,
    unlocked: true,
    upgradePath: null,
    weeklyReport: {
      headline: input.weeklyInsight ?? 'Your first personal pattern is taking shape.',
      highlights: [
        `${input.daysProteinLogged} nutrition day${input.daysProteinLogged === 1 ? '' : 's'} logged`,
        input.avgProtein == null ? 'Protein average needs more logged days' : `${input.avgProtein}g average protein on logged days`,
        weightLine,
        symptomDetail,
      ],
      focus: proteinLeft == null
        ? 'No personal protein target is saved yet; focus on including a protein source at each meal.'
        : proteinLeft > 0
        ? `Today, spread the remaining ${proteinLeft}g of protein across your next meal and snack.`
        : 'Today, maintain steady fluids and choose the foods that have been easiest on your stomach.',
    },
    injectionInsight: {
      title: `${medication}${dose} · ${injection}`,
      body: symptomDetail,
      nextStep: topSymptom
        ? 'Use smaller meals and steady fluids around the timing when this usually appears. Seek medical help for severe or rapidly worsening symptoms.'
        : 'Log how you feel for the next few injection cycles so Grace can identify your personal timing and what helps.',
    },
    dailyPlan: {
      breakfast,
      lunch: `${lunchProtein} with rice or potatoes and cooked vegetables`,
      snack,
      dinner: `${dinnerProtein} with a small starch and roasted vegetables`,
      hydration: `You have logged ${Math.round(input.waterTodayOz)} oz today. Sip regularly between meals rather than drinking a large amount at once.`,
      movement: 'If you feel well, take a gentle 10–20 minute walk after a meal; keep it light if nausea or dizziness is active.',
    },
    doctorReport: [
      `Medication: ${medication}${dose}; ${injection}.`,
      `This week: ${input.daysProteinLogged} nutrition days logged${input.avgProtein == null ? '' : `, averaging ${input.avgProtein}g protein`}.`,
      `${weightLine}.`,
      `Current day: ${Math.round(input.proteinToday)}g protein, ${Math.round(input.caloriesToday)} calories, ${Math.round(input.waterTodayOz)} oz fluids.`,
      `Symptom pattern: ${symptomDetail}`,
      'Questions to discuss: whether the symptom timing is expected, what warning signs should trigger a call, and whether the current nutrition and hydration targets fit the treatment plan.',
    ].join('\n'),
    preview,
  };
}
