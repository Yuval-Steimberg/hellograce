// Scope Guard — blocks off-topic questions BEFORE any memory retrieval,
// context summarization, or LLM generation. Sends a short canned boundary
// response so Grace never dumps stored personal memory into a refusal.
//
// Production bug this fixes (2026-05-29):
//   User: "Will Trump attack Iran?"
//   Grace: "I know you're and you're on Ozempic, working towards your weight
//          loss goals and focusing on getting enough protein…"
// → Reveals memory retrieval, feels creepy, breaks trust.
//
// Correct behavior:
//   User: "Will Trump attack Iran?"
//   Grace: "That's outside my area of support — I'm here for your GLP-1
//          journey, nutrition, symptoms, and progress."
//
// Style:
//   - Deterministic regex matching (no LLM call, ~1ms latency)
//   - Negation-aware ("I gave up on politics" → not blocked)
//   - Health-context-aware ("how does Ozempic affect my politics" → not blocked,
//     the health anchor wins)
//   - Varied response templates (deterministic hash → stable per user/message
//     but not robotically identical across users)

export type ScopeCategory =
  | 'politics'
  | 'war_violence'
  | 'finance'
  | 'legal'
  | 'tech_coding'
  | 'entertainment_sports'
  | 'religion'
  | 'science_trivia'
  | 'sexual'
  | 'dangerous'
  | 'news_general';

export interface ScopeCheck {
  blocked: boolean;
  category?: ScopeCategory;
  matched?: string;
  response?: string;
}

// ── Health/scope-anchor terms ───────────────────────────────────────────────
// If ANY of these appear in the message AS A WHOLE WORD, scope check is
// SKIPPED — Grace's in-scope work takes precedence. Word boundaries prevent
// false positives like "latest" matching the anchor "ate".
const IN_SCOPE_ANCHOR_RE = new RegExp(
  '\\b(' + [
    // Medications
    'ozempic', 'wegovy', 'mounjaro', 'zepbound', 'semaglutide', 'tirzepatide',
    'rybelsus', 'glp[\\s-]?1', 'injection', 'shot', 'jab', 'dose', 'medication',
    // Body / food / habit
    'weight', 'protein', 'calorie', 'calories', 'kcal', 'food', 'meal', 'snack',
    'breakfast', 'lunch', 'dinner', 'eat', 'eating', 'ate', 'hungry', 'appetite',
    'water', 'hydrat\\w*', 'sleep', 'exercise', 'workout', 'walk', 'steps',
    // Symptoms
    'nausea', 'nauseous', 'constipat\\w*', 'diarrhea', 'fatigue', 'tired', 'dizzy',
    'headache', 'cramp', 'bloat\\w*', 'reflux', 'stomach', 'belly', 'gas',
    // Mood / journey
    'mood', 'anxious', 'depress\\w*', 'lonely', 'frustrat\\w*', 'plateau', 'progress',
    'goal', 'goals', 'journey', 'check[\\s-]?in', 'check[\\s-]?ins',
  ].join('|') + ')\\b',
  'i',
);

function hasInScopeAnchor(lower: string): boolean {
  return IN_SCOPE_ANCHOR_RE.test(lower);
}

// ── Out-of-scope category patterns ──────────────────────────────────────────
// Each pattern is a strong, unambiguous signal that the user is asking about
// something outside Grace's lane. Patterns require either a question shape
// ("will X", "who is", "what's the", "how do I") or topic-defining nouns
// (election, war, stock, code, bible). Bare keywords alone are NOT enough —
// "Trump" or "stock" in passing isn't reason to refuse.

interface ScopePattern {
  category: ScopeCategory;
  patterns: RegExp[];
}

