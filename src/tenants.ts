// -----------------------------------------------------------------------------
// Per-tenant policy. "Per tenant" has to mean more than a key prefix: the
// search team gets more throughput than an intern sandbox, and the EU billing
// service is contractually forbidden from sending data to one provider.
//
// Resolution order, most specific wins:
//   tenants.json  tenants[<key>]   the tenant's own overrides
//   tenants.json  default          the operator's default for everyone
//   .env                           the instance defaults (config.policy)
//
// The provider allowlist is the important one. It is POLICY, not a request
// flag: a caller must not be able to opt INTO a provider their contract
// forbids. It feeds the router as "which providers exist for this tenant", so
// a forbidden provider is simply not in the route plan - the request either
// fails over to an allowed same-tier model or is refused with a 403.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { config, root } from "./config.js";

export interface TenantPolicy {
  rateLimitPerMin: number;
  budgetUsdPerDay: number;
  /** Providers this tenant may be routed to. Absent = all configured providers. */
  providers?: string[];
  /** Free text, surfaced in /v1/tenants and the trace - say WHY a policy exists. */
  note?: string;
}

export interface TenantsFile {
  default?: Partial<TenantPolicy>;
  tenants?: Record<string, Partial<TenantPolicy>>;
}

let policies: TenantsFile = {};

/** Replace the in-memory policy table (boot, or a test). */
export function configureTenants(file: TenantsFile): void {
  policies = file;
}

/** Load tenants.json from the repo root, if present. Missing file = env defaults only. */
export function loadTenantsFile(file = process.env.TENANTS_FILE ?? path.join(root, "tenants.json")): number {
  try {
    configureTenants(JSON.parse(fs.readFileSync(file, "utf8")) as TenantsFile);
    return Object.keys(policies.tenants ?? {}).length;
  } catch {
    configureTenants({});
    return 0;
  }
}

/** The effective policy for one tenant, resolved at call time so env changes and tests apply immediately. */
export function policyFor(tenant: string): TenantPolicy {
  const own = policies.tenants?.[tenant] ?? {};
  const def = policies.default ?? {};
  return {
    rateLimitPerMin: own.rateLimitPerMin ?? def.rateLimitPerMin ?? config.policy.rateLimitPerMin,
    budgetUsdPerDay: own.budgetUsdPerDay ?? def.budgetUsdPerDay ?? config.policy.budgetUsdPerDay,
    ...(own.providers ?? def.providers ? { providers: own.providers ?? def.providers } : {}),
    ...(own.note ? { note: own.note } : {}),
  };
}

/** Everything /v1/tenants shows: the named tenants and the default they fall back to. */
export function listTenants(): { default: TenantPolicy; tenants: Record<string, TenantPolicy> } {
  const tenants: Record<string, TenantPolicy> = {};
  for (const name of Object.keys(policies.tenants ?? {})) tenants[name] = policyFor(name);
  return { default: policyFor("__default__"), tenants };
}
