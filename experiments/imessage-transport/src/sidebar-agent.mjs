import {
  isAgentInvocation,
  isStartRequest,
  parseNaturalLanguageIntent,
} from "./intent-parser.mjs";
import { SidebarDbError } from "./sidebar-client.mjs";
import { fingerprint } from "./transport-core.mjs";
import { deriveRegisteredPhoneHash } from "./web-onboarding.mjs";
import { createConversationContextStore } from "./conversation-context.mjs";
import { createNaturalReplyRenderer } from "./response-renderer.mjs";

export function createSidebarAgent({
  client,
  resolveBinding,
  parseIntent = parseNaturalLanguageIntent,
  now = () => new Date(),
  timezone = process.env.SIDEBAR_GROUP_TIMEZONE ?? "America/New_York",
  issueSetupLink,
  hashPhone = (value) => deriveRegisteredPhoneHash(value, process.env.SESSION_SECRET),
  pendingMarketDrafts = createPendingMarketDraftStore({ now }),
  conversationContexts = createConversationContextStore({ now }),
  renderReply = createNaturalReplyRenderer(),
  dryRun = false,
} = {}) {
  if (!client || !resolveBinding) throw new Error("Sidebar agent needs a client and binding resolver.");
  assertTimeZone(timezone);

  return async function handleMessage(envelope) {
    if (!isAgentInvocation(envelope.text)) return null;
    const conversationHash = fingerprint(envelope.conversationId);
    const senderHash = fingerprint(envelope.senderId);
    const binding = await resolveBinding(conversationHash, senderHash, {
      conversationId: envelope.conversationId,
      senderId: envelope.senderId,
    });

    if (isStartRequest(envelope.text)) {
      if (binding.status === "bound") {
        return "you're already connected\nsend sidebar help if you need me";
      }
      if (!issueSetupLink) {
        return "setup isn't configured on this agent yet";
      }
      if (dryRun) {
        return "would send you a private setup link";
      }
      try {
        await issueSetupLink({
          conversationId: envelope.conversationId,
          senderId: envelope.senderId,
          groupId: binding.status === "unbound_sender" ? binding.groupId : null,
        });
        return "sent you a setup link privately\nit expires in 15 min";
      } catch (error) {
        return `couldn't start setup — ${safeErrorMessage(error)}`;
      }
    }

    if (binding.status === "unbound_group") {
      return "this chat isn't connected yet\nsend sidebar start";
    }
    if (binding.status === "unbound_sender") {
      return "this chat is connected, but you aren't\nsend sidebar start";
    }

    const recentContext = conversationContexts.get(binding.groupId);
    let intent = null;
    try {
      await client.requireMembership(binding.groupId, binding.userId);
      const marketRows = await client.listMarkets(binding.groupId, binding.userId);
      const pendingMarketDraft = pendingMarketDrafts.get(binding.groupId, binding.userId);
      const requestTime = now();
      intent = await parseIntent({
        text: envelope.text,
        now: requestTime,
        timezone,
        markets: marketRows.map(({ market }) => market),
        pendingMarketDraft: publicDraftContext(pendingMarketDraft),
        conversationContext: recentContext,
      });
      if (!intent) return null;
      const canonicalReply = await executeIntent({
        client,
        intent,
        binding,
        marketRows,
        pendingMarketDraft,
        savePendingMarketDraft: (draft) =>
          pendingMarketDrafts.set(binding.groupId, binding.userId, draft),
        clearPendingMarketDraft: () =>
          pendingMarketDrafts.delete(binding.groupId, binding.userId),
        now: requestTime,
        timezone,
        hashPhone,
        dryRun,
      });
      const reply = await renderReply({
        request: envelope.text,
        intent,
        canonicalReply,
        conversationContext: recentContext,
      });
      rememberTurn(conversationContexts, binding, envelope.text, reply);
      return reply;
    } catch (error) {
      const message = safeErrorMessage(error);
      const canonicalReply = `couldn't do that — ${message}`;
      const reply = await renderReply({
        request: envelope.text,
        intent: intent ?? { action: "error" },
        canonicalReply,
        conversationContext: recentContext,
      });
      rememberTurn(conversationContexts, binding, envelope.text, reply);
      return reply;
    }
  };
}

function rememberTurn(store, binding, userMessage, assistantReply) {
  store.append(binding.groupId, {
    speaker: fingerprint(binding.userId),
    user: userMessage,
    assistant: assistantReply,
  });
}

