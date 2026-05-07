import type { Logger } from 'pino';
import type { Tool } from '@grace/ai-core';
import type { RagService } from '../rag/rag.service.js';

export function makeKnowledgeSearchTool(deps: { rag: RagService; logger: Logger; userId: string }): Tool {
  return {
    name: 'knowledge_search',
    description: 'Search the GLP-1 knowledge base for relevant guidance.',
    async execute(args) {
      const query = typeof args['query'] === 'string' ? (args['query'] as string).trim() : '';
      if (!query) return { ok: false, error: 'empty_query' };
      const docs = await deps.rag.retrieve(query, { userId: deps.userId, topK: 4 });
      const filtered = docs.filter((d) => d.source === 'knowledge');
      deps.logger.info({ userId: deps.userId, query, hits: filtered.length }, 'tool.knowledge.ok');
      return { hits: filtered };
    },
  };
}
