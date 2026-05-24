import { AIOrchestrator } from '@grace/ai-core';
import type { ChatTurn, LLMProvider, OrchestratorOutput } from '@grace/shared';
import { ToolRegistry } from '@grace/ai-core';
import { buildMockToolRegistry } from '../eval/mockTools.js';
import { getPersona } from './personas.js';
import { generateUserMessage } from './conversation-generator.js';
import type {
  ConversationScenario,
  Persona,
  SimulatedConversation,
  SimulatedTurn,
} from './types.js';

export interface SimulatorDeps {
  llm: LLMProvider;
  tools?: ToolRegistry;
}

export class ConversationSimulator {
  private readonly llm: LLMProvider;
  private readonly tools: ToolRegistry;
  private readonly orchestrator: AIOrchestrator;

  constructor(deps: SimulatorDeps) {
    this.llm = deps.llm;
    this.tools = deps.tools ?? buildMockToolRegistry();
    this.orchestrator = new AIOrchestrator({ llm: this.llm, tools: this.tools });
  }

  async simulate(scenario: ConversationScenario): Promise<SimulatedConversation> {
    const persona = getPersona(scenario.personaId);
    if (!persona) {
      return {
        id: `conv_${scenario.id}_${Date.now()}`,
        scenarioId: scenario.id,
        personaId: scenario.personaId,
        persona: { id: scenario.personaId, name: 'Unknown' } as Persona,
        scenario,
        turns: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: `Persona "${scenario.personaId}" not found`,
      };
    }

    const turns: SimulatedTurn[] = [];
    const startedAt = new Date().toISOString();

    try {
      const userTurnCount = scenario.turnCount;

      for (let i = 0; i < userTurnCount; i++) {
        const userText = await generateUserMessage(
          this.llm,
          persona,
          scenario,
          turns,
          i,
          userTurnCount,
        );

        turns.push({
          role: 'user',
          text: userText,
          timestamp: Date.now(),
        });

        const history = this.buildHistory(turns.slice(0, -1));
        const graceOutput = await this.runOrchestrator(persona, userText, history, scenario, i === 0);

        turns.push({
          role: 'grace',
          text: graceOutput.text,
          timestamp: Date.now(),
          orchestratorMeta: {
            intent: graceOutput.intent,
            confidence: graceOutput.confidence,
            toolResults: graceOutput.toolResults,
            latencyMs: graceOutput.latencyMs,
            regenerated: graceOutput.regenerated,
            usedSafeFallback: graceOutput.usedSafeFallback,
            critic: graceOutput.critic,
          },
        });
      }
    } catch (err) {
      return {
        id: `conv_${scenario.id}_${Date.now()}`,
        scenarioId: scenario.id,
        personaId: scenario.personaId,
        persona,
        scenario,
        turns,
        startedAt,
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      id: `conv_${scenario.id}_${Date.now()}`,
      scenarioId: scenario.id,
      personaId: scenario.personaId,
      persona,
      scenario,
      turns,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async runOrchestrator(
    persona: Persona,
    text: string,
    history: ChatTurn[],
    scenario: ConversationScenario,
    isFirst: boolean,
  ): Promise<OrchestratorOutput> {
    return this.orchestrator.run({
      userId: `sim-${persona.id}`,
      text,
      history,
      retrieved: scenario.setup
        ? [{ id: 'setup-ctx', source: 'history', content: scenario.setup, score: 0.95 }]
        : [],
      toolsEnabled: true,
      userFirstName: persona.name,
      isFirstMessage: isFirst,
      foodDislikes: persona.foodDislikes,
      medicationType: persona.medicationType,
      dietaryRestriction: persona.dietaryRestriction
        ? buildDietaryRestriction(persona.dietaryRestriction)
        : undefined,
      userMemories: this.buildMemories(persona),
    });
  }

  private buildHistory(turns: SimulatedTurn[]): ChatTurn[] {
    return turns.map((t) => ({
      role: t.role === 'user' ? 'user' as const : 'assistant' as const,
      content: t.text,
      createdAt: new Date(t.timestamp),
    }));
  }

  private buildMemories(persona: Persona): string[] {
    const memories: string[] = [];
    if (persona.weight) {
      memories.push(`Current weight: ${persona.weight.current} lbs, goal: ${persona.weight.goal} lbs`);
    }
    memories.push(`On ${persona.medication} for ${persona.weekOnGlp1} weeks`);
    if (persona.dietaryRestriction) {
      memories.push(`Follows a ${persona.dietaryRestriction.toLowerCase()} diet`);
    }
    if (persona.foodDislikes?.length) {
      memories.push(`Dislikes: ${persona.foodDislikes.join(', ')}`);
    }
    for (const goal of persona.goals) {
      memories.push(`Goal: ${goal}`);
    }
    return memories;
  }
}

function buildDietaryRestriction(label: 'VEGAN' | 'VEGETARIAN' | 'PESCATARIAN') {
  const restrictions = {
    VEGAN: {
      label: 'VEGAN' as const,
      forbidden: ['chicken', 'beef', 'pork', 'fish', 'eggs', 'dairy', 'cheese', 'yogurt', 'milk', 'honey'],
      allowed: ['tofu', 'tempeh', 'lentils', 'chickpeas', 'hemp seeds', 'nutritional yeast', 'seitan'],
    },
    VEGETARIAN: {
      label: 'VEGETARIAN' as const,
      forbidden: ['chicken', 'beef', 'pork', 'fish', 'turkey', 'bacon', 'steak'],
      allowed: ['eggs', 'greek yogurt', 'cottage cheese', 'tofu', 'lentils', 'chickpeas', 'tempeh'],
    },
    PESCATARIAN: {
      label: 'PESCATARIAN' as const,
      forbidden: ['chicken', 'beef', 'pork', 'turkey', 'bacon', 'steak'],
      allowed: ['salmon', 'tuna', 'shrimp', 'eggs', 'tofu', 'lentils', 'greek yogurt'],
    },
  };
  return restrictions[label];
}
