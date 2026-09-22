// Entry point: wire real dependencies, listen, shut down cleanly.
import { config } from "./config.js";
import { createStore } from "./store/index.js";
import { CircuitBreaker } from "./reliability.js";
import { buildProviders, providerStatus } from "./providers/index.js";
import { createApp } from "./app.js";
import { loadTenantsFile } from "./tenants.js";

const store = await createStore(config.redisUrl);
const providers = buildProviders();
const tenantCount = loadTenantsFile();
const app = createApp({ store, providers, breaker: new CircuitBreaker(store) });

const server = app.listen(config.port, () => {
  console.log(`\nmodelgate on http://localhost:${config.port}`);
  console.log(`  store     : ${store.kind}`);
  console.log(`  providers : ${providerStatus(providers).map((p) => `${p.name}${p.ready ? "" : " (no key)"}`).join(", ")}`);
  console.log(`  policy    : ${config.policy.rateLimitPerMin}/min, $${config.policy.budgetUsdPerDay}/day, cache ${config.policy.cacheTtlSeconds}s (${tenantCount} tenant overrides from tenants.json)`);
  console.log(`  api docs  : http://localhost:${config.port}/docs`);
  console.log(`  metrics   : http://localhost:${config.port}/metrics\n`);
});

// --- Graceful shutdown -------------------------------------------------------
// On SIGTERM (what Kubernetes sends before it kills the pod) stop accepting new
// connections, let in-flight requests finish, close the Redis connection, then
// exit. A hard deadline guarantees we do not hang forever on a stuck request.
function shutdown(signal: string) {
  console.log(`\n[server] ${signal} received - draining`);
  server.close(async () => {
    await store.close();
    console.log("[server] drained, exiting");
    process.exit(0);
  });
  setTimeout(() => { console.error("[server] drain timed out - exiting"); process.exit(1); }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
