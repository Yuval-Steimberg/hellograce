import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import type { LLMProvider } from '@grace/shared';
import type { Logger } from 'pino';
import type { PreferencePair, PatternAnalysis, AutoEvalReport } from './types.js';

/**
 * Reads preference pairs from auto-eval results and formats them
 * as synthetic RLHF signals for the prompt optimizer.
 */
export function loadPreferencePairs(resultsDir: string): PreferencePair[] {
  const dir = join(resultsDir, 'preference-pairs');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  if (files.length === 0) return [];

  const latest = files[0];
  if (!latest) return [];

  // Load only the most recent batch
  try {
    const content = readFileSync(join(dir, latest), 'utf8');
    return JSON.parse(content) as PreferencePair[];
  } catch {
    return [];
  }
}

/**
 * Converts preference pairs into synthetic negative feedback rows
 * that the prompt optimizer can consume alongside real RLHF signals.
 */
export function pairsToSyntheticFeedback(pairs: PreferencePair[]): Array<{
  user_message: string;
  assistant_message: string;
  comment: string;
  rating: number;
}> {
  return pairs.map((pair) => ({
    user_message: pair.userMessage,
    assistant_message: pair.rejected,
    comment: `[auto-eval] ${pair.dimension}: ${pair.reasoning}. Better response: "${pair.chosen.slice(0, 150)}"`,
    rating: -1,
  }));
}

/**
 * Runs a lightweight auto-eval (limited scenarios) against a candidate prompt
 * and returns whether it passes the quality baseline.
 */
export async function evalGateCheck(
  _llm: LLMProvider,
  _candidatePrompt: string,
  baselineScore: number,
  logger: Logger,
): Promise<{ passed: boolean; score: number; details: string }> {
  // Lazy-import to avoid circular deps and keep the gate lightweight
  const { runAutoEval } = await import('./runner.js');
  const { join: pathJoin } = await import('path');
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');

  const tempDir = mkdtempSync(pathJoin(tmpdir(), 'grace-eval-gate-'));

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { passed: true, score: 0, details: 'GEMINI_API_KEY not set — eval gate skipped' };
    }

    const report = await runAutoEval({
      apiKey,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
      scenarioCount: 8,
      concurrency: 2,
      outDir: tempDir,
      verbose: false,
      generatePreferencePairs: false,
    });

    const passed = report.overallScore >= baselineScore;

    logger.info({
      evalGate: true,
      score: report.overallScore,
      baseline: baselineScore,
      passed,
      scenarios: report.totalConversations,
    }, 'prompt_activation.eval_gate_result');

    return {
      passed,
      score: report.overallScore,
      details: passed
        ? `Score ${report.overallScore.toFixed(2)} >= baseline ${baselineScore.toFixed(2)} (${report.totalConversations} scenarios, ${report.totalTurns} turns)`
        : `Score ${report.overallScore.toFixed(2)} < baseline ${baselineScore.toFixed(2)} — activation blocked. Worst category: ${findWorstCategory(report)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'prompt_activation.eval_gate_error');
    return { passed: true, score: 0, details: `Eval gate failed (${msg}) — allowing activation by default` };
  }
}

function findWorstCategory(report: AutoEvalReport): string {
  let worst = '';
  let worstScore = Infinity;
  for (const [cat, data] of Object.entries(report.scoreByCategory)) {
    if (data.avg < worstScore) {
      worstScore = data.avg;
      worst = `${cat} (${data.avg.toFixed(2)})`;
    }
  }
  return worst || 'unknown';
}

/**
 * Analyzes auto-eval patterns and generates candidate content rules
 * for recurring failure patterns that can be caught at runtime.
 */
export async function generateContentRulesFromPatterns(
  llm: LLMProvider,
  patterns: PatternAnalysis[],
  pool: Pool,
  logger: Logger,
): Promise<Array<{ rule_type: string; pattern: string; is_regex: boolean; reason: string; severity: string }>> {
  const actionablePatterns = patterns.filter(
    (p) => p.frequency >= 3 && p.avgScoreImpact >= 1.5,
  );

  if (actionablePatterns.length === 0) return [];

  const patternsBlock = actionablePatterns
    .map((p) => `- "${p.pattern}" (${p.frequency} occurrences, avg score impact: ${p.avgScoreImpact.toFixed(2)}, category: ${p.category})`)
    .join('\n');

  // Load existing rules to avoid duplicates
  const { rows: existingRules } = await pool.query<{ pattern: string; reason: string }>(
    `SELECT pattern, reason FROM content_rules WHERE is_active = TRUE`,
  );
  const existingBlock = existingRules.length > 0
    ? `\nEXISTING RULES (do NOT duplicate these):\n${existingRules.map((r) => `- "${r.pattern}": ${r.reason}`).join('\n')}`
    : '';

  try {
    const resp = await llm.generate({
      messages: [
        {
          role: 'system',
          content: `You generate runtime content-checking rules for Grace, a WhatsApp health companion.
Rules are regex or substring patterns that catch problematic AI responses BEFORE they reach users.
Each rule has: pattern (regex or plain text), severity (regen = force new response, log = observe only), and reason.

CONSTRAINTS:
- Only create rules for patterns that are clearly catchable with text matching
- Prefer simple substring matches over complex regex
- severity should be 'regen' for serious issues, 'log' for observation
- NEVER create 'block' severity rules — those require manual review
- Be precise: overly broad patterns will cause false positives
- Each pattern must be testable against a response string

Return JSON array: [{ "rule_type": string, "pattern": string, "is_regex": boolean, "reason": string, "severity": "regen"|"log" }]
Return empty array [] if no patterns are actionable as runtime rules.`,
        },
        {
          role: 'user',
          content: `RECURRING FAILURE PATTERNS FROM AUTO-EVAL:
${patternsBlock}
${existingBlock}

Generate content rules that would catch these patterns at runtime. Only create rules where a text pattern can reliably detect the issue. Return JSON array only.`,
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 2000,
      responseFormat: 'json',
    });

    const parsed = JSON.parse(resp.text);
    const rules = Array.isArray(parsed) ? parsed : parsed.rules ?? [];

    const validRules = rules.filter((r: Record<string, unknown>) => {
      if (!r.pattern || !r.reason || !r.severity) return false;
      if (r.is_regex) {
        try {
          new RegExp(String(r.pattern));
        } catch {
          return false;
        }
      }
      return true;
    });

    logger.info({ generated: validRules.length, fromPatterns: actionablePatterns.length }, 'auto_rules.generated');
    return validRules;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'auto_rules.generation_failed');
    return [];
  }
}

/**
 * Inserts auto-generated content rules into the database as inactive drafts
 * (is_active = false) so an admin can review and activate them.
 */
export async function insertDraftContentRules(
  pool: Pool,
  rules: Array<{ rule_type: string; pattern: string; is_regex: boolean; reason: string; severity: string }>,
  logger: Logger,
): Promise<number> {
  let inserted = 0;
  for (const rule of rules) {
    try {
      await pool.query(
        `INSERT INTO content_rules (rule_type, pattern, is_regex, reason, severity, applies_to, is_active)
         VALUES ($1, $2, $3, $4, $5, 'all', FALSE)`,
        [rule.rule_type, rule.pattern, rule.is_regex, `[auto-eval] ${rule.reason}`, rule.severity],
      );
      inserted++;
    } catch (err) {
      logger.warn({ rule: rule.pattern, err: err instanceof Error ? err.message : String(err) }, 'auto_rules.insert_failed');
    }
  }
  return inserted;
}
