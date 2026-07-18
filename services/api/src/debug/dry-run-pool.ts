import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * DryRunPool (2026-07-18) — the safety core of the internal debug platform.
 *
 * Wraps the real Postgres pool so the REAL Grace pipeline can run against REAL
 * data with ZERO risk of a production write. SELECT/read statements pass through
 * to the real pool (so a live test sees the user's actual profile, logs, history,
 * memory). Any mutation (INSERT/UPDATE/DELETE/MERGE/TRUNCATE/ALTER/DROP/CREATE,
 * incl. CTE-wrapped writes) is CAPTURED and returns an empty result INSTEAD of
 * executing — nothing is committed. The captured writes are surfaced in the debug
 * trace as "what Grace WOULD have written".
 *
 * Because every write in the AI path funnels through `pool.query` (food/weight/
 * mood logs, messages/turn persistence, tool_logs, latency, memory, profile
 * updates), this one wrapper captures 100% of would-be writes with NO change to
 * Grace's code — no `dryRun` flags threaded through dozens of call sites.
 *
 * Detection is START-ANCHORED on the write verb (plus the `WITH … ) INSERT/…`
 * CTE form). This codebase's writes are all plain top-level statements, so a read
 * is never misclassified as a write (which would break the run by starving a
 * needed SELECT). If in doubt the rule errs toward passing SELECTs through.
 */

export interface CapturedWrite {
  /** The SQL statement (as given). */
  sql: string;
  /** Bound parameters, lightly sanitized (long strings truncated). */
  params: unknown[];
  /** Parsed { op, table } best-effort, for readable grouping in the UI. */
  op: 'insert' | 'update' | 'delete' | 'other';
  table: string | null;
  at: number;
}

const WRITE_RE = /^\s*(insert\s+into|update\s+|delete\s+from|merge\s+into|truncate|alter\s+|drop\s+|create\s+)/i;
// CTE that ends in a data-modifying statement: WITH x AS (...) INSERT/UPDATE/DELETE …
const CTE_WRITE_RE = /^\s*with\b[\s\S]*\)\s*(insert\s+into|update\s+|delete\s+from)/i;

export function isWriteStatement(sql: string): boolean {
  return WRITE_RE.test(sql) || CTE_WRITE_RE.test(sql);
}

function parseOpTable(sql: string): { op: CapturedWrite['op']; table: string | null } {
  const m = sql.match(/^\s*(?:with[\s\S]*?\)\s*)?(insert\s+into|update|delete\s+from)\s+"?([a-z0-9_.]+)"?/i);
  if (!m) return { op: 'other', table: null };
  const verb = m[1]!.toLowerCase();
  const table = m[2] ?? null;
  const op = verb.startsWith('insert') ? 'insert' : verb.startsWith('update') ? 'update' : 'delete';
  return { op, table };
}

function sanitizeParams(params: unknown[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((p) => (typeof p === 'string' && p.length > 300 ? `${p.slice(0, 300)}…[${p.length} chars]` : p));
}

const EMPTY_RESULT: QueryResult<QueryResultRow> = {
  command: '',
  rowCount: 0,
  oid: 0,
  rows: [],
  fields: [],
};

/**
 * A DryRunPool presents the subset of the `pg.Pool` surface the app uses
 * (`query`, `connect`, `on`, `end`) and forwards reads to the real pool while
 * capturing writes. It intentionally implements `Pool` structurally so it can be
 * dropped in wherever a `Pool` is expected.
 */
export class DryRunPool {
  readonly captures: CapturedWrite[] = [];

  constructor(private real: Pool) {}

  /** Overloaded like pg's `query`. Reads → real pool; writes → captured + empty. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(...args: any[]): any {
    const text: string = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const values: unknown[] | undefined = Array.isArray(args[1]) ? args[1] : args[0]?.values;
    if (isWriteStatement(text)) {
      const { op, table } = parseOpTable(text);
      this.captures.push({ sql: text.trim(), params: sanitizeParams(values), op, table, at: Date.now() });
      return Promise.resolve(EMPTY_RESULT);
    }
    // Read — forward verbatim to the real pool.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.real.query as any)(...args);
  }

  /**
   * Some code paths use a checked-out client for transactions. Return a proxy
   * client that gates `query` the same way and makes BEGIN/COMMIT/ROLLBACK/
   * release no-ops, so a transaction can "run" without ever committing.
   */
  async connect(): Promise<PoolClient> {
    const self = this;
    const client = await this.real.connect();
    const proxy = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (...args: any[]) => {
            const text: string = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
            const t = text.trim().toLowerCase();
            if (t === 'begin' || t === 'commit' || t === 'rollback') return Promise.resolve(EMPTY_RESULT);
            const values: unknown[] | undefined = Array.isArray(args[1]) ? args[1] : args[0]?.values;
            if (isWriteStatement(text)) {
              const { op, table } = parseOpTable(text);
              self.captures.push({ sql: text.trim(), params: sanitizeParams(values), op, table, at: Date.now() });
              return Promise.resolve(EMPTY_RESULT);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target.query as any)(...args);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return proxy as PoolClient;
  }

  // Passthroughs so the object is Pool-shaped where the app touches it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(...args: any[]): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.real.on as any)(...args);
  }

  async end(): Promise<void> {
    // Never end the real shared pool from a dry run.
  }
}

/** Build a DryRunPool typed as a Pool for injection into services. */
export function makeDryRunPool(real: Pool): { pool: Pool; captures: CapturedWrite[] } {
  const drp = new DryRunPool(real);
  return { pool: drp as unknown as Pool, captures: drp.captures };
}
