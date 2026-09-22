// -----------------------------------------------------------------------------
// The HTTP surface, as a function of its dependencies. server.ts wires real
// ones and listens; tests wire a MemoryStore and mocks and listen on port 0.
// Keeping `listen` out of this file is what makes the routes testable.
// -----------------------------------------------------------------------------
import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import path from "node:path";
import { config, root } from "./config.js";
import { handleChat, type GatewayDeps } from "./pipeline.js";
import { stats, recentRequests, prometheus } from "./metrics.js";
import { providerStatus, setMockFailing } from "./providers/index.js";
import { MODELS } from "./providers/registry.js";
import { openapiSpec } from "./openapi.js";
import { validateChatRequest } from "./validate.js";
import { listTenants } from "./tenants.js";

const SWAGGER_DIR = path.join(root, "node_modules", "swagger-ui-dist");
const SWAGGER_FILES = ["swagger-ui.css", "swagger-ui-bundle.js"];

export function createApp(deps: GatewayDeps) {
  const { store, providers } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(root, "public")));
  // Swagger UI is served from the installed package rather than a CDN, so /docs
  // works with no internet - and only the two files the page needs, not the
  // package's whole directory.
  for (const f of SWAGGER_FILES) {
    app.get(`/swagger-ui/${f}`, (_req, res) => res.sendFile(path.join(SWAGGER_DIR, f)));
  }

  /** The gateway endpoint. Your agents point here instead of at a provider. */
  app.post("/v1/chat", async (req, res, next) => {
    // One id ties the response, the usage record and (in production) the log
    // line and the span together. Honour the caller's if they sent a sane one,
    // so the id survives across their hop and ours.
    const supplied = req.header("x-request-id");
    const requestId = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
    res.setHeader("x-request-id", requestId);

    // In a real deployment this maps an API key to a tenant record; here the
    // key IS the tenant, so limits, budgets and cache isolation are
    // demonstrable without a user system. It is still required: an anonymous
    // caller would otherwise share one bucket, one budget and one cache with
    // every other anonymous caller.
    const tenant = req.header("x-api-key")?.trim().slice(0, 128);
    if (!tenant) {
      res.status(401).json({ requestId, error: "missing_api_key", detail: "send x-api-key" });
      return;
    }

    const v = validateChatRequest(req.body);
    if (!v.ok) {
      res.status(400).json({ requestId, error: "invalid_request", detail: v.detail });
      return;
    }
    // The HTTP way to say "fresh answer, please". Same effect as `cache: false`
    // in the body; the header exists because every HTTP client already knows it.
    if (/\bno-cache\b|\bno-store\b/i.test(req.header("cache-control") ?? "")) v.req.cache = false;
    try {
      const result = await handleChat(tenant, v.req, deps, requestId);
      // Retry-After is the header clients actually honour; the body field is
      // for humans reading the JSON.
      const retryAfter = result.body.retryAfterSec;
      if (typeof retryAfter === "number") res.setHeader("Retry-After", String(retryAfter));
      res.status(result.status).json({ ...result.body, trace: result.trace });
    } catch (err) {
      next(err);
    }
  });

  /** The catalogue: what can I ask for, and what does it cost? */
  app.get("/v1/models", (_req, res) => {
    res.json(Object.values(MODELS).map((m) => ({
      id: m.id, provider: m.provider, tier: m.tier, pricingPerMTok: m.pricing,
      available: providers.has(m.provider), note: m.note,
      isDefault: m.id === config.policy.defaultModel,
    })));
  });

  app.get("/v1/stats", (_req, res) => {
    res.json({ ...stats(), store: store.kind, providers: providerStatus(providers) });
  });

  app.get("/v1/recent", (_req, res) => res.json(recentRequests(25)));

  /** Who gets what: the per-tenant policies and the default everyone else falls back to. */
  app.get("/v1/tenants", (_req, res) => res.json(listTenants()));

  /** Prometheus scrape target. Cumulative, unlike /v1/stats which is a window. */
  app.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(prometheus());
  });

  /** Demo control: simulate a provider outage to show retries + failover live. */
  app.post("/v1/_chaos", (req, res) => {
    const { provider, failing } = req.body ?? {};
    const changed = setMockFailing(providers, String(provider), Boolean(failing));
    res.json({ ok: changed, provider, failing: Boolean(failing) });
  });

  app.get("/health", (_req, res) => res.json({ ok: true, store: store.kind }));

  // --- The contract ----------------------------------------------------------
  // Built per request rather than at boot so the spec always reflects the live
  // policy numbers and the current model registry - documentation that can
  // drift from the service is worse than none.
  app.get("/openapi.json", (_req, res) => res.json(openapiSpec()));
  app.get("/docs", (_req, res) => res.redirect("/docs.html"));

  // --- Errors are JSON, always -----------------------------------------------
  // Express's default is an HTML page. A JSON API that answers a malformed body
  // with HTML is a contract violation, and an uncaught exception that answers
  // with nothing (the request just hangs) is worse.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json", detail: e.message });
      return;
    }
    if (e.type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large", detail: "body exceeds 1mb" });
      return;
    }
    console.error("[server] unhandled error:", err);
    res.status(e.status ?? 500).json({ error: "internal_error", detail: e.message ?? String(err) });
  });

  return app;
}
