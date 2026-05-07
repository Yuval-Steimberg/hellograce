import type { ToolCall, ToolResult } from '@grace/shared';

export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

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

    const timeoutMs = opts.timeoutMs ?? 5_000;
    try {
      const output = await Promise.race([
        tool.execute(call.args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`tool_timeout:${call.name}`)), timeoutMs),
        ),
      ]);
      return { name: call.name, ok: true, output, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        name: call.name,
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
