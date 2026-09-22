// -----------------------------------------------------------------------------
// The provider adapter. Everything upstream of this - cache, rate limit,
// budget, breaker, metrics - is provider-agnostic, which is precisely what
// makes failover between providers possible.
//
// The request/response here is the gateway's own neutral shape. Each adapter
// translates it to one vendor's wire format and back; callers never see the
// difference between Gemini's functionDeclarations and Anthropic's tool_use.
// -----------------------------------------------------------------------------

/** A tool the model may ask to call. JSON Schema parameters, as every vendor takes. */
export interface ToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** The model asking for a tool to be run. The gateway never runs it - the caller does. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque, provider-specific. Some models (Gemini 3) sign their reasoning and
   * require it echoed back with the call on the next turn. Callers pass it
   * through untouched; they never need to know what it is.
   */
  signature?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Text for system/user/assistant; the tool's result for role "tool". */
  content: string;
  /** Assistant only: the tool calls it made in this turn. */
  toolCalls?: ToolCall[];
  /** Tool only: which call this result answers. */
  toolCallId?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  /** Opt out of same-tier model substitution on failover. Default: allowed. */
  allowSubstitute?: boolean;
  /**
   * Opt out of the response cache for this call - neither read nor written.
   * Default: cached, per the instance TTL. Also settable with the standard
   * `Cache-Control: no-cache` request header.
   */
  cache?: boolean;
  /**
   * Reasoning-token budget for thinking models. 0 disables thinking entirely.
   * Omit to let the model decide. A gateway has to expose this rather than hide
   * it - see the note on Usage.thinkingTokens.
   */
  thinkingBudget?: number;
}

export interface Usage {
  inputTokens: number;
  /**
   * INCLUDES thinking/reasoning tokens, because providers bill them as output.
   * Counting only the visible answer understates cost badly on a short reply
   * from a thinking model - measured against gemini-3.6-flash: 3 visible
   * tokens and 98 thought tokens for "say exactly: gateway online".
   */
  outputTokens: number;
  /** The reasoning portion of outputTokens, broken out so it is attributable. */
  thinkingTokens?: number;
}

export type StopReason = "end" | "tool_use" | "max_tokens";

export interface ChatResponse {
  text: string;
  /** Present when the model wants tools run. The caller runs them and sends `tool` messages back. */
  toolCalls?: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
  provider: string;
}

export interface Provider {
  readonly name: string;
  /** False when no API key is configured - the factory skips unusable providers. */
  isReady(): boolean;
  complete(req: ChatRequest): Promise<ChatResponse>;
}

// Pricing lives in providers/registry.ts, beside the models it prices: one
// table, so cost accounting and routing can never disagree about a model.

/** Rough token estimate for pre-flight budget checks (~4 chars per token). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Find which tool a `tool` message answers, by walking back to the assistant call. */
export function toolNameForCall(messages: ChatMessage[], toolCallId: string): string | undefined {
  for (const m of messages) {
    const hit = m.toolCalls?.find((c) => c.id === toolCallId);
    if (hit) return hit.name;
  }
  return undefined;
}
