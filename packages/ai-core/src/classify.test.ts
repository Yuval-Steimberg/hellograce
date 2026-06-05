import { describe, it, expect } from 'vitest';
import { classifyMessage } from './classify.js';

describe('classifyMessage — appointment_prep (session 3 production fix)', () => {
  it('matches "I have my endo appointment. Help me write my questions" (cross-sentence)', () => {
    // This was the exact production failure from session 3: trigger phrase
    // and appointment word were in different sentences, so the same-sentence
    // patterns didn't bridge them.
    const result = classifyMessage('I have my endocrinologist appointment next week. Help me write my questions');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches same-sentence variant', () => {
    const result = classifyMessage('Help me write my questions for my endocrinologist appointment');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches reversed order (appointment first, then help)', () => {
    const result = classifyMessage('My doctor visit is next week. I want help preparing the questions');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches standalone "help me write my questions" without appointment context', () => {
    // The standalone trigger fires too — "write my questions" is unambiguous.
    const result = classifyMessage('help me write my questions');
    expect(result.type).toBe('appointment_prep');
  });

  it('matches "prepare me to the appointment"', () => {
    const result = classifyMessage('prepare me to the appointment');
    expect(result.type).toBe('appointment_prep');
  });

  it('does NOT match unrelated messages with the word "questions"', () => {
    const result = classifyMessage('I have so many questions about my new puppy');
    expect(result.type).not.toBe('appointment_prep');
  });

  it('does NOT match "what should I eat tonight?"', () => {
    const result = classifyMessage('what should I eat tonight?');
    expect(result.type).not.toBe('appointment_prep');
  });
});

describe('classifyMessage — food_question patterns (2026-05-31 production fix)', () => {
  it('matches "How did I reached 40 g of protein?" (exact production failure)', () => {
    const result = classifyMessage('How did I reached 40 g of protein?');
    expect(result.type).toBe('food_question');
  });

  it('matches "How did I get to 80g of protein?"', () => {
    const result = classifyMessage('How did I get to 80g of protein?');
    expect(result.type).toBe('food_question');
  });

  it('matches "what foods did I eat today?"', () => {
    const result = classifyMessage('what foods did I eat today?');
    expect(result.type).toBe('food_question');
  });

  it('matches "show me what I logged today"', () => {
    const result = classifyMessage('show me what I logged today');
    expect(result.type).toBe('food_question');
  });

  it('matches "break down my protein today"', () => {
    const result = classifyMessage('break down my protein today');
    expect(result.type).toBe('food_question');
  });

  it('matches "where is the extra protein coming from?"', () => {
    const result = classifyMessage('where is the extra protein coming from?');
    expect(result.type).toBe('food_question');
  });

  it('matches "how am I doing on protein?"', () => {
    expect(classifyMessage('how am I doing on protein?').type).toBe('food_question');
  });

  it('matches "protein update?"', () => {
    expect(classifyMessage('protein update?').type).toBe('food_question');
  });

  it('matches "am I close to my protein target?"', () => {
    expect(classifyMessage('am I close to my protein target?').type).toBe('food_question');
  });

  it('matches "if I eat eggs will I hit my protein goal?"', () => {
    expect(classifyMessage('if I eat eggs will I hit my protein goal?').type).toBe('food_question');
  });

  it('matches "will eating a protein shake hit my target?"', () => {
    expect(classifyMessage('will eating a protein shake hit my target?').type).toBe('food_question');
  });
});

describe('classifyMessage — past-day / history queries (protein audit)', () => {
  it('matches "what was my protein yesterday?"', () => {
    expect(classifyMessage('what was my protein yesterday?').type).toBe('food_question');
  });

  it('matches "how much protein did I have yesterday?"', () => {
    expect(classifyMessage('how much protein did I have yesterday?').type).toBe('food_question');
  });

  it('matches "show me my protein history for the last 7 days"', () => {
    expect(classifyMessage('show me my protein history for the last 7 days').type).toBe('food_question');
  });

  it('matches "have I been hitting my protein goal this week?"', () => {
    expect(classifyMessage('have I been hitting my protein goal this week?').type).toBe('food_question');
  });

  it('matches "this week\'s protein average?"', () => {
    expect(classifyMessage("this week's protein average?").type).toBe('food_question');
  });
});

