// Provider registry: a NAME -> adapter map (not an ordered list), because the
// order is now decided per request by the model router, not by config.
import { config } from "../config.js";
import { Provider } from "./types.js";
import { MockProvider } from "./mock.js";
import { GoogleProvider } from "./google.js";
import { AnthropicProvider } from "./anthropic.js";

export function buildProviders(): Map<string, Provider> {
  const m = new Map<string, Provider>();

  const google = new GoogleProvider(config.providers.googleKey);
  if (google.isReady()) m.set("google", google);

  const anthropic = new AnthropicProvider(config.providers.anthropicKey);
  if (anthropic.isReady()) m.set("anthropic", anthropic);

  // Mock providers are always available so routing, failover and the breaker
  // are demonstrable without any API keys.
  m.set("mock-primary", new MockProvider("mock-primary", 180));
  m.set("mock-secondary", new MockProvider("mock-secondary", 320));

  return m;
}

export function providerStatus(providers: Map<string, Provider>) {
  return [...providers.values()].map((p) => ({ name: p.name, ready: p.isReady() }));
}

export function setMockFailing(providers: Map<string, Provider>, name: string, failing: boolean): boolean {
  const p = providers.get(name);
  if (p instanceof MockProvider) { p.failing = failing; return true; }
  return false;
}
