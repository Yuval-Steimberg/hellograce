import { normalizeUserText } from '@grace/ai-core';

// Fast-path responder for trivial messages — bypasses the full pipeline
// (no LLM call, no RAG, no tools, no guards). Used for greetings, brief
// positive feelings, brief acks, and simple thanks where a warm one-liner
// is both the best response and the right tradeoff for speed.
//
// 2026-05-30 latency pass: simple greetings were going through the full
// pipeline (~2-4s including coalesce + LLM). This brings them down to
// ~50-150ms (just Twilio send time + DB write).
//
// Safety: this fires ONLY on short, unambiguous messages. Anything that
// could reasonably need personalization, education, or tool use falls
// through to the normal pipeline.

export interface FastPathResult {
  text: string;
  category:
    | 'greeting'
    | 'brief_positive'
    | 'brief_negative'
    | 'brief_ack'
    | 'thanks'
    | 'goodnight'
    | 'farewell'
    | 'laughter'
    | 'apology'
    | 'reaction'
    | 'appreciation'
    | 'love_it'
    | 'denial'
    | 'confirmation'
    | 'identity'
    // 2026-06-05 — Phase B fast-path expansion. 8 more high-frequency
    // message shapes that today fall through to the orchestrator.
    | 'how_are_you'        // user asks Grace how she is
    | 'help_capabilities'  // "what can you do" / "help me"
    | 'presence_check'     // "are you there?" / "hello?"
    | 'reengagement'       // "I'm back" / "sorry been busy"
    | 'feeling_better'     // "feeling much better" / "way better today"
    | 'feeling_worse'      // "feeling worse" / "much worse today"
    | 'meal_skip'          // "skipped breakfast" / "didn't eat lunch"
    | 'check_in_query'     // "how am I doing" / "where am I at"
    // 2026-06-06 — Coverage audit. Non-English short messages get a warm
    // English-ask reply (no LLM, no translation). Distress keywords in the
    // supported scripts bypass this and reach the orchestrator + safety.
    | 'non_english';
}

// Pure greeting — no question, no follow-up content
const GREETING_RE = /^(hi|hey|hello|hii+|heyy+|helloo+|good\s+morning|good\s+afternoon|good\s+evening|morning|evening|hey\s+grace|hi\s+grace|hello\s+grace|sup|yo|howdy|whats?\s+up|whats?up|hiya)\s*[.!?]?\s*$/i;

// Brief positive feeling — e.g. "I'm feeling strong", "I'm good", "feeling great"
// Brief positive feeling — short emotional states that get a one-sentence
// warm acknowledgment per the prompt's BRIEF REPLY RULE. EXCLUDES "good X"
// where X is something specific (so "good night" goes through GOODNIGHT_RE).
// Must not contain a question mark, must be short. Negative feelings are
// excluded — they need real empathy, not a canned reply.
//
// Greeting prefix support: "morning, X" / "good morning, X" / "evening, X"
// optionally prefix the brief positive (production failure 2026-06-01: user
// said "Morning, felling good" → no fast-path match → full LLM pipeline
// generated a 6-sentence response that dredged up old context). We strip
// common greeting prefixes before matching the positive word.
//
// Typo tolerance: "felling" (instead of "feeling") and a few other common
// typos are accepted so the fast-path holds for noisy real messages.
const GREETING_PREFIX_RE = /^(good\s+)?(morning|afternoon|evening|night)\s*[,.\-]?\s+/i;
const FEELING_TYPO_RE = /\b(felling|feelign|feelin)\b/gi;

