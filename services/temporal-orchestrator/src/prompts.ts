/**
 * Prompt builders for medication lifecycle messages.
 * Separated so clinical content can be updated without touching orchestration logic.
 */

interface UserContext {
  first_name: string | null;
  medication_type: string | null;
  injection_count: number;
  glp1_start_date: Date | null;
  goals: string[];
}

export function buildDay2Prompt(user: UserContext): string {
  const name = user.first_name ? `The user's name is ${user.first_name}.` : '';
  const injCount = user.injection_count > 0 ? `This is injection #${user.injection_count}.` : '';
  const glp1Weeks = user.glp1_start_date
    ? `They started GLP-1 therapy ${Math.floor((Date.now() - user.glp1_start_date.getTime()) / (7 * 24 * 3600 * 1000))} weeks ago.`
    : '';
  const goal = user.goals[0] ? `Primary goal: ${user.goals[0]}.` : '';

  return `Context: ${name} ${injCount} ${glp1Weeks} ${goal}

It is Day 2 after their weekly GLP-1 injection — peak serum concentration window.
This is when nausea, fatigue, and reduced appetite are most common.

Write a short, warm check-in message (1–2 sentences) that:
- Gently acknowledges they may be feeling some effects today
- Asks how they're doing (one direct question)
- Does NOT mention "peak" or "serum" or any clinical term
- Does NOT give medical advice or suggest dose changes
- Does NOT use their name as the first word
`.trim();
}

export function buildDay6Prompt(user: UserContext): string {
  const name = user.first_name ? `The user's name is ${user.first_name}.` : '';
  const injCount = user.injection_count > 0 ? `This is injection #${user.injection_count}.` : '';
  const glp1Weeks = user.glp1_start_date
    ? `They started GLP-1 therapy ${Math.floor((Date.now() - user.glp1_start_date.getTime()) / (7 * 24 * 3600 * 1000))} weeks ago.`
    : '';
  const goal = user.goals[0] ? `Primary goal: ${user.goals[0]}.` : '';

  return `Context: ${name} ${injCount} ${glp1Weeks} ${goal}

It is Day 6 after their weekly GLP-1 injection — the end-of-cycle trough phase.
Medication levels are at their lowest. Hunger, energy dips, or mood changes may be returning.
Their next injection is tomorrow.

Write a short, warm check-in message (1–2 sentences) that:
- Acknowledges this can be a trickier day in the cycle (without clinical language)
- Either asks about hunger/energy OR gives a small encouraging nudge
- Does NOT mention "trough" or "half-life" or injection timing explicitly
- Does NOT use their name as the first word
- Ends with a period or question mark (not an em dash)
`.trim();
}
