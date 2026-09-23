// The Gemini adapter, with a fake SDK client. This is where the subtle logic
// lives - thinking-token accounting, the empty-answer trap, tool-call parsing
// with reasoning signatures - so it is where a wrong assumption would hide.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { GoogleProvider, MIN_OUTPUT_TOKENS, type GeminiClient } from "./google.js";

type Reply = { parts: Record<string, unknown>[]; finish?: string; usage?: Record<string, number> };

/** A client that returns a canned reply and remembers what it was asked. */
function fake(reply: Reply) {
  const calls: GenerateContentParameters[] = [];
  const client: GeminiClient = {
    models: {
      async generateContent(params) {
        calls.push(params);
        return {
          candidates: [{ content: { parts: reply.parts, role: "model" }, finishReason: reply.finish ?? "STOP" }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, ...reply.usage },
        } as unknown as GenerateContentResponse;
      },
    },
  };
  return { client, calls, provider: new GoogleProvider("", "gemini-3.6-flash", client) };
}

const ask = (content: string) => ({ messages: [{ role: "user" as const, content }] });

test("thinking tokens are billed as output and broken out", async () => {
  const { provider } = fake({ parts: [{ text: "gateway online." }], usage: { thoughtsTokenCount: 84 } });
  const r = await provider.complete(ask("say it"));
  assert.equal(r.text, "gateway online.");
  assert.equal(r.usage.outputTokens, 3 + 84);
  assert.equal(r.usage.thinkingTokens, 84);
  assert.equal(r.stopReason, "end");
});

test("thought parts are excluded from the visible text", async () => {
  const { provider } = fake({ parts: [{ text: "let me think", thought: true }, { text: "answer" }] });
  const r = await provider.complete(ask("q"));
  assert.equal(r.text, "answer");
});

test("an empty answer that ran out of budget throws rather than returning ''", async () => {
  const { provider } = fake({ parts: [], finish: "MAX_TOKENS", usage: { thoughtsTokenCount: 34, candidatesTokenCount: 0 } });
  await assert.rejects(() => provider.complete(ask("q")), (e: Error & { status?: number }) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /34 thought tokens/);
    return true;
  });
});

test("a caller's small maxTokens is raised to the floor so reasoning cannot eat the answer", async () => {
  const { provider, calls } = fake({ parts: [{ text: "ok" }] });
  await provider.complete({ ...ask("q"), maxTokens: 40 });
  assert.equal((calls[0].config as { maxOutputTokens: number }).maxOutputTokens, MIN_OUTPUT_TOKENS);
});

test("thinkingBudget is passed through; tools become functionDeclarations", async () => {
  const { provider, calls } = fake({ parts: [{ text: "ok" }] });
  await provider.complete({ ...ask("q"), thinkingBudget: 0,
    tools: [{ name: "get_weather", description: "d", parameters: { type: "object" } }] });
  const cfg = calls[0].config as { thinkingConfig: { thinkingBudget: number }; tools: { functionDeclarations: { name: string }[] }[] };
  assert.equal(cfg.thinkingConfig.thinkingBudget, 0);
  assert.equal(cfg.tools[0].functionDeclarations[0].name, "get_weather");
});

test("a functionCall part becomes a toolCall, signature preserved, stopReason tool_use", async () => {
  const { provider } = fake({ parts: [
    { functionCall: { name: "get_weather", args: { city: "Haifa" } }, thoughtSignature: "sig-abc" },
  ] });
  const r = await provider.complete(ask("weather?"));
  assert.equal(r.stopReason, "tool_use");
  assert.equal(r.text, "");
  assert.deepEqual(r.toolCalls, [{ id: "call_0", name: "get_weather", arguments: { city: "Haifa" }, signature: "sig-abc" }]);
});

