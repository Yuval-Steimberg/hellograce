import type {
  LLMProvider,
  OrchestratorInput,
  OrchestratorOutput,
  ToolResult,
} from '@grace/shared';
import { PlannerAgent } from './planner.js';
import { GRACE_SYSTEM_PROMPT, renderHistory, renderRetrievalContext } from './prompts.js';
import { ToolRegistry } from './tools/registry.js';
import { validateResponse } from './validator.js';

export interface OrchestratorDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  planner?: PlannerAgent;
}

export class AIOrchestrator {
  private planner: PlannerAgent;

  constructor(private deps: OrchestratorDeps) {
    this.planner = deps.planner ?? new PlannerAgent(deps.llm);
  }

  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const started = Date.now();

    const plan = input.toolsEnabled
      ? await this.planner.plan(input.text)
      : { intent: 'chat' as const, needsTools: false, toolCalls: [], rationale: 'tools_disabled' };

    let toolResults: ToolResult[] = [];
    if (plan.needsTools && plan.toolCalls.length > 0) {
      toolResults = await this.deps.tools.executeMany(plan.toolCalls);
    }

    const systemPrompt =
      (input.systemPrompt ?? GRACE_SYSTEM_PROMPT) +
      renderRetrievalContext(input.retrieved) +
      (toolResults.length > 0 ? `\n\nTool results: ${JSON.stringify(toolResults)}` : '');

    const llmResp = await this.deps.llm.generate({
      messages: [
        { role: 'system', content: systemPrompt },
        ...renderHistory(input.history),
        { role: 'user', content: input.text },
      ],
      temperature: 0.6,
      maxOutputTokens: 400,
    });

    const validated = validateResponse(llmResp.text);

    return {
      text: validated.text,
      confidence: validated.confidence,
      intent: plan.intent,
      toolResults,
      usedRetrieval: input.retrieved.length > 0,
      latencyMs: Date.now() - started,
    };
  }
}
