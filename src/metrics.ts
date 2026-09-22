// -----------------------------------------------------------------------------
// Usage accounting and observability. Three outputs from one record:
//
//   1. data/usage.jsonl  - the LEDGER. Append-only, one line per request, the
//                          evidence for billing and chargeback. Never mutated.
//   2. /metrics          - PROMETHEUS exposition: cumulative counters and a
//                          latency histogram, for scraping and alerting.
//   3. /v1/stats, /recent - a small in-process window for the dashboard.
//
// The split is the point: a ledger answers "what did tenant X spend in March"
// (per-record, exact, warehouse-shaped); metrics answer "is p95 rising right
// now" (aggregated, cheap, time-series-shaped). One store that tries to be both
// is bad at both.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { root } from "./config.js";

export interface UsageRecord {
  ts?: string;
  requestId: string;
  tenant: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  costUsd: number;
  cached: boolean;
  /** Served by a different same-tier model than requested. */
  substituted?: boolean;
  /** Served by a later step of the route plan - the primary was unavailable. */
  failedOver?: boolean;
  ms: number;
  ok: boolean;
}

const LOG = process.env.USAGE_LOG ?? path.join(root, "data", "usage.jsonl");
const recent: UsageRecord[] = [];
const MAX_RECENT = 500;

// --- Prometheus state --------------------------------------------------------
// Labels are deliberately few. `tenant` is the one to watch: label cardinality
// is what kills a Prometheus server, and tenants are unbounded in the real
// world. Here it is fine (a handful, for the demo); in production per-tenant
// questions move to the ledger/warehouse and this keeps provider/model only.
const LATENCY_BUCKETS_S = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const counters = new Map<string, number>();                  // "name{labels}" -> value
const latencyBuckets = new Map<string, number[]>();          // labels -> per-bucket counts (+Inf last)
const latencySum = new Map<string, number>();
const latencyCount = new Map<string, number>();

const labelStr = (l: Record<string, string | number | boolean>) =>
  Object.entries(l).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(",");
const bump = (name: string, labels: Record<string, string | number | boolean>, by: number) => {
  const key = `${name}{${labelStr(labels)}}`;
  counters.set(key, (counters.get(key) ?? 0) + by);
};

export async function recordUsage(r: UsageRecord): Promise<void> {
  const rec = { ...r, ts: new Date().toISOString() };
  recent.push(rec);
  if (recent.length > MAX_RECENT) recent.shift();

  // A cache hit is served by the cache, not by the provider whose answer it
  // stored - attributing it to the provider makes the provider look busier
  // than it is.
  const served = r.cached ? "cache" : r.provider;
  const base = { tenant: r.tenant, provider: served, model: r.model };
  bump("modelgate_requests_total", { ...base, cached: r.cached, ok: r.ok }, 1);
  bump("modelgate_cost_usd_total", base, r.costUsd);
  bump("modelgate_tokens_total", { ...base, type: "input" }, r.inputTokens);
  bump("modelgate_tokens_total", { ...base, type: "output" }, r.outputTokens);
  if (r.thinkingTokens) bump("modelgate_tokens_total", { ...base, type: "thinking" }, r.thinkingTokens);
  if (r.failedOver) bump("modelgate_failovers_total", { tenant: r.tenant, provider: served }, 1);

  const hk = labelStr({ provider: served, cached: r.cached });
  const buckets = latencyBuckets.get(hk) ?? new Array(LATENCY_BUCKETS_S.length + 1).fill(0);
  const s = r.ms / 1000;
  LATENCY_BUCKETS_S.forEach((le, i) => { if (s <= le) buckets[i]++; });
  buckets[LATENCY_BUCKETS_S.length]++;
  latencyBuckets.set(hk, buckets);
  latencySum.set(hk, (latencySum.get(hk) ?? 0) + s);
  latencyCount.set(hk, (latencyCount.get(hk) ?? 0) + 1);

  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
  } catch { /* observability must never break the request path */ }
}

/** Prometheus text exposition format, hand-rolled: it is four line shapes. */
export function prometheus(): string {
  const out: string[] = [];
  const help: Record<string, [string, string]> = {
    modelgate_requests_total:  ["counter", "Requests handled, by outcome."],
    modelgate_cost_usd_total:  ["counter", "Spend attributed, in USD."],
    modelgate_tokens_total:    ["counter", "Tokens by type; thinking tokens are billed as output."],
    modelgate_failovers_total: ["counter", "Requests served by a later route step than the primary."],
  };
  for (const [name, [type, text]] of Object.entries(help)) {
    const rows = [...counters].filter(([k]) => k.startsWith(name + "{"));
    if (!rows.length) continue;
    out.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
    for (const [k, v] of rows) out.push(`${k} ${v}`);
  }
  if (latencyCount.size) {
    out.push("# HELP modelgate_request_duration_seconds End-to-end latency, retries included.",
             "# TYPE modelgate_request_duration_seconds histogram");
    for (const [labels, buckets] of latencyBuckets) {
      LATENCY_BUCKETS_S.forEach((le, i) =>
        out.push(`modelgate_request_duration_seconds_bucket{${labels},le="${le}"} ${buckets[i]}`));
      out.push(`modelgate_request_duration_seconds_bucket{${labels},le="+Inf"} ${buckets[LATENCY_BUCKETS_S.length]}`);
      out.push(`modelgate_request_duration_seconds_sum{${labels}} ${latencySum.get(labels)}`);
      out.push(`modelgate_request_duration_seconds_count{${labels}} ${latencyCount.get(labels)}`);
    }
  }
  return out.join("\n") + "\n";
}

/** The dashboard's window: the last MAX_RECENT requests, not all time. */
export function stats() {
  const total = recent.length;
  const cached = recent.filter((r) => r.cached).length;
  const failed = recent.filter((r) => !r.ok).length;
  const spend = recent.reduce((s, r) => s + r.costUsd, 0);
  const latencies = recent.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : 0;

  // What a cache hit saved: average cost of the misses x number of hits.
  const misses = recent.filter((r) => !r.cached && r.ok);
  const avgMissCost = misses.length ? misses.reduce((s, r) => s + r.costUsd, 0) / misses.length : 0;

  const byProvider: Record<string, number> = {};
  for (const r of recent) {
    const k = r.cached ? "cache" : r.provider;
    byProvider[k] = (byProvider[k] ?? 0) + 1;
  }

  return {
    window: MAX_RECENT,
    requests: total,
    cacheHits: cached,
    cacheHitRate: total ? Number((cached / total).toFixed(3)) : 0,
    failures: failed,
    spendUsd: Number(spend.toFixed(6)),
    estimatedSavedUsd: Number((avgMissCost * cached).toFixed(6)),
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    // How often we are running on the backup. A rising number here is the
    // early warning that the primary is degrading before it is fully down.
    failovers: recent.filter((r) => r.failedOver).length,
    substitutions: recent.filter((r) => r.substituted).length,
    byProvider,
  };
}

export function recentRequests(n = 25): UsageRecord[] {
  return recent.slice(-n).reverse();
}
