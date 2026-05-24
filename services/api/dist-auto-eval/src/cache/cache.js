export class Cache {
    redis;
    prefix;
    hits = 0;
    misses = 0;
    constructor(redis, prefix = 'grace') {
        this.redis = redis;
        this.prefix = prefix;
    }
    key(namespace, id) {
        return `${this.prefix}:${namespace}:${id}`;
    }
    async get(namespace, id) {
        const raw = await this.redis.get(this.key(namespace, id));
        if (raw === null) {
            this.misses++;
            return null;
        }
        this.hits++;
        return JSON.parse(raw);
    }
    async set(namespace, id, value, ttlSec) {
        await this.redis.set(this.key(namespace, id), JSON.stringify(value), 'EX', ttlSec);
    }
    async del(namespace, id) {
        await this.redis.del(this.key(namespace, id));
    }
    stats() {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            hitRate: total === 0 ? 0 : this.hits / total,
        };
    }
}
