import { AIOrchestrator } from '@grace/ai-core';
import { buildMockToolRegistry } from '../eval/mockTools.js';
import { getPersona } from './personas.js';
import { generateUserMessage } from './conversation-generator.js';
export class ConversationSimulator {
    llm;
    tools;
    orchestrator;
    constructor(deps) {
        this.llm = deps.llm;
        this.tools = deps.tools ?? buildMockToolRegistry();
        this.orchestrator = new AIOrchestrator({ llm: this.llm, tools: this.tools });
    }
    async simulate(scenario) {
        const persona = getPersona(scenario.personaId);
        if (!persona) {
            return {
                id: `conv_${scenario.id}_${Date.now()}`,
                scenarioId: scenario.id,
                personaId: scenario.personaId,
                persona: { id: scenario.personaId, name: 'Unknown' },
                scenario,
                turns: [],
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                error: `Persona "${scenario.personaId}" not found`,
            };
        }
        const turns = [];
        const startedAt = new Date().toISOString();
        try {
            const userTurnCount = scenario.turnCount;
            for (let i = 0; i < userTurnCount; i++) {
                const userText = await generateUserMessage(this.llm, persona, scenario, turns, i, userTurnCount);
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
        }
        catch (err) {
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
    async runOrchestrator(persona, text, history, scenario, isFirst) {
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
    buildHistory(turns) {
        return turns.map((t) => ({
            role: t.role === 'user' ? 'user' : 'assistant',
            content: t.text,
            createdAt: new Date(t.timestamp),
        }));
    }
    buildMemories(persona) {
        const memories = [];
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
function buildDietaryRestriction(label) {
    const restrictions = {
        VEGAN: {
            label: 'VEGAN',
            forbidden: ['chicken', 'beef', 'pork', 'fish', 'eggs', 'dairy', 'cheese', 'yogurt', 'milk', 'honey'],
            allowed: ['tofu', 'tempeh', 'lentils', 'chickpeas', 'hemp seeds', 'nutritional yeast', 'seitan'],
        },
        VEGETARIAN: {
            label: 'VEGETARIAN',
            forbidden: ['chicken', 'beef', 'pork', 'fish', 'turkey', 'bacon', 'steak'],
            allowed: ['eggs', 'greek yogurt', 'cottage cheese', 'tofu', 'lentils', 'chickpeas', 'tempeh'],
        },
        PESCATARIAN: {
            label: 'PESCATARIAN',
            forbidden: ['chicken', 'beef', 'pork', 'turkey', 'bacon', 'steak'],
            allowed: ['salmon', 'tuna', 'shrimp', 'eggs', 'tofu', 'lentils', 'greek yogurt'],
        },
    };
    return restrictions[label];
}
