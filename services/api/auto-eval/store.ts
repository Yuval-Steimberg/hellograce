import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  AutoEvalReport,
  ConversationEvaluation,
  PreferencePair,
  SimulatedConversation,
} from './types.js';

export class AutoEvalStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(join(this.baseDir, 'conversations'), { recursive: true });
    mkdirSync(join(this.baseDir, 'evaluations'), { recursive: true });
    mkdirSync(join(this.baseDir, 'reports'), { recursive: true });
    mkdirSync(join(this.baseDir, 'preference-pairs'), { recursive: true });
  }

  saveConversation(conv: SimulatedConversation): void {
    const path = join(this.baseDir, 'conversations', `${conv.id}.json`);
    writeFileSync(path, JSON.stringify(conv, null, 2), 'utf8');
  }

  saveEvaluation(evaluation: ConversationEvaluation): void {
    const path = join(this.baseDir, 'evaluations', `${evaluation.conversationId}.json`);
    writeFileSync(path, JSON.stringify(evaluation, null, 2), 'utf8');
  }

  saveReport(report: AutoEvalReport): void {
    const safeTs = report.timestamp.replace(/[:.]/g, '-');
    const path = join(this.baseDir, 'reports', `${safeTs}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  }

  savePreferencePairs(pairs: PreferencePair[]): void {
    if (pairs.length === 0) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.baseDir, 'preference-pairs', `${ts}.json`);
    writeFileSync(path, JSON.stringify(pairs, null, 2), 'utf8');
  }

  loadPreviousReport(): AutoEvalReport | null {
    const dir = join(this.baseDir, 'reports');
    if (!existsSync(dir)) return null;

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    try {
      const content = readFileSync(join(dir, files[0]), 'utf8');
      return JSON.parse(content) as AutoEvalReport;
    } catch {
      return null;
    }
  }

  loadAllEvaluations(): ConversationEvaluation[] {
    const dir = join(this.baseDir, 'evaluations');
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const evals: ConversationEvaluation[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf8');
        evals.push(JSON.parse(content) as ConversationEvaluation);
      } catch {
        continue;
      }
    }

    return evals;
  }

  loadAllPreferencePairs(): PreferencePair[] {
    const dir = join(this.baseDir, 'preference-pairs');
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const pairs: PreferencePair[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf8');
        const batch = JSON.parse(content) as PreferencePair[];
        pairs.push(...batch);
      } catch {
        continue;
      }
    }

    return pairs;
  }
}