const BRIEF_POSITIVE_RE = /^(i'?m\s+)?(feeling\s+|doing\s+)?(strong|great|good|amazing|wonderful|fantastic|awesome|excellent|fine|okay|ok|alright|well|happy|grateful|blessed|energized|motivated|focused|positive|chill|calm|peaceful|content|relaxed|refreshed|hopeful|optimistic|proud)\s*[.!]?\s*$/i;

/** Normalize a brief message so the BRIEF_POSITIVE_RE can match common variants:
 *  - strip "morning," / "good morning," / "evening," prefixes
 *  - fix the "felling" / "feelign" typos for "feeling"
 *  - trim whitespace and trailing punctuation */
function normalizeBriefText(text: string): string {
  let t = text.trim();
  // Strip greeting prefix once
  t = t.replace(GREETING_PREFIX_RE, '');
  // Fix common feeling typos
  t = t.replace(FEELING_TYPO_RE, 'feeling');
  return t;
}

// Brief negative feeling — short emotional states that get a one-sentence
// warm acknowledgment per the prompt's BRIEF REPLY RULE. EXCLUDES medical
// states (nauseous, sick, dizzy, in pain) — those need real personalization
// + tool calls + medical guidance. Also excludes "hungry" / "no appetite"
// which need food suggestions.
const BRIEF_NEGATIVE_RE = /^(i'?m\s+)?(feeling\s+|been\s+|so\s+)?(tired|exhausted|drained|wiped|spent|done|knackered|rough|stressed|anxious|overwhelmed|frustrated|sad|down|low|blue|lonely|defeated|burned\s+out|burnt\s+out|meh|blah|off|not\s+great|not\s+good|not\s+okay|not\s+ok|rough\s+day|long\s+day|hard\s+day|tough\s+day|rough\s+night|terrible|awful|the\s+worst)\s*[.!]?\s*$/i;

// Brief ack — "ok", "got it", "noted", "cool"
const BRIEF_ACK_RE = /^(ok|okay|kk|k|got\s+it|noted|cool|sweet|solid|nice|alright|sure|will\s+do|sounds?\s+good|copy\s+that|gotcha|👍|👌|🤍|🧡|❤️|💛|💚|💙|💜)\s*[.!]?\s*$/i;

// Confirmation — short "yes" style
const CONFIRMATION_RE = /^(yes|yeah|yep|yup|absolutely|definitely|for\s+sure|of\s+course|certainly|right|exactly|true|correct|indeed|100%|💯)\s*[.!]?\s*$/i;

// Brief denial — short "no" style. No medical / contextual content.
const DENIAL_RE = /^(no|nope|nah|not\s+really|no\s+thanks|i'?m\s+good|i'?m\s+ok|i'?m\s+okay|i'?m\s+fine\s+thanks|no\s+thank\s+you)\s*[.!]?\s*$/i;

const THANKS_RE = /^(thanks|thank\s+you|thank\s+u|thx|ty|tysm|appreciate\s+it|appreciate\s+you|appreciate\s+that|thanks\s+so\s+much|thank\s+you\s+so\s+much|much\s+appreciated|🙏)\s*[.!]?\s*$/i;

// Goodnight / heading to bed
const GOODNIGHT_RE = /^(goodnight|good\s+night|night|nighty|nite|gn|nighty\s+night|sweet\s+dreams|heading\s+to\s+bed|going\s+to\s+bed|off\s+to\s+bed|going\s+to\s+sleep|going\s+to\s+rest|gotta\s+sleep|need\s+sleep|time\s+for\s+bed|bedtime)\s*[.!]?\s*$/i;

// General farewell (not necessarily bedtime)
const FAREWELL_RE = /^(bye|byee+|goodbye|see\s+you|see\s+ya|see\s+you\s+later|see\s+you\s+tomorrow|talk\s+later|talk\s+tomorrow|catch\s+you\s+later|ttyl|ttys|later|peace|cya|gtg|gotta\s+go|have\s+to\s+go|i'?ll\s+be\s+back|brb)\s*[.!]?\s*$/i;

// Laughter
const LAUGHTER_RE = /^(lol|lolol|lololol|haha+|hehe+|hahah+a*|lmao+|lmfao+|rofl|hah|heh|🤣|😂|😆|😅|😄|😹|😊\s*😂)\s*[.!]?\s*$/i;

// Apology
const APOLOGY_RE = /^(sorry|sry|i'?m\s+sorry|im\s+sorry|so\s+sorry|my\s+bad|my\s+apologies|apologies|sorry\s+about\s+that|sorry\s+about\s+it|oops|oof|mb)\s*[.!]?\s*$/i;

// Reaction — short non-question reactions like "wow", "omg", "hmm"
const REACTION_RE = /^(wow|woah|whoa|woww+|omg|oh\s+my|gosh|oh\s+gosh|huh|hmm+|interesting|oh|oh\s+wow|oh\s+okay|oh\s+ok|geez|sheesh|dang|damn|noted)\s*[.!]?\s*$/i;

// Appreciation — "you're the best", "love you", "you rock"
const APPRECIATION_RE = /^(love\s+you|love\s+ya|i\s+love\s+you|you'?re\s+the\s+best|you\s+rock|you'?re\s+amazing|you'?re\s+great|you'?re\s+awesome|youre\s+the\s+best|best\s+ever|amazing|you'?re\s+helpful|so\s+helpful)\s*[.!]?\s*$/i;

// Generic positive reaction to Grace's previous message
const LOVE_IT_RE = /^(love\s+it|love\s+that|love\s+this|like\s+it|like\s+that|that'?s\s+helpful|that'?s\s+great|that\s+helps|helpful|thats\s+great|that'?s\s+perfect|perfect)\s*[.!]?\s*$/i;

// ── 2026-06-05 Phase B additions ────────────────────────────────────────────

// User asks Grace how she is — meta question that today goes to orchestrator
// and gets a generic "I'm here to help" reply. Allows '?' as an exception.
const HOW_ARE_YOU_RE = /^(how\s+(are|r)\s+(you|u)|how'?s\s+(it\s+going|life|you|things|your\s+day)|hru|how\s+have\s+you\s+been|how\s+ya\s+doing|hows\s+everything|hows\s+it)\s*[?.!]?\s*$/i;

// "What can you do" / "help" / "what do you offer" — meta capability question.
const HELP_CAPABILITIES_RE = /^(help|help\s+me|what\s+(can|do)\s+you\s+do|what\s+do\s+you\s+offer|what\s+are\s+(you|your\s+features)|how\s+do(es)?\s+(this|grace)\s+work|how\s+does\s+this\s+work|what\s+is\s+this|how\s+can\s+you\s+help|how\s+can\s+i\s+use\s+(you|this))\s*[?.!]?\s*$/i;

// "Are you there?" / "Hello?" — presence check.
const PRESENCE_CHECK_RE = /^(are\s+you\s+there|you\s+there|grace\s*\??|hello\s*\?|hey\s*\?|anyone\s+there|still\s+there)\s*[?.!]?\s*$/i;

// "I'm back" / "sorry been busy" — re-engagement after silence.
const REENGAGEMENT_RE = /^(i'?m\s+back|im\s+back|i'?m\s+here(\s+now)?|back\s+now|been\s+(busy|away|gone|off\s+the\s+grid|crazy|swamped)|sorry\s+(i'?ve\s+been|for\s+(disappearing|the\s+silence|being\s+(quiet|gone))|i\s+disappeared)|hi\s+again|long\s+time)\s*[.!]?\s*$/i;

// "Feeling much better" / "way better today" — improvement signal.
const FEELING_BETTER_RE = /^(i'?m\s+)?(feeling\s+|doing\s+)?(much\s+|way\s+|so\s+much\s+|a\s+lot\s+|tons\s+|loads\s+)?(better|improved|recovering|on\s+the\s+mend|stronger\s+today|good\s+today|great\s+now|fine\s+now|back\s+to\s+normal|like\s+myself\s+again)\s*[.!]?\s*$/i;

// "Feeling worse" / "much worse today" — deterioration signal that needs
// real empathy + checking for safety. NOT fast-path replied directly —
// instead returns a brief acknowledgment that doesn't trigger the slow
// orchestrator path (Grace's emotional_direct handles the rest if user
// follows up).
const FEELING_WORSE_RE = /^(i'?m\s+)?(feeling\s+|doing\s+)?(much\s+|way\s+|so\s+much\s+|a\s+lot\s+|even\s+)?(worse|worsened|going\s+downhill|getting\s+worse|sicker|weaker|terrible\s+today|awful\s+today|the\s+worst)\s*[.!]?\s*$/i;

// "Skipped breakfast" / "didn't eat lunch" — explicit non-meal log.
// Acknowledges without trying to estimate macros (0g protein logged).
const MEAL_SKIP_RE = /^(skipped|didn'?t\s+(eat|have)|no|missed)\s+(breakfast|lunch|dinner|snack|brunch|meals?|food|anything)(\s+today)?\s*[.!]?\s*$/i;

// "How am I doing" / "where am I at" / "status check" — open-ended progress
// query that today the orchestrator handles inconsistently.
const CHECK_IN_QUERY_RE = /^(how\s+am\s+i\s+doing|how'?s\s+(my\s+)?progress|where\s+am\s+i(\s+at)?|status\s+(check|update)?|progress\s+(check|update)?|am\s+i\s+on\s+track|hows\s+today\s+going)\s*[?.!]?\s*$/i;

// ── Response pools ──────────────────────────────────────────────────────────
// Rotated by deterministic hash of (userId + text) so the same user doesn't
// see identical replies repeatedly, but variety still exists across users.

const GREETING_REPLIES: readonly string[] = [
  'Hey there.',
  'Hi 🤍',
  'Hey. Good to hear from you.',
  'Hey. How are you doing today?',
  'Hi there. How are you feeling?',
  'Hey. What\'s on your mind today?',
  'Hi. How\'s your day going?',
  'Hey 🧡',
  'Hey. How\'s today treating you?',
] as const;

const BRIEF_POSITIVE_REPLIES: readonly string[] = [
  'Love hearing that.',
  'Really glad to hear it.',
  'That\'s great to hear.',
  'Good to hear 🤍',
  'Happy to hear that.',
  'Glad you\'re feeling that way.',
  'That makes me happy 🧡',
  'Solid.',
] as const;

// 2026-06-06 v2 — Coverage audit emotional-engagement follow-up.
// Each entry now recognizes the feeling AND leaves a small door open
// (a soft observation or a single gentle question) so the conversation
// doesn't dead-end on a one-liner.
const BRIEF_NEGATIVE_REPLIES: readonly string[] = [
  'Ugh. That one\'s heavy — want to put it into words?',
  'That sounds rough. Anything specific weighing on you?',
  'Heavy day. What\'s the hardest piece right now?',
  'Rough is fair. Want to talk through it a little?',
  'Sending you something gentle 🤍 What\'s pulling at you?',
  'I\'m here. Take your time — what\'s underneath it?',
  'That stings. Want to say what set it off?',
  'Yeah, that one lands. Where\'s the worst of it sitting?',
  'Of course you\'re feeling that way. What feels heaviest?',
] as const;

const BRIEF_ACK_REPLIES: readonly string[] = [
  'Got it 👍',
  'Noted.',
  'Cool.',
  'Sounds good.',
  '🤍',
  'On it.',
  'Heard.',
] as const;

const CONFIRMATION_REPLIES: readonly string[] = [
  'Good.',
  'Cool.',
  'Glad we\'re on the same page.',
  'Nice.',
  'Got it 👍',
] as const;

const DENIAL_REPLIES: readonly string[] = [
  'All good.',
  'No worries.',
  'Sounds good.',
  'Got it.',
  'Cool.',
] as const;

const THANKS_REPLIES: readonly string[] = [
  'Anytime.',
  'Of course.',
  'Glad it helped.',
  'No worries.',
  'Always 🤍',
  'Really glad it landed.',
  'That\'s what I\'m here for.',
] as const;

const GOODNIGHT_REPLIES: readonly string[] = [
  'Sleep well 🤍',
  'Goodnight. Rest up.',
  'Night. Talk tomorrow.',
  'Rest well 🧡',
  'Sleep tight.',
  'Sweet dreams.',
  'Goodnight 🤍',
] as const;

const FAREWELL_REPLIES: readonly string[] = [
  'Talk soon.',
  'Catch you later 🤍',
  'See you 🧡',
  'Take care.',
  'Later.',
  'Anytime you need me.',
] as const;

const LAUGHTER_REPLIES: readonly string[] = [
  '😄',
  'Right?',
  'Hehe.',
  'Right 😄',
  'Haha.',
  '😆',
] as const;

const APOLOGY_REPLIES: readonly string[] = [
  'No worries.',
  'All good.',
  'Nothing to apologize for.',
  'It\'s okay 🤍',
  'Don\'t worry about it.',
  'All good — really.',
] as const;

const REACTION_REPLIES: readonly string[] = [
  'Right?',
  'Yeah, I know.',
  'I hear you.',
  'Mhm.',
  'Yeah.',
] as const;

const APPRECIATION_REPLIES: readonly string[] = [
  'That means a lot 🤍',
  'Right back at you.',
  'You\'re the kind one 🧡',
  'Thank you for saying that.',
  'Made my day.',
] as const;

const LOVE_IT_REPLIES: readonly string[] = [
  'Really glad 🤍',
  'Good.',
  'Happy that landed.',
  'Glad it helped.',
  'Awesome.',
] as const;

// ── 2026-06-05 Phase B reply pools ──────────────────────────────────────────

const HOW_ARE_YOU_REPLIES: readonly string[] = [
  "I'm here and ready — how are you doing today?",
  "Doing well — thanks for asking. How's your day?",
  "All good on my end. How are you feeling?",
  "I'm here, listening. What's on your mind?",
] as const;

const HELP_CAPABILITIES_REPLIES: readonly string[] = [
  "I'm here for your GLP-1 journey — log food and weight, talk through side effects, answer questions about Ozempic / Wegovy / Mounjaro / Zepbound, and check in daily. Just send what's going on and I'll take it from there.",
  "Send me what you ate and I'll estimate protein, tell me how you're feeling and I'll listen, ask anything about your medication. I check in with you most days too.",
  "Daily check-ins, food logging (text or photo), weight tracking, side-effect support, and answers about your medication. Send anything — I'll handle it.",
] as const;

const PRESENCE_CHECK_REPLIES: readonly string[] = [
  "Here. What's going on?",
  "Yes, I'm here. How can I help?",
  "Right here. What do you need?",
  "Still here 🤍 What's up?",
] as const;

const REENGAGEMENT_REPLIES: readonly string[] = [
  "Welcome back — good to hear from you. How have things been?",
  "Glad you're back. What's been happening?",
  "Hey, no worries. How are you doing right now?",
  "Good to see you. How's the journey been lately?",
] as const;

const FEELING_BETTER_REPLIES: readonly string[] = [
  "That's really good to hear. What's helped?",
  "Glad you're feeling better 🤍",
  "Love that. What feels different?",
  "Really good news. Take it slow.",
] as const;

const FEELING_WORSE_REPLIES: readonly string[] = [
  "That's hard. Tell me a bit more about what's going on.",
  "Sorry — that's rough. What's the worst of it right now?",
  "I'm here. What part is hitting the hardest today?",
  "Ugh, that's a lot. What's going on?",
] as const;

const MEAL_SKIP_REPLIES: readonly string[] = [
  "Got it. Try to grab some protein when you can — even 15–20g helps.",
  "Noted. A small protein snack later helps keep muscle protected.",
  "Logged. Aim for a protein-forward next meal when you're ready.",
  "Okay. Greek yogurt, a protein shake, or a hard-boiled egg works when you can manage it.",
] as const;

const CHECK_IN_QUERY_REPLIES: readonly string[] = [
  "Send me 'what I ate today' and I'll show your totals. Or tell me how you're feeling.",
  "Tell me what you've eaten and I'll pull your numbers. Or share what's on your mind.",
  "Type 'what I ate today' for your protein/calorie total, or just share how it's going.",
] as const;

// 2026-06-04 production failure: "are you real?" was routed to general intent,
// generated a long meandering response, tripped behavioral guard, regen also
// failed, served "What's on your mind?" canned fallback. Identity questions
// are deterministic and need a brief truthful answer.
const IDENTITY_RE = /^(?:are\s+you|r\s+u)\s+(?:real|human|a\s+(?:bot|robot|machine|ai|person|chatbot|computer)|alive|sentient|a\s+real\s+person|an?\s+(?:ai|chatbot|bot|robot))\??$|^(?:who|what)\s+(?:are|r)\s+(?:you|u)\??$/i;
const IDENTITY_REPLIES: readonly string[] = [
  "I'm Grace — an AI companion built for people on GLP-1 medications. Real in the sense that I'm here, listening, and remember our chats. Not a human, but I won't pretend to be.",
  "I'm Grace, an AI built to support you between doctor visits — food, mood, side effects, all of it. Not human, but here whenever you need me.",
  "I'm Grace, your GLP-1 companion. An AI, not a person, but designed to actually pay attention and remember what matters to you.",
] as const;

function pickFromPool(pool: readonly string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length]!;
}

/**
 * Try to match the message against a fast-path category and return a
 * deterministic warm reply. Returns null if the message doesn't qualify —
 * in which case the caller runs the full pipeline.
 *
 * @param text the user's inbound message
 * @param userId stable per-user identifier — used to vary the picked reply
 *               so the same user doesn't see identical greetings repeatedly
 */
// ── Hard exclusions — never fast-path these even if a regex matches ─────────
// Medical / symptom states need real personalization + medical guidance.
// Food / hunger states need food suggestions. Risk/crisis content is caught
// by the safety classifier upstream but double-check defensively here.
const NEVER_FAST_PATH_RE = /\b(nauseous|nausea|sick|throwing up|vomit|dizzy|faint|chest pain|hurts|hurting|in pain|pain|cramp|cramping|diarrhea|constipated|bleeding|fever|swollen|allergic|injection|shot|dose|dosage|hungry|starving|appetite|eat|ate|had|drank|drink|breakfast|lunch|dinner|snack|meal|food|protein|weight|lbs|kg|kilo|pound|scale|workout|exercise|reminder|stop|cancel|unsubscribe|pause|kill|die|suicide|hurt myself|harm)\b/i;

// ── Non-English handler (2026-06-06) ────────────────────────────────────────
// Per the coverage audit: non-English messages must be handled gracefully,
// not refused. Detect by either (a) ≥40% of letter chars in non-Latin
// scripts (Hebrew/Arabic/Cyrillic/Devanagari/CJK), or (b) a short whitelist
// of common non-English greetings. SAFETY-CRITICAL: any non-English symptom
// keyword (chest pain / can't breathe / suicide / etc. in supported scripts)
// short-circuits this path so the safety guard still sees the message.
const NON_LATIN_RE = /[֐-׿؀-ۿЀ-ӿऀ-ॿ一-鿿぀-ヿ㐀-䶿]/u;
const NON_ENGLISH_GREETING_RE = /^(?:hola|bonjour|salut|guten\s+tag|hallo|ciao|salve|namaste|merhaba|здравствуйте|привет|שלום|سلام|مرحبا|你好|こんにちは|안녕하세요)[\s.,!?]*$/iu;
// Non-English distress / symptom / safety triggers — when present, the
// non_english fast-path MUST bail out so the message falls through to the
// orchestrator (and through the safety classifier on the way).
const NON_ENGLISH_DISTRESS_RE = /(?:כאב|חזה|נושם|להתאבד|התאבדות|אנפלקסיס|התקף|חירום|عذر|صدر|تنفس|انتحار|طوارئ|ألم|болит|боль|задыхаюсь|самоуб|skon|skonu|dolor|pecho|respirar|suicid|ayuda|emergencia|douleur|poitrine|respirer|urgence|sangue|Schmerz|Brust|atmen|Notfall)/iu;

function countNonLatinLetters(text: string): { nonLatin: number; total: number } {
  let nonLatin = 0;
  let total = 0;
  for (const ch of text) {
    if (/[A-Za-z]/.test(ch)) total++;
    else if (NON_LATIN_RE.test(ch)) { nonLatin++; total++; }
  }
  return { nonLatin, total };
}

function looksNonEnglish(text: string): boolean {
  if (NON_ENGLISH_GREETING_RE.test(text.trim())) return true;
  const { nonLatin, total } = countNonLatinLetters(text);
  if (total === 0) return false;
  return nonLatin / total >= 0.4;
}

const NON_ENGLISH_REPLIES: readonly string[] = [
  "I'm best in English right now — could you try in English? 🤍",
  "English only for now — could you send that again in English?",
  "I work in English so far — try again in English and I'm here.",
  "I can only really help in English right now — could you rephrase in English?",
];

export function tryFastPath(text: string, userId: string): FastPathResult | null {
  // Normalize iOS smart-quote apostrophes (U+2019) so "I'm" with curly quote
  // matches `i'?m` with straight quote. Production failure 2026-06-05.
  const trimmed = normalizeUserText(text).trim();
  // Slightly higher cap to allow longer meta questions ("how does this work").
  if (trimmed.length === 0 || trimmed.length > 60) return null;
  // Identity questions are the ONE exception to "no `?` allowed" — they're
  // deterministic and need a brief truthful response, not a full LLM pipeline.
  // 2026-06-05 Phase B: same exception for how_are_you / help_capabilities /
  // presence_check / check_in_query — they're deterministic meta questions.
  const isIdentity = IDENTITY_RE.test(trimmed);
  const isMetaQuestion =
    HOW_ARE_YOU_RE.test(trimmed) ||
    HELP_CAPABILITIES_RE.test(trimmed) ||
    PRESENCE_CHECK_RE.test(trimmed) ||
    CHECK_IN_QUERY_RE.test(trimmed);
  if (!isIdentity && !isMetaQuestion) {
    // Any question mark → real pipeline (user is asking something)
    if (trimmed.includes('?')) return null;
  }
  // Any digit → could be a weight/food/dose log → real pipeline
  if (/\d/.test(trimmed)) return null;
  // Hash prefix is RLHF feedback comment — handled upstream
  if (trimmed.startsWith('#')) return null;
  // Defensive double-check — never fast-path medical/food/crisis content
  // EXCEPTION: meal_skip ("skipped breakfast") and feeling_worse use the
  // exclusion words but ARE valid fast-path categories.
  if (NEVER_FAST_PATH_RE.test(trimmed)) {
    if (!MEAL_SKIP_RE.test(trimmed) && !FEELING_WORSE_RE.test(trimmed) && !FEELING_BETTER_RE.test(trimmed)) {
      return null;
    }
  }

  const seed = `${userId}|${trimmed.toLowerCase()}`;

  // ── Non-English handler (2026-06-06) ────────────────────────────────────
  // Runs AFTER NEVER_FAST_PATH_RE so symptom keywords still bail. ALSO
  // checks NON_ENGLISH_DISTRESS_RE for symptom/safety words in supported
  // non-English scripts — if any match, bail to the orchestrator + safety
  // classifier path. Cap message length to keep this conservative.
  if (trimmed.length <= 40 && looksNonEnglish(trimmed) && !NON_ENGLISH_DISTRESS_RE.test(trimmed)) {
    return { text: pickFromPool(NON_ENGLISH_REPLIES, seed), category: 'non_english' };
  }

  if (isIdentity) {
    return { text: pickFromPool(IDENTITY_REPLIES, seed), category: 'identity' };
  }

  // Order matters: more specific patterns first so a generic word doesn't
  // shadow a more meaningful match.
  if (GREETING_RE.test(trimmed)) {
    return { text: pickFromPool(GREETING_REPLIES, seed), category: 'greeting' };
  }
  if (THANKS_RE.test(trimmed)) {
    return { text: pickFromPool(THANKS_REPLIES, seed), category: 'thanks' };
  }
  if (GOODNIGHT_RE.test(trimmed)) {
    return { text: pickFromPool(GOODNIGHT_REPLIES, seed), category: 'goodnight' };
  }
  if (FAREWELL_RE.test(trimmed)) {
    return { text: pickFromPool(FAREWELL_REPLIES, seed), category: 'farewell' };
  }
  if (LAUGHTER_RE.test(trimmed)) {
    return { text: pickFromPool(LAUGHTER_REPLIES, seed), category: 'laughter' };
  }
  if (APOLOGY_RE.test(trimmed)) {
    return { text: pickFromPool(APOLOGY_REPLIES, seed), category: 'apology' };
  }
  if (APPRECIATION_RE.test(trimmed)) {
    return { text: pickFromPool(APPRECIATION_REPLIES, seed), category: 'appreciation' };
  }
  if (LOVE_IT_RE.test(trimmed)) {
    return { text: pickFromPool(LOVE_IT_REPLIES, seed), category: 'love_it' };
  }
  // Normalize before matching brief feeling patterns: strip greeting
  // prefixes ("morning, X" / "good morning, X") and fix common typos
  // ("felling" / "feelign" → "feeling"). Production failure 2026-06-01:
  // "Morning, felling good" missed the fast-path → full LLM pipeline → 6-
  // sentence response that surfaced stale context. Normalization makes
  // brief check-ins much more reliable to catch.
  const normalized = normalizeBriefText(trimmed);
  if (BRIEF_POSITIVE_RE.test(normalized)) {
    return { text: pickFromPool(BRIEF_POSITIVE_REPLIES, seed), category: 'brief_positive' };
  }
  if (BRIEF_NEGATIVE_RE.test(normalized)) {
    return { text: pickFromPool(BRIEF_NEGATIVE_REPLIES, seed), category: 'brief_negative' };
  }
  if (REACTION_RE.test(trimmed)) {
    return { text: pickFromPool(REACTION_REPLIES, seed), category: 'reaction' };
  }
  if (DENIAL_RE.test(trimmed)) {
    return { text: pickFromPool(DENIAL_REPLIES, seed), category: 'denial' };
  }
  if (CONFIRMATION_RE.test(trimmed)) {
    return { text: pickFromPool(CONFIRMATION_REPLIES, seed), category: 'confirmation' };
  }
  if (BRIEF_ACK_RE.test(trimmed)) {
    return { text: pickFromPool(BRIEF_ACK_REPLIES, seed), category: 'brief_ack' };
  }
  // ── 2026-06-05 Phase B additions ────────────────────────────────────────
  // Meta questions (have '?' but are deterministic).
  if (HOW_ARE_YOU_RE.test(trimmed)) {
    return { text: pickFromPool(HOW_ARE_YOU_REPLIES, seed), category: 'how_are_you' };
  }
  if (HELP_CAPABILITIES_RE.test(trimmed)) {
    return { text: pickFromPool(HELP_CAPABILITIES_REPLIES, seed), category: 'help_capabilities' };
  }
  if (PRESENCE_CHECK_RE.test(trimmed)) {
    return { text: pickFromPool(PRESENCE_CHECK_REPLIES, seed), category: 'presence_check' };
  }
  if (CHECK_IN_QUERY_RE.test(trimmed)) {
    return { text: pickFromPool(CHECK_IN_QUERY_REPLIES, seed), category: 'check_in_query' };
  }
  // Declarative new categories.
  if (REENGAGEMENT_RE.test(trimmed)) {
    return { text: pickFromPool(REENGAGEMENT_REPLIES, seed), category: 'reengagement' };
  }
  if (FEELING_BETTER_RE.test(trimmed)) {
    return { text: pickFromPool(FEELING_BETTER_REPLIES, seed), category: 'feeling_better' };
  }
  if (FEELING_WORSE_RE.test(trimmed)) {
    return { text: pickFromPool(FEELING_WORSE_REPLIES, seed), category: 'feeling_worse' };
  }
  if (MEAL_SKIP_RE.test(trimmed)) {
    return { text: pickFromPool(MEAL_SKIP_REPLIES, seed), category: 'meal_skip' };
  }
  return null;
}
