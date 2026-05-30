// ────────────────────────────────────────────────────────────────────────────
// AIOrchestrator — the core AI response generation engine.
//
// This is the central pipeline that turns a user message into a Grace response.
// Flow: classify → plan → execute tools → generate LLM response → enforce
// format → check content rules → check grounding → check relevance → regen
// if any check fails → web search fallback → safe fallback.
//
// Pure module: no DB, no env reads, no network I/O except LLM calls. All
// external deps (user data, RAG, tool implementations) are injected by
// ai.service.ts which calls orchestrator.run().
// ────────────────────────────────────────────────────────────────────────────

import type {
  CriticReport,
  LLMProvider,
  OrchestratorInput,
  OrchestratorOutput,
  PlannerDecision,
  RetrievedDoc,
  ToolResult,
} from '@grace/shared';
import { checkContent, buildContentRegenInstruction, type ContentViolation } from './content-checker.js';
import { classifyMessage, type MessageType } from './classify.js';
import { LLMCritic } from './critic.js';
import { BehavioralGuard } from './behavioral-guard.js';
import { checkResponseQuality } from './quality-guard.js';
import { RelevanceChecker } from './relevance-check.js';
import { enforceFormat } from './format-enforcer.js';
import { precheckGrounding, summarizeUnsupported, type GroundingResult } from './grounding.js';
import { PlannerAgent } from './planner.js';
import { GRACE_SYSTEM_PROMPT, renderHistory, renderRetrievalContext } from './prompts.js';
import { ToolRegistry } from './tools/registry.js';
import { validateResponse, type ValidationResult } from './validator.js';

export interface OrchestratorDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  planner?: PlannerAgent;
  critic?: LLMCritic;
}

// Typed fallbacks — each message type gets contextually appropriate recovery
// text so users never see "can you rephrase?" after logging a meal.
const TYPED_FALLBACKS: Record<MessageType, string[]> = {
  food_log: [
    "Logged that for you. How are you feeling after that meal?",
    "Got it, that's tracked. How's your day going?",
    "Noted — tell me a bit more about what you had if you want a protein estimate.",
  ],
  food_question: [
    "Greek yogurt, cottage cheese, or eggs are solid high-protein options that tend to sit well on GLP-1s. Small portions, protein first.",
    "For a quick high-protein meal: grilled chicken, a protein shake, or a tofu stir-fry. Keep portions small and eat slowly.",
    "Edamame, hard-boiled eggs, or string cheese are easy GLP-1-friendly snacks with good protein. What sounds good?",
  ],
  weight_log: [
    "Got it, I'll track that. How are you feeling today overall?",
    "Noted. How has the week been going?",
    "Logged. How are you doing?",
  ],
  mood_log: [
    "Thanks for sharing that. Tell me more about how you're feeling.",
    "I hear you. What's been going on today?",
    "Got it. What's on your mind?",
  ],
  greeting: [
    "Hey! How are you doing today?",
    "Hi! What's on your mind?",
    "Good to hear from you! How's it going?",
  ],
  emotional: [
    "I hear you. Tell me more about what's going on.",
    "That sounds tough. I'm here — what's happening?",
    "Thanks for sharing that with me. How are you feeling right now?",
  ],
  scheduling: [
    "Of course — what works better for you?",
    "Got it. You can always update your check-in frequency at grace-admin-silk.vercel.app/settings.",
  ],
  knowledge: [
    "Muscle loss is common on GLP-1s, with research showing 25-35% of weight lost can be lean mass. Protein (1.2-1.6g/kg daily) and resistance training help shift the balance toward fat loss.",
    "GLP-1s work by mimicking the incretin hormone, slowing gastric emptying and reducing appetite. Side effects like nausea typically peak in the first 4-8 weeks, then improve as your body adjusts.",
    "Protein targets on GLP-1 therapy are higher than normal, around 1.2-1.6g/kg body weight daily. Front-loading 25-30g at breakfast helps protect muscle mass during weight loss.",
  ],
  gibberish: [
    "Hey! What's on your mind today?",
    "I'm here — what would you like to talk about?",
    "What's going on? Feel free to share anything.",
  ],
  general: [
    "I'm here and ready to help. What's on your mind?",
    "Let me help with that. What would be most useful right now?",
    "I'm listening. What would you like to talk about?",
  ],
};

const _fallbackIdx: Record<string, number> = {};
function getTypedFallback(type: MessageType): string {
  const arr = TYPED_FALLBACKS[type];
  const idx = (_fallbackIdx[type] ?? 0) % arr.length;
  _fallbackIdx[type] = idx + 1;
  return arr[idx]!;
}

/**
 * Tool-aware fallback. When generation fails but a tool ran successfully,
 * we have real data — use it instead of a generic "got it, what else?"
 * which makes Grace look like she ignored what the user just did.
 */
