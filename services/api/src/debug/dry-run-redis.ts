import type { Redis } from 'ioredis';

/**
 * DryRunRedis (2026-07-18) — Redis half of the debug safety layer.
 *
 * Wraps the real ioredis client so a live debug run can READ cache/state (real
 * user cache, pending-food state, etc.) but can NEVER mutate it. Read commands
 * pass through to the real client; every other command (writes, pipelines,
 * transactions, scripts) is a no-op returning a benign value.
 *
 * Fail-safe by construction: only an explicit allowlist of READ commands is
 * forwarded. Anything not on the list — including a command we forgot — no-ops
 * and degrades to a cache miss (→ the caller falls back to the DB read), which is
 * correct and slower, never a production write. This guarantees a debug run
 * cannot alter another user's Redis state (locks, pending food, counters, caches).
 */

const READ_COMMANDS = new Set<string>([
  'get', 'getbuffer', 'mget', 'exists', 'ttl', 'pttl', 'type', 'strlen', 'getrange',
  'hget', 'hmget', 'hgetall', 'hkeys', 'hvals', 'hlen', 'hexists',
  'smembers', 'sismember', 'scard', 'srandmember',
  'zrange', 'zrevrange', 'zrangebyscore', 'zscore', 'zcard', 'zrank', 'zrevrank',
  'llen', 'lrange', 'lindex',
  'keys', 'scan', 'hscan', 'sscan', 'zscan', 'dbsize', 'randomkey',
  'bitcount', 'object', 'memory', 'ping',
]);

// Connection/meta accessors we forward or make chainable no-ops.
const CHAINABLE_NOOP = new Set(['on', 'once', 'off', 'removeListener', 'addListener', 'setMaxListeners']);

function makeNoopPipeline(): unknown {
  const p: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop) {
      if (prop === 'exec') return () => Promise.resolve([]);
      // Any chained command returns the pipeline itself (chainable), no-op.
      return () => proxy;
    },
  };
  const proxy = new Proxy(p, handler);
  return proxy;
}

/**
 * Return a Redis-typed proxy that reads through and no-ops all mutations.
 */
export function makeDryRunRedis(real: Redis): Redis {
  const handler: ProxyHandler<Redis> = {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);

      const cmd = prop.toLowerCase();

      if (READ_COMMANDS.has(cmd)) {
        const fn = Reflect.get(target, prop, receiver);
        return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(target) : fn;
      }
      if (prop === 'pipeline' || prop === 'multi') {
        return () => makeNoopPipeline();
      }
      if (prop === 'duplicate') {
        return () => makeDryRunRedis(real);
      }
      if (CHAINABLE_NOOP.has(prop)) {
        return () => receiver; // chainable, attaches nothing to the real client
      }
      if (prop === 'status') return Reflect.get(target, prop, receiver); // 'ready'
      if (prop === 'quit' || prop === 'disconnect') return () => Promise.resolve('OK');

      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig === 'function') {
        // Any other command (set/del/expire/incr/sadd/eval/…) → no-op.
        // Return null so NX-style locks read as "not acquired" and plain
        // sets/writes are silently dropped; callers ignore write results.
        return () => Promise.resolve(null);
      }
      return orig;
    },
  };
  return new Proxy(real, handler);
}