export async function executeIntent({
  client,
  intent,
  binding,
  marketRows = [],
  pendingMarketDraft = null,
  savePendingMarketDraft = () => undefined,
  clearPendingMarketDraft = () => undefined,
  now,
  timezone = "America/New_York",
  hashPhone,
  dryRun,
}) {
  switch (intent.action) {
    case "help":
      return [
        "i can make markets, show odds, take bets, and resolve outcomes",
        "try: sidebar make a market on whether dan is late tonight",
        "i'll ask for anything missing",
      ].join("\n");
    case "health_check":
      return ["all good here", "what's up?"];
    case "group_request": {
      const group = typeof client.getGroup === "function"
        ? await client.getGroup(binding.groupId)
        : null;
      return [
        group?.name
          ? `this chat is already the sidebar group “${group.name}”`
          : "this chat is already linked to a sidebar group",
        "were you trying to make a market?",
      ];
    }
    case "chat":
      return Array.isArray(intent.replyMessages) && intent.replyMessages.length
        ? intent.replyMessages.slice(0, 3)
        : ["what's up?"];
    case "list_markets":
      return formatMarketList(marketRows, now);
    case "show_market": {
      requirePositiveInteger(intent.marketNumber, "market number");
      const result = await client.getMarketByNumber(
        binding.groupId,
        intent.marketNumber,
        binding.userId,
      );
      if (!result) return `can't find market #${intent.marketNumber} in this group`;
      return formatMarket(result, now, timezone);
    }
    case "create_market": {
      const draft = mergeCreateDraft({
        pending: pendingMarketDraft,
        intent,
        now,
        hashPhone,
      });
      const missingReply = missingCreateReply(draft, now);
      if (missingReply) {
        savePendingMarketDraft(draft);
        return missingReply;
      }
      const input = validateCreateIntent(draft, now);
      const marketInput = {
        question: input.question,
        criteria: input.criteria,
        revealAt: input.revealAt,
        closeAt: input.closeAt,
        resolveAt: input.resolveAt,
        subjectName: input.subjectName,
      };
      if (input.subjectName && !draft.subjectPhoneHash) {
        if (!dryRun) {
          await client.stageMarketDraft({
            groupId: binding.groupId,
            userId: binding.userId,
            ...marketInput,
            expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
          });
        }
        clearPendingMarketDraft();
        return [
          `what's ${input.subjectName}'s phone number?`,
          `reply: sidebar subject ${input.subjectName} +12125550199`,
          "not about a person? say sidebar no subject",
        ].join("\n");
      }
      if (dryRun) return `would make this market\n${input.question}`;
      const market = await client.openMarket({
        groupId: binding.groupId,
        userId: binding.userId,
        ...marketInput,
        subjectPhoneHash: draft.subjectPhoneHash,
      });
      clearPendingMarketDraft();
      return formatCreatedMarket(market, timezone);
    }
    case "complete_person_market": {
      const subjectName = String(intent.subjectName ?? "").trim();
      if (!subjectName || subjectName.length > 40) {
        throw new Error("send the person's name and phone number");
      }
      const subjectPhoneHash = requirePhoneHash(hashPhone, intent.subjectPhone);
      if (dryRun) return `would finish the market about ${subjectName}`;
      const market = await client.completeMarketDraft({
        groupId: binding.groupId,
        userId: binding.userId,
        subjectName,
        subjectPhoneHash,
      });
      return formatCreatedMarket(market, timezone);
    }
    case "complete_market_without_subject": {
      if (dryRun) return "would finish the market without a blocked subject";
      const market = await client.completeMarketDraft({
        groupId: binding.groupId,
        userId: binding.userId,
      });
      return formatCreatedMarket(market, timezone);
    }
    case "join_market": {
      requirePositiveInteger(intent.marketNumber, "market number");
      if (dryRun) return `would join #${intent.marketNumber}`;
      await client.joinMarket({
        groupId: binding.groupId,
        userId: binding.userId,
        marketNumber: intent.marketNumber,
      });
      return `joined #${intent.marketNumber}\nyou can bet now`;
    }
    case "leave_market": {
      requirePositiveInteger(intent.marketNumber, "market number");
      if (dryRun) return `would leave #${intent.marketNumber}`;
      await client.leaveMarket({
        groupId: binding.groupId,
        userId: binding.userId,
        marketNumber: intent.marketNumber,
      });
      return `left #${intent.marketNumber}`;
    }
    case "place_bet": {
      requirePositiveInteger(intent.marketNumber, "market number");
      requirePositiveInteger(intent.amount, "bet amount");
      if (!new Set(["yes", "no"]).has(intent.side)) {
        throw new Error("pick yes or no");
      }
      if (dryRun) {
        return `would put ${intent.amount} on ${intent.side} for #${intent.marketNumber}`;
      }
      const result = await client.placeBet({
        groupId: binding.groupId,
        userId: binding.userId,
        marketNumber: intent.marketNumber,
        side: intent.side,
        amount: intent.amount,
      });
      return `got it — ${intent.amount} on ${intent.side} for #${intent.marketNumber}\n${formatOdds(result)}`;
    }
    case "resolve_market": {
      requirePositiveInteger(intent.marketNumber, "market number");
      if (!new Set(["yes", "no", "void"]).has(intent.side)) {
        throw new Error("pick yes, no, or void");
      }
      if (dryRun) return `would resolve #${intent.marketNumber} as ${intent.side}`;
      const resolved = await client.resolveMarket({
        groupId: binding.groupId,
        userId: binding.userId,
        marketNumber: intent.marketNumber,
        side: intent.side,
      });
      return formatResolution(intent.marketNumber, intent.side, resolved);
    }
    case "unknown":
      return intent.clarification || "what do you want me to do?";
    default:
      throw new Error("that sidebar action isn't supported");
  }
}

