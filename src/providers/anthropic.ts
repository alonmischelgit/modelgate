// Anthropic (Claude) adapter - the second provider, which is what makes the
// failover path real rather than theoretical.
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { ChatRequest, ChatResponse, Provider, ToolCall } from "./types.js";
import { config } from "../config.js";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic | null;

  constructor(apiKey: string, private defaultModel = "claude-haiku-4-5") {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  isReady() { return this.client !== null; }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    if (!this.client) throw new Error("anthropic: ANTHROPIC_API_KEY not configured");
    const model = req.model ?? this.defaultModel;
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");

    // Claude wants strictly alternating user/assistant turns. Tool calls are
    // tool_use blocks on the assistant turn; results are tool_result blocks on
    // the *next user turn* - several results from parallel calls share one.
    const messages: MessageParam[] = [];
    for (const m of req.messages) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        const block: ContentBlockParam = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
        const prev = messages.at(-1);
        if (prev?.role === "user" && Array.isArray(prev.content)) prev.content.push(block);
        else messages.push({ role: "user", content: [block] });
        continue;
      }
      const content: ContentBlockParam[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      messages.push({ role: m.role, content });
    }

    const res = await this.client.messages.create({
      model,
      max_tokens: req.maxTokens ?? config.policy.defaultMaxTokens,
      ...(system ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as never })) }
        : {}),
      messages,
    });

    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolCalls: ToolCall[] = res.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> }));

    return {
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      stopReason: res.stop_reason === "tool_use" ? "tool_use" : res.stop_reason === "max_tokens" ? "max_tokens" : "end",
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model,
      provider: this.name,
    };
  }
}