describe('classifyMessage — target/goal explanation queries (protein audit)', () => {
  it('matches "why is my protein target 60g?"', () => {
    expect(classifyMessage('why is my protein target 60g?').type).toBe('food_question');
  });

  it('matches "how was my protein goal calculated?"', () => {
    expect(classifyMessage('how was my protein goal calculated?').type).toBe('food_question');
  });

  it('matches "what\'s my protein target?"', () => {
    expect(classifyMessage("what's my protein target?").type).toBe('food_question');
  });

  it('matches "is 60g of protein enough?"', () => {
    expect(classifyMessage('is 60g of protein enough?').type).toBe('food_question');
  });

  it('matches "how much protein should I eat per day?"', () => {
    expect(classifyMessage('how much protein should I eat per day?').type).toBe('food_question');
  });
});

describe('classifyMessage — food removal / correction queries (protein audit)', () => {
  it('matches "remove the eggs"', () => {
    expect(classifyMessage('remove the eggs').type).toBe('food_question');
  });

  it('matches "delete my last food log"', () => {
    expect(classifyMessage('delete my last food log').type).toBe('food_question');
  });

  it('matches "I didn\'t eat that"', () => {
    expect(classifyMessage("I didn't eat that").type).toBe('food_question');
  });

  it('matches "actually it was 3 eggs"', () => {
    expect(classifyMessage('actually it was 3 eggs').type).toBe('food_question');
  });

  it('matches "that\'s wrong"', () => {
    expect(classifyMessage("that's wrong").type).toBe('food_question');
  });
});

describe('classifyMessage — exercise_log (Phase 1 coverage expansion)', () => {
  it('matches "I just worked out"', () => {
    expect(classifyMessage('I just worked out').type).toBe('exercise_log');
  });

  it('matches "did 30 mins of cardio"', () => {
    expect(classifyMessage('did 30 mins of cardio').type).toBe('exercise_log');
  });

  it('matches "ran 5k this morning"', () => {
    expect(classifyMessage('ran 5k this morning').type).toBe('exercise_log');
  });

  it('matches "hit the gym for legs day"', () => {
    expect(classifyMessage('hit the gym for legs day').type).toBe('exercise_log');
  });

  it('matches "got 10k steps"', () => {
    expect(classifyMessage('got 10k steps').type).toBe('exercise_log');
  });
});

describe('classifyMessage — injection_log (Phase 1 coverage expansion)', () => {
  it('matches "took my shot"', () => {
    expect(classifyMessage('took my shot').type).toBe('injection_log');
  });

  it('matches "just injected"', () => {
    expect(classifyMessage('just injected').type).toBe('injection_log');
  });

  it('matches "did my weekly injection"', () => {
    expect(classifyMessage('did my weekly injection').type).toBe('injection_log');
  });

  it('matches "shot is done"', () => {
    expect(classifyMessage('shot is done').type).toBe('injection_log');
  });
});

describe('classifyMessage — medication_question (Phase 1 coverage expansion)', () => {
  it('matches "when should I take my shot?"', () => {
    expect(classifyMessage('when should I take my shot?').type).toBe('medication_question');
  });

  it('matches "can I change my injection day?"', () => {
    expect(classifyMessage('can I change my injection day?').type).toBe('medication_question');
  });

  it('matches "how do I store my pen?"', () => {
    expect(classifyMessage('how do I store my pen?').type).toBe('medication_question');
  });

  it('matches "can I travel with my injection?"', () => {
    expect(classifyMessage('can I travel with my injection?').type).toBe('medication_question');
  });

  it('matches "switching from Ozempic to Mounjaro"', () => {
    expect(classifyMessage('switching from Ozempic to Mounjaro').type).toBe('medication_question');
  });
});

