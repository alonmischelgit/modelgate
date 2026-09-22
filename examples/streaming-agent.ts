// -----------------------------------------------------------------------------
// The same agent as agent.ts, streaming. Tokens print as they arrive; when the
// model asks for a tool, the `done` event carries the tool calls, the agent
// runs them and loops. Read next to agent.ts: the LOOP is identical, only the
// transport changed - which is the point of putting streaming in the gateway
// rather than in every agent.
//
//   npm run agent:stream                       # mock model, no key needed
//   npm run agent:stream -- gemini-3.6-flash   # a real one
//
// Server-sent events, parsed by hand in ~15 lines so nothing is hidden: an
// SSE stream is just `event: <name>\ndata: <json>\n\n` blocks over a
// long-lived HTTP response. Every hop sends the same x-request-id.
// -----------------------------------------------------------------------------
import { config } from "../src/config.js";

const BASE = `http://localhost:${config.port}`;
const MODEL = process.argv[2] ?? config.policy.defaultModel;
const RUN_ID = `stream-${Math.random().toString(36).slice(2, 8)}`;

const tools = [{
  name: "get_weather",
  description: "Current weather for a city. Use for any weather question; not for forecasts.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}];
const run = (name: string, args: Record<string, unknown>): string =>
  name === "get_weather" ? JSON.stringify({ city: args.city, tempC: 29, sky: "clear" }) : JSON.stringify({ error: `unknown tool ${name}` });

type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; signature?: string };
type Msg = { role: "user" | "assistant" | "tool"; content: string; toolCalls?: ToolCall[]; toolCallId?: string };
type Done = { text: string; toolCalls?: ToolCall[]; stopReason: string; costUsd: number; cached: boolean;
              servedBy: { provider: string; model: string }; trace: string[] };

/** Parse one SSE stream into events, yielding each as soon as its block is complete. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
      const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}");
      yield { event, data };
    }
  }
}

const messages: Msg[] = [{ role: "user", content: process.argv[3] ?? "What's the weather in Haifa right now?" }];
let hops = 0, totalCost = 0;

// Errors end the run by returning, not process.exit(): exiting with a fetch
// body still open trips a libuv assertion on Windows. Let the loop unwind.
async function main(): Promise<string | undefined> {
  for (;;) {
    hops++;
    const res = await fetch(`${BASE}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "x-api-key": "agent-demo", "x-request-id": RUN_ID },
      body: JSON.stringify({ model: MODEL, messages, tools, thinkingBudget: 0 }),
    });
    if (!res.ok || !res.body) {   // decided before the first byte: plain JSON with a status
      const err = await res.json() as { error: string; detail: string };
      return `hop ${hops}: HTTP ${res.status} ${err.error} - ${err.detail}`;
    }

    process.stdout.write(`\nhop ${hops}  `);
    let done: Done | undefined;
    for await (const { event, data } of sse(res.body)) {
      if (event === "delta") process.stdout.write(String(data.text));
      else if (event === "done") done = data as unknown as Done;
      else if (event === "error") return `\nstream interrupted: ${data.detail}`;
    }
    if (!done) return "\nstream ended without a done event";

    totalCost += done.costUsd;
    console.log(`\n      ${done.servedBy.provider}/${done.servedBy.model}  ${done.cached ? "CACHE HIT" : `$${done.costUsd}`}`);
    for (const line of done.trace) console.log(`      ${line}`);

    if (done.stopReason !== "tool_use" || !done.toolCalls?.length) return undefined;

    // Tool calls arrive on `done`, not mid-stream: the model decides what to call
    // only once it has finished, and we need the whole call to run it.
    messages.push({ role: "assistant", content: done.text, toolCalls: done.toolCalls });
    for (const call of done.toolCalls) {
      const result = run(call.name, call.arguments);
      console.log(`      -> ran ${call.name}(${JSON.stringify(call.arguments)}) = ${result}`);
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
    if (hops >= 5) return "step cap hit - an agent loop always needs one";
  }
}

const failure = await main();
if (failure) { console.error(failure); process.exitCode = 1; }
else console.log(`\n${hops} hops, $${totalCost.toFixed(6)} total, request id ${RUN_ID}`);
