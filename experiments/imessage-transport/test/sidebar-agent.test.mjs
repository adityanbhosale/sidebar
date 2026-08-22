import assert from "node:assert/strict";
import test from "node:test";
import {
  createPendingMarketDraftStore,
  createSidebarAgent,
  executeIntent,
} from "../src/sidebar-agent.mjs";
import { SidebarDbError } from "../src/sidebar-client.mjs";

const NOW = new Date("2026-08-18T16:00:00.000Z");
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const market = {
  id: "market-id",
  group_id: GROUP_ID,
  display_num: 3,
  question: "Will Dan be late?",
  reveal_at: "2026-08-18T15:00:00.000Z",
  close_at: "2026-08-18T18:00:00.000Z",
  resolve_at: "2026-08-18T18:00:01.000Z",
  resolved_at: null,
  void_reason: null,
  adjudicator_id: USER_ID,
};

function marketResult() {
  return {
    market,
    sides: [
      { id: "yes-id", label: "Yes", ordinal: 0 },
      { id: "no-id", label: "No", ordinal: 1 },
    ],
    pools: [
      { side_id: "yes-id", pool: 75, revealed: true },
      { side_id: "no-id", pool: 25, revealed: true },
    ],
    totals: { total_pool: 100, participants: 2, revealed: true },
    myStakes: [{ amount: 40 }],
    payouts: [],
    adjudicatorName: "Yash",
  };
}

