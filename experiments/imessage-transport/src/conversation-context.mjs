const PHONE_LIKE = /(?:\+?\d[\d().\s-]{6,}\d)/g;

export function createConversationContextStore({
  now = () => new Date(),
  ttlMs = 60 * 60_000,
  maxTurns = 8,
} = {}) {
  const conversations = new Map();

  const get = (groupId) => {
    const entry = conversations.get(groupId);
    if (!entry) return [];
    if (entry.expiresAt <= now().getTime()) {
      conversations.delete(groupId);
      return [];
    }
    return entry.turns.map(copyTurn);
  };

  return {
    get,

    append(groupId, { speaker, user, assistant }) {
      if (!groupId) return;
      const current = get(groupId);
      const turn = {
        speaker: String(speaker ?? "member"),
        user: redactSensitiveText(user),
        assistant: normalizeMessages(assistant).map(redactSensitiveText),
      };
      conversations.set(groupId, {
        turns: [...current, turn].slice(-maxTurns),
        expiresAt: now().getTime() + ttlMs,
      });
    },

    delete(groupId) {
      conversations.delete(groupId);
    },
  };
}

export function redactSensitiveText(value) {
  return String(value ?? "").replace(PHONE_LIKE, "[phone provided]").trim();
}

function normalizeMessages(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((message) => String(message ?? "").split(/\n+/))
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function copyTurn(turn) {
  return { ...turn, assistant: [...turn.assistant] };
}
