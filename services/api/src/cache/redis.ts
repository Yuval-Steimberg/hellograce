import { Redis } from 'ioredis';

let _client: Redis | null = null;

/** Returns a singleton ioredis client. Safe to call multiple times. */
export function getRedisClient(url: string): Redis {
  if (_client) return _client;
  _client = new Redis(url, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  });
  return _client;
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
