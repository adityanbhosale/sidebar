import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationContextStore,
  redactSensitiveText,
} from "../src/conversation-context.mjs";

test("keeps recent turns isolated by Sidebar group", () => {
  const store = createConversationContextStore();
  store.append("group-a", {
    speaker: "member-a",
    user: "sidebar show markets",
    assistant: ["#1 dan is late"],
  });
  assert.equal(store.get("group-a").length, 1);
  assert.deepEqual(store.get("group-b"), []);
});

test("redacts phone-like values before keeping short-term context", () => {
  const store = createConversationContextStore();
  store.append("group-a", {
    speaker: "member-a",
    user: "sidebar subject dan +1 (212) 555-0199",
    assistant: "market #2 is live",
  });
  const [turn] = store.get("group-a");
  assert.equal(turn.user.includes("212"), false);
  assert.match(turn.user, /\[phone provided\]/);
  assert.equal(redactSensitiveText("call 484-252-8904"), "call [phone provided]");
});

test("bounds and expires conversation context", () => {
  let now = new Date("2026-08-22T12:00:00.000Z");
  const store = createConversationContextStore({
    now: () => now,
    ttlMs: 1_000,
    maxTurns: 2,
  });
  for (const value of ["one", "two", "three"]) {
    store.append("group-a", { speaker: "member", user: value, assistant: value });
  }
  assert.deepEqual(store.get("group-a").map((turn) => turn.user), ["two", "three"]);
  now = new Date(now.getTime() + 1_001);
  assert.deepEqual(store.get("group-a"), []);
});
