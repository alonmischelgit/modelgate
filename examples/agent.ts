// -----------------------------------------------------------------------------
// A minimal agent that talks to the gateway. This is the whole point of the
// project in thirty lines: the agent owns the loop and runs the tools; the
// gateway is the transport that makes every hop routed, limited, budgeted,
// cached, retried, and metered.
//
//   npm run agent                       # mock model, no key needed
//   npm run agent -- gemini-3.6-flash   # a real one
//
// One x-request-id is sent on every hop, so the ledger and the trace answer
// "what did THIS task cost, across all its calls" - the question that is
// impossible to answer when agents call providers directly.
// -----------------------------------------------------------------------------
import { config } from "../src/config.js";

const BASE = `http://localhost:${config.port}`;
const MODEL = process.argv[2] ?? config.policy.defaultModel;
const RUN_ID = `agent-${Math.random().toString(36).slice(2, 8)}`;

// The tools this agent can run. The gateway only ever sees the schema.
const tools = [{
  name: "get_weather",
  description: "Current weather for a city. Use for any weather question; not for forecasts.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}];
const run = (name: string, args: Record<string, unknown>): string => {
  if (name === "get_weather") return JSON.stringify({ city: args.city, tempC: 29, sky: "clear" });
  return JSON.stringify({ error: `unknown tool ${name}` });
};

type Msg = { role: "user" | "assistant" | "tool"; content: string; toolCalls?: ToolCall[]; toolCallId?: string };
type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; signature?: string };
type Reply = {
  text: string; toolCalls?: ToolCall[]; stopReason: string; costUsd: number; cached: boolean;
  servedBy: { provider: string; model: string }; usage: { thinkingTokens?: number }; trace: string[]; error?: string; detail?: string;
};

const messages: Msg[] = [{ role: "user", content: process.argv[3] ?? "What's the weather in Haifa right now?" }];
let hops = 0, totalCost = 0;

for (;;) {
  hops++;
  const res = await fetch(`${BASE}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "agent-demo", "x-request-id": RUN_ID },
    body: JSON.stringify({ model: MODEL, messages, tools, thinkingBudget: 0 }),
  });
  const r = await res.json() as Reply;
  if (!res.ok) { console.error(`hop ${hops}: HTTP ${res.status} ${r.error} - ${r.detail}`); process.exit(1); }

  totalCost += r.costUsd;
  console.log(`\nhop ${hops}  ${r.servedBy.provider}/${r.servedBy.model}  ${r.cached ? "CACHE HIT" : `$${r.costUsd}`}` +
              (r.usage.thinkingTokens ? `  (${r.usage.thinkingTokens} thinking tokens)` : ""));
  for (const line of r.trace) console.log(`    ${line}`);

  if (r.stopReason !== "tool_use" || !r.toolCalls?.length) {
    console.log(`\nanswer: ${r.text}`);
    break;
  }

  // The model asked for tools. WE run them - the gateway never does - and send
  // the results back as `tool` messages, echoing the assistant turn (with its
  // signature) so the provider can pick up where it left off.
  messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
  for (const call of r.toolCalls) {
    const result = run(call.name, call.arguments);
    console.log(`    -> ran ${call.name}(${JSON.stringify(call.arguments)}) = ${result}`);
    messages.push({ role: "tool", toolCallId: call.id, content: result });
  }
  if (hops >= 5) { console.error("step cap hit - an agent loop always needs one"); process.exit(1); }
}

console.log(`\n${hops} hops, $${totalCost.toFixed(6)} total, request id ${RUN_ID}`);
console.log(`ledger: grep ${RUN_ID} data/usage.jsonl`);
