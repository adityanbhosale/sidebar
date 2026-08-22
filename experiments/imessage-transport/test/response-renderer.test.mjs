import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLY_SCHEMA,
  createNaturalReplyRenderer,
} from "../src/response-renderer.mjs";

test("renders a deterministic result in a natural structured reply", async () => {
  let requestBody;
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return modelReply(["locked in — 40 on yes for #3", "yes is at 75% · pot 100"]);
    },
  });

  const result = await render({
    request: "sidebar put 40 on dan being late",
    intent: { action: "place_bet" },
    canonicalReply: "got it — 40 on yes for #3\nyes 75% (75) · no 25% (25) · pot 100",
  });

  // The renderer omitted canonical numeric facts, so correctness wins over
  // style and the known-good result is used instead.
  assert.deepEqual(result, [
    "got it — 40 on yes for #3",
    "yes 75% (75) · no 25% (25) · pot 100",
  ]);
  assert.equal(requestBody.store, false);
  assert.deepEqual(requestBody.text.format.schema, REPLY_SCHEMA);
  assert.equal(requestBody.text.format.strict, true);
});

test("accepts concise generated bubbles when every critical fact is preserved", async () => {
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async () => modelReply([
      "locked in — 40 on yes for market 3",
      "yes 75% (75) · no 25% (25) · pot 100",
    ]),
  });
  const result = await render({
    request: "sidebar put 40 on dan being late",
    intent: { action: "place_bet" },
    canonicalReply: "got it — 40 on yes for #3\nyes 75% (75) · no 25% (25) · pot 100",
  });
  assert.deepEqual(result, [
    "locked in — 40 on yes for market 3",
    "yes 75% (75) · no 25% (25) · pot 100",
  ]);
});

test("rejects a rendered reply that invents a number", async () => {
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async () => modelReply(["market #3 is live with a 90% chance"]),
  });
  assert.deepEqual(
    await render({
      request: "sidebar show market 3",
      intent: { action: "show_market" },
      canonicalReply: "#3 dan is late\nyes 75% · pot 100",
    }),
    ["#3 dan is late", "yes 75% · pot 100"],
  );
});

test("rejects a rendered reply that changes the market subject", async () => {
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async () => modelReply([
      "#3 will adam be late?",
      "yes 75% · pot 100",
    ]),
  });
  assert.deepEqual(
    await render({
      request: "sidebar show market 3",
      intent: { action: "show_market" },
      canonicalReply: "#3 Will Dan be late?\nyes 75% · pot 100",
    }),
    ["#3 will dan be late?", "yes 75% · pot 100"],
  );
});

test("allows a direct natural health-check response", async () => {
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async () => modelReply(["up and running!"]),
  });
  assert.deepEqual(
    await render({
      request: "sidebar test",
      intent: { action: "health_check" },
      canonicalReply: "all good here",
    }),
    ["up and running!"],
  );
});

test("uses the canonical fallback if rendering is unavailable", async () => {
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  assert.deepEqual(
    await render({
      request: "sidebar test",
      intent: { action: "health_check" },
      canonicalReply: ["all good here", "what's up?"],
    }),
    ["all good here", "what's up?"],
  );
});

test("does not spend a second model call rewriting planned chat", async () => {
  let called = false;
  const render = createNaturalReplyRenderer({
    apiKey: "test-key",
    fetchImpl: async () => {
      called = true;
      return modelReply(["wrong"]);
    },
  });
  const result = await render({
    request: "sidebar the public hates you",
    intent: { action: "chat" },
    canonicalReply: ["damn 😭", "i'm trying"],
  });
  assert.equal(called, false);
  assert.deepEqual(result, ["damn 😭", "i'm trying"]);
});

function modelReply(bubbles) {
  return new Response(
    JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ bubbles }),
        }],
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
