export function buildReport(evaluations, patterns, regressions, suggestions, preferencePairCount, model) {
    const totalTurns = evaluations.reduce((sum, e) => sum + e.turnEvaluations.length, 0);
    const allTurnScores = evaluations.flatMap((e) => e.turnEvaluations.map((t) => t.overallScore));
    const overallScore = allTurnScores.length > 0
        ? allTurnScores.reduce((a, b) => a + b, 0) / allTurnScores.length
        : 0;
    const passedTurns = evaluations.reduce((sum, e) => sum + e.turnEvaluations.filter((t) => t.passed).length, 0);
    const passRate = totalTurns > 0 ? passedTurns / totalTurns : 0;
    const scoreByCategory = buildCategoryScores(evaluations);
    const scoreByDimension = buildDimensionScores(evaluations);
    const worstConversations = [...evaluations]
        .sort((a, b) => a.overallScore - b.overallScore)
        .slice(0, 10);
    return {
        runId: `run_${Date.now()}`,
        timestamp: new Date().toISOString(),
        model,
        totalConversations: evaluations.length,
        totalTurns,
        overallScore,
        passRate,
        scoreByCategory,
        scoreByDimension,
        topPatterns: patterns,
        worstConversations,
        preferencePairsGenerated: preferencePairCount,
        regressions,
        improvementSuggestions: suggestions,
    };
}
function buildCategoryScores(evaluations) {
    const byCategory = new Map();
    for (const e of evaluations) {
        const list = byCategory.get(e.category) ?? [];
        list.push(e);
        byCategory.set(e.category, list);
    }
    const result = {};
    for (const [cat, evals] of byCategory) {
        const scores = evals.map((e) => e.overallScore);
        const passed = evals.reduce((sum, e) => sum + e.turnEvaluations.filter((t) => t.passed).length, 0);
        const total = evals.reduce((sum, e) => sum + e.turnEvaluations.length, 0);
        result[cat] = {
            avg: scores.reduce((a, b) => a + b, 0) / scores.length,
            count: evals.length,
            passRate: total > 0 ? passed / total : 0,
            worstScore: Math.min(...scores),
        };
    }
    return result;
}
function buildDimensionScores(evaluations) {
    const byDim = new Map();
    for (const e of evaluations) {
        for (const te of e.turnEvaluations) {
            for (const dim of te.dimensions) {
                const list = byDim.get(dim.name) ?? [];
                list.push(dim.score);
                byDim.set(dim.name, list);
            }
        }
    }
    const result = {};
    for (const [name, scores] of byDim) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const failures = scores.filter((s) => s < 3).length;
        result[name] = { avg, failRate: failures / scores.length };
    }
    return result;
}
export function formatReport(report) {
    const lines = [];
    lines.push('');
    lines.push('='.repeat(78));
    lines.push(`  GRACE AUTO-EVALUATION REPORT`);
    lines.push(`  ${report.timestamp} | model: ${report.model}`);
    lines.push('='.repeat(78));
    lines.push('');
    lines.push('SUMMARY');
    lines.push('-'.repeat(40));
    lines.push(`  Conversations:      ${report.totalConversations}`);
    lines.push(`  Total turns:        ${report.totalTurns}`);
    lines.push(`  Overall score:      ${report.overallScore.toFixed(2)} / 5.00`);
    lines.push(`  Pass rate:          ${pct(report.passRate)}`);
    lines.push(`  Preference pairs:   ${report.preferencePairsGenerated}`);
    lines.push('');
    lines.push('SCORES BY CATEGORY');
    lines.push('-'.repeat(78));
    const cats = Object.entries(report.scoreByCategory)
        .sort(([, a], [, b]) => a.avg - b.avg);
    for (const [cat, data] of cats) {
        const bar = scoreBar(data.avg);
        lines.push(`  ${cat.padEnd(22)} ${bar} ${data.avg.toFixed(2)}  pass:${pct(data.passRate).padStart(4)}  worst:${data.worstScore.toFixed(2)}  (n=${data.count})`);
    }
    lines.push('');
    lines.push('SCORES BY DIMENSION');
    lines.push('-'.repeat(78));
    const dims = Object.entries(report.scoreByDimension)
        .sort(([, a], [, b]) => a.avg - b.avg);
    for (const [dim, data] of dims) {
        const bar = scoreBar(data.avg);
        lines.push(`  ${dim.padEnd(28)} ${bar} ${data.avg.toFixed(2)}  fail:${pct(data.failRate).padStart(5)}`);
    }
    lines.push('');
    if (report.regressions.length > 0) {
        lines.push('REGRESSIONS DETECTED');
        lines.push('-'.repeat(60));
        for (const reg of report.regressions) {
            const icon = reg.significance === 'high' ? '!!!' : reg.significance === 'medium' ? '!!' : '!';
            lines.push(`  ${icon} ${reg.dimension}: ${reg.previousAvg.toFixed(2)} -> ${reg.currentAvg.toFixed(2)} (${reg.delta > 0 ? '+' : ''}${reg.delta.toFixed(2)})`);
        }
        lines.push('');
    }
    if (report.topPatterns.length > 0) {
        lines.push('TOP RECURRING PATTERNS');
        lines.push('-'.repeat(60));
        for (const pattern of report.topPatterns.slice(0, 10)) {
            lines.push(`  [${pattern.category}] "${pattern.pattern}" (${pattern.frequency}x, impact: ${pattern.avgScoreImpact.toFixed(2)})`);
            lines.push(`    Fix: ${pattern.suggestedFix}`);
        }
        lines.push('');
    }
    if (report.worstConversations.length > 0) {
        lines.push('WORST CONVERSATIONS');
        lines.push('-'.repeat(78));
        for (const conv of report.worstConversations.slice(0, 5)) {
            lines.push(`  [${conv.scenarioId}] score: ${conv.overallScore.toFixed(2)} | persona: ${conv.personaId} | cat: ${conv.category}`);
            lines.push(`    ${conv.summary}`);
            if (conv.conversationLevelIssues.length > 0) {
                for (const issue of conv.conversationLevelIssues.slice(0, 2)) {
                    lines.push(`    - ${issue}`);
                }
            }
            for (const te of conv.turnEvaluations) {
                if (!te.passed) {
                    lines.push(`    Turn ${te.turnIndex + 1}: ${te.overallScore.toFixed(1)} — user: "${truncate(te.userMessage, 40)}"`);
                    for (const ci of te.criticalIssues) {
                        lines.push(`      CRITICAL: ${ci}`);
                    }
                    for (const dim of te.dimensions.filter((d) => d.score < 3)) {
                        lines.push(`      ${dim.name}: ${dim.score}/5 — ${dim.reasoning}`);
                    }
                }
            }
            lines.push('');
        }
    }
    if (report.improvementSuggestions.length > 0) {
        lines.push('IMPROVEMENT SUGGESTIONS');
        lines.push('-'.repeat(60));
        for (const sug of report.improvementSuggestions) {
            lines.push(`  -> ${sug}`);
        }
        lines.push('');
    }
    lines.push('='.repeat(78));
    return lines.join('\n');
}
function pct(x) {
    return `${Math.round(x * 100)}%`;
}
function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n - 1) + '...';
}
function scoreBar(score) {
    const filled = Math.round(score);
    const empty = 5 - filled;
    return '[' + '#'.repeat(filled) + '.'.repeat(empty) + ']';
}