// Order matters: more specific categories first. "Will Trump attack Iran?"
// hits BOTH politics (trump) and war_violence (attack iran) — war_violence
// wins because it's checked first.
const SCOPE_PATTERNS: ScopePattern[] = [
  {
    category: 'war_violence',
    patterns: [
      /\b(will|would|is|are|did|should|can)\s+\w+\s+(attack|invade|bomb|strike|nuke)\s+\w+/i,
      /\b(war|invasion|airstrike|missile|drone\s+strike|ceasefire|hostages?|terrorist|terrorism)\b.*\?/i,
      /\b(israel|palestine|gaza|ukraine|russia|iran|iraq|syria|afghanistan|taiwan|china|north\s+korea)\b.*\b(war|attack|invade|conflict|missile|bomb|strike|nuke)\b/i,
      /\b(who('s|\s+is)\s+(winning|losing)\s+the\s+war|when\s+will\s+the\s+war\s+end)\b/i,
    ],
  },
  {
    category: 'politics',
    patterns: [
      // Named political figures + question/opinion shape
      /\b(trump|biden|harris|obama|putin|xi\s+jinping|netanyahu|zelensky|macron|merkel|modi|erdogan)\b.*\?/i,
      /\b(who|what|will|did|should|why|when|where).*\b(trump|biden|harris|obama|putin|netanyahu|zelensky|election|elections|president|prime\s+minister|congress|senate|parliament|democrat|democrats|republican|republicans|liberal|liberals|conservative|conservatives|left[\s-]?wing|right[\s-]?wing)\b/i,
      // Elections + outcomes
      /\b(election|elections)\b.*\b(win|winning|won|lose|losing|lost|result|results|outcome|polls?)\b/i,
      /\bwho\s+(will|should|did|gonna)\s+win\b/i,
      // Political opinion solicitation
      /\bwhat\s+do\s+you\s+(think|feel)\s+about\s+(trump|biden|harris|obama|putin|the\s+election|the\s+president|democrats|republicans|liberals|conservatives)\b/i,
      /\b(politics|political\s+(views?|opinions?|stances?|parties|party|leanings?))\b/i,
      /\bwhat\s+are\s+your\s+political\b/i,
    ],
  },
  {
    category: 'finance',
    patterns: [
      /\b(what|which|should\s+i)\s+(stock|stocks|crypto|coin|coins|nft|nfts|etf|index\s+fund|mutual\s+fund|bond|bonds|asset|investment|investments)\b.*\b(buy|invest|sell|short|hold)\b/i,
      /\b(buy|invest\s+in|sell)\s+(stock|stocks|crypto|bitcoin|btc|eth|ethereum|dogecoin|tesla|nvda|aapl|spy|qqq)\b/i,
      /\bwill\s+(bitcoin|btc|ethereum|eth|tesla|nvidia|the\s+(stock\s+)?market|the\s+s&p|the\s+nasdaq|gold|oil)\s+(go\s+up|go\s+down|crash|rally|moon|dump|rise|fall)\b/i,
      /\b(financial|investment|trading)\s+advice\b/i,
      /\bhow\s+do\s+i\s+(get\s+rich|make\s+money|trade\s+(stocks|crypto|options|forex))\b/i,
    ],
  },
  {
    category: 'legal',
    patterns: [
      /\b(can|should)\s+i\s+sue\b/i,
      /\b(legal\s+advice|lawyer|attorney|lawsuit|file\s+a\s+(claim|case|suit)|court\s+case)\b.*\?/i,
      /\bis\s+it\s+(legal|illegal)\s+to\b/i,
      /\bwhat('s|\s+is|\s+are)\s+(my\s+(rights|legal\s+rights)|the\s+law\s+on)\b/i,
    ],
  },
  {
    category: 'tech_coding',
    patterns: [
      // "write me a Python script", "debug this function", "fix the code"
      /\b(write|generate|debug|fix|review)\b(?:\s+\w+){0,4}\s+(code|script|function|program|app|class|module)\b/i,
      /\bhow\s+(do|to)\s+i?\s*(code|program|debug|hack|crack|exploit|jailbreak|bypass)\b/i,
      /\b(in|using)\s+(python|javascript|typescript|java|c\+\+|rust|golang|ruby|php)\b.*\?/i,
      /\b(sql\s+query|regex|api\s+endpoint|docker\s+container|kubernetes|aws\s+lambda|node\.?js|react)\b/i,
      /\bhow\s+do\s+i\s+hack\b/i,
    ],
  },
  {
    category: 'entertainment_sports',
    patterns: [
      /\bwho\s+(won|will\s+win|is\s+winning)\s+the\s+(super\s+bowl|world\s+cup|nba|nfl|mlb|nhl|olympics?|world\s+series|champions\s+league|wimbledon|us\s+open|masters)\b/i,
      /\bwhat('s|\s+is)\s+the\s+(score|result)\s+of\b/i,
      /\b(movie|film|show|series|netflix|disney\+|hbo)\s+(recommend|recommendation|suggest|suggestion)/i,
      // "what should I watch tonight" / "what movie should I watch"
      /\bwhat\s+(?:\w+\s+)?should\s+i\s+(watch|stream|listen\s+to)\b/i,
      /\b(taylor\s+swift|kanye|kardashian|drake|beyonce|rihanna)\b.*\?/i,
    ],
  },
  {
    category: 'religion',
    patterns: [
      /\b(what\s+does\s+the\s+(bible|quran|torah|gita)\s+say|is\s+there\s+a\s+god|does\s+god\s+exist|is\s+(jesus|allah|buddha)\s+real)\b/i,
      /\b(which\s+religion|true\s+religion|right\s+religion|best\s+religion)\b/i,
      /\b(pray\s+for\s+me|will\s+i\s+go\s+to\s+(heaven|hell))\b/i,
    ],
  },
  {
    category: 'sexual',
    patterns: [
      /\b(sexting|sext\s+me|talk\s+dirty|nude|nudes|naked\s+pic|porn|pornography|erotic|kinky|fetish|orgasm)\b/i,
      /\bdescribe.*\b(sex|sexual|naked|nude)\b/i,
    ],
  },
  {
    category: 'dangerous',
    patterns: [
      /\bhow\s+(do|to)\s+i?\s*(make|build|create|synthesize)\s+(a\s+)?(bomb|explosive|gun|weapon|poison|meth|cocaine|heroin|fentanyl|lsd)\b/i,
      /\bhow\s+(do|to)\s+i?\s*(kill|murder|harm|hurt)\s+(someone|a\s+person|him|her|them)\b/i,
      /\bhow\s+(do|to)\s+i?\s*(buy|get|acquire)\s+(illegal|street)\s+(drugs|weapons|guns)\b/i,
    ],
  },
  {
    category: 'news_general',
    patterns: [
      /\bwhat('s|\s+is)\s+(happening|going\s+on|in\s+the\s+news)\s+(in|with)\b/i,
      /\b(latest\s+news|breaking\s+news|news\s+update|current\s+events)\b/i,
      /\bwhat\s+do\s+you\s+think\s+(about|of)\s+the\s+(news|current\s+(situation|event))/i,
    ],
  },
];

// ── Negation guard ──────────────────────────────────────────────────────────
// "I gave up on politics" / "I don't follow the news" / "I don't care about
// the election" — user is mentioning the topic to dismiss it, not asking. Skip.
const DISMISSAL_RE = /\b(don'?t\s+(care|follow|watch|read|want\s+to\s+talk|want\s+to\s+hear)|gave\s+up\s+on|tired\s+of|sick\s+of|hate)\b/i;

// ── Response templates ─────────────────────────────────────────────────────
// Per spec: ONE response, short, calm, professional. NEVER mention memory.
// Five templates rotated by stable hash so it doesn't sound robotic across
// repeated off-topic messages from the same user.
const RESPONSES: readonly string[] = [
  "That's outside what I can help with — I'm here for your GLP-1 journey, nutrition, symptoms, and progress.",
  "Not my area, but I can help with food, protein, medication, symptoms, or how you're feeling.",
  "I'm focused on your health journey. Want to talk through anything around food, symptoms, or your goals?",
  "That's outside my scope. I can help with your medication, nutrition, sleep, or how today's going.",
  "I'll leave that one to the experts. What I can help with: your protein, weight, symptoms, or anything about your journey.",
] as const;

function pickResponse(text: string): string {
  // Stable hash of the inbound text → same off-topic message always gets the
  // same template for the same user. Across users the choice still varies.
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % RESPONSES.length;
  return RESPONSES[idx]!;
}

/**
 * Classify whether the inbound message is out-of-scope for Grace.
 *
 * Decision order:
 *  1. If an in-scope health anchor word appears → NOT blocked (Grace handles it normally)
 *  2. If a dismissal phrase appears ("I don't follow politics") → NOT blocked
 *  3. If any off-topic pattern matches → blocked with that category
 *  4. Otherwise → NOT blocked
 */
export function classifyScope(text: string): ScopeCheck {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return { blocked: false };

  // Rule 1: any health anchor word → defer to normal pipeline.
  if (hasInScopeAnchor(lower)) return { blocked: false };

  // Rule 2: dismissal phrase → user isn't asking, just venting. Defer.
  if (DISMISSAL_RE.test(lower)) return { blocked: false };

  // Rule 3: scan all off-topic patterns.
  for (const group of SCOPE_PATTERNS) {
    for (const re of group.patterns) {
      const m = re.exec(text);
      if (m) {
        return {
          blocked: true,
          category: group.category,
          matched: m[0],
          response: pickResponse(text),
        };
      }
    }
  }

  return { blocked: false };
}
