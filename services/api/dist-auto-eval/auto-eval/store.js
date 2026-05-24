import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
export class AutoEvalStore {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
        mkdirSync(join(this.baseDir, 'conversations'), { recursive: true });
        mkdirSync(join(this.baseDir, 'evaluations'), { recursive: true });
        mkdirSync(join(this.baseDir, 'reports'), { recursive: true });
        mkdirSync(join(this.baseDir, 'preference-pairs'), { recursive: true });
    }
    saveConversation(conv) {
        const path = join(this.baseDir, 'conversations', `${conv.id}.json`);
        writeFileSync(path, JSON.stringify(conv, null, 2), 'utf8');
    }
    saveEvaluation(evaluation) {
        const path = join(this.baseDir, 'evaluations', `${evaluation.conversationId}.json`);
        writeFileSync(path, JSON.stringify(evaluation, null, 2), 'utf8');
    }
    saveReport(report) {
        const safeTs = report.timestamp.replace(/[:.]/g, '-');
        const path = join(this.baseDir, 'reports', `${safeTs}.json`);
        writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
    }
    savePreferencePairs(pairs) {
        if (pairs.length === 0)
            return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const path = join(this.baseDir, 'preference-pairs', `${ts}.json`);
        writeFileSync(path, JSON.stringify(pairs, null, 2), 'utf8');
    }
    loadPreviousReport() {
        const dir = join(this.baseDir, 'reports');
        if (!existsSync(dir))
            return null;
        const files = readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .reverse();
        if (files.length === 0)
            return null;
        try {
            const content = readFileSync(join(dir, files[0]), 'utf8');
            return JSON.parse(content);
        }
        catch {
            return null;
        }
    }
    loadAllEvaluations() {
        const dir = join(this.baseDir, 'evaluations');
        if (!existsSync(dir))
            return [];
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        const evals = [];
        for (const file of files) {
            try {
                const content = readFileSync(join(dir, file), 'utf8');
                evals.push(JSON.parse(content));
            }
            catch {
                continue;
            }
        }
        return evals;
    }
    loadAllPreferencePairs() {
        const dir = join(this.baseDir, 'preference-pairs');
        if (!existsSync(dir))
            return [];
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        const pairs = [];
        for (const file of files) {
            try {
                const content = readFileSync(join(dir, file), 'utf8');
                const batch = JSON.parse(content);
                pairs.push(...batch);
            }
            catch {
                continue;
            }
        }
        return pairs;
    }
}
