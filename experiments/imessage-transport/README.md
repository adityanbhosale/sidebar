# Sidebar local iMessage transport proof

This isolated experiment tests the native iMessage group behavior that the
Blooio free trial could not validate. It uses Photon's open-source
`@photon-ai/imessage-kit` against the Messages database on this Mac.

The transport probe remains isolated, but this directory now also contains a
local Sidebar agent. The agent reads and writes through the same Supabase views
and atomic RPCs as the web app. The Mac only needs to remain online while this
proof is running; this is not the intended production architecture.

## What it proves

- A manually created native iMessage group produces a stable conversation ID.
- Each inbound group message identifies its individual sender.
- A process can reply into the exact group that produced the message.
- Overlapping groups remain isolated.
- Ordinary chatter does not trigger bot replies.
- Rename, membership, and process-restart behavior can be observed.

## Permissions

No Photon account or credential is used.

The process running the probe needs access to the local Messages database:

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Enable Codex or the terminal application that will run this probe.
3. Restart that application.
4. Keep Messages open and signed into iMessage.
5. Approve the macOS Automation prompt for controlling Messages when the first
   reply is sent.

Basic receipt and text replies do not require Photon's hosted service or its
private API.

## Install and verify

From this directory:

```zsh
npm ci
npm test
npm run smoke
```

`smoke` performs a read-only query and prints only hashed conversation IDs. A
successful response has `"status":"ready"` and at least one group.

## Watch safely

Start in dry-run mode so nothing is sent:

```zsh
npm run watch:dry
```

Send these messages from the test group:

```text
ordinary chatter G1-N-01
sidebar G1-A-01 ping
G1-B-01 odds
```

Only the last two should be classified as commands. The watcher discards all
untagged traffic before processing, so unrelated conversations are not recorded.
Evidence is appended to `.local/evidence.jsonl`; identifiers are SHA-256
fingerprints and message bodies are not persisted. Dry-run commands are recorded
as `would_reply`; no message is sent.

After confirming the correct group and sender hashes, start reply mode:

```zsh
npm run watch
```

The expected replies are `ACK G1-A-01` and `ACK G1-B-01`. Stop with Control-C.

### Test with one iMessage account

Messages sent from an iPhone using the same iMessage account as this Mac arrive
as `isFromMe` and are ignored by default. A deliberately narrow self-test mode
can exercise one known group without changing that production behavior.

Put only the redacted hash printed by `npm run smoke` in the root `.env.local`:

```dotenv
SIDEBAR_IMESSAGE_CONVERSATION_HASH=12-character-hash-for-the-test-group
```

Then start with no writes:

```zsh
npm run watch:self:dry
```

Send `sidebar G1-SELF-01 ping` from the same iMessage account. Once it is
recorded as `would_reply`, run `npm run watch:self` and send
`sidebar G1-SELF-02 ping`; the exact group should receive `ACK G1-SELF-02`.
Only messages beginning with `sidebar` in that exact conversation are adapted;
all other from-me traffic remains ignored. Replies do not begin with `sidebar`,
and generated `ACK` messages are rejected explicitly, so they cannot recursively
invoke the watcher. A separate circuit breaker also blocks identical replies
within ten seconds and caps total replies per minute. Never enable this mode on
a hosted or multi-user transport.

## Test sequence

1. Send one tagged message from two different participants in G1.
2. Create G2 with an overlapping participant and send ten interleaved tags.
3. Confirm G1 and G2 have different `conversationHash` values and no reply
   crosses groups.
4. Rename G1 and send another tag.
5. Add and remove a participant and send after each change.
6. Restart the watcher and confirm the same group hash returns.
7. Send ten ordinary messages and confirm every one is recorded as
   `ordinary_chatter` with no reply.
8. Run 50 tagged inbound messages and 25 replies over several hours.

The proof passes only with complete sender attribution, stable group hashes,
zero cross-group replies, zero chatter replies, and reliable exact-group ACKs.

## Transport boundary

The probe normalizes local Photon messages into a provider-neutral envelope:

```text
provider, eventId, messageId, conversationId, isGroup,
senderId, text, receivedAt, kind, service, isFromMe
```

Only `receiveMessage` and `sendReply(conversationId, text)` behavior should move
into the eventual Sidebar integration. Market state remains deterministic and
provider-independent.

## Run the Sidebar agent

The local agent currently supports the functionality already present in the
Sidebar backend:

- create and list markets;
- join and leave markets;
- show status, odds, stakes, total pot, and time remaining;
- place a Yes or No bet;
- resolve a market as Yes, No, or Void; and
- show the resulting payouts.

Market deletion is not in the current database model. Native iMessage group
membership is never changed. Market participation is explicit and separate
from the native chat: everyone can view, but only joined members can bet. Each new market gets
a randomly selected current group member as adjudicator, preferring someone
other than the proposer when possible.

### 1. Create or connect with `sidebar start`

After migration `010_optional_imessage_links.sql` is applied, configure these
values only in the root `.env.local`:

