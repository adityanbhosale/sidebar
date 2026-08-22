const DEFAULT_DELAY_MS = 350;

export function replyMessages(reply) {
  const values = Array.isArray(reply) ? reply : [reply];
  return values
    .flatMap((value) => String(value ?? "").split(/\n+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .map(lowercaseChatMessage);
}

export function lowercaseChatMessage(value) {
  return String(value)
    .split(/(https?:\/\/\S+)/gi)
    .map((part) => (/^https?:\/\//i.test(part) ? part : part.toLocaleLowerCase("en-US")))
    .join("");
}

export async function sendReplySequence({
  reply,
  send,
  delayMs = DEFAULT_DELAY_MS,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const messages = replyMessages(reply);
  for (let index = 0; index < messages.length; index++) {
    if (index > 0 && delayMs > 0) await wait(delayMs);
    await send(messages[index]);
  }
  return messages;
}

export function configuredReplyDelay(value) {
  const parsed = Number(value ?? DEFAULT_DELAY_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS;
  return Math.max(0, Math.min(2_000, Math.round(parsed)));
}