test("executes a parsed bet through the deterministic Sidebar client", async () => {
  const calls = [];
  const result = await executeIntent({
    client: {
      placeBet: async (input) => {
        calls.push(input);
        return marketResult();
      },
    },
    intent: {
      action: "place_bet",
      marketNumber: 3,
      amount: 40,
      side: "yes",
    },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    dryRun: false,
  });

  assert.deepEqual(calls, [
    { groupId: GROUP_ID, userId: USER_ID, marketNumber: 3, side: "yes", amount: 40 },
  ]);
  assert.match(result, /got it — 40 on yes for #3/);
  assert.match(result, /yes 75% \(75\).*pot 100/);
});

test("dry-run write requests never call a mutation", async () => {
  let called = false;
  const result = await executeIntent({
    client: { placeBet: async () => (called = true) },
    intent: { action: "place_bet", marketNumber: 3, amount: 10, side: "no" },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    dryRun: true,
  });
  assert.equal(called, false);
  assert.equal(result, "would put 10 on no for #3");
});

test("holds a likely person market and prompts for the subject phone", async () => {
  const calls = [];
  const result = await executeIntent({
    client: { stageMarketDraft: async (input) => calls.push(input) },
    intent: {
      action: "create_market",
      question: "Will Dan be late?",
      criteria: "Dan arrives after 9pm.",
      revealAt: "2026-08-18T16:00:01.000Z",
      closeAt: "2026-08-18T18:00:00.000Z",
      resolveAt: "2026-08-18T18:00:01.000Z",
      subjectName: "Dan",
      subjectPhone: null,
    },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    dryRun: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].subjectName, "Dan");
  assert.equal(calls[0].expiresAt, "2026-08-18T16:15:00.000Z");
  assert.match(result, /what's Dan's phone number/i);
  assert.match(result, /sidebar subject Dan/);
  assert.match(result, /sidebar no subject/);
});

test("finishes a pending person market with only a one-way phone hash", async () => {
  const calls = [];
  const result = await executeIntent({
    client: {
      completeMarketDraft: async (input) => {
        calls.push(input);
        return {
          display_num: 4,
          question: "Will Dan be late?",
          subject_name: "Dan",
          close_at: "2026-08-18T18:00:00.000Z",
        };
      },
    },
    intent: {
      action: "complete_person_market",
      subjectName: "Dan",
      subjectPhone: "+12125550199",
    },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    hashPhone: (value) => (value === "+12125550199" ? "h".repeat(64) : null),
    dryRun: false,
  });

  assert.deepEqual(calls, [{
    groupId: GROUP_ID,
    userId: USER_ID,
    subjectName: "Dan",
    subjectPhoneHash: "h".repeat(64),
  }]);
  assert.equal(JSON.stringify(calls).includes("+12125550199"), false);
  assert.match(result, /Dan can watch but can't bet/);
});

test("can finish the prompted draft as a non-person market", async () => {
  const calls = [];
  const result = await executeIntent({
    client: {
      completeMarketDraft: async (input) => {
        calls.push(input);
        return {
          display_num: 6,
          question: "Will Bitcoin rise?",
          subject_name: null,
          close_at: "2026-08-18T18:00:00.000Z",
        };
      },
    },
    intent: { action: "complete_market_without_subject" },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    dryRun: false,
  });
  assert.deepEqual(calls, [{ groupId: GROUP_ID, userId: USER_ID }]);
  assert.doesNotMatch(result, /cannot join or bet/);
});

test("creates an inline person market without storing the raw phone", async () => {
  const calls = [];
  await executeIntent({
    client: {
      openMarket: async (input) => {
        calls.push(input);
        return {
          display_num: 5,
          question: input.question,
          subject_name: input.subjectName,
          close_at: input.closeAt,
        };
      },
    },
    intent: {
      action: "create_market",
      question: "Will Dan be late?",
      criteria: "Dan arrives after 9pm.",
      revealAt: "2026-08-18T16:00:01.000Z",
      closeAt: "2026-08-18T18:00:00.000Z",
      resolveAt: "2026-08-18T18:00:01.000Z",
      subjectName: "Dan",
      subjectPhone: "+12125550199",
    },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    hashPhone: () => "h".repeat(64),
    dryRun: false,
  });
  assert.equal(calls[0].subjectPhoneHash, "h".repeat(64));
  assert.equal(Object.hasOwn(calls[0], "subjectPhone"), false);
});

test("agent binds the iMessage identities before parsing or executing", async () => {
  const calls = [];
  const client = {
    requireMembership: async (...args) => calls.push(["membership", ...args]),
    listMarkets: async (...args) => {
      calls.push(["list", ...args]);
      return [{ market, totals: marketResult().totals, adjudicatorName: "Yash", joined: true }];
    },
  };
  const agent = createSidebarAgent({
    client,
    resolveBinding: () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    parseIntent: async ({ markets }) => {
      assert.deepEqual(markets, [market]);
      return { action: "list_markets" };
    },
    now: () => NOW,
  });

  const result = await agent({
    conversationId: "chat-1",
    senderId: "+15550000001",
    text: "sidebar show markets",
  });

  assert.deepEqual(calls, [
    ["membership", GROUP_ID, USER_ID],
    ["list", GROUP_ID, USER_ID],
  ]);
  assert.match(result.join("\n"), /#3 will dan be late\?/);
});

test("unbound identities cannot reach the database", async () => {
  const agent = createSidebarAgent({
    client: {
      requireMembership: async () => assert.fail("database should not be called"),
      listMarkets: async () => assert.fail("database should not be called"),
    },
    resolveBinding: () => ({ status: "unbound_sender", groupId: GROUP_ID }),
  });
  const result = await agent({ conversationId: "chat", senderId: "sender", text: "sidebar help" });
  assert.match(result, /you aren't.*sidebar start/s);
});

test("Sidebar start issues a setup link before any market access", async () => {
  const setupCalls = [];
  const agent = createSidebarAgent({
    client: {
      requireMembership: async () => assert.fail("database should not be called"),
      listMarkets: async () => assert.fail("database should not be called"),
    },
    resolveBinding: async () => ({ status: "unbound_group" }),
    issueSetupLink: async (input) => {
      setupCalls.push(input);
    },
  });

  const result = await agent({
    conversationId: "chat-1",
    senderId: "+15550000001",
    text: "@sidebar, start",
  });

  assert.deepEqual(setupCalls, [
    { conversationId: "chat-1", senderId: "+15550000001", groupId: null },
  ]);
  assert.match(result, /sent you a setup link privately/);
  assert.match(result, /expires in 15 min/);
});

test("Sidebar start attaches an unbound sender to the conversation's group", async () => {
  const setupCalls = [];
  const agent = createSidebarAgent({
    client: {},
    resolveBinding: async () => ({ status: "unbound_sender", groupId: GROUP_ID }),
    issueSetupLink: async (input) => {
      setupCalls.push(input);
    },
  });
  await agent({ conversationId: "chat-1", senderId: "sender-2", text: "@Sidebar start" });
  assert.equal(setupCalls[0].groupId, GROUP_ID);
});

test("Sidebar start does not issue another link for an existing binding", async () => {
  let issued = false;
  const agent = createSidebarAgent({
    client: {},
    resolveBinding: async () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    issueSetupLink: async () => {
      issued = true;
    },
  });
  const result = await agent({ conversationId: "chat-1", senderId: "sender-1", text: "@sidebar start" });
  assert.equal(issued, false);
  assert.match(result, /already connected/);
});

test("dry-run Sidebar start does not persist a setup token", async () => {
  let issued = false;
  const agent = createSidebarAgent({
    client: {},
    resolveBinding: async () => ({ status: "unbound_group" }),
    issueSetupLink: async () => {
      issued = true;
    },
    dryRun: true,
  });
  const result = await agent({ conversationId: "chat-1", senderId: "sender-1", text: "@sidebar start" });
  assert.equal(issued, false);
  assert.match(result, /would send you a private setup link/);
});

test("unprefixed text is ignored before binding or database access", async () => {
  let called = false;
  const agent = createSidebarAgent({
    client: {},
    resolveBinding: async () => {
      called = true;
      return { status: "bound", groupId: GROUP_ID, userId: USER_ID };
    },
  });
  assert.equal(
    await agent({ conversationId: "chat", senderId: "sender", text: "hey sidebar, show markets" }),
    null,
  );
  assert.equal(called, false);
});

test("explains a group request without creating a market", async () => {
  let mutated = false;
  const agent = createSidebarAgent({
    client: {
      requireMembership: async () => undefined,
      listMarkets: async () => [],
      getGroup: async () => ({ id: GROUP_ID, name: "Monkey Business" }),
      openMarket: async () => {
        mutated = true;
      },
    },
    resolveBinding: async () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    now: () => NOW,
  });

  const result = await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "sidebar make a group titled monkey business",
  });

  assert.equal(mutated, false);
  assert.deepEqual(result, [
    "this chat is already the sidebar group “monkey business”",
    "were you trying to make a market?",
  ]);
});

test("returns social replies without attempting a market action", async () => {
  let mutated = false;
  const agent = createSidebarAgent({
    client: {
      requireMembership: async () => undefined,
      listMarkets: async () => [],
      openMarket: async () => {
        mutated = true;
      },
    },
    resolveBinding: async () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    parseIntent: async () => ({
      action: "chat",
      replyMessages: ["damn 😭", "i'm locked in"],
    }),
    now: () => NOW,
  });

  const result = await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "sidebar the public hates you can you lock in",
  });
  assert.equal(mutated, false);
  assert.deepEqual(result, ["damn 😭", "i'm locked in"]);
});

