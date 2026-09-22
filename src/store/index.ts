// =============================================================================
// Shared state for the gateway: cache entries, rate-limit buckets, spend
// counters and circuit-breaker status.
//
// WHY REDIS IS THE DEFAULT, NOT A NICE-TO-HAVE:
// A gateway is a stateless service you run several replicas of. All four of the
// things above are *fleet-wide* facts, not per-process facts:
//
//   - rate limits : with in-process counters, 3 replicas enforce 3x the limit.
//                   The limit silently stops meaning anything.
//   - budgets     : same problem, but it costs real money.
//   - cache       : per-process caches give you a 1/N hit rate and N copies.
//   - breaker     : each replica would have to discover the outage separately,
//                   so you keep hammering a dead provider N times over.
//
// So Redis is the correct implementation. The in-memory store below exists ONLY
// so the repo runs with zero setup for local dev and tests - it is explicitly
// single-instance, and the gateway logs a warning when it falls back to it.
// =============================================================================
// ioredis v6 exports a named `Redis` class (the default export is the same
// constructor, but the named import is what carries the type).
import { Redis } from "ioredis";

export interface Store {
  readonly kind: "redis" | "memory";
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  /** Atomic increment-by-float, returns the new total. Used for spend counters. */
  incrByFloat(key: string, delta: number, ttlSeconds: number): Promise<number>;
  /**
   * Atomic token-bucket take. Returns the remaining tokens, or -1 if the bucket
   * was empty. MUST be atomic: two concurrent requests that both read "1 token
   * left" and both decrement would each be allowed - the same check-then-act
   * race as a double-spend.
   */
  takeToken(key: string, capacity: number, refillPerSec: number, now: number): Promise<number>;
  close(): Promise<void>;
}

// --- Redis implementation ----------------------------------------------------

// Token bucket as a Lua script so the read-modify-write happens inside Redis,
// in one atomic step. This is the same "atomic claim" idea as SET NX on a seat
// or SELECT ... FOR UPDATE on a balance - the operation must both check and
// take, with no window in between.
const TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end

-- refill for the time elapsed since we last looked
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, 3600)
if allowed == 1 then return math.floor(tokens) else return -1 end
`;

class RedisStore implements Store {
  readonly kind = "redis" as const;
  constructor(private redis: Redis) {}

  async get(key: string) { return this.redis.get(key); }
  async setex(key: string, ttl: number, value: string) { await this.redis.setex(key, ttl, value); }

  async incrByFloat(key: string, delta: number, ttl: number) {
    const total = await this.redis.incrbyfloat(key, delta);
    await this.redis.expire(key, ttl);
    return Number(total);
  }

  async takeToken(key: string, capacity: number, refillPerSec: number, now: number) {
    const res = await this.redis.eval(TOKEN_BUCKET_LUA, 1, key, capacity, refillPerSec, now);
    return Number(res);
  }

  async close() { await this.redis.quit(); }
}

// --- In-memory fallback (single instance, dev only) --------------------------

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  // One keyspace for strings and counters, exactly like Redis: a value written
  // by incrByFloat must be readable by get, because that is how the budget
  // check reads the spend counter. Expiry is stored per key and checked on
  // read, since TTLs differ per use (cache vs breaker vs spend).
  private kv = new Map<string, { v: string; expires: number }>();
  private buckets = new Map<string, { tokens: number; ts: number }>();

  async get(key: string) {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.expires < Date.now()) { this.kv.delete(key); return null; }
    return e.v;
  }
  async setex(key: string, ttl: number, value: string) {
    this.kv.set(key, { v: value, expires: Date.now() + ttl * 1000 });
  }
  async incrByFloat(key: string, delta: number, ttl: number) {
    // No `await` between the read and the write. JavaScript is single-threaded,
    // so a synchronous read-modify-write is atomic - but an await in the middle
    // yields to other callers and turns this into the same lost-update race the
    // Redis Lua script exists to prevent. A concurrency test caught exactly that.
    const e = this.kv.get(key);
    const current = e && e.expires >= Date.now() ? Number(e.v) : 0;
    const next = current + delta;
    this.kv.set(key, { v: String(next), expires: Date.now() + ttl * 1000 });
    return next;
  }
  async takeToken(key: string, capacity: number, refillPerSec: number, now: number) {
    // Single-threaded JS makes this atomic *within one process* - which is
    // exactly the limitation that makes this dev-only.
    const b = this.buckets.get(key) ?? { tokens: capacity, ts: now };
    b.tokens = Math.min(capacity, b.tokens + Math.max(0, now - b.ts) * refillPerSec);
    b.ts = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return -1; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return Math.floor(b.tokens);
  }
  async close() {}
}

/**
 * Connect to Redis, or fall back to in-memory for local dev.
 * Fails FAST (2s) rather than hanging a demo on a dead Redis.
 */
export async function createStore(redisUrl: string | undefined): Promise<Store> {
  if (!redisUrl) {
    console.warn("[store] REDIS_URL not set - using in-memory state (single instance only).");
    return new MemoryStore();
  }
  try {
    const redis = new Redis(redisUrl, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    await redis.connect();
    await redis.ping();
    console.log("[store] connected to Redis - shared state across instances.");
    return new RedisStore(redis);
  } catch (err) {
    console.warn(`[store] Redis unavailable (${err instanceof Error ? err.message : err}) - falling back to in-memory.`);
    console.warn("[store] NOTE: rate limits and budgets are per-process in this mode.");
    return new MemoryStore();
  }
}
