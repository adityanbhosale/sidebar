// Plain `sidebar ...` is the product syntax. Keep `@sidebar ...` working so
// links and habits from the earlier beta do not fail abruptly.
const BOT_PREFIX = /^\s*@?sidebar\b\s*[:,\-]?\s*/i;

const ACTIONS = new Set([
  "help",
  "list_markets",
  "show_market",
  "create_market",
  "complete_person_market",
  "complete_market_without_subject",
  "join_market",
  "leave_market",
  "place_bet",
  "resolve_market",
  "health_check",
  "group_request",
  "chat",
  "unknown",
]);

export function isAgentInvocation(text) {
  return BOT_PREFIX.test(text);
}

export function isStartRequest(text) {
  return BOT_PREFIX.test(text) && /^start\s*[.!?]*$/i.test(stripBotPrefix(text).trim());
}

export function parseDeterministicIntent(text, { now = new Date(), markets = [] } = {}) {
  const request = stripBotPrefix(text).trim();
  if (!request) return unknown("What would you like Sidebar to do?");

  if (/^(?:start|help|commands|what can you do)\??$/i.test(request)) {
    return intent("help");
  }

  if (
    /^(?:test|ping|status|working|online|you there|are you (?:there|working|online)|(?:is )?(?:everything|all) (?:good|working))\s*[.!?]*$/i.test(
      request,
    )
  ) {
    return intent("health_check");
  }

  const groupRequest = parseGroupRequest(request);
  if (groupRequest) return groupRequest;

  const subjectCompletion = parseSubjectCompletion(request);
  if (subjectCompletion) return subjectCompletion;

  if (/\b(?:add|remove)\b.*\b(?:person|member|market)\b/i.test(request)) {
    return unknown(
      "Market-specific membership is not implemented in Sidebar yet; group membership is unchanged.",
    );
  }
  if (/\bdelete\b.*\bmarket\b/i.test(request)) {
    return unknown("Deleting a market is not implemented in Sidebar yet.");
  }
  const bet = parseBet(request, markets);
  if (bet) return bet;

  const participation = parseParticipation(request, markets);
  if (participation) return participation;

  const resolution = parseResolution(request, markets);
  if (resolution) return resolution;

  const create = parseCreateMarket(request, now);
  if (create) return create;

  const marketNumber = extractMarketNumber(request);
  if (/\b(?:odds?|pot|status|time|left|remaining|stakes?|payouts?)\b/i.test(request)) {
    if (marketNumber != null) return intent("show_market", { marketNumber });
    const matched = resolveMarketReference(request, markets);
    if (matched.intent) return intent("show_market", { marketNumber: matched.intent });
    return unknown(matched.clarification || "Which market should I show?");
  }

  if (/\b(?:show|list|current|open)\b.*\bmarkets?\b|^markets?\??$/i.test(request)) {
    return intent("list_markets");
  }

  if (/^\s*(?:show|describe)\b/i.test(request)) {
    const matched = resolveMarketReference(request, markets);
    if (matched.intent) return intent("show_market", { marketNumber: matched.intent });
    if (matched.clarification) return unknown(matched.clarification);
  }

  return null;
}

