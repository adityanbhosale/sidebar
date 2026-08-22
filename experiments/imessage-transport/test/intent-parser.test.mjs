import assert from "node:assert/strict";
import test from "node:test";
import {
  INTENT_SCHEMA,
  isAgentInvocation,
  parseDeterministicIntent,
  parseNaturalLanguageIntent,
} from "../src/intent-parser.mjs";

test("invokes only messages that begin by naming Sidebar", () => {
  assert.equal(isAgentInvocation("sidebar what are the odds on market 2?"), true);
  assert.equal(isAgentInvocation("Sidebar, show markets"), true);
  // Older beta commands remain valid, but the @ is no longer required.
  assert.equal(isAgentInvocation("@Sidebar, put 40 on yes in market 3"), true);
  assert.equal(isAgentInvocation("hey sidebar: show markets"), false);
  assert.equal(isAgentInvocation("please @sidebar show markets"), false);
  assert.equal(isAgentInvocation("put 40 on yes in market 3"), false);
  assert.equal(isAgentInvocation("what are the odds on market 2?"), false);
  assert.equal(isAgentInvocation("I mentioned Sidebar in conversation"), false);
  assert.equal(isAgentInvocation("I bet Dan is late again"), false);
  assert.equal(isAgentInvocation("ordinary group chatter"), false);
});

test("parses natural bet and market query phrases without an LLM", () => {
  assert.deepEqual(
    parseDeterministicIntent("@sidebar, put 40 points on yes in market 3"),
    {
      action: "place_bet",
      marketNumber: 3,
      side: "yes",
      amount: 40,
      question: null,
      criteria: null,
      revealAt: null,
      closeAt: null,
      resolveAt: null,
      subjectName: null,
      subjectPhone: null,
      requestedGroupName: null,
      replyMessages: [],
      confidence: 1,
      clarification: null,
      source: "deterministic",
    },
  );
  assert.equal(
    parseDeterministicIntent("what are the odds on market #7?").action,
    "show_market",
  );
});

test("matches a natural bet description against only the supplied markets", () => {
  const markets = [
    { display_num: 1, question: "Will Adi black out tonight?" },
    { display_num: 2, question: "Will Brent arrive before midnight?" },
  ];
  const parsed = parseDeterministicIntent(
    "@sidebar, put 100 points on adi blacking out tonight",
    { markets },
  );
  assert.equal(parsed.action, "place_bet");
  assert.equal(parsed.marketNumber, 1);
  assert.equal(parsed.side, "yes");
  assert.equal(parsed.amount, 100);
});

test("matches a resolution description and rejects ambiguous market references", () => {
  const markets = [
    { display_num: 1, question: "Will Adi black out tonight?" },
    { display_num: 2, question: "Will Adi black out tomorrow?" },
  ];
  const resolved = parseDeterministicIntent(
    "@sidebar, resolve adi blacking out tonight as yes",
    { markets },
  );
  assert.equal(resolved.action, "resolve_market");
  assert.equal(resolved.marketNumber, 1);
  assert.equal(resolved.side, "yes");

  const ambiguous = parseDeterministicIntent("@sidebar, put 20 on adi blacking out", {
    markets,
  });
  assert.equal(ambiguous.action, "unknown");
  assert.match(ambiguous.clarification, /more than one possible market/i);
});

test("matches join and leave commands by question instead of requiring a number", () => {
  const markets = [{ display_num: 1, question: "Will Adi black out tonight?" }];
  assert.deepEqual(
    parseDeterministicIntent("@sidebar, join adi blacking out tonight", { markets }),
    {
      action: "join_market",
      marketNumber: 1,
      side: null,
      amount: null,
      question: null,
      criteria: null,
      revealAt: null,
      closeAt: null,
      resolveAt: null,
      subjectName: null,
      subjectPhone: null,
      requestedGroupName: null,
      replyMessages: [],
      confidence: 1,
      clarification: null,
      source: "deterministic",
    },
  );
  assert.equal(
    parseDeterministicIntent("@sidebar, leave market 1", { markets }).action,
    "leave_market",
  );
});

test("parses a final-payout request as a market detail read", () => {
  assert.deepEqual(parseDeterministicIntent("show payouts for market 3"), {
    action: "show_market",
    marketNumber: 3,
    side: null,
    amount: null,
    question: null,
    criteria: null,
    revealAt: null,
    closeAt: null,
    resolveAt: null,
    subjectName: null,
    subjectPhone: null,
    requestedGroupName: null,
    replyMessages: [],
    confidence: 1,
    clarification: null,
    source: "deterministic",
  });
});