describe('classifyMessage — social_situation (Phase 1 coverage expansion)', () => {
  it('matches "I have a wedding this weekend"', () => {
    expect(classifyMessage('I have a wedding this weekend').type).toBe('social_situation');
  });

  it('matches "going out to a restaurant tonight"', () => {
    expect(classifyMessage('going out to a restaurant tonight').type).toBe('social_situation');
  });

  it('matches "how do I handle a buffet?"', () => {
    expect(classifyMessage('how do I handle a buffet?').type).toBe('social_situation');
  });

  it('matches "going on vacation next week"', () => {
    expect(classifyMessage('going on vacation next week').type).toBe('social_situation');
  });

  it('matches "my family doesn\'t know I\'m on Ozempic"', () => {
    expect(classifyMessage("my family doesn't know I'm on Ozempic").type).toBe('social_situation');
  });
});

describe('classifyMessage — pause_request (Phase 1 coverage expansion)', () => {
  it('matches "pause"', () => {
    expect(classifyMessage('pause').type).toBe('pause_request');
  });

  it('matches "stop sending messages"', () => {
    expect(classifyMessage('stop sending messages').type).toBe('pause_request');
  });

  it('matches "I need a break"', () => {
    expect(classifyMessage('I need a break').type).toBe('pause_request');
  });

  it('matches "don\'t text me for a week"', () => {
    expect(classifyMessage("don't text me for a week").type).toBe('pause_request');
  });
});

describe('classifyMessage — questions are never food_log (2026-06-05 fix)', () => {
  // Auto-eval / coverage corpus surfaced 4 distinct production failures where
  // the classifier routed questions into food_log because food verbs +
  // quantity patterns matched FOOD_LOG. The forced log_food tool call then
  // hallucinated macros for non-food content. Rule: '?' → never food_log.

  it('routes "Why does protein matter so much on GLP-1s? Everyone says aim for 100g but I can barely eat 50g a day" to knowledge', () => {
    const result = classifyMessage(
      "Why does protein matter so much on GLP-1s? Everyone says aim for 100g but I can barely eat 50g a day with the appetite suppression.",
    );
    expect(result.type).toBe('knowledge');
  });

  it('routes "Got my first injection yesterday and woke up with terrible heartburn at 3am. Is this a side effect?" to knowledge', () => {
    const result = classifyMessage(
      "Got my first injection yesterday and woke up with terrible heartburn at 3am. Is this a side effect?",
    );
    expect(result.type).toBe('knowledge');
  });

  it('routes "I take Rybelsus daily. Today I drank coffee 20 minutes after my pill. Did I just waste my dose?" to knowledge', () => {
    const result = classifyMessage(
      "I take Rybelsus daily. Today I drank coffee 20 minutes after my pill. Did I just waste my dose?",
    );
    expect(result.type).toBe('knowledge');
  });

  it('still routes "I just ate 2 eggs" to food_log (declarative — no question mark)', () => {
    const result = classifyMessage("I just ate 2 eggs");
    expect(result.type).toBe('food_log');
  });

  it('still routes "Lunch: chicken salad with rice" to food_log (declarative)', () => {
    const result = classifyMessage("Lunch: chicken salad with rice");
    expect(result.type).toBe('food_log');
  });

  it('"Did I have eggs today?" is NEVER classified as food_log (the key invariant)', () => {
    // Has '?' so the new rule prevents food_log routing. Whatever it falls
    // through to (food_question / general / knowledge) is fine — the goal
    // here is "never log a question as a food log".
    const result = classifyMessage("Did I have eggs today?");
    expect(result.type).not.toBe('food_log');
  });
});