export async function parseNaturalLanguageIntent({
  text,
  now = new Date(),
  timezone = "America/New_York",
  markets = [],
  pendingMarketDraft = null,
  conversationContext = [],
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_INTENT_MODEL ?? "gpt-5.4-nano",
  intentMode = process.env.SIDEBAR_INTENT_MODE ?? "llm_first",
  fetchImpl = globalThis.fetch,
}) {
  if (!isAgentInvocation(text)) return null;

  const deterministic = parseDeterministicIntent(text, { now, markets });
  if (!apiKey) {
    if (deterministic) return deterministic;
    if (!pendingMarketDraft && !hasProductRequestSignal(stripBotPrefix(text))) {
      return fallbackChat();
    }
    return unknown(
      "i didn't get that — try saying it another way",
    );
  }
  if (intentMode === "deterministic_first" && deterministic) return deterministic;

  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        input: [
          {
            role: "developer",
            content: buildSystemPrompt({
              now,
              timezone,
              markets,
              pendingMarketDraft,
              conversationContext,
            }),
          },
          { role: "user", content: stripBotPrefix(text) },
        ],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "sidebar_market_intent",
            strict: true,
            schema: INTENT_SCHEMA,
          },
        },
        max_output_tokens: 350,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI intent parsing failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = await response.json();
    const outputText = extractOutputText(payload);
    if (!outputText) throw new Error("OpenAI returned no structured intent output.");

    const modeled = validateModelIntent(JSON.parse(outputText));
    // These two tiny, unambiguous checks prevent the model from turning a
    // transport check or product-level group request into a market mutation.
    // Their final wording still comes from the response renderer.
    if (new Set(["group_request", "health_check"]).has(deterministic?.action)) {
      return deterministic;
    }
    if (modeled.action === "unknown" && deterministic) return deterministic;
    return modeled;
  } catch {
    // An obvious command should still work during a transient model outage.
    if (deterministic) return deterministic;
    if (!pendingMarketDraft && !hasProductRequestSignal(stripBotPrefix(text))) {
      return fallbackChat();
    }
    return unknown("i'm having trouble reading that — try again in a sec");
  }
}

export const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
    },
    marketNumber: { type: ["integer", "null"] },
    side: { enum: ["yes", "no", "void", null] },
    amount: { type: ["integer", "null"] },
    question: { type: ["string", "null"] },
    criteria: { type: ["string", "null"] },
    revealAt: { type: ["string", "null"] },
    closeAt: { type: ["string", "null"] },
    resolveAt: { type: ["string", "null"] },
    subjectName: { type: ["string", "null"] },
    subjectPhone: { type: ["string", "null"] },
    requestedGroupName: { type: ["string", "null"] },
    replyMessages: {
      type: "array",
      items: { type: "string" },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    clarification: { type: ["string", "null"] },
  },
  required: [
    "action",
    "marketNumber",
    "side",
    "amount",
    "question",
    "criteria",
    "revealAt",
    "closeAt",
    "resolveAt",
    "subjectName",
    "subjectPhone",
    "requestedGroupName",
    "replyMessages",
    "confidence",
    "clarification",
  ],
};

function stripBotPrefix(text) {
  return String(text ?? "").replace(BOT_PREFIX, "");
}

function parseGroupRequest(request) {
  const directlyTargetsGroup =
    /\b(?:create|make|open|start)\s+(?:a\s+)?(?:new\s+)?(?:group|groupchat|group\s+chat)\b/i.test(
      request,
    ) ||
    /\b(?:name|rename|title|call)\s+(?:(?:this|the|our)\s+)?(?:group|groupchat|group\s+chat)\b/i.test(
      request,
    );
  if (!directlyTargetsGroup) {
    return null;
  }
  const name = request.match(
    /\b(?:called|named|titled)\s+["“]?(.+?)["”]?\s*[.!?]*$/i,
  )?.[1]?.trim();
  return intent("group_request", {
    requestedGroupName: name ? name.slice(0, 60) : null,
  });
}

function hasProductRequestSignal(request) {
  return /\b(?:markets?|odds?|pot|payouts?|points?|bet|stake|wager|resolve|adjudicate|settle|join|leave|show|list|create|open|close|closes|deadline|subject|group|help|commands?)\b/i.test(
    request,
  );
}

function fallbackChat() {
  return intent("chat", { replyMessages: ["what's up?"] });
}

