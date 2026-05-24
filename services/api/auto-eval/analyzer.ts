import type {
  AutoEvalReport,
  ConversationEvaluation,
  EvalDimensionName,
  PatternAnalysis,
  RegressionFlag,
  ScenarioCategory,
} from './types.js';

export function analyzeResults(
  evaluations: ConversationEvaluation[],
  previousReport?: AutoEvalReport | null,
): {
  patterns: PatternAnalysis[];
  regressions: RegressionFlag[];
  suggestions: string[];
} {
  const patterns = detectPatterns(evaluations);
  const regressions = previousReport ? detectRegressions(evaluations, previousReport) : [];
  const suggestions = generateSuggestions(patterns, evaluations);
  return { patterns, regressions, suggestions };
}

function detectPatterns(evaluations: ConversationEvaluation[]): PatternAnalysis[] {
  const patterns: PatternAnalysis[] = [];
  const issueMap = new Map<string, { convIds: string[]; scores: number[] }>();

  for (const evaluation of evaluations) {
    for (const turnEval of evaluation.turnEvaluations) {
      for (const dim of turnEval.dimensions) {
        if (dim.score < 3) {
          const key = `low_${dim.name}`;
          const entry = issueMap.get(key) ?? { convIds: [], scores: [] };
          entry.convIds.push(evaluation.conversationId);
          entry.scores.push(dim.score);
          issueMap.set(key, entry);
        }
      }

      for (const issue of turnEval.criticalIssues) {
        const normalized = normalizeIssue(issue);
        const entry = issueMap.get(normalized) ?? { convIds: [], scores: [] };
        entry.convIds.push(evaluation.conversationId);
        entry.scores.push(turnEval.overallScore);
        issueMap.set(normalized, entry);
      }

      for (const weakness of turnEval.weaknesses) {
        const normalized = normalizeIssue(weakness);
        const entry = issueMap.get(normalized) ?? { convIds: [], scores: [] };
        entry.convIds.push(evaluation.conversationId);
        entry.scores.push(turnEval.overallScore);
        issueMap.set(normalized, entry);
      }
    }

    for (const issue of evaluation.conversationLevelIssues) {
      const normalized = normalizeIssue(issue);
      const entry = issueMap.get(normalized) ?? { convIds: [], scores: [] };
      entry.convIds.push(evaluation.conversationId);
      entry.scores.push(evaluation.overallScore);
      issueMap.set(normalized, entry);
    }
  }

  for (const [pattern, data] of issueMap) {
    if (data.convIds.length < 2) continue;

    const avgScore = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
    const uniqueConvIds = [...new Set(data.convIds)];

    patterns.push({
      pattern,
      frequency: uniqueConvIds.length,
      avgScoreImpact: 5 - avgScore,
      exampleConversationIds: uniqueConvIds.slice(0, 5),
      suggestedFix: suggestFix(pattern),
      category: categorizePattern(pattern),
    });
  }

  patterns.sort((a, b) => {
    const aWeight = a.frequency * a.avgScoreImpact;
    const bWeight = b.frequency * b.avgScoreImpact;
    return bWeight - aWeight;
  });

  return patterns.slice(0, 20);
}

function detectRegressions(
  evaluations: ConversationEvaluation[],
  previousReport: AutoEvalReport,
): RegressionFlag[] {
  const regressions: RegressionFlag[] = [];

  const currentByDim = new Map<EvalDimensionName, number[]>();
  for (const evaluation of evaluations) {
    for (const turnEval of evaluation.turnEvaluations) {
      for (const dim of turnEval.dimensions) {
        const list = currentByDim.get(dim.name) ?? [];
        list.push(dim.score);
        currentByDim.set(dim.name, list);
      }
    }
  }

  for (const [dimName, scores] of currentByDim) {
    const currentAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const prevData = previousReport.scoreByDimension[dimName];
    if (!prevData) continue;

    const delta = currentAvg - prevData.avg;
    if (delta < -0.3) {
      regressions.push({
        dimension: dimName,
        previousAvg: prevData.avg,
        currentAvg,
        delta,
        significance: delta < -1 ? 'high' : delta < -0.5 ? 'medium' : 'low',
      });
    }
  }

  regressions.sort((a, b) => a.delta - b.delta);
  return regressions;
}