```zsh
openssl rand -base64 32
```

```dotenv
SIDEBAR_IMESSAGE_ID_SECRET=the-generated-value
SIDEBAR_APP_URL=https://your-sidebar-deployment.example
SIDEBAR_GROUP_TIMEZONE=America/New_York
```

Keep the secret stable: it creates non-reversible, keyed hashes for native
conversation and sender identifiers. Raw phone numbers and chat IDs are never
stored in Supabase.

An unconnected participant sends `sidebar start`. The bot acknowledges in the
group and sends that participant a direct iMessage containing a single-use
browser link that expires after 15 minutes. The link is never posted to the
shared group. The page then:

- connects the conversation to the Sidebar group in the current web session;
- lets a new user create a Sidebar group if the conversation has none; or
- accepts an existing group ID and password when the browser is not signed in;
- lets another participant privately enter the existing group password and
create their own phone-derived member identity.

The setup token is stored only as a SHA-256 hash and is consumed atomically with
the group membership and iMessage binding. A Sidebar group needs no iMessage
row at all, so web-only groups continue to work unchanged. Adding or removing a
native iMessage participant still does not alter Sidebar membership.

The older `SIDEBAR_IMESSAGE_CONVERSATION_HASH`, `SIDEBAR_GROUP_ID`, and
`SIDEBAR_IMESSAGE_USER_MAP` values remain available only as a temporary local
fallback for an already configured test chat.

For a database-backed test using the same iMessage account as the Mac, add the
existing Sidebar member to impersonate only in the scoped local test:

```dotenv
SIDEBAR_ALLOW_SELF_TEST=1
SIDEBAR_SELF_TEST_USER_ID=the-existing-sidebar-user-uuid
```

Verify Messages access, exact-group selection, Supabase credentials, and group
membership without writing anything:

```zsh
npm run preflight:self
```

Use `npm run agent:self:dry` first and `npm run agent:self` only after its
responses identify the intended group and user.

### 2. Natural-language interpretation

Common phrasing is parsed locally and costs nothing:

```text
sidebar show markets
sidebar what are the odds on market 3?
sidebar join Dan being late
sidebar put 40 points on Dan being late
sidebar create a market: Will Dan be late? closes in 2 hours
sidebar resolve Dan being late as yes
```

For person markets, Sidebar asks for the subject's name and phone number when
either is missing. The agent hashes the phone immediately; the database stores
only that keyed hash and prevents the matching subject from joining or betting
while leaving the market visible to them.

Every request must begin with `sidebar`. The older `@sidebar` form still works
for compatibility. Even an
otherwise clear market instruction is ignored without that prefix, so ordinary
group conversation cannot accidentally invoke parsing, an API call, or a
database action.

When `OPENAI_API_KEY` is configured, every explicit `sidebar` request goes to
the OpenAI turn planner first. Ordinary group chatter is still discarded
before any API call. The planner returns a strict structured intent;
application validation and Supabase RPCs remain the authority for every
mutation. Once deterministic execution finishes, a separate structured reply
renderer turns the canonical result into one to three concise iMessage bubbles.
It cannot execute actions, and its output is discarded if it adds or drops any
numeric fact, market number, percentage, time, or URL. If either model call is
unavailable, obvious commands and known-good result messages fall back locally.

Set the key in the root `.env.local` or export it in the launching shell. Do
not put a key in this repository or a chat message. `OPENAI_INTENT_MODEL`
defaults to `gpt-5.4-nano`. `OPENAI_REPLY_MODEL` can select a separate rendering
model and otherwise inherits `OPENAI_INTENT_MODEL`. Set
`SIDEBAR_INTENT_MODE=deterministic_first` only if reducing API calls matters
more than natural-language coverage.

Sidebar keeps at most eight invoked turns in memory for one hour, keyed by the
bound Sidebar group. This lets follow-ups like `sidebar put 20 on that one`
refer to the previous Sidebar exchange without mixing overlapping native
groups. Ordinary chatter is never added, and phone-like values are redacted
before a turn enters this short-lived context.

Incomplete market creation is conversational. Sidebar keeps a group-and-member
scoped draft for 15 minutes and asks one short question at a time for the
market question, betting close time, or subject identity. The raw subject phone
number is never kept in the draft. Replies are split into short iMessage
bubbles and sent in order; `SIDEBAR_REPLY_DELAY_MS` controls the pause between
bubbles and defaults to 350 milliseconds.

### 3. Verify without writes, then run

Keep Messages open and run this from the experiment directory in a Terminal
with Full Disk Access:

```zsh
npm test
npm run agent:dry
```

In dry-run mode, reads are real but create/bet/resolve operations only reply
with what they would do. After checking the correct group and sender mapping:

```zsh
npm run agent
```

Stop with Control-C. The process logs only redacted event, conversation, and
sender hashes—not message bodies or credentials.

This database-backed linking flow is suitable for validating onboarding, but
the local Photon transport still depends on this Mac. A hosted iMessage
transport remains required before a public beta can remove that dependency.