test("parses a relative-time market creation without an LLM", () => {
  const now = new Date("2026-08-18T20:00:00.000Z");
  const parsed = parseDeterministicIntent(
    "create a market: Will Dan be late? closes in 2 hours",
    { now },
  );
  assert.equal(parsed.action, "create_market");
  assert.equal(parsed.question, "Will Dan be late?");
  assert.equal(parsed.closeAt, "2026-08-18T22:00:00.000Z");
  assert.ok(Date.parse(parsed.revealAt) < Date.parse(parsed.closeAt));
  assert.ok(Date.parse(parsed.closeAt) < Date.parse(parsed.resolveAt));
  assert.equal(parsed.subjectName, "Dan");
  assert.equal(parsed.subjectPhone, null);
});

test("takes a person name and phone in the original market command", () => {
  const parsed = parseDeterministicIntent(
    "@sidebar create a market: Will Dan be late? subject Dan +1 (212) 555-0199 closes in 2 hours",
    { now: new Date("2026-08-18T20:00:00.000Z") },
  );
  assert.equal(parsed.action, "create_market");
  assert.equal(parsed.question, "Will Dan be late?");
  assert.equal(parsed.subjectName, "Dan");
  assert.equal(parsed.subjectPhone, "+1 (212) 555-0199");
});

test("parses the prompted person-market follow-up without an LLM", () => {
  assert.deepEqual(
    parseDeterministicIntent("@sidebar subject Dan +1 (212) 555-0199"),
    {
      action: "complete_person_market",
      marketNumber: null,
      side: null,
      amount: null,
      question: null,
      criteria: null,
      revealAt: null,
      closeAt: null,
      resolveAt: null,
      subjectName: "Dan",
      subjectPhone: "+1 (212) 555-0199",
      requestedGroupName: null,
      replyMessages: [],
      confidence: 1,
      clarification: null,
      source: "deterministic",
    },
  );
  assert.equal(
    parseDeterministicIntent("@sidebar no subject").action,
    "complete_market_without_subject",
  );
});

