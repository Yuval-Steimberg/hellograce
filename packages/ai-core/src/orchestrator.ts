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

const SAFE_FALLBACK_TEXTS = [
  "Not sure I got all of that. Can you say it another way?",
  "I missed something there. Can you give me a bit more to go on?",
  "Hmm, I didn't quite follow. Can you rephrase that?",
  "I want to make sure I get this right. Can you say more?",
  "I think I missed part of what you meant. What's going on?",
];
let _safeFallbackIdx = 0;
function getNextSafeFallback(): string {
  const text = SAFE_FALLBACK_TEXTS[_safeFallbackIdx % SAFE_FALLBACK_TEXTS.length]!;
  _safeFallbackIdx++;
  return text;
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

    const plan: PlannerDecision = input.toolsEnabled
      ? await this.planner.plan(input.text)
      : { intent: 'chat', needsTools: false, toolCalls: [], rationale: 'tools_disabled' };

    let toolResults: ToolResult[] = [];
    if (plan.needsTools && plan.toolCalls.length > 0) {
      toolResults = await this.deps.tools.executeMany(plan.toolCalls);
    }

    const baseSystem =
      (input.systemPrompt ?? GRACE_SYSTEM_PROMPT) +
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
      // 700 was producing mid-word truncation (e.g. "easy-to-" cut off).
      // 2048 leaves plenty of room for thinking + a 1–3 sentence reply.
      maxOutputTokens: 2048,
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
    };
    const contentViolations: ContentViolation[] = checkContent(validated.text, contentCheckOpts);

    // Detect mid-word/mid-sentence truncation (e.g. "...easy-to-" cut off by
    // hitting maxOutputTokens). Forces the critic→regen path so the user
    // never sees a half-sentence reply.
    const truncated =
      llmResp.finishReason === 'length' || endsMidWord(validated.text);

    const needsReview =
      truncated ||
      contentViolations.length > 0 ||
      precheck.unsupported.length > 0 ||
      this.shouldRunCritic(plan, validated);

    if (needsReview) {
      critic = await this.review(precheck, input.text, validated.text, input.retrieved);

      // Treat a content-rule violation (forbidden food) as a hard fail even
      // if the LLM-critic thinks the draft was fine — Gemini-as-judge often
      // misses dietary slips because it doesn't track the conversation state.
      const hardFail = !critic.pass || contentViolations.length > 0;

      if (hardFail) {
        regenerated = true;
        const addendum =
          buildCriticAddendum(critic) +
          (contentViolations.length > 0
            ? buildContentRegenInstruction(contentViolations, input.dietaryRestriction)
            : '');
        const retryResp = await this.deps.llm.generate({
          messages: [
            { role: 'system', content: baseSystem + addendum },
            ...renderHistory(input.history),
            { role: 'user', content: input.text },
          ],
          temperature: 0.4,
          maxOutputTokens: 2048,
        });
        const retryFormatted = enforceFormat(retryResp.text, stripName ? { stripFirstName: stripName } : {});
        const retryValidated = validateResponse(retryFormatted.text);
        const retryPrecheck = precheckGrounding(retryValidated.text, input.retrieved);
        const retryContentViolations = checkContent(retryValidated.text, contentCheckOpts);
        const retryCritic = await this.review(
          retryPrecheck,
          input.text,
          retryValidated.text,
          input.retrieved,
        );

        if (retryCritic.pass && retryContentViolations.length === 0) {
          validated = retryValidated;
          critic = retryCritic;
        } else {
          validated = {
            text: getNextSafeFallback(),
            confidence: 'low',
            flags: ['safe_fallback'],
          };
          critic = retryCritic;
          usedSafeFallback = true;
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
