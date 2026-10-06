import type { Issue } from "@paperclipai/shared";

/** Issues created from an external chat are conversations, not tasks in progress. */
export function isChatConversationIssue(issue: Pick<Issue, "originKind"> | null | undefined): boolean {
  return issue?.originKind === "chat_channel";
}