function generateSuggestions(
  patterns: PatternAnalysis[],
  evaluations: ConversationEvaluation[],
): string[] {
  const suggestions: string[] = [];

  const categoryScores = new Map<ScenarioCategory, number[]>();
  for (const evaluation of evaluations) {
    const list = categoryScores.get(evaluation.category) ?? [];
    list.push(evaluation.overallScore);
    categoryScores.set(evaluation.category, list);
  }

  for (const [cat, scores] of categoryScores) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg < 3) {
      suggestions.push(`Category "${cat}" scores below threshold (avg ${avg.toFixed(2)}). Investigate prompt handling for this scenario type.`);
    }
  }

  for (const pattern of patterns.slice(0, 5)) {
    if (pattern.frequency >= 3) {
      suggestions.push(`Recurring issue: "${pattern.pattern}" (${pattern.frequency} occurrences). ${pattern.suggestedFix}`);
    }
  }

  const safeFallbackCount = evaluations.reduce((count, e) => {
    for (const te of e.turnEvaluations) {
      const hasFallback = te.weaknesses.some((w) =>
        w.toLowerCase().includes('fallback') || w.toLowerCase().includes('generic'),
      );
      if (hasFallback) count++;
    }
    return count;
  }, 0);

  const totalTurns = evaluations.reduce((sum, e) => sum + e.turnEvaluations.length, 0);
  if (totalTurns > 0 && safeFallbackCount / totalTurns > 0.1) {
    suggestions.push(
      `Safe fallback rate is ${((safeFallbackCount / totalTurns) * 100).toFixed(1)}% — investigate why the orchestrator fails to generate valid responses.`,
    );
  }

  return suggestions;
}

function normalizeIssue(issue: string): string {
  return issue
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function suggestFix(pattern: string): string {
  if (pattern.includes('relevance') || pattern.includes('topic'))
    return 'Review TOPIC PIVOT rules in system prompt. Add stronger "respond to current message first" instructions.';
  if (pattern.includes('tone') || pattern.includes('empathy'))
    return 'Review tone-matching rules. Add communication-style-awareness to the system prompt.';
  if (pattern.includes('repetition') || pattern.includes('generic'))
    return 'Strengthen EVERY RESPONSE IS UNIQUE rule. Add more variety examples.';
  if (pattern.includes('question') || pattern.includes('unnecessary'))
    return 'Review QUESTION RULE — default should be NO question mark.';
  if (pattern.includes('hallucination') || pattern.includes('memory'))
    return 'Review memory injection. Ensure user memories are passed correctly and not over-interpreted.';
  if (pattern.includes('concise') || pattern.includes('length'))
    return 'Review BRIEF REPLY RULE. Short user messages should get short responses.';
  if (pattern.includes('guardrail') || pattern.includes('medical'))
    return 'Review medical boundary rules and content guardbands.';
  return 'Investigate specific cases and update system prompt or content rules.';
}

function categorizePattern(pattern: string): PatternAnalysis['category'] {
  if (pattern.includes('guardrail') || pattern.includes('medical') || pattern.includes('safety'))
    return 'guardrail';
  if (pattern.includes('tone') || pattern.includes('empathy') || pattern.includes('natural'))
    return 'tone';
  if (pattern.includes('memory') || pattern.includes('context'))
    return 'memory';
  if (pattern.includes('tool') || pattern.includes('log'))
    return 'tool';
  if (pattern.includes('repetition') || pattern.includes('generic') || pattern.includes('fallback'))
    return 'content';
  return 'prompt';
}
