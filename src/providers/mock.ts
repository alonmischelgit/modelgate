// -----------------------------------------------------------------------------
// A deterministic fake provider.
//
// This is not a toy: it means the gateway - every middleware, the cache, the
// rate limiter, the breaker, the dashboard - can be run, demoed and tested with
// no API key, no network and no spend. The interesting engineering here is the
// gateway, not the model, so the model should not be a prerequisite for showing
// it. It also makes the failover demo reproducible: we can make a provider fail
// on command - before the first byte, or in the middle of a stream.
// -----------------------------------------------------------------------------
import { ChatRequest, ChatResponse, Provider, StreamEvent, ToolCall, estimateTokens } from "./types.js";

export class MockProvider implements Provider {
  readonly name: string;
  /** Flip at runtime to simulate an outage (used by the failover demo). */
  public failing = false;
  /** Streaming chaos: fail after this many chunks have been sent (0 = never). */
  public failAfterChunks = 0;
  /** Streaming chaos: stop sending (hang) after this many chunks (0 = never). */
  public stallAfterChunks = 0;
  public latencyMs: number;

  constructor(name = "mock", latencyMs = 180) {
    this.name = name;
    this.latencyMs = latencyMs;
  }

  isReady() { return true; }

  private outage(): Error & { status?: number } {
    const err = new Error(`${this.name}: upstream unavailable (simulated)`) as Error & { status?: number };
    err.status = 503;
    return err;
  }

  /** The answer, computed up front; streaming just paces it out. */
  private answer(req: ChatRequest): ChatResponse {
    const prompt = req.messages.map((m) => m.content).join("\n");
    const inputTokens = estimateTokens(prompt);
    const last = req.messages.at(-1);
    const base = { model: req.model ?? "mock-small", provider: this.name };

    // Tool round-trip, deterministically: given tools and a fresh user turn,
    // "decide" to call the first one; given a tool result, answer with it.
    // Enough to exercise the whole loop - request shape, cache key, response
    // shape, the caller's tool execution - without a real model.
    if (req.tools?.length && last?.role !== "tool") {
      const tool = req.tools[0];
      const props = Object.keys((tool.parameters as { properties?: object }).properties ?? {});
      // "What's the weather in Haifa right now?" -> "Haifa": the last
      // capitalised word that isn't the sentence start, else the last word.
      // Crude, but it is what a model would extract for a one-argument tool,
      // and it keeps the demo readable.
      const words = (last?.content ?? "").replace(/[?.!,]/g, "").trim().split(/\s+/);
      const proper = words.slice(1).filter((w) => /^[A-Z]/.test(w)).at(-1);
      const guess = proper ?? words.at(-1) ?? "";
      const args = Object.fromEntries(props.map((p) => [p, guess]));
      const call: ToolCall = { id: `call_${inputTokens}`, name: tool.name, arguments: args };
      return {
        ...base, text: "", toolCalls: [call], stopReason: "tool_use",
        usage: { inputTokens, outputTokens: estimateTokens(JSON.stringify(call)) },
      };
    }

    const text = last?.role === "tool"
      ? `[${this.name}] Answer using the tool result: "${last.content.slice(0, 80)}"`
      : `[${this.name}] I received ${req.messages.length} message(s), ${inputTokens} input tokens. ` +
        `Last message: "${last?.content.slice(0, 60) ?? ""}"`;
    return { ...base, text, stopReason: "end", usage: { inputTokens, outputTokens: estimateTokens(text) } };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failing) throw this.outage();
    return this.answer(req);
  }

  /** Word by word, a few ms apart, so the demo visibly streams with no key. */
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    await new Promise((r) => setTimeout(r, this.latencyMs / 4));   // time to first token
    if (this.failing) throw this.outage();
    const final = this.answer(req);
    const words = final.text ? final.text.split(/(?<=\s)/) : [];
    for (const [i, w] of words.entries()) {
      if (this.stallAfterChunks && i >= this.stallAfterChunks) await new Promise(() => {});   // hang forever
      if (this.failAfterChunks && i >= this.failAfterChunks) throw this.outage();
      await new Promise((r) => setTimeout(r, Math.max(1, this.latencyMs / 20)));
      yield { type: "delta", text: w };
    }
    // A tool call is emitted the moment it is complete - here, before the turn
    // ends - exactly as a real provider does, so the agent can start running
    // it without waiting for `final`.
    for (const call of final.toolCalls ?? []) {
      await new Promise((r) => setTimeout(r, Math.max(1, this.latencyMs / 20)));
      yield { type: "tool_call", call };
    }
    yield { type: "final", response: final };
  }
}