test("carries recent Sidebar turns into the next request in the same group", async () => {
  const seenContexts = [];
  let turn = 0;
  const agent = createSidebarAgent({
    client: {
      requireMembership: async () => undefined,
      listMarkets: async () => [],
    },
    resolveBinding: async () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    parseIntent: async ({ conversationContext }) => {
      seenContexts.push(conversationContext);
      turn += 1;
      return {
        action: "chat",
        replyMessages: [turn === 1 ? "first answer" : "second answer"],
      };
    },
    renderReply: async ({ canonicalReply }) => canonicalReply,
    now: () => NOW,
  });

  await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "sidebar remember this",
  });
  await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "sidebar what did i say?",
  });

  assert.deepEqual(seenContexts[0], []);
  assert.equal(seenContexts[1].length, 1);
  assert.equal(seenContexts[1][0].user, "sidebar remember this");
  assert.deepEqual(seenContexts[1][0].assistant, ["first answer"]);
});

test("answers a health check in short useful bubbles", async () => {
  const result = await executeIntent({
    client: {},
    intent: { action: "health_check" },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
  });
  assert.deepEqual(result, ["all good here", "what's up?"]);
});

test("formats final payouts after deterministic resolution", async () => {
  const result = await executeIntent({
    client: {
      resolveMarket: async () => ({
        result: "resolved",
        market: marketResult(),
        payouts: [{ name: "Adam", amount: 160 }, { name: "Brent", amount: 40 }],
      }),
    },
    intent: { action: "resolve_market", marketNumber: 3, side: "yes" },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    dryRun: false,
  });
  assert.equal(result, "#3 resolved yes\npayouts: Adam 160 · Brent 40");
});