function getToolAwareFallback(type: MessageType, toolResults: ToolResult[]): string {
  // Successfully logged food → reference the actual protein count.
  // Note: outer `r.ok` means the tool didn't throw; the tool's internal
  // logic may still have failed (output.ok === false). Check both.
  const foodLogged = toolResults.find((r) => {
    if (r.name !== 'log_food' || !r.ok || !r.output) return false;
    const out = r.output as Record<string, unknown>;
    return out['ok'] !== false && typeof out['protein_g'] === 'number';
  });
  if (foodLogged) {
    const out = foodLogged.output as Record<string, unknown>;
    const proteinG = Math.round(out['protein_g'] as number);
    const dailyG = typeof out['daily_protein_g'] === 'number' ? Math.round(out['daily_protein_g'] as number) : null;
    if (proteinG > 0) {
      if (dailyG != null && dailyG !== proteinG) {
        return `Got it — about ${proteinG}g protein for that. You're at ${dailyG}g for today.`;
      }
      return `Got it — about ${proteinG}g protein for that.`;
    }
  }

  // Successfully logged weight
  const weightLogged = toolResults.find((r) => r.name === 'log_weight' && r.ok);
  if (weightLogged) return "Got it, I've logged that. How are you feeling today?";

  // Successfully logged mood
  const moodLogged = toolResults.find((r) => r.name === 'log_mood' && r.ok);
  if (moodLogged) return "Thanks for checking in. What's on your mind?";

  // Food summary requested — tool returns `protein_g` (today's total)
  const foodSummary = toolResults.find((r) => r.name === 'get_food_summary' && r.ok && r.output);
  if (foodSummary) {
    const out = foodSummary.output as Record<string, unknown>;
    const total = typeof out['protein_g'] === 'number' ? Math.round(out['protein_g'] as number) : null;
    const goal = typeof out['protein_goal_grams'] === 'number' ? Math.round(out['protein_goal_grams'] as number) : null;
    if (total != null) {
      if (goal != null) return `You're at ${total}g protein today — your goal is ${goal}g.`;
      return `You're at ${total}g protein today.`;
    }
  }

  return getTypedFallback(type);
}

// ── Topic drift detection — keyword extraction ────────────────────────────
// Extracts content words from messages, filtering out stop words, so we can
// compare what the user is asking about vs. what Grace just answered about.
// Used by buildFocusMarker and the drift/duplication checks in run().
const STOP_WORDS = new Set([
  'i', 'me', 'my', 'you', 'your', 'we', 'our', 'the', 'a', 'an', 'is', 'are',
  'was', 'were', 'am', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'could', 'should', 'can', 'may', 'might', 'shall', 'to',
  'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'it', 'its', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if',
  'not', 'no', 'so', 'up', 'out', 'just', 'also', 'than', 'then', 'too',
  'very', 'really', 'how', 'what', 'when', 'where', 'why', 'who', 'which',
  'all', 'any', 'some', 'more', 'most', 'much', 'many', 'well', 'still',
  'tell', 'everything', 'know', 'think', 'like', 'get', 'got',
  'make', 'take', 'going', 'want', 'need', 'hey',
  'hi', 'hello', 'grace', 'thanks', 'thank', 'please', 'ok', 'okay',
  'yes', 'yeah', 'yep', 'nope', 'sure', 'right', 'good', 'great',
  'any', 'question', 'questions',
]);

function extractTopicKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// Injected right before the user turn to prevent the LLM from anchoring on
// old topics. Quotes the last Grace message so the model knows NOT to repeat it.
function buildFocusMarker(type: MessageType, toolResults: ToolResult[], lastAssistantMessage?: string, userText?: string): string {
  const parts: string[] = [];

  // Hard "do not repeat" guard — the most common failure mode is Gemini
  // Flash copy-pasting the previous assistant message verbatim before adding
  // new content. Quoting the first ~80 chars makes the model explicitly aware
  // of what it must NOT start with.
  if (lastAssistantMessage && lastAssistantMessage.trim().length > 40) {
    const snippet = lastAssistantMessage.trim().slice(0, 100).replace(/"/g, "'");
    parts.push(
      `CRITICAL: Your previous message ("${snippet}...") has already been sent and received by the user. Do NOT repeat any part of it. Do NOT start with those words. Write a completely fresh reply to the NEW message below.`,
    );

    if (userText) {
      const userKeywords = extractTopicKeywords(userText);
      const prevKeywords = extractTopicKeywords(lastAssistantMessage);
      const overlap = userKeywords.filter((w) => prevKeywords.includes(w));
      if (userKeywords.length >= 2 && overlap.length <= 1) {
        const banned = prevKeywords.slice(0, 8).join(', ');
        const required = userKeywords.slice(0, 6).join(', ');
        parts.push(
          `⚠️ TOPIC SWITCH — THIS IS THE #1 PRIORITY INSTRUCTION. The user's NEW message is about a COMPLETELY DIFFERENT topic than your previous response. ` +
          `You MUST answer ONLY about: ${required}. ` +
          `You MUST NOT mention or continue these words/topics from before: ${banned}. ` +
          `The previous conversation topic is CLOSED. If your response contains any of the banned words, it will be rejected and regenerated.`,
        );
      }
    }
  }

  // For food-summary queries with a fresh tool result, the answer IS the
  // number — be explicit.
  const foodSummary = toolResults.find((r) => r.name === 'get_food_summary' && r.ok && r.output);
  if (foodSummary) {
    const out = foodSummary.output as Record<string, unknown>;
    const total = typeof out['protein_g'] === 'number' ? Math.round(out['protein_g'] as number) : null;
    const goal = typeof out['protein_goal_grams'] === 'number' ? Math.round(out['protein_goal_grams'] as number) : null;
    if (total != null) {
      parts.push(
        `USER IS ASKING ABOUT TODAY'S PROTEIN TOTAL. Answer with the exact number: ${total}g${goal != null ? ` (goal ${goal}g)` : ''}. One or two short sentences. Do NOT continue any previous topic from history.`,
      );
      return parts.join('\n');
    }
  }

  const intentDescription: Record<MessageType, string> = {
    food_log: 'logging a food they ate. Acknowledge + state the protein from the tool result. Do NOT continue any previous topic.',
    food_question: 'asking a question about food or nutrition. Answer their question directly. Do NOT continue any previous topic.',
    weight_log: 'reporting their weight. Acknowledge + respond warmly. Do NOT continue any previous topic.',
    mood_log: 'sharing their mood or energy level. Respond with empathy. Do NOT continue any previous topic.',
    greeting: 'just greeting you. Reply with ONE warm sentence. Topic reset — do NOT reference any prior conversation.',
    emotional: 'sharing a feeling or struggle. Validate first. Do NOT continue any previous topic.',
    scheduling: 'asking about message frequency. Do NOT continue any previous topic.',
    knowledge: 'asking a GLP-1 / medication / nutrition knowledge question. Answer directly with facts. Do NOT continue any previous topic.',
    gibberish: 'sending an unclear message. Ask a brief clarifying question.',
    general: 'sending a new message. Answer ONLY what they just asked. Do NOT continue any previous topic. Do NOT repeat or paraphrase any previous Grace message.',
  };

  parts.push(`[CURRENT USER MESSAGE TYPE: ${intentDescription[type]}]`);

  if (userText && userText.length > 3 && type !== 'greeting' && type !== 'gibberish') {
    const echo = userText.trim().slice(0, 150).replace(/"/g, "'");
    parts.push(`>>> THE USER'S CURRENT MESSAGE: "${echo}" <<<\nYour ENTIRE response must answer THIS message. Not the previous one. Not something from history. THIS one above.`);
  }

  return parts.join('\n');
}

// Only run the LLM critic for genuinely dangerous intent categories.
// `knowledge_lookup` was here but it's too broad — food/nutrition questions
// get treated as risky and the critic then fails on USDA protein-gram facts
// that aren't verbatim in retrieved KB chunks. The validator's
// `possible_medical_advice` flag handles the cases we care about.
const RISKY_INTENT_PREFIXES = ['safety_'];

// The orchestrator composes three sub-components: PlannerAgent (decides which
// tools to call), LLMCritic (grades response safety/grounding), and
// RelevanceChecker (verifies the response answers the user's actual question).
export class AIOrchestrator {
  private planner: PlannerAgent;
  private critic: LLMCritic;
  private relevance: RelevanceChecker;
  private behavioral: BehavioralGuard;

  constructor(private deps: OrchestratorDeps) {
    this.planner = deps.planner ?? new PlannerAgent(deps.llm);
    this.critic = deps.critic ?? new LLMCritic(deps.llm);
    this.relevance = new RelevanceChecker(deps.llm);
    this.behavioral = new BehavioralGuard(deps.llm);
  }

  // Main pipeline. Steps: (1) classify message type, (2) plan + execute tools,
  // (3) generate LLM response, (4) enforce format, (5) check content rules
  // (block/regen/log), (6) check grounding + topic drift + relevance,
  // (7) regen if any check fails, (8) web search fallback, (9) safe fallback.
  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const started = Date.now();

    // Step 1: Fast deterministic classifier — drives typed fallbacks, planner skip, and thinking control.
    const classification = classifyMessage(input.text);
    const simpleTypes = ['greeting', 'gibberish', 'food_log', 'weight_log', 'mood_log'];
    const skipPlanner = simpleTypes.includes(classification.type);
    const isSimpleMessage = simpleTypes.includes(classification.type) || classification.type === 'emotional';

    const chatFallbackPlan: PlannerDecision = { intent: 'chat', needsTools: false, toolCalls: [], rationale: 'tools_disabled' };
    // If the caller ran the planner in parallel with RAG (ai.service.ts does
    // this for latency), use that result directly. Otherwise plan now.
    const plan: PlannerDecision = input.prePlannedDecision
      ? input.prePlannedDecision
      : (input.toolsEnabled && !skipPlanner)
        ? await this.planner.plan(input.text).catch(() => chatFallbackPlan)
        : chatFallbackPlan;

    let toolResults: ToolResult[] = [];
    if (plan.needsTools && plan.toolCalls.length > 0) {
      toolResults = await this.deps.tools.executeMany(plan.toolCalls);
    }

    // Long-term semantic memories about this user — top-k retrieved by
    // ai.service.ts from the user_memories table. Framed as background-only
    // so the LLM doesn't randomly surface unrelated facts.
    const memoryBlock = input.userMemories && input.userMemories.length > 0
      ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nBACKGROUND MEMORY (DO NOT mention unless directly relevant to the user's CURRENT message):\n${input.userMemories.map((m) => `- ${m}`).join('\n')}\nIMPORTANT: These are background facts. Only reference a fact if the user's current message is about that specific topic. Never volunteer unrelated memories.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      : '';

    const toolResultBlock = toolResults.length > 0
      ? `\n\nTool results (use ONLY to answer the user's current question — do not mention tool data that isn't relevant to what they just asked):\n${JSON.stringify(toolResults)}`
      : '';

    const baseSystem =
      (input.systemPrompt ?? GRACE_SYSTEM_PROMPT) +
      memoryBlock +
      renderRetrievalContext(input.retrieved) +
      toolResultBlock;

    // Extract the last Grace message from history — used in the focus marker
    // and in the format-enforcer deduplication check.
    const lastAssistantMessage = [...input.history]
      .reverse()
      .find((m) => m.role === 'assistant')?.content ?? undefined;

    // Topic-focus injection. Always inject a focus marker right before the
    // user turn. It (1) tells Gemini what kind of message this is, and (2)
    // explicitly quotes the last Grace message so the model knows NOT to
    // repeat it verbatim — the most common Gemini Flash failure pattern.
    const focusMarker = buildFocusMarker(classification.type, toolResults, lastAssistantMessage, input.text);
    const generationMessages = [
      { role: 'system' as const, content: baseSystem },
      ...renderHistory(input.history),
      { role: 'system' as const, content: focusMarker },
      { role: 'user' as const, content: input.text },
    ];

    // Per-intent token budget (2026-05-30 latency pass) — tighter caps shave
    // ~200-400ms off generation latency without compromising completeness.
    // Gemini 2.5 Flash allocates thinking tokens from maxOutputTokens, so the
    // numbers below include both thinking + output budget. Simple intents
    // disable thinking entirely (disableThinking: true) so the full budget
    // goes to the response.
    let generationTokenBudget: number;
    if (classification.type === 'greeting' || classification.type === 'gibberish') {
      generationTokenBudget = 256; // one-sentence reply, thinking off
    } else if (classification.type === 'food_log' || classification.type === 'weight_log' || classification.type === 'mood_log') {
      generationTokenBudget = 512; // log ack + macro number, thinking off
    } else if (classification.type === 'emotional') {
      generationTokenBudget = 1024; // 2-sentence empathic reply, thinking off
    } else {
      generationTokenBudget = 8192; // knowledge / food question — thinking enabled, full room
    }

    const llmResp = await this.deps.llm.generate({
      messages: generationMessages,
      temperature: 0.6,
      maxOutputTokens: generationTokenBudget,
      disableThinking: isSimpleMessage,
    });

    // ─── Format enforcement (silent auto-fix) ─────────────────────────
    // Strip em dashes, markdown bold, numbered lists, etc. that Gemini Flash
    // emits despite the system prompt's "BANNED" rules. This always runs and
    // never triggers a regen — it's just a deterministic cleanup pass.
    // The user's first name is also stripped here on non-welcome turns
    // (NAME USAGE ZERO TOLERANCE).
    const stripName = !input.isFirstMessage && input.userFirstName ? input.userFirstName : undefined;
    const enforceOpts = {
      ...(stripName ? { stripFirstName: stripName } : {}),
      messageContext: classification.type,
      // Pass last Grace message so enforceFormat can strip any duplicate prefix.
      // Gemini Flash sometimes copy-pastes the previous response before appending
      // new content. The deduplication check catches this silently.
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    };
    const formatted = enforceFormat(llmResp.text, enforceOpts);
    let validated = validateResponse(formatted.text);
    const precheck = precheckGrounding(validated.text, input.retrieved);
    let critic: CriticReport | undefined;
    let regenerated = false;
    let usedSafeFallback = false;

    // ─── Step 5: Content-rule enforcement ──────────────────────────────
    // Three severity levels: block (never send, immediate safe fallback),
    // regen (LLM must rewrite), log (telemetry only, response still sent).
    const contentCheckOpts = {
      ...(input.dietaryRestriction ? { dietaryRestriction: input.dietaryRestriction } : {}),
      ...(input.foodDislikes && input.foodDislikes.length > 0 ? { foodDislikes: input.foodDislikes } : {}),
      ...(input.medicationType ? { medicationType: input.medicationType } : {}),
      ...(input.responseMode ? { responseMode: input.responseMode } : {}),
      ...(input.dbRules && input.dbRules.length > 0 ? { dbRules: input.dbRules } : {}),
    };
    const contentViolations: ContentViolation[] = checkContent(validated.text, contentCheckOpts);

    // ── Block-severity gate ───────────────────────────────────────────────────
    // Block rules (e.g. extra-dose commands, prescribing language) must never
    // reach the user even after a regen — skip straight to safe fallback so
    // no extra Gemini call is made.
    const blockViolations = contentViolations.filter((v) => v.severity === 'block');
    if (blockViolations.length > 0) {
      return {
        text: getToolAwareFallback(classification.type, toolResults),
        confidence: 'low',
        intent: plan.intent,
        toolResults,
        usedRetrieval: input.retrieved.length > 0,
        latencyMs: Date.now() - started,
        usedSafeFallback: true,
        critic: {
          scores: { grounding: 1, safety: 1, on_task: 1, tone: 1 },
          overall: 4,
          pass: false,
          issues: blockViolations.map((v) => v.message),
          source: 'precheck',
        },
      };
    }

    // Only regen/undefined violations trigger regeneration; log violations are
    // surfaced in telemetry but don't affect the response.
    const regenViolations = contentViolations.filter(
      (v) => !v.severity || v.severity === 'regen',
    );

    // ── Step 6: Response relevance + duplication checks ─────────────────
    // Three layers: (a) keyword overlap ratio detects obvious topic drift,
    // (b) Jaccard similarity detects copy-paste duplication of last response,
    // (c) LLM relevance check catches semantic mismatches keywords miss.
    let topicDrift = false;
    if (lastAssistantMessage && lastAssistantMessage.trim().length > 40 && classification.type !== 'greeting') {
      const userKws = extractTopicKeywords(input.text);
      const prevKws = extractTopicKeywords(lastAssistantMessage);
      const respKws = extractTopicKeywords(validated.text);

      // Check 1: topic drift — response matches old topic, misses new one.
      // Triggers when the response is more aligned with the previous assistant
      // message than with the user's current message. A ratio-based check catches
      // cases where one incidental word overlaps with the user but 3+ words
      // match the old topic.
      if (userKws.length >= 2) {
        const respMatchesUser = userKws.filter((w) => respKws.includes(w)).length;
        const respMatchesPrev = prevKws.filter((w) => respKws.includes(w)).length;
        const drifted =
          (respMatchesUser === 0 && respMatchesPrev >= 2) ||
          (respMatchesPrev >= 3 && respMatchesPrev > respMatchesUser * 2);
        if (drifted) {
          topicDrift = true;
          regenViolations.push({
            code: 'topic_drift',
            message: `Response is about the PREVIOUS topic (shares ${respMatchesPrev} keywords with last response, only ${respMatchesUser} with user's new message). Answer the user's CURRENT message instead: "${input.text.slice(0, 100)}"`,
            severity: 'regen',
          });
        }
      }

      // Check 2: response duplication — response is a rephrased copy of last
      // Grace message. Jaccard similarity on content words > 0.5 = too similar.
      if (!topicDrift && prevKws.length >= 3 && respKws.length >= 3) {
        const union = new Set([...prevKws, ...respKws]);
        const intersection = prevKws.filter((w) => respKws.includes(w)).length;
        const jaccard = intersection / union.size;
        if (jaccard > 0.4) {
          topicDrift = true;
          regenViolations.push({
            code: 'response_duplication',
            message: `Response is too similar to your previous message (${Math.round(jaccard * 100)}% keyword overlap). Write a COMPLETELY DIFFERENT response. Do not rephrase the same information.`,
            severity: 'regen',
          });
        }
      }
    }

    // Detect mid-word/mid-sentence truncation (e.g. "...easy-to-" cut off by
    // hitting maxOutputTokens). Forces the critic→regen path so the user
    // never sees a half-sentence reply.
    const truncated =
      llmResp.finishReason === 'length' || endsMidWord(validated.text);

    // ─── Final quality guard (deterministic, last check before send) ──────
    // Catches walls of text, nutrition-report formatting, numeric clutter,
    // and excessive questions that slip past content rules and the LLM
    // relevance check. Failures trigger regen with specific feedback.
    const qualityIssue = checkResponseQuality(validated.text, classification.type);
    if (qualityIssue) {
      regenViolations.push({
        code: qualityIssue.code,
        message: qualityIssue.message,
        severity: 'regen',
      });
    }

    // ─── Parallel LLM guards (relevance + behavioral + critic) ───────────
    // Latency optimization (2026-05-30): the three LLM-based post-generation
    // guards are independent — they all judge the same response — so we run
    // them concurrently with Promise.all instead of sequentially. Saves
    // ~500-800ms per turn on average.
    //
    // Skip rules (zero-risk cases — no LLM call needed):
    //   - Greeting / gibberish / brief reply: response is too short and the
    //     deterministic content checker already covers it.
    //   - Very short responses (<40 chars): one-sentence acks like "Got it 👍"
    //     have no surface area for behavioral/relevance failures.
    //   - Topic drift OR existing regen violation already triggered: we'll
    //     regen anyway, so spending more LLM calls is wasted work.
    const looksLikeQuestion =
      /\?/.test(input.text) ||
      /\b(how|what|why|when|where|am i|are you|can i|should i|is it|do you|does this|but i|but my)\b/i.test(input.text);
    const isTrivial =
      classification.type === 'greeting' ||
      classification.type === 'gibberish' ||
      validated.text.length < 40;
    const shouldRunRelevance =
      !isTrivial &&
      !topicDrift &&
      (lastAssistantMessage || looksLikeQuestion) &&
      input.text.length > 10;
    const shouldRunBehavioral =
      !isTrivial && !topicDrift && regenViolations.length === 0;
    // Run the critic in this parallel batch only when the intent is risky
    // (it'll be needed regardless of other guards). Non-risky critic invocations
    // happen later via review() inside the needsReview branch.
    const shouldRunCriticEarly =
      !isTrivial && this.shouldRunCritic(plan, validated);

    const userContextBlock = shouldRunBehavioral && baseSystem.includes('━━━ THIS USER')
      ? baseSystem.slice(baseSystem.indexOf('━━━ THIS USER'), baseSystem.indexOf('━━━ END OF USER DATA ━━━') + 24)
      : '';

    const [relevanceVerdict, behavioralViolations, earlyCritic] = await Promise.all([
      shouldRunRelevance
        ? this.relevance.check(input.text, validated.text, lastAssistantMessage)
        : Promise.resolve<{ relevant: boolean; reason: string } | null>(null),
      shouldRunBehavioral
        ? this.behavioral.check({
            userMessage: input.text,
            graceResponse: validated.text,
            userContext: userContextBlock,
          })
        : Promise.resolve<Array<{ principle: string; reason: string }>>([]),
      shouldRunCriticEarly
        ? this.review(precheck, input.text, validated.text, input.retrieved)
        : Promise.resolve<CriticReport | null>(null),
    ]);

    if (relevanceVerdict && !relevanceVerdict.relevant) {
      topicDrift = true;
      regenViolations.push({
        code: 'relevance_check_failed',
        message: `LLM relevance check: response does NOT answer the user's latest message. Reason: ${relevanceVerdict.reason}. You MUST answer THIS message: "${input.text.slice(0, 120)}". Address the user's actual question or concern — do not give empty acknowledgment or congratulation.`,
        severity: 'regen',
      });
    }

    if (behavioralViolations.length > 0) {
      const top = behavioralViolations[0]!;
      regenViolations.push({
        code: 'behavioral_violation',
        message: `Behavioral guard flagged: ${top.principle}. ${top.reason}. Rewrite the response to follow this principle directly. ${behavioralViolations.length > 1 ? `Also fix: ${behavioralViolations.slice(1).map((v) => v.principle).join(', ')}.` : ''}`,
        severity: 'regen',
      });
    }

    if (earlyCritic) {
      critic = earlyCritic;
    }

    const needsReview =
      truncated ||
      topicDrift ||
      regenViolations.length > 0 ||
      precheck.unsupported.length > 0 ||
      shouldRunCriticEarly;

    // Step 7: If any check failed, regenerate with targeted feedback appended
    // to the system prompt so the LLM knows exactly what to fix.
    if (needsReview) {
      // Reuse the critic result if it ran in the parallel guard batch above;
      // otherwise run it now (this branch hit because of truncation / drift /
      // content-rule violations that don't trigger shouldRunCriticEarly).
      if (!critic) {
        critic = await this.review(precheck, input.text, validated.text, input.retrieved);
      }

      // Treat a content-rule violation (forbidden food, banned phrase, DB rule)
      // as a hard fail even if the LLM-critic thinks the draft was fine — Gemini-
      // as-judge often misses dietary slips and persona violations.
      const hardFail = !critic.pass || regenViolations.length > 0;

      if (hardFail) {
        regenerated = true;
        const addendum =
          buildCriticAddendum(critic) +
          (regenViolations.length > 0
            ? buildContentRegenInstruction(regenViolations, input.dietaryRestriction)
            : '');
        const retryResp = await this.deps.llm.generate({
          messages: [
            { role: 'system', content: baseSystem + addendum },
            ...renderHistory(input.history),
            { role: 'system' as const, content: focusMarker },
            { role: 'user', content: input.text },
          ],
          temperature: 0.4,
          maxOutputTokens: 8192,
        });
        const retryFormatted = enforceFormat(retryResp.text, enforceOpts);
        const retryValidated = validateResponse(retryFormatted.text);
        const retryPrecheck = precheckGrounding(retryValidated.text, input.retrieved);
        const retryContentViolations = checkContent(retryValidated.text, contentCheckOpts);
        // Re-check block violations on the retry; if the model still emits one,
        // fall through to safe fallback below.
        const retryBlockViolations = retryContentViolations.filter((v) => v.severity === 'block');
        const retryRegenViolations = retryContentViolations.filter(
          (v) => !v.severity || v.severity === 'regen',
        );
        // Apply quality guard to the retry too — if the regen is still
        // verbose / cluttered, fall through to safe fallback rather than
        // shipping a bad response.
        const retryQualityIssue = checkResponseQuality(retryValidated.text, classification.type);
        if (retryQualityIssue) {
          retryRegenViolations.push({
            code: retryQualityIssue.code,
            message: retryQualityIssue.message,
            severity: 'regen',
          });
        }
        const retryCritic = await this.review(
          retryPrecheck,
          input.text,
          retryValidated.text,
          input.retrieved,
        );

        // If the original failure was a relevance issue, verify the retry is on-topic too.
        let retryRelevanceFail = false;
        if (retryCritic.pass && retryRegenViolations.length === 0 && retryBlockViolations.length === 0 && topicDrift && lastAssistantMessage) {
          const retryVerdict = await this.relevance.check(input.text, retryValidated.text, lastAssistantMessage);
          retryRelevanceFail = !retryVerdict.relevant;
        }

        if (retryCritic.pass && retryRegenViolations.length === 0 && retryBlockViolations.length === 0 && !retryRelevanceFail) {
          validated = retryValidated;
          critic = retryCritic;
        } else {
          // Step 8: Web search fallback — last resort before the canned safe
          // fallback. Calls Gemini with Google Search grounding when the KB
          // has no answer. Content rules still apply. Falls through to Step 9
          // (safe fallback) if web search also fails or violates a block rule.
          const webResult = await this.tryWebSearchFallback(
            baseSystem,
            input.text,
            input.history,
            contentCheckOpts,
            stripName,
          );
          if (webResult) {
            validated = webResult;
            critic = retryCritic;
          } else {
            validated = {
              text: getToolAwareFallback(classification.type, toolResults),
              confidence: 'low',
              flags: ['safe_fallback'],
            };
            critic = retryCritic;
            usedSafeFallback = true;
          }
        }
      }
    }

    return {
      text: validated.text,
      confidence: validated.confidence,
      intent: plan.intent,
      toolResults,
      usedRetrieval: input.retrieved.length > 0,
      latencyMs: Date.now() - started,
      ...(critic ? { critic } : {}),
      ...(regenerated ? { regenerated } : {}),
      ...(usedSafeFallback ? { usedSafeFallback } : {}),
    };
  }

  /**
   * Last-resort: call Gemini with Google Search grounding enabled. Used
   * when both the primary attempt and the regen failed. Returns the cleaned
   * text on success, or null if web search also produced something we can't
   * send (block violation, empty, or generation error).
   *
   * Grounding precheck is skipped here — the model's response IS grounded
   * by Google. Block-severity content rules still apply (e.g. "I prescribe"
   * is never OK, even if the web says it).
   */
  private async tryWebSearchFallback(
    baseSystem: string,
    userText: string,
    history: OrchestratorInput['history'],
    contentCheckOpts: Parameters<typeof checkContent>[1],
    stripName: string | undefined,
  ): Promise<ValidationResult | null> {
    try {
      const webResp = await this.deps.llm.generate({
        messages: [
          {
            role: 'system',
            content:
              baseSystem +
              '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nWEB RESEARCH MODE — last resort before falling back' +
              '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' +
              '\nYour knowledge base had no confident answer. Use Google Search to find:' +
              '\n  1. Peer-reviewed research, clinical studies, or systematic reviews on GLP-1 medications' +
              '\n  2. Guidelines from major medical bodies (Endocrine Society, ADA, FDA, NIH)' +
              '\n  3. Recent (last 2 years) evidence-based GLP-1 nutrition and exercise research' +
              '\nPrefer scientific sources over blogs or product sites.' +
              '\n' +
              '\nThen answer in Grace\'s voice: warm, brief (2-4 sentences), no clinical jargon, no markdown, no citations or URLs in the reply (you don\'t need to name sources).' +
              '\nIf web search also returns nothing useful, say honestly in one sentence that you couldn\'t find a reliable answer and suggest the user ask their prescriber.',
          },
          ...renderHistory(history),
          { role: 'user', content: userText },
        ],
        temperature: 0.4,
        maxOutputTokens: 8192,
        useGoogleSearch: true,
      });
      const formatted = enforceFormat(webResp.text, { ...(stripName ? { stripFirstName: stripName } : {}) });
      const validated = validateResponse(formatted.text);
      if (!validated.text || validated.text.trim().length === 0) return null;
      const webViolations = checkContent(validated.text, contentCheckOpts);
      // Only block-severity violations disqualify the web result. The response
      // is already Google Search-grounded so regen violations (e.g. style rules)
      // don't apply — we can't regen from a grounded result anyway. Block rules
      // (e.g. prescribing language) still apply unconditionally.
      if (webViolations.some((v) => v.severity === 'block')) return null;
      return validated;
    } catch {
      return null;
    }
  }

  /**
   * Single review step. If the deterministic precheck already flagged
   * unsupported quantitative/safety claims, synthesize a failing
   * CriticReport directly — no LLM call needed. Otherwise call the
   * LLM-critic and attach the (empty) precheck info for observability.
   */
  private async review(
    precheck: GroundingResult,
    userText: string,
    response: string,
    retrieved: RetrievedDoc[],
  ): Promise<CriticReport> {
    if (precheck.unsupported.length > 0) {
      return synthesizePrecheckFailure(precheck);
    }
    return this.critic.evaluate({ userText, response, retrieved });
  }

  /**
   * Risk-gate: the LLM-critic costs an extra Gemini call per message.
   * We only invoke it where the failure modes are dangerous or expensive
   * (medical advice, KB lookups, low-confidence drafts). The grounding
   * precheck runs independently and can force review even when this gate
   * would have skipped.
   */
  private shouldRunCritic(plan: PlannerDecision, v: ValidationResult): boolean {
    if (v.confidence === 'low') return true;
    if (v.flags.includes('possible_medical_advice')) return true;
    if (RISKY_INTENT_PREFIXES.some((p) => plan.intent.startsWith(p))) return true;
    return false;
  }
}

function synthesizePrecheckFailure(precheck: GroundingResult): CriticReport {
  const claims = summarizeUnsupported(precheck.unsupported);
  return {
    scores: { grounding: 1, safety: 2, on_task: 4, tone: 4 },
    overall: 11,
    pass: false,
    issues: claims,
    unsupportedClaims: precheck.unsupported.map((c) => c.text),
    source: 'precheck',
  };
}

function buildCriticAddendum(c: CriticReport): string {
  const unsupported = c.unsupportedClaims ?? [];
  const issues = c.issues ?? [];

  const parts: string[] = ['\n\nREVIEWER FEEDBACK on your previous draft:'];

  if (unsupported.length > 0) {
    parts.push(
      `These specific claims were not supported by the knowledge base and MUST be removed: ${unsupported.map((x) => `"${x}"`).join(', ')}.`,
    );
  }
  if (issues.length > 0) {
    parts.push('Issues to fix:');
    for (const i of issues) parts.push(`- ${i}`);
  }

  parts.push(
    "Rewrite the response. Be brief and warm. Never assert specific doses, durations, frequencies, percentages, or drug-interaction safety unless those exact facts appear in retrieved knowledge. For anything dose- or medication-specific, defer to the user's prescribing clinician.",
  );

  return parts.join('\n');
}

/**
 * Heuristic for mid-word/mid-sentence truncation.
 * Returns true when the response clearly ends in the middle of something —
 * a trailing dash/hyphen, a single letter, an article ("the", "a"), a
 * preposition ("of", "on", "for"), or no terminal punctuation/emoji at all.
 */
function endsMidWord(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Ends in a dash/hyphen → mid-word
  if (/[-–—]$/.test(trimmed)) return true;
  const lastTok = trimmed.split(/\s+/).pop() ?? "";
  // Ends with a stranded preposition/article (no terminal punctuation)
  const stranded = /^(the|a|an|of|on|in|to|for|with|and|or|but|so|by|at|as|is|are|was|were|be|easy|dense)$/i;
  if (stranded.test(lastTok)) return true;
  // No terminal punctuation or emoji at all
  if (!/[.!?…]$|[\p{Extended_Pictographic}]$/u.test(trimmed)) return true;
  return false;
}
