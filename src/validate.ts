// -----------------------------------------------------------------------------
// Request validation at the edge.
//
// A gateway is a boundary: what comes in is untrusted JSON, and every field
// below is eventually handed to a provider SDK that will either throw something
// unhelpful or, worse, quietly do the wrong thing. Rejecting bad shapes here
// with a 400 that names the field is cheaper for everyone than a 500 with a
// stack trace from inside a vendor library.
//
// Hand-written on purpose: the schema is small and stable, and the OpenAPI
// document (openapi.ts) is the human-facing contract - this is its runtime
// twin. If the two ever disagree, the tests catch it.
// -----------------------------------------------------------------------------
import { ChatMessage, ChatRequest, ToolCall, ToolDef } from "./providers/types.js";

export type Validation = { ok: true; req: ChatRequest } | { ok: false; detail: string };

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;

export function validateChatRequest(body: unknown): Validation {
  if (!isObj(body)) return fail("body must be a JSON object");
  const b = body;

  if (!Array.isArray(b.messages) || b.messages.length === 0) return fail("messages[] is required and must be non-empty");
  const messages: ChatMessage[] = [];
  const openCalls = new Set<string>();   // tool calls the assistant made that have not been answered yet
  for (const [i, m] of b.messages.entries()) {
    const at = `messages[${i}]`;
    if (!isObj(m)) return fail(`${at} must be an object`);
    if (!ROLES.has(m.role as string)) return fail(`${at}.role must be one of system|user|assistant|tool`);
    if (typeof m.content !== "string") return fail(`${at}.content must be a string`);
    const msg: ChatMessage = { role: m.role as ChatMessage["role"], content: m.content };
    if (m.role === "tool") {
      if (typeof m.toolCallId !== "string" || !m.toolCallId) return fail(`${at}.toolCallId is required for role "tool"`);
      // A result must answer a call the assistant actually made earlier in this
      // conversation. Providers reject orphans with an opaque 400; we say which.
      if (!openCalls.delete(m.toolCallId)) return fail(`${at}.toolCallId "${m.toolCallId}" does not match any earlier assistant toolCalls`);
      msg.toolCallId = m.toolCallId;
    }
    if (m.toolCalls !== undefined) {
      if (m.role !== "assistant") return fail(`${at}.toolCalls is only valid on role "assistant"`);
      if (!Array.isArray(m.toolCalls)) return fail(`${at}.toolCalls must be an array`);
      const calls: ToolCall[] = [];
      for (const [j, c] of m.toolCalls.entries()) {
        if (!isObj(c) || typeof c.id !== "string" || typeof c.name !== "string" || !isObj(c.arguments)) {
          return fail(`${at}.toolCalls[${j}] must be { id: string, name: string, arguments: object }`);
        }
        calls.push({ id: c.id, name: c.name, arguments: c.arguments,
          ...(typeof c.signature === "string" ? { signature: c.signature } : {}) });
        openCalls.add(c.id);
      }
      msg.toolCalls = calls;
    }
    messages.push(msg);
  }

  const req: ChatRequest = { messages };

  if (b.model !== undefined) {
    if (typeof b.model !== "string" || !b.model) return fail("model must be a non-empty string");
    req.model = b.model;
  }
  if (b.maxTokens !== undefined) {
    if (!isInt(b.maxTokens, 1)) return fail("maxTokens must be a positive integer");
    req.maxTokens = b.maxTokens as number;
  }
  if (b.temperature !== undefined) {
    if (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2) return fail("temperature must be a number between 0 and 2");
    req.temperature = b.temperature;
  }
  if (b.thinkingBudget !== undefined) {
    if (!isInt(b.thinkingBudget, 0)) return fail("thinkingBudget must be a non-negative integer");
    req.thinkingBudget = b.thinkingBudget as number;
  }
  if (b.allowSubstitute !== undefined) {
    if (typeof b.allowSubstitute !== "boolean") return fail("allowSubstitute must be a boolean");
    req.allowSubstitute = b.allowSubstitute;
  }
  if (b.cache !== undefined) {
    if (typeof b.cache !== "boolean") return fail("cache must be a boolean");
    req.cache = b.cache;
  }
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return fail("tools must be an array");
    const tools: ToolDef[] = [];
    for (const [i, t] of b.tools.entries()) {
      if (!isObj(t) || typeof t.name !== "string" || !t.name || !isObj(t.parameters)) {
        return fail(`tools[${i}] must be { name: string, parameters: object, description?: string }`);
      }
      tools.push({ name: t.name, parameters: t.parameters,
        ...(typeof t.description === "string" ? { description: t.description } : {}) });
    }
    req.tools = tools;
  }

  return { ok: true, req };
}

const fail = (detail: string): Validation => ({ ok: false, detail });
