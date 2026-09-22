// The runtime twin of the OpenAPI contract: bad shapes are 400s with a field
// name, never a 500 from inside a vendor SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChatRequest } from "./validate.js";

const user = { role: "user", content: "hi" };

test("a minimal valid request passes and is normalised", () => {
  const v = validateChatRequest({ messages: [user] });
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.req, { messages: [user] });
});

test("optional fields are kept when valid", () => {
  const v = validateChatRequest({
    messages: [user], model: "mock-small", maxTokens: 10, temperature: 0.5,
    thinkingBudget: 0, allowSubstitute: false,
    tools: [{ name: "t", parameters: { type: "object" }, description: "d" }],
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.req.thinkingBudget, 0);
    assert.equal(v.req.allowSubstitute, false);
    assert.equal(v.req.tools?.[0].description, "d");
  }
});

const bad: [string, unknown, RegExp][] = [
  ["non-object body",           "nope",                                              /JSON object/],
  ["missing messages",          {},                                                  /messages\[\]/],
  ["empty messages",            { messages: [] },                                    /non-empty/],
  ["bad role",                  { messages: [{ role: "robot", content: "x" }] },     /messages\[0\]\.role/],
  ["non-string content",        { messages: [{ role: "user", content: 5 }] },        /messages\[0\]\.content/],
  ["tool without toolCallId",   { messages: [{ role: "tool", content: "x" }] },      /toolCallId/],
  ["toolCalls on user",         { messages: [{ role: "user", content: "x", toolCalls: [] }] }, /only valid on role "assistant"/],
  ["malformed toolCall",        { messages: [{ role: "assistant", content: "", toolCalls: [{ id: 1 }] }] }, /toolCalls\[0\]/],
  ["maxTokens string",          { messages: [user], maxTokens: "abc" },              /maxTokens/],
  ["maxTokens zero",            { messages: [user], maxTokens: 0 },                  /maxTokens/],
  ["temperature out of range",  { messages: [user], temperature: 3 },                /temperature/],
  ["negative thinkingBudget",   { messages: [user], thinkingBudget: -5 },            /thinkingBudget/],
  ["allowSubstitute string",    { messages: [user], allowSubstitute: "yes" },        /allowSubstitute/],
  ["tools not an array",        { messages: [user], tools: "x" },                    /tools must be an array/],
  ["tool without parameters",   { messages: [user], tools: [{ name: "t" }] },        /tools\[0\]/],
];

for (const [name, body, pattern] of bad) {
  test(`rejects: ${name}`, () => {
    const v = validateChatRequest(body);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.detail, pattern);
  });
}

test("rejects a tool result that answers no earlier assistant call", () => {
  const v = validateChatRequest({ messages: [
    { role: "user", content: "x" },
    { role: "tool", toolCallId: "ghost", content: "r" },
  ] });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.detail, /"ghost" does not match any earlier assistant toolCalls/);
});

test("accepts a tool result that answers an earlier assistant call, once", () => {
  const ok = validateChatRequest({ messages: [
    { role: "user", content: "x" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
    { role: "tool", toolCallId: "c1", content: "r" },
  ] });
  assert.equal(ok.ok, true);
  const twice = validateChatRequest({ messages: [
    { role: "user", content: "x" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
    { role: "tool", toolCallId: "c1", content: "r" },
    { role: "tool", toolCallId: "c1", content: "r again" },
  ] });
  assert.equal(twice.ok, false, "a call can only be answered once");
});
