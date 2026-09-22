import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const line of readLines(path.join(root, ".env"))) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}
function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
      .filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  } catch { return []; }
}

export const config = {
  port: Number(process.env.PORT ?? 3200),
  redisUrl: process.env.REDIS_URL || undefined,

  // Keys only. There is deliberately no "primary"/"fallback" provider setting:
  // provider order is decided per request by the model router (providers/
  // registry.ts), not by config. A static ordering here would just be a second,
  // conflicting source of truth for a decision the registry already owns.
  providers: {
    googleKey: process.env.GOOGLE_API_KEY ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  },

  policy: {
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 60),
    budgetUsdPerDay: Number(process.env.BUDGET_USD_PER_DAY ?? 5),
    cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000),   // per attempt
    requestDeadlineMs: Number(process.env.REQUEST_DEADLINE_MS ?? 60_000), // for the whole request, retries and failover included
    // Streaming has two clocks instead of one: how long until the FIRST token
    // (is the provider alive?) and how long between tokens (did it stall?).
    // One total budget would kill every legitimately long answer.
    ttftTimeoutMs: Number(process.env.TTFT_TIMEOUT_MS ?? 30_000),
    streamIdleTimeoutMs: Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? 30_000),
    defaultModel: process.env.DEFAULT_MODEL ?? "mock-small",
    // One default for every provider, so the same request costs the same
    // regardless of which adapter serves it.
    defaultMaxTokens: Number(process.env.DEFAULT_MAX_TOKENS ?? 1024),
  },

  reliability: {
    maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),                  // per provider, before failing over
    baseBackoffMs: Number(process.env.BASE_BACKOFF_MS ?? 200),          // exponential: 200, 400, 800... plus jitter
    breakerThreshold: Number(process.env.BREAKER_THRESHOLD ?? 5),       // consecutive failures before the circuit opens
    breakerCooldownSec: Number(process.env.BREAKER_COOLDOWN_SEC ?? 30), // how long it stays open before a trial request
  },
};
