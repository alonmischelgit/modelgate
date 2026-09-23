// Google (Gemini) adapter. Thin on purpose: the adapter's only job is to map
// our provider-neutral request/response onto one vendor's SDK.
//
// THE THINKING-MODEL TRAP (found by running this against a real key):
// Gemini 3.x reasons before it answers, and those reasoning tokens
//   (a) count against maxOutputTokens, and
//   (b) are billed as output tokens.
// Two consequences a gateway MUST handle:
//   1. A small maxTokens produces an EMPTY answer with finishReason MAX_TOKENS -
//      the budget was spent thinking. Measured: maxOutputTokens 40 -> 34 thought
//      tokens, 2 visible. So the floor below is not a nicety.
//   2. Billing only candidatesTokenCount understates cost by an order of
//      magnitude. Measured: 3 visible tokens, 98 thought tokens, all billable.
import {
  GoogleGenAI, type Content, type Part, type GenerateContentParameters, type GenerateContentResponse,
} from "@google/genai";
import {
  ChatRequest, ChatResponse, Provider, StreamEvent, ToolCall, estimateTokens, toolNameForCall,
} from "./types.js";
import { config } from "../config.js";

/** Headroom so a thinking model has room to think AND answer. */
export const MIN_OUTPUT_TOKENS = 512;

/** The two SDK calls the adapter makes - narrow so tests can inject a fake. */
export interface GeminiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    generateContentStream?(params: GenerateContentParameters): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

export class GoogleProvider implements Provider {
  readonly name = "google";
  private client: GeminiClient | null;

  constructor(apiKey: string, private defaultModel = "gemini-3.6-flash", client?: GeminiClient) {
    this.client = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : null);
  }

  isReady() { return this.client !== null; }

  /** Our neutral request -> Gemini's parameters. */
  private params(req: ChatRequest, model: string): { params: GenerateContentParameters; contents: Content[]; system: string } {
    // Gemini takes a system instruction plus alternating user/model turns.
    // Tool calls ride on the model turn as functionCall parts; tool results go
    // back as functionResponse parts on a user turn.
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents: Content[] = [];
    for (const m of req.messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        contents.push({ role: "user", parts: [{ functionResponse: {
          id: m.toolCallId,
          name: toolNameForCall(req.messages, m.toolCallId ?? "") ?? "tool",
          response: { result: m.content },
        } }] });
        continue;
      }
      const parts: Part[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls ?? []) {
        parts.push({ functionCall: { id: c.id, name: c.name, args: c.arguments },
                     ...(c.signature ? { thoughtSignature: c.signature } : {}) });
      }
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }

    // Raise a too-small caller budget rather than silently returning "". The
    // caller asked for a short ANSWER; they did not ask for a short think.
    const maxOutputTokens = Math.max(req.maxTokens ?? config.policy.defaultMaxTokens, MIN_OUTPUT_TOKENS);

    return { contents, system, params: {
      model,
      contents,
      config: {
        maxOutputTokens,
        ...(system ? { systemInstruction: system } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } }
          : {}),
        ...(req.tools?.length
          ? { tools: [{ functionDeclarations: req.tools.map((t) => ({
              name: t.name, description: t.description, parameters: t.parameters as never,
            })) }] }
          : {}),
      },
    } };
  }

  /** One functionCall part -> one neutral ToolCall. `index` gives a stable id when Gemini sends none. */
  private toToolCall(p: Part, index: number): ToolCall {
    return {
      id: p.functionCall!.id ?? `call_${index}`,
      name: p.functionCall!.name ?? "",
      arguments: p.functionCall!.args ?? {},
      ...(p.thoughtSignature ? { signature: p.thoughtSignature } : {}),
    };
  }

  /**
   * Gemini's parts -> our neutral response. Reads the parts directly: the
   * SDK's `.text` drops thought-signed parts, and the function calls (and
   * their signatures) only exist at the part level. Shared by the one-shot
   * and streaming paths - a stream is just parts arriving over time.
   */
  private parse(
    parts: Part[], um: GenerateContentResponse["usageMetadata"], finish: string | undefined,
    model: string, fallbackInput: string,
  ): ChatResponse {
    const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    const toolCalls: ToolCall[] = parts.filter((p) => p.functionCall).map((p, i) => this.toToolCall(p, i));

    const thinking = um?.thoughtsTokenCount ?? 0;
    const visible = um?.candidatesTokenCount ?? estimateTokens(text);

    if (finish === "MAX_TOKENS" && !text.trim() && toolCalls.length === 0) {
      // Fail loudly rather than returning "" and letting it be cached as a valid
      // answer - a cached empty string is a bug that outlives the request.
      throw Object.assign(
        new Error(`google: output budget exhausted by reasoning (${thinking} thought tokens, no answer). Raise maxTokens or set thinkingBudget: 0.`),
        { status: 502 },
      );
    }

    return {
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      stopReason: toolCalls.length ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end",
      usage: {
        inputTokens: um?.promptTokenCount ?? estimateTokens(fallbackInput),
        outputTokens: visible + thinking,   // providers bill thinking as output
        thinkingTokens: thinking || undefined,
      },
      model,
      provider: this.name,
    };
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    if (!this.client) throw new Error("google: GOOGLE_API_KEY not configured");
    const model = req.model ?? this.defaultModel;
    const { params, contents, system } = this.params(req, model);
    const res = await this.client.models.generateContent(params);
    return this.parse(res.candidates?.[0]?.content?.parts ?? [], res.usageMetadata,
      res.candidates?.[0]?.finishReason, model, JSON.stringify(contents) + system);
  }

  /**
   * Same request, parts arriving as chunks. Visible text is forwarded as it
   * comes; every part is also accumulated so the final response is parsed by
   * exactly the same code as a one-shot call - tool calls, signatures,
   * thinking tokens and all. Usage metadata is cumulative on Gemini chunks, so
   * the last one seen is the total.
   */
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.client) throw new Error("google: GOOGLE_API_KEY not configured");
    if (!this.client.models.generateContentStream) {
      yield { type: "final", response: await this.complete(req) };
      return;
    }
    const model = req.model ?? this.defaultModel;
    const { params, contents, system } = this.params(req, model);
    const chunks = await this.client.models.generateContentStream(params);

    const parts: Part[] = [];
    let usage: GenerateContentResponse["usageMetadata"];
    let finish: string | undefined;
    let calls = 0;
    for await (const chunk of chunks) {
      const cand = chunk.candidates?.[0];
      for (const p of cand?.content?.parts ?? []) {
        parts.push(p);
        if (p.text && !p.thought) yield { type: "delta", text: p.text };
        // Gemini sends each function call as one complete part, so it can be
        // handed to the agent the moment it arrives. Same index-based id as
        // parse() will assign, so `final.toolCalls` matches what was emitted.
        if (p.functionCall) yield { type: "tool_call", call: this.toToolCall(p, calls++) };
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (cand?.finishReason) finish = cand.finishReason;
    }
    yield { type: "final", response: this.parse(parts, usage, finish, model, JSON.stringify(contents) + system) };
  }
}
