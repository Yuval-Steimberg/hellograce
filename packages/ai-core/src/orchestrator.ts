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
    "Let me think on that — what are you in the mood for?",
    "Good question. Any foods you're trying to avoid right now?",
    "Happy to help with ideas — what sounds good to you?",
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
    "That's a great question. Can you tell me a bit more about what you're experiencing?",
    "I want to give you a good answer on that — can you share a bit more context?",
    "Good question. Let me think through that with you — what prompted this?",
  ],
  gibberish: [
    "Hey! What's on your mind today?",
    "I'm here — what would you like to talk about?",
    "What's going on? Feel free to share anything.",
  ],
  general: [
    "I want to make sure I get this right — can you say a bit more?",
    "I think I missed part of what you meant. What's going on?",
    "Can you give me a bit more to go on?",
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

// Only run the LLM critic for genuinely dangerous intent categories.
// `knowledge_lookup` was here but it's too broad — food/nutrition questions
// get treated as risky and the critic then fails on USDA protein-gram facts
// that aren't verbatim in retrieved KB chunks. The validator's
// `possible_medical_advice` flag handles the cases we care about.
const RISKY_INTENT_PREFIXES = ['safety_'];

export class AIOrchestrator {
  private planner: PlannerAgent;
  private critic: LLMCritic;

  constructor(private deps: OrchestratorDeps) {
    this.planner = deps.planner ?? new PlannerAgent(deps.llm);
    this.critic = deps.critic ?? new LLMCritic(deps.llm);
  }

  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const started = Date.now();

    // Fast deterministic classifier — drives typed fallbacks and planner skip.
    // Greetings and gibberish never need a Gemini planning call.
    const classification = classifyMessage(input.text);
    const skipPlanner = classification.type === 'greeting' || classification.type === 'gibberish';

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
    // ai.service.ts from the user_memories table.
    const memoryBlock = input.userMemories && input.userMemories.length > 0
      ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nWHAT YOU REMEMBER ABOUT THIS USER (from past conversations):\n${input.userMemories.map((m) => `- ${m}`).join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
      : '';

    const baseSystem =
      (input.systemPrompt ?? GRACE_SYSTEM_PROMPT) +
      memoryBlock +
      renderRetrievalContext(input.retrieved) +
      (toolResults.length > 0 ? `\n\nTool results: ${JSON.stringify(toolResults)}` : '');

    const llmResp = await this.deps.llm.generate({
      messages: [
        { role: 'system', content: baseSystem },
        ...renderHistory(input.history),
        { role: 'user', content: input.text },
      ],
      temperature: 0.6,
      // Gemini 2.5 Flash burns budget on internal thinking BEFORE output.
      // 800 was too tight when memories + tool results + retrieval context
      // were all packed in — Flash returned empty text and the orchestrator
      // fell through to the safe fallback. 1400 leaves enough thinking
      // budget for the 71k-char system prompt without going back to 2048.
      maxOutputTokens: 1400,
    });

    // ─── Format enforcement (silent auto-fix) ─────────────────────────
    // Strip em dashes, markdown bold, numbered lists, etc. that Gemini Flash
    // emits despite the system prompt's "BANNED" rules. This always runs and
    // never triggers a regen — it's just a deterministic cleanup pass.
    // The user's first name is also stripped here on non-welcome turns
    // (NAME USAGE ZERO TOLERANCE).
    const stripName = !input.isFirstMessage && input.userFirstName ? input.userFirstName : undefined;
    const formatted = enforceFormat(llmResp.text, stripName ? { stripFirstName: stripName } : {});
    let validated = validateResponse(formatted.text);
    const precheck = precheckGrounding(validated.text, input.retrieved);
    let critic: CriticReport | undefined;
    let regenerated = false;
    let usedSafeFallback = false;

    // ─── Content-rule enforcement (force regen on violation) ──────────
    // Forbidden foods given a dietary restriction. We must regen — there's
    // no way to "fix" a chicken recommendation to a vegetarian via string
    // replacement.
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

    // Detect mid-word/mid-sentence truncation (e.g. "...easy-to-" cut off by
    // hitting maxOutputTokens). Forces the critic→regen path so the user
    // never sees a half-sentence reply.
    const truncated =
      llmResp.finishReason === 'length' || endsMidWord(validated.text);

    const needsReview =
      truncated ||
      regenViolations.length > 0 ||
      precheck.unsupported.length > 0 ||
      this.shouldRunCritic(plan, validated);

    if (needsReview) {
      critic = await this.review(precheck, input.text, validated.text, input.retrieved);

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
            { role: 'user', content: input.text },
          ],
          temperature: 0.4,
          maxOutputTokens: 1400,
        });
        const retryFormatted = enforceFormat(retryResp.text, stripName ? { stripFirstName: stripName } : {});
        const retryValidated = validateResponse(retryFormatted.text);
        const retryPrecheck = precheckGrounding(retryValidated.text, input.retrieved);
        const retryContentViolations = checkContent(retryValidated.text, contentCheckOpts);
        // Re-check block violations on the retry; if the model still emits one,
        // fall through to safe fallback below.
        const retryBlockViolations = retryContentViolations.filter((v) => v.severity === 'block');
        const retryRegenViolations = retryContentViolations.filter(
          (v) => !v.severity || v.severity === 'regen',
        );
        const retryCritic = await this.review(
          retryPrecheck,
          input.text,
          retryValidated.text,
          input.retrieved,
        );

        if (retryCritic.pass && retryRegenViolations.length === 0 && retryBlockViolations.length === 0) {
          validated = retryValidated;
          critic = retryCritic;
        } else {
          // Last resort BEFORE the canned safe fallback: ask Gemini to answer
          // with Google Search grounding. If the KB has nothing on a topic
          // (e.g. recent research, GLP-1 muscle-loss percentages we don't index)
          // the web has the answer. The model is forced to cite, and content
          // checks still apply. Only blocks if web search ALSO returns nothing
          // usable or violates a block-severity rule.
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
        maxOutputTokens: 1200,
        useGoogleSearch: true,
      });
      const formatted = enforceFormat(webResp.text, stripName ? { stripFirstName: stripName } : {});
      const validated = validateResponse(formatted.text);
      if (!validated.text || validated.text.trim().length === 0) return null;
      const webViolations = checkContent(validated.text, contentCheckOpts);
      // Block AND regen violations both disqualify the web result. We can't
      // regen here (no chat history + web grounding context), so if the web
      // answer still contains a banned phrase or forbidden food we fall through
      // to the safe fallback rather than delivering a guideline-violating reply.
      if (webViolations.some((v) => v.severity === 'block' || !v.severity || v.severity === 'regen')) return null;
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
