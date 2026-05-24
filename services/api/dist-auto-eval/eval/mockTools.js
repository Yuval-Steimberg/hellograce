import { ToolRegistry } from '@grace/ai-core';
/**
 * Mock registry for the eval harness. Each tool returns a canned successful
 * result — we are evaluating the planner+LLM behavior, not DB-side effects.
 * Real tools live in services/api/src/tools/ and are integration-tested
 * separately.
 */
export function buildMockToolRegistry() {
    const registry = new ToolRegistry();
    for (const tool of MOCK_TOOLS)
        registry.register(tool);
    return registry;
}
const MOCK_TOOLS = [
    {
        name: 'log_food',
        description: 'Log a meal',
        execute: async (args) => ({
            logged: true,
            protein_g: 30,
            kcal: 450,
            args,
        }),
    },
    {
        name: 'log_weight',
        description: 'Log weight',
        execute: async (args) => ({ logged: true, args }),
    },
    {
        name: 'log_mood',
        description: 'Log mood',
        execute: async (args) => ({ logged: true, args }),
    },
    {
        name: 'log_side_effect',
        description: 'Log side effect',
        execute: async (args) => ({ logged: true, followup_scheduled: true, args }),
    },
    {
        name: 'knowledge_search',
        description: 'Search GLP-1 KB',
        execute: async (args) => ({
            results: [
                {
                    content: 'GLP-1 medications can cause GI side effects including nausea, constipation, and reduced appetite. Always consult your prescriber for personal guidance.',
                    score: 0.82,
                },
            ],
            args,
        }),
    },
    {
        name: 'get_user_profile',
        description: 'Read user goals/profile',
        execute: async () => ({
            goals: ['lose 30 lbs over 6 months', 'hit 80g protein daily'],
            medication: 'semaglutide 1mg weekly',
            weight_lbs: 198,
        }),
    },
    {
        name: 'get_weight_trend',
        description: 'Last 10 weights + trend',
        execute: async () => ({
            trend: 'down',
            entries: [
                { date: '2026-05-01', lbs: 200 },
                { date: '2026-05-08', lbs: 198 },
            ],
        }),
    },
    {
        name: 'get_food_summary',
        description: "Today's protein + kcal",
        execute: async () => ({
            protein_g: 62,
            kcal: 1420,
            protein_goal_met: false,
        }),
    },
];
