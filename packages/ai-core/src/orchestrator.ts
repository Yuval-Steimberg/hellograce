import type {
  CriticReport,
  LLMProvider,
  OrchestratorInput,
  OrchestratorOutput,
  PlannerDecision,
  RetrievedDoc,
  ToolResult,
} from '@grace/shared';
import { LLMCritic } from './critic.js';
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

const SAFE_FALLBACK_TEXT =
  "I want to make sure I give you good information here — could you share a bit more about what you're hoping to learn? For anything dose- or medication-specific, your prescribing clinician is the right person to check with.";

const RISKY_INTENT_PREFIXES = ['knowledge_lookup', 'safety_'];

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
      maxOutputTokens: 400,
    });

    let validated = validateResponse(llmResp.text);
    const precheck = precheckGrounding(validated.text, input.retrieved);
    let critic: CriticReport | undefined;
    let regenerated = false;
    let usedSafeFallback = false;

    const needsReview =
      precheck.unsupported.length > 0 || this.shouldRunCritic(plan, validated);

    if (needsReview) {
      critic = await this.review(precheck, input.text, validated.text, input.retrieved);

      if (!critic.pass) {
        regenerated = true;
        const retryResp = await this.deps.llm.generate({
          messages: [
            { role: 'system', content: baseSystem + buildCriticAddendum(critic) },
            ...renderHistory(input.history),
            { role: 'user', content: input.text },
          ],
          temperature: 0.4,
          maxOutputTokens: 400,
        });
        const retryValidated = validateResponse(retryResp.text);
        const retryPrecheck = precheckGrounding(retryValidated.text, input.retrieved);
        const retryCritic = await this.review(
          retryPrecheck,
          input.text,
          retryValidated.text,
          input.retrieved,
        );

        if (retryCritic.pass) {
          validated = retryValidated;
          critic = retryCritic;
        } else {
          validated = {
            text: SAFE_FALLBACK_TEXT,
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
