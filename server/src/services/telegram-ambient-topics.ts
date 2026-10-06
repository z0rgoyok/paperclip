/**
 * Telegram ambient intake ("respond without mention") can be limited to some
 * forum topics of one group destination. A forum topic is not a destination of
 * its own: the pinned Chat SDK adapter encodes the topic into the thread id as
 * `telegram:<chatId>:<message_thread_id>`, while a General-topic or plain group
 * message has no topic part (`telegram:<chatId>`).
 */

/** Telegram's General forum topic. Its messages carry no message_thread_id. */
export const TELEGRAM_GENERAL_TOPIC_ID = "1";

/** Forum topic id of a Telegram Chat SDK thread id; General when absent. */
export function telegramTopicIdFromThreadId(threadId: string): string {
  return (
    /^telegram:[^:]+:([^:]+)$/.exec(threadId)?.[1] ?? TELEGRAM_GENERAL_TOPIC_ID
  );
}

/** Topic list as stored: trimmed, de-duplicated, null when it means "all". */
export function normalizeTelegramAmbientThreadIds(
  threadIds: readonly string[] | null | undefined,
): string[] | null {
  if (!threadIds) return null;
  const normalized = [
    ...new Set(threadIds.map((id) => id.trim()).filter(Boolean)),
  ];
  return normalized.length > 0 ? normalized : null;
}

/**
 * True when ambient intake applies to this Telegram thread: no topic list
 * (null or empty) keeps the whole group ambient, otherwise only the listed
 * topics are.
 */
export function telegramAmbientTopicAllowed(
  threadIds: readonly string[] | null | undefined,
  threadId: string,
): boolean {
  const allowed = normalizeTelegramAmbientThreadIds(threadIds);
  if (!allowed) return true;
  return allowed.includes(telegramTopicIdFromThreadId(threadId));
}
