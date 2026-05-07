import type { Redis } from 'ioredis';

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
}

export class Cache {
  private hits = 0;
  private misses = 0;

  constructor(
    private redis: Redis,
    private prefix = 'grace',
  ) {}

  private key(namespace: string, id: string): string {
    return `${this.prefix}:${namespace}:${id}`;
  }

  async get<T>(namespace: string, id: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(namespace, id));
    if (raw === null) {
      this.misses++;
      return null;
    }
    this.hits++;
    return JSON.parse(raw) as T;
  }

  async set<T>(namespace: string, id: string, value: T, ttlSec: number): Promise<void> {
    await this.redis.set(this.key(namespace, id), JSON.stringify(value), 'EX', ttlSec);
  }

  async del(namespace: string, id: string): Promise<void> {
    await this.redis.del(this.key(namespace, id));
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