function parseBet(request, markets) {
  const patterns = [
    /\b(?:bet|stake|put)\s+(\d+)(?:\s+points?)?\s+(?:on\s+)?(yes|no)\b.*?\b(?:market\s*)?#?(\d+)\b/i,
    /\b(?:market\s*)?#?(\d+)\b.*?\b(?:bet|stake|put)\s+(\d+)(?:\s+points?)?\s+(?:on\s+)?(yes|no)\b/i,
  ];
  const first = request.match(patterns[0]);
  if (first) {
    return intent("place_bet", {
      amount: Number(first[1]),
      side: first[2].toLowerCase(),
      marketNumber: Number(first[3]),
    });
  }
  const second = request.match(patterns[1]);
  if (second) {
    return intent("place_bet", {
      marketNumber: Number(second[1]),
      amount: Number(second[2]),
      side: second[3].toLowerCase(),
    });
  }

  const implicit = request.match(
    /\b(?:bet|stake|put)\s+(\d+)(?:\s+points?)?\s+(?:on\s+)?(?:(yes|no)\s+(?:on|for)\s+)?(.+)$/i,
  );
  if (implicit) {
    const matched = resolveMarketReference(implicit[3], markets);
    if (matched.intent) {
      return intent("place_bet", {
        amount: Number(implicit[1]),
        side: implicit[2]?.toLowerCase() ?? "yes",
        marketNumber: matched.intent,
      });
    }
    return unknown(matched.clarification || "Which market do you want to bet on?");
  }
  return null;
}

function parseResolution(request, markets) {
  if (!/\b(?:resolve|adjudicate|settle)\b/i.test(request)) return null;
  let marketNumber = extractMarketNumber(request);
  const side = request.match(/\b(yes|no|void|ambiguous)\b/i)?.[1]?.toLowerCase();
  if (!side) return unknown("Should I resolve that market as Yes, No, or Void?");
  if (marketNumber == null) {
    const matched = resolveMarketReference(request, markets);
    if (!matched.intent) {
      return unknown(matched.clarification || "Which market do you want to resolve?");
    }
    marketNumber = matched.intent;
  }
  return intent("resolve_market", {
    marketNumber,
    side: side === "ambiguous" ? "void" : side,
  });
}

function parseParticipation(request, markets) {
  const action = /^\s*(join|enter|leave|exit)\b/i.exec(request)?.[1]?.toLowerCase();
  if (!action) return null;
  const marketNumber = extractMarketNumber(request);
  if (marketNumber != null) {
    return intent(new Set(["join", "enter"]).has(action) ? "join_market" : "leave_market", {
      marketNumber,
    });
  }
  const matched = resolveMarketReference(request, markets);
  if (!matched.intent) {
    return unknown(matched.clarification || "Which market do you mean?");
  }
  return intent(new Set(["join", "enter"]).has(action) ? "join_market" : "leave_market", {
    marketNumber: matched.intent,
  });
}

