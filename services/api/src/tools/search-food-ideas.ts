import type { Logger } from 'pino';
import type { Tool } from '@grace/ai-core';
import type { LLMProvider } from '@grace/shared';

export interface FoodIdea {
  name: string;
  protein_g: number | null;
  why: string;
}

export function makeSearchFoodIdeasTool(deps: { llm: LLMProvider; logger: Logger; userId: string }): Tool {
  return {
    name: 'search_food_ideas',
    description:
      'Search the web for specific, current meal or snack ideas. Use when the user asks what to eat, requests food recommendations, snack ideas, or dinner/lunch/breakfast options. Always pass their dietary restriction (vegetarian, vegan, etc.) and any food dislikes in the query so results are safe to suggest.',
    async execute(args) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return { ok: false, error: 'empty_query' };

      try {
        const resp = await deps.llm.generate({
          messages: [
            {
              role: 'system',
              content: `You are a nutrition assistant for someone on GLP-1 medication (semaglutide or tirzepatide). Use Google Search to find specific, practical, varied meal and snack ideas.

RULES:
- Return ONLY a JSON array — no prose, no markdown outside the array
- Each item: {"name": "...", "protein_g": <number or null>, "why": "<one short reason it works on GLP-1>"}
- 4–6 items maximum
- Suggestions must be SPECIFIC (e.g. "Greek yogurt with hemp seeds" not "high-protein snack")
- Favour small, protein-dense options — GLP-1 slows digestion so smaller portions sit better
- Strictly respect any dietary restriction in the query — never include forbidden ingredients
- Vary categories: not 5 shakes, not 5 salads — mix snacks, meals, quick prep options
- Include approximate protein only when reasonably certain; use null otherwise`,
            },
            {
              role: 'user',
              content: `Find 4–6 specific high-protein meal or snack ideas for: ${query}`,
            },
          ],
          temperature: 0.4,
          maxOutputTokens: 600,
          useGoogleSearch: true,
          responseFormat: 'json',
        });

        let cleaned = resp.text
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();

        const arrStart = cleaned.indexOf('[');
        const arrEnd = cleaned.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd > arrStart) {
          cleaned = cleaned.slice(arrStart, arrEnd + 1);
        }

        let ideas: FoodIdea[];
        try {
          ideas = JSON.parse(cleaned) as FoodIdea[];
          if (!Array.isArray(ideas) || ideas.length === 0) throw new Error('empty array');
        } catch {
          deps.logger.warn(
            { userId: deps.userId, query, raw: resp.text.slice(0, 300) },
            'tool.search_food_ideas.parse_failed',
          );
          return { ok: false, error: 'parse_failed' };
        }

        deps.logger.info({ userId: deps.userId, query, count: ideas.length }, 'tool.search_food_ideas.ok');
        return { ok: true, ideas };
      } catch (err) {
        deps.logger.warn({ err, userId: deps.userId, query }, 'tool.search_food_ideas.error');
        return { ok: false, error: 'search_failed' };
      }
    },
  };
}