function validateCreateIntent(intent, now) {
  const question = String(intent.question ?? "").trim();
  if (!question) throw new Error("a market needs a question");
  if (question.length > 200) throw new Error("the market question has to stay under 200 characters");

  const closeAt = validDate(intent.closeAt, "betting close time");
  const revealAt = intent.revealAt ? validDate(intent.revealAt, "reveal time") : new Date(now.getTime() + 1_000);
  const resolveAt = intent.resolveAt ? validDate(intent.resolveAt, "resolve time") : new Date(closeAt.getTime() + 1_000);
  if (closeAt <= now) throw new Error("betting has to close in the future");
  if (!(revealAt < closeAt && closeAt < resolveAt)) {
    throw new Error("the times have to go reveal, close, then resolve");
  }

  const criteria = String(
    intent.criteria || `Resolves Yes if “${question}” is true when betting closes.`,
  ).trim();
  if (criteria.length > 500) throw new Error("keep the resolution criteria under 500 characters");
  const subjectName = intent.subjectName ? String(intent.subjectName).trim() : null;
  if (subjectName && subjectName.length > 40) {
    throw new Error("keep the subject's name under 40 characters");
  }
  return {
    question,
    criteria,
    revealAt: revealAt.toISOString(),
    closeAt: closeAt.toISOString(),
    resolveAt: resolveAt.toISOString(),
    subjectName,
  };
}

function mergeCreateDraft({ pending, intent, now, hashPhone }) {
  const next = { ...(pending ?? {}) };
  for (const field of [
    "question",
    "criteria",
    "revealAt",
    "closeAt",
    "resolveAt",
    "subjectName",
  ]) {
    if (intent[field] != null && String(intent[field]).trim()) {
      next[field] = String(intent[field]).trim();
    }
  }
  if (intent.subjectPhone) {
    next.subjectPhoneHash = requirePhoneHash(hashPhone, intent.subjectPhone);
  }
  next.updatedAt = now.toISOString();
  return next;
}

function missingCreateReply(draft, now) {
  if (!draft.question) {
    return "what should the market ask?\nex: will dan make it by 10?";
  }
  if (!draft.closeAt || Number.isNaN(new Date(draft.closeAt).valueOf())) {
    delete draft.closeAt;
    return "when should betting close?\nex: tonight at 11 or in 2 hours";
  }
  if (new Date(draft.closeAt) <= now) {
    delete draft.closeAt;
    return "that time already passed — when should betting close?";
  }
  if (draft.subjectPhoneHash && !draft.subjectName) {
    return "who's this market about?";
  }
  return null;
}

function publicDraftContext(draft) {
  if (!draft) return null;
  const { subjectPhoneHash, ...safe } = draft;
  return { ...safe, hasSubjectPhone: Boolean(subjectPhoneHash) };
}

export function createPendingMarketDraftStore({
  now = () => new Date(),
  ttlMs = 15 * 60_000,
} = {}) {
  const drafts = new Map();
  const key = (groupId, userId) => `${groupId}:${userId}`;
  return {
    get(groupId, userId) {
      const entry = drafts.get(key(groupId, userId));
      if (!entry) return null;
      if (entry.expiresAt <= now().getTime()) {
        drafts.delete(key(groupId, userId));
        return null;
      }
      return entry.draft;
    },
    set(groupId, userId, draft) {
      drafts.set(key(groupId, userId), {
        draft: { ...draft },
        expiresAt: now().getTime() + ttlMs,
      });
    },
    delete(groupId, userId) {
      drafts.delete(key(groupId, userId));
    },
  };
}

