import type {
  CriticReport,
  LLMProvider,
  OrchestratorInput,
  OrchestratorOutput,
  PlannerDecision,
  ToolResult,
} from '@grace/shared';
import { LLMCritic } from './critic.js';
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
    let critic: CriticReport | undefined;
    let regenerated = false;
    let usedSafeFallback = false;

    if (this.shouldRunCritic(plan, validated)) {
      critic = await this.critic.evaluate({
        userText: input.text,
        response: validated.text,
        retrieved: input.retrieved,
      });

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
        const retryCritic = await this.critic.evaluate({
          userText: input.text,
          response: retryValidated.text,
          retrieved: input.retrieved,
        });

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
   * Risk-gate: the LLM-critic costs an extra Gemini call per message.
   * We only invoke it where the failure modes are dangerous or expensive
   * (medical advice, KB lookups, low-confidence drafts).
   */
  private shouldRunCritic(plan: PlannerDecision, v: ValidationResult): boolean {
    if (v.confidence === 'low') return true;
    if (v.flags.includes('possible_medical_advice')) return true;
    if (RISKY_INTENT_PREFIXES.some((p) => plan.intent.startsWith(p))) return true;
    return false;
  }
}

function buildCriticAddendum(c: CriticReport): string {
  if (c.issues.length === 0) {
    return '\n\nREVIEWER FEEDBACK: your previous draft scored low. Be more cautious, more concise, and never give specific dose or medication advice — defer to the user\'s prescribing clinician for those.';
  }
  const bullets = c.issues.map((i) => `- ${i}`).join('\n');
  return `\n\nREVIEWER FEEDBACK on your previous draft:\n${bullets}\n\nRewrite the response addressing these issues. Stay brief and warm. Never give specific dose or medication advice — for those, defer to the user's prescribing clinician.`;
}
