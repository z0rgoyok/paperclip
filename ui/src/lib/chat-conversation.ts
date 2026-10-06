import type { Issue } from "@paperclipai/shared";

/** Issues created from an external chat are conversations, not tasks in progress. */
export function isChatConversationIssue(issue: Pick<Issue, "originKind"> | null | undefined): boolean {
  return issue?.originKind === "chat_channel";
}

/** Board inbox visibility. The separate Blocked view always keeps conversations. */
export function filterInboxChatConversations<T extends { originKind?: string | null }>(
  issues: T[],
  showChatConversations = false,
): T[] {
  return showChatConversations ? issues : issues.filter((issue) => issue.originKind !== "chat_channel");
}
