import type { ToolCall, ToolResult } from '@grace/shared';

export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Per-tool timeout overrides. Falls back to DEFAULT_TIMEOUT_MS for unlisted tools. */
const TOOL_TIMEOUT_MS: Record<string, number> = {
  log_food: 10_000,       // LLM-assisted food parsing can be slow
  log_weight: 3_000,
  log_mood: 3_000,
  knowledge_search: 5_000,
};

const DEFAULT_TIMEOUT_MS = 5_000;

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(call: ToolCall, opts: { timeoutMs?: number } = {}): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    const started = Date.now();
    if (!tool) {
      return {
        name: call.name,
        ok: false,
        error: `unknown_tool:${call.name}`,
        latencyMs: 0,
      };
    }

    const timeoutMs = opts.timeoutMs ?? TOOL_TIMEOUT_MS[call.name] ?? DEFAULT_TIMEOUT_MS;
    try {
      const output = await Promise.race([
        tool.execute(call.args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`tool_timeout:${call.name}`)), timeoutMs),
        ),
      ]);
      return { name: call.name, args: call.args, ok: true, output, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        name: call.name,
        args: call.args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  async executeMany(calls: ToolCall[], opts: { timeoutMs?: number } = {}): Promise<ToolResult[]> {
    return Promise.all(calls.map((c) => this.execute(c, opts)));
  }
}