function requirePhoneHash(hashPhone, value) {
  if (typeof hashPhone !== "function") {
    throw new Error("phone matching isn't configured on this agent");
  }
  const hash = hashPhone(value);
  if (!hash) throw new Error("send a valid phone number with the country code if you're outside the us");
  return hash;
}

function formatCreatedMarket(market, timezone) {
  if (!market) throw new Error("the market was created but i couldn't load it");
  const lines = [
    `market #${market.display_num} is live`,
    market.question,
    `betting closes ${formatInstant(market.close_at, timezone)}`,
  ];
  if (market.subject_name) lines.push(`${market.subject_name} can watch but can't bet`);
  return lines.join("\n");
}

function formatMarketList(rows, now) {
  if (rows.length === 0) return "no markets here yet";
  const markets = rows
    .slice(0, 10)
    .map(({ market, totals, adjudicatorName, joined }) => {
      const state = marketState(market, now);
      const pot = totals?.revealed ? ` · pot ${totals.total_pool ?? 0}` : " · pot sealed";
      const participation = joined ? "in" : "not in";
      return `#${market.display_num} ${market.question} — ${state} · ${participation}${pot} · judge: ${adjudicatorName}`;
    })
    .join("\n");
  return `here's what this group has\n${markets}`;
}

function formatMarket(result, now, timezone) {
  const { market, totals } = result;
  const lines = [
    `#${market.display_num} ${market.question}`,
    `${marketState(market, now)} · ${timeDescription(market, now, timezone)}`,
    `judge: ${result.adjudicatorName}`,
    formatOdds(result),
  ];
  const myStake = result.myStakes.reduce((sum, stake) => sum + stake.amount, 0);
  if (myStake > 0) lines.push(`you have ${myStake} points in`);
  if (totals?.revealed) lines.push(`${totals.participants} people in`);
  if (market.resolved_at) {
    lines.push(
      result.payouts?.length
        ? `payouts: ${result.payouts
            .map((payout) => `${payout.name} ${payout.amount}`)
            .join(" · ")}`
        : "no payouts",
    );
  }
  return lines.join("\n");
}

function formatOdds({ sides, pools, totals }) {
  if (!totals?.revealed) return "odds are sealed until reveal";
  const total = totals.total_pool ?? 0;
  const poolBySide = new Map(pools.map((pool) => [pool.side_id, pool.pool ?? 0]));
  const sideText = sides.map((side) => {
    const pool = poolBySide.get(side.id) ?? 0;
    const probability = total > 0 ? Math.round((pool / total) * 100) : 0;
    return `${side.label.toLowerCase()} ${probability}% (${pool})`;
  });
  return `${sideText.join(" · ")} · pot ${total}`;
}

function formatResolution(marketNumber, side, resolved) {
  const outcome = resolved.result === "resolved" ? side : "void";
  const lines = [`#${marketNumber} resolved ${outcome}`];
  if (resolved.payouts.length === 0) lines.push("no payouts");
  else {
    lines.push(
      `payouts: ${resolved.payouts
        .map((payout) => `${payout.name} ${payout.amount}`)
        .join(" · ")}`,
    );
  }
  return lines.join("\n");
}

function marketState(market, now) {
  if (market.resolved_at) return market.void_reason ? "void" : "resolved";
  if (now < new Date(market.reveal_at)) return "seeding";
  if (now < new Date(market.close_at)) return "open";
  return "closed";
}

function timeDescription(market, now, timezone) {
  if (market.resolved_at) return `resolved ${formatInstant(market.resolved_at, timezone)}`;
  const target = new Date(market.close_at);
  if (target <= now) return `betting closed ${formatInstant(target, timezone)}`;
  return `${formatDuration(target.getTime() - now.getTime())} until betting closes`;
}

function formatDuration(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatInstant(value, timezone) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    timeZoneName: "short",
  }).format(new Date(value));
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`send a valid ${label}`);
}

function validDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`send a valid ${label}`);
  return date;
}

function safeErrorMessage(error) {
  if (error instanceof SidebarDbError) {
    return error.publicMessage || "the database rejected it";
  }
  if (error instanceof Error) return error.message;
  return "something unexpected happened";
}

function assertTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid SIDEBAR_GROUP_TIMEZONE: ${timezone}`);
  }
}
