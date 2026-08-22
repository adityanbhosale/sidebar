import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredReplyDelay,
  replyMessages,
  sendReplySequence,
} from "../src/reply-sequence.mjs";

test("turns compact newline replies into separate iMessage bubbles", () => {
  assert.deepEqual(replyMessages("Got it\n40 on YES\nNew odds: 60/40"), [
    "got it",
    "40 on yes",
    "new odds: 60/40",
  ]);
});

test("normalizes array replies into lowercase chat bubbles", () => {
  assert.deepEqual(replyMessages(["Damn 😭", "I'm locked in"]), [
    "damn 😭",
    "i'm locked in",
  ]);
});

test("keeps case-sensitive URLs intact while lowercasing surrounding text", () => {
  assert.deepEqual(
    replyMessages("OPEN https://trysidebar.xyz/setup?token=AbC123XyZ NOW"),
    ["open https://trysidebar.xyz/setup?token=AbC123XyZ now"],
  );
});

test("sends reply bubbles in order with a small pause", async () => {
  const events = [];
  await sendReplySequence({
    reply: ["first", "second", "third"],
    delayMs: 350,
    send: async (text) => events.push(["send", text]),
    wait: async (milliseconds) => events.push(["wait", milliseconds]),
  });
  assert.deepEqual(events, [
    ["send", "first"],
    ["wait", 350],
    ["send", "second"],
    ["wait", 350],
    ["send", "third"],
  ]);
});

test("bounds configured reply pacing", () => {
  assert.equal(configuredReplyDelay("0"), 0);
  assert.equal(configuredReplyDelay("9000"), 2000);
  assert.equal(configuredReplyDelay("nope"), 350);
});