test("the tool round-trip is mapped to model functionCall + user functionResponse turns", async () => {
  const { provider, calls } = fake({ parts: [{ text: "29C and clear." }] });
  await provider.complete({
    messages: [
      { role: "system", content: "terse" },
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_weather", arguments: { city: "Haifa" }, signature: "sig" }] },
      { role: "tool", toolCallId: "c1", content: "29C" },
    ],
  });
  const p = calls[0];
  const contents = p.contents as { role: string; parts: Record<string, unknown>[] }[];
  assert.equal((p.config as { systemInstruction: string }).systemInstruction, "terse");
  assert.deepEqual(contents.map((c) => c.role), ["user", "model", "user"]);
  assert.deepEqual(contents[1].parts[0], { functionCall: { id: "c1", name: "get_weather", args: { city: "Haifa" } }, thoughtSignature: "sig" });
  const fr = contents[2].parts[0].functionResponse as { id: string; name: string; response: unknown };
  assert.equal(fr.name, "get_weather", "the result is matched back to the call by id to recover the name");
  assert.deepEqual(fr.response, { result: "29C" });
});

test("stream: text parts are forwarded as they arrive; the final is parsed like a one-shot", async () => {
  const chunks = [
    { candidates: [{ content: { parts: [{ text: "gateway " }], role: "model" } }] },
    { candidates: [{ content: { parts: [{ text: "reasoning...", thought: true }], role: "model" } }] },
    { candidates: [{ content: { parts: [{ text: "online." }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, thoughtsTokenCount: 84 } },
  ];
  const client: GeminiClient = {
    models: {
      async generateContent() { throw new Error("not used"); },
      async generateContentStream() {
        return (async function* () { for (const c of chunks) yield c as unknown as GenerateContentResponse; })();
      },
    },
  };
  const provider = new GoogleProvider("", "gemini-3.6-flash", client);
  const deltas: string[] = [];
  let final: import("./types.js").ChatResponse | undefined;
  for await (const ev of provider.stream(ask("say it"))) {
    if (ev.type === "delta") deltas.push(ev.text); else if (ev.type === "final") final = ev.response;
  }
  assert.deepEqual(deltas, ["gateway ", "online."], "thought parts are not forwarded");
  assert.equal(final!.text, "gateway online.");
  assert.equal(final!.usage.outputTokens, 3 + 84, "thinking tokens still counted on the streaming path");
  assert.equal(final!.stopReason, "end");
});

test("stream: a functionCall part arriving in a chunk becomes a tool call with its signature", async () => {
  const chunks = [
    { candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Haifa" } }, thoughtSignature: "sig" }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 } },
  ];
  const client: GeminiClient = {
    models: {
      async generateContent() { throw new Error("not used"); },
      async generateContentStream() { return (async function* () { for (const c of chunks) yield c as unknown as GenerateContentResponse; })(); },
    },
  };
  const provider = new GoogleProvider("", "gemini-3.6-flash", client);
  let final: import("./types.js").ChatResponse | undefined;
  for await (const ev of provider.stream(ask("weather?"))) if (ev.type === "final") final = ev.response;
  assert.equal(final!.stopReason, "tool_use");
  assert.deepEqual(final!.toolCalls, [{ id: "call_0", name: "get_weather", arguments: { city: "Haifa" }, signature: "sig" }]);
});

test("stream: a tool call is emitted the moment its part arrives, before final, with the same id final uses", async () => {
  const chunks = [
    { candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Haifa" } }, thoughtSignature: "s1" }], role: "model" } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "get_time", args: { tz: "Asia/Jerusalem" } } }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 8 } },
  ];
  const client: GeminiClient = {
    models: {
      async generateContent() { throw new Error("not used"); },
      async generateContentStream() { return (async function* () { for (const c of chunks) yield c as unknown as GenerateContentResponse; })(); },
    },
  };
  const provider = new GoogleProvider("", "gemini-3.6-flash", client);
  const order: string[] = [];
  const emitted: import("./types.js").ToolCall[] = [];
  let final: import("./types.js").ChatResponse | undefined;
  for await (const ev of provider.stream(ask("weather and time?"))) {
    order.push(ev.type);
    if (ev.type === "tool_call") emitted.push(ev.call);
    if (ev.type === "final") final = ev.response;
  }
  assert.deepEqual(order, ["tool_call", "tool_call", "final"]);
  assert.deepEqual(emitted.map((c) => c.id), ["call_0", "call_1"]);
  assert.deepEqual(final!.toolCalls, emitted, "final repeats exactly what was emitted, ids included");
  assert.equal(emitted[0].signature, "s1");
});