test("does not call OpenAI for ordinary chatter", async () => {
  let called = false;
  const result = await parseNaturalLanguageIntent({
    text: "we should get dinner",
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected");
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("does not call OpenAI for an unprefixed market instruction", async () => {
  let called = false;
  const result = await parseNaturalLanguageIntent({
    text: "put 40 points on yes in market 3",
    apiKey: "test-key",
    fetchImpl: async () => {
      called = true;
      throw new Error("should not call");
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("keeps group creation distinct from market creation", async () => {
  const deterministic = parseDeterministicIntent(
    "sidebar make a group titled monkey business",
  );
  assert.equal(deterministic.action, "group_request");
  assert.equal(deterministic.requestedGroupName, "monkey business");

  const modeledWrong = await parseNaturalLanguageIntent({
    text: "sidebar make a group titled monkey business",
    apiKey: "test-key",
    fetchImpl: async () => modelResponse({
      action: "create_market",
      question: "monkey business",
      confidence: 0.99,
    }),
  });
  assert.equal(modeledWrong.action, "group_request");
  assert.equal(modeledWrong.source, "deterministic");
});

test("answers test and status checks without guessing at a market action", async () => {
  assert.equal(
    parseDeterministicIntent("sidebar test").action,
    "health_check",
  );
  assert.equal(
    parseDeterministicIntent("sidebar are you working?").action,
    "health_check",
  );

  const modeledWrong = await parseNaturalLanguageIntent({
    text: "sidebar test",
    apiKey: "test-key",
    fetchImpl: async () => modelResponse({
      action: "chat",
      replyMessages: ["lol fair"],
      confidence: 0.99,
    }),
  });
  assert.equal(modeledWrong.action, "health_check");
  assert.equal(modeledWrong.source, "deterministic");
});

test("treats addressed banter as chat instead of an incomplete market command", async () => {
  const result = await parseNaturalLanguageIntent({
    text: "sidebar the public hates you can you lock in",
    apiKey: "test-key",
    fetchImpl: async () => modelResponse({
      action: "chat",
      replyMessages: ["Damn 😭", "I'm locked in"],
      confidence: 0.99,
    }),
  });
  assert.equal(result.action, "chat");
  assert.deepEqual(result.replyMessages, ["damn 😭", "i'm locked in"]);
});

test("does not replace the model's semantic classification with a keyword fallback", async () => {
  const result = await parseNaturalLanguageIntent({
    text: "sidebar lock in bro",
    apiKey: "test-key",
    fetchImpl: async () => modelResponse({
      action: "chat",
      replyMessages: ["i'm locked in"],
      confidence: 0.99,
    }),
  });
  assert.equal(result.action, "chat");
  assert.deepEqual(result.replyMessages, ["i'm locked in"]);
});

test("uses strict structured output for ambiguous invoked language", async () => {
  let requestBody;
  const result = await parseNaturalLanguageIntent({
    text: "@sidebar I want fifty points on the affirmative side of number four",
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    action: "place_bet",
                    marketNumber: 4,
                    side: "yes",
                    amount: 50,
                    question: null,
                    criteria: null,
                    revealAt: null,
                    closeAt: null,
                    resolveAt: null,
                    subjectName: null,
                    subjectPhone: null,
                    requestedGroupName: null,
                    replyMessages: [],
                    confidence: 0.98,
                    clarification: null,
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(requestBody.store, false);
  assert.equal(requestBody.input[0].role, "developer");
  assert.equal(requestBody.text.verbosity, "low");
  assert.deepEqual(requestBody.text.format.schema, INTENT_SCHEMA);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(result.action, "place_bet");
  assert.equal(result.source, "openai");
});

test("returns a short clarification when OpenAI is not configured", async () => {
  const result = await parseNaturalLanguageIntent({
    text: "@sidebar do the thing with market four",
    apiKey: "",
  });
  assert.equal(result.action, "unknown");
  assert.equal(result.clarification, "i didn't get that — try saying it another way");
});

test("keeps casual addressed text out of market parsing without an API key", async () => {
  const result = await parseNaturalLanguageIntent({
    text: "sidebar the public hates you can you lock in",
    apiKey: "",
  });
  assert.equal(result.action, "chat");
  assert.deepEqual(result.replyMessages, ["what's up?"]);
});

test("uses the LLM first for every invoked command when a key is configured", async () => {
  let called = false;
  const result = await parseNaturalLanguageIntent({
    text: "@sidebar show markets",
    apiKey: "test-key",
    fetchImpl: async () => {
      called = true;
      return modelResponse({ action: "list_markets", confidence: 0.99 });
    },
  });
  assert.equal(called, true);
  assert.equal(result.action, "list_markets");
  assert.equal(result.source, "openai");
});

test("falls back to a deterministic intent during an OpenAI outage", async () => {
  const result = await parseNaturalLanguageIntent({
    text: "@sidebar show markets",
    apiKey: "test-key",
    fetchImpl: async () => new Response("temporarily unavailable", { status: 503 }),
  });
  assert.equal(result.action, "list_markets");
  assert.equal(result.source, "deterministic");
});

test("gives the model safe pending-draft context for creation follow-ups", async () => {
  let requestBody;
  await parseNaturalLanguageIntent({
    text: "@sidebar midnight",
    apiKey: "test-key",
    pendingMarketDraft: {
      question: "Will Dan be late?",
      subjectName: "Dan",
      hasSubjectPhone: false,
    },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return modelResponse({
        action: "create_market",
        closeAt: "2026-08-19T04:00:00.000Z",
        confidence: 0.99,
      });
    },
  });
  assert.match(requestBody.input[0].content, /Pending market draft/);
  assert.match(requestBody.input[0].content, /Will Dan be late/);
  assert.equal(requestBody.input[0].content.includes("subjectPhoneHash"), false);
});

test("gives the planner recent context from only the current Sidebar group", async () => {
  let requestBody;
  await parseNaturalLanguageIntent({
    text: "sidebar put 20 on that one",
    apiKey: "test-key",
    conversationContext: [{
      speaker: "member-a",
      user: "sidebar show markets",
      assistant: ["#3 will dan be late?"],
    }],
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return modelResponse({
        action: "place_bet",
        marketNumber: 3,
        side: "yes",
        amount: 20,
        confidence: 0.99,
      });
    },
  });
  assert.match(requestBody.input[0].content, /Recent group-scoped Sidebar turns/);
  assert.match(requestBody.input[0].content, /will dan be late/i);
});

function modelResponse(overrides) {
  const value = {
    action: "unknown",
    marketNumber: null,
    side: null,
    amount: null,
    question: null,
    criteria: null,
    revealAt: null,
    closeAt: null,
    resolveAt: null,
    subjectName: null,
    subjectPhone: null,
    requestedGroupName: null,
    replyMessages: [],
    confidence: 0.9,
    clarification: null,
    ...overrides,
  };
  return new Response(
    JSON.stringify({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