function resolveMarketReference(reference, markets) {
  if (!Array.isArray(markets) || markets.length === 0) return {};
  const referenceTokens = meaningfulTokens(reference);
  if (referenceTokens.size === 0) return {};

  const ranked = markets
    .map((market) => {
      const questionTokens = meaningfulTokens(market.question);
      const overlap = [...questionTokens].filter((token) => referenceTokens.has(token)).length;
      const coverage = questionTokens.size ? overlap / questionTokens.size : 0;
      const precision = referenceTokens.size ? overlap / referenceTokens.size : 0;
      return {
        market,
        overlap,
        score: coverage * 0.75 + precision * 0.25,
      };
    })
    .filter(({ overlap, score }) => overlap >= 2 && score >= 0.5)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap);

  if (ranked.length === 0) return {};
  const [best, second] = ranked;
  if (second && best.score - second.score < 0.15) {
    return {
      clarification: `I found more than one possible market: ${ranked
        .slice(0, 3)
        .map(({ market }) => `#${market.display_num} “${market.question}”`)
        .join("; ")}. Which one?`,
    };
  }
  return { intent: Number(best.market.display_num) };
}

const MATCH_STOPWORDS = new Set([
  "a",
  "an",
  "as",
  "at",
  "bet",
  "for",
  "is",
  "join",
  "enter",
  "leave",
  "exit",
  "market",
  "on",
  "points",
  "put",
  "resolve",
  "settle",
  "show",
  "stake",
  "that",
  "the",
  "to",
  "will",
  "yes",
  "no",
  "void",
]);

function meaningfulTokens(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map(stemToken)
      .filter((token) => token.length >= 2 && !MATCH_STOPWORDS.has(token)),
  );
}

function stemToken(token) {
  if (token.length > 5 && token.endsWith("ing")) {
    const stem = token.slice(0, -3);
    return /(.)\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function parseCreateMarket(request, now) {
  const match = request.match(
    /^(?:create|open)(?:\s+a)?\s+market(?:\s*[:\-])?\s+(.+?)\s+(?:betting\s+)?closes?\s+(.+)$/i,
  );
  if (!match) return null;

  const closeAt = parseRelativeInstant(match[2], now);
  if (!closeAt) return null;

  let questionText = match[1].trim();
  let subjectName = null;
  let subjectPhone = null;
  const explicitWithPhone = questionText.match(
    /\s+(?:subject|about)\s*:?\s*([A-Za-z][A-Za-z .'’-]{0,39}?)\s+(?:phone\s*:?\s*|at\s+)?(\+?\d[\d().\s-]{6,}\d)\s*$/i,
  );
  if (explicitWithPhone) {
    subjectName = cleanSubjectName(explicitWithPhone[1]);
    subjectPhone = explicitWithPhone[2].trim();
    questionText = questionText.slice(0, explicitWithPhone.index).trim();
  } else {
    const explicitName = questionText.match(
      /\s+(?:subject|about)\s*:?\s*([A-Za-z][A-Za-z .'’-]{0,39})\s*$/i,
    );
    if (explicitName) {
      subjectName = cleanSubjectName(explicitName[1]);
      questionText = questionText.slice(0, explicitName.index).trim();
    }
  }

  const question = questionText.replace(/^["“]|["”]$/g, "");
  subjectName ??= inferPersonName(question);
  const revealAt = new Date(now.getTime() + 1_000);
  const resolveAt = new Date(closeAt.getTime() + 1_000);
  return intent("create_market", {
    question,
    criteria: `Resolves Yes if “${question}” is true when betting closes.`,
    revealAt: revealAt.toISOString(),
    closeAt: closeAt.toISOString(),
    resolveAt: resolveAt.toISOString(),
    subjectName,
    subjectPhone,
  });
}

function parseSubjectCompletion(request) {
  if (/^(?:no\s+subject|not\s+about\s+(?:a\s+)?person)\s*[.!?]*$/i.test(request)) {
    return intent("complete_market_without_subject");
  }
  const match = request.match(
    /^(?:subject|person)(?:\s+is)?\s*:?\s*([A-Za-z][A-Za-z .'’-]{0,39}?)\s+(?:phone\s*:?\s*|at\s+)?(\+?\d[\d().\s-]{6,}\d)\s*$/i,
  );
  if (!match) return null;
  return intent("complete_person_market", {
    subjectName: cleanSubjectName(match[1]),
    subjectPhone: match[2].trim(),
  });
}

function cleanSubjectName(value) {
  return value.trim().replace(/\s+/g, " ");
}

function inferPersonName(question) {
  const match = question.match(/^Will\s+([A-Z][a-z'’-]{1,30}(?:\s+[A-Z][a-z'’-]{1,30})?)\s+\b/);
  if (!match) return null;
  if (new Set(["The", "This", "That", "There", "Everyone", "Anyone"]).has(match[1])) {
    return null;
  }
  return match[1];
}

function parseRelativeInstant(value, now) {
  const relative = value.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i);
  if (!relative) return null;
  const amount = Number(relative[1]);
  const unit = relative[2].toLowerCase();
  const multiplier = unit.startsWith("d")
    ? 86_400_000
    : unit.startsWith("h")
      ? 3_600_000
      : 60_000;
  return new Date(now.getTime() + amount * multiplier);
}

function extractMarketNumber(request) {
  const explicit = request.match(/\bmarket\s*#?(\d+)\b/i);
  if (explicit) return Number(explicit[1]);
  const hash = request.match(/#(\d+)\b/);
  return hash ? Number(hash[1]) : null;
}

function intent(action, fields = {}) {
  return {
    action,
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
    confidence: 1,
    clarification: null,
    source: "deterministic",
    ...fields,
  };
}

function unknown(clarification) {
  return intent("unknown", { clarification });
}

function buildSystemPrompt({
  now,
  timezone,
  markets,
  pendingMarketDraft,
  conversationContext,
}) {
  const marketContext = markets
    .slice(0, 20)
    .map((market) => `#${market.display_num}: ${market.question}`)
    .join("\n");
  return [
    "Classify one message addressed to Sidebar, and extract an app action only when the user actually requests one.",
    "Do not execute anything and do not invent IDs, amounts, outcomes, or times.",
    "Use chat for jokes, insults, encouragement, banter, reactions, or anything that does not ask to read or change Sidebar state. Idioms such as lock in, bet, odds, or stake are not app commands without actual market context.",
    "Respond to the meaning of casual text. A system check needs a direct status answer; criticism or banter needs a relevant human reaction, never a random generic phrase.",
    "Use health_check for test, ping, status, are you working, are you there, or similar checks that Sidebar is responding.",
    "Use group_request when the user asks to create, make, name, rename, title, or open a group or group chat. A native iMessage chat maps to one Sidebar group, so never reinterpret a group request as create_market. Copy an explicitly requested name into requestedGroupName.",
    "For clear market creation intent, always return create_market even when fields are missing. Leave missing fields null so the app can ask one follow-up at a time.",
    "If a pending market draft is shown, treat the user's message as a possible answer to its missing field and merge only information the user actually supplied.",
    "For other ambiguous app requests, use unknown with one short clarification question. Do not ask for market fields unless the user clearly asked to create, change, inspect, join, bet on, or resolve a market.",
    "create_market preserves the user's question and close time. criteria may summarize a stated resolution condition. If it is about a named person, put their name in subjectName and copy a supplied phone number into subjectPhone; never invent one.",
    "complete_person_market supplies the name and phone requested for the caller's pending market. complete_market_without_subject confirms that a pending market is not about a person.",
    "place_bet needs marketNumber, side yes/no, and a positive whole-number amount.",
    "join_market and leave_market need marketNumber.",
    "resolve_market needs marketNumber and side yes/no/void.",
    "For chat, write 1 to 3 short natural replies in replyMessages. For every other action replyMessages must be empty.",
    "Reply style: lowercase, casual group-chat voice, usually under 60 characters per message, no greeting, formal explanation, filler, or sign-off.",
    "Clarification style: one short lowercase question under 80 characters.",
    `Current time: ${now.toISOString()}`,
    `Group timezone: ${timezone}`,
    marketContext ? `Known markets:\n${marketContext}` : "Known markets: none",
    pendingMarketDraft
      ? `Pending market draft:\n${JSON.stringify(pendingMarketDraft)}`
      : "Pending market draft: none",
    Array.isArray(conversationContext) && conversationContext.length
      ? `Recent group-scoped Sidebar turns:\n${JSON.stringify(conversationContext.slice(-6))}`
      : "Recent group-scoped Sidebar turns: none",
  ].join("\n");
}

function extractOutputText(payload) {
  for (const item of payload?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

function validateModelIntent(value) {
  if (!value || typeof value !== "object" || !ACTIONS.has(value.action)) {
    throw new Error("OpenAI returned an unsupported Sidebar action.");
  }
  if (typeof value.confidence !== "number" || value.confidence < 0.8) {
    return unknown(value.clarification || "can you say that another way?");
  }
  const clarification = value.clarification
    ? String(value.clarification).trim().toLowerCase().slice(0, 100)
    : null;
  const replyMessages = Array.isArray(value.replyMessages)
    ? value.replyMessages
        .map((message) => String(message ?? "").trim().toLowerCase().slice(0, 160))
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (value.action === "chat" && replyMessages.length === 0) {
    return unknown("what's up?");
  }
  return { ...value, clarification, replyMessages, source: "openai" };
}