test("joins a group-scoped market before betting", async () => {
  const calls = [];
  const result = await executeIntent({
    client: { joinMarket: async (input) => calls.push(input) },
    intent: { action: "join_market", marketNumber: 3 },
    binding: { groupId: GROUP_ID, userId: USER_ID },
    now: NOW,
    dryRun: false,
  });
  assert.deepEqual(calls, [{ groupId: GROUP_ID, userId: USER_ID, marketNumber: 3 }]);
  assert.equal(result, "joined #3\nyou can bet now");
});

test("turns an asynchronous database rejection into one user-facing reply", async () => {
  const agent = createSidebarAgent({
    client: {
      requireMembership: async () => undefined,
      listMarkets: async () => [{ market, totals: marketResult().totals }],
      resolveMarket: async () => {
        throw new SidebarDbError(
          "Sidebar database request failed (400)",
          400,
          JSON.stringify({ message: "market has not closed yet" }),
        );
      },
    },
    resolveBinding: async () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    parseIntent: async () => ({ action: "resolve_market", marketNumber: 3, side: "void" }),
    now: () => NOW,
  });

  const reply = await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "@sidebar, resolve Dan being late as void",
  });
  assert.deepEqual(reply, ["couldn't do that — market has not closed yet"]);
});

test("keeps an incomplete market draft and fills it over the next invoked message", async () => {
  const opened = [];
  const seenDrafts = [];
  let turn = 0;
  const client = {
    requireMembership: async () => undefined,
    listMarkets: async () => [],
    openMarket: async (input) => {
      opened.push(input);
      return {
        display_num: 7,
        question: input.question,
        subject_name: null,
        close_at: input.closeAt,
      };
    },
  };
  const agent = createSidebarAgent({
    client,
    resolveBinding: async () => ({ status: "bound", groupId: GROUP_ID, userId: USER_ID }),
    parseIntent: async ({ pendingMarketDraft }) => {
      seenDrafts.push(pendingMarketDraft);
      turn += 1;
      if (turn === 1) {
        return {
          action: "create_market",
          question: "Will Bitcoin be above 70k?",
          closeAt: null,
        };
      }
      return {
        action: "create_market",
        closeAt: "2026-08-18T18:00:00.000Z",
      };
    },
    now: () => NOW,
  });

  const first = await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "@sidebar make a bitcoin market",
  });
  assert.match(first.join("\n"), /when should betting close/);
  assert.equal(opened.length, 0);

  const second = await agent({
    conversationId: "chat-1",
    senderId: "sender-1",
    text: "@sidebar in 2 hours",
  });
  assert.equal(seenDrafts[0], null);
  assert.equal(seenDrafts[1].question, "Will Bitcoin be above 70k?");
  assert.equal(opened.length, 1);
  assert.match(second.join("\n"), /market #7 is live/);
});

test("pending market drafts expire and stay isolated by group and member", () => {
  let time = NOW.getTime();
  const store = createPendingMarketDraftStore({
    now: () => new Date(time),
    ttlMs: 1_000,
  });
  store.set(GROUP_ID, USER_ID, { question: "Will Dan be late?" });
  assert.equal(store.get(GROUP_ID, "another-user"), null);
  assert.equal(store.get("another-group", USER_ID), null);
  assert.equal(store.get(GROUP_ID, USER_ID).question, "Will Dan be late?");
  time += 1_001;
  assert.equal(store.get(GROUP_ID, USER_ID), null);
});
