import { nonIdleSlackIssueCondition } from "./slack-conversation-state.js";
import { and, isNull, ne, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind))!;
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}

/** Work queues and execution totals omit persistent conversation containers. */
export function executionIssueCondition(): SQL {
  return and(visibleIssueCondition(), isNull(issues.conversationAgentId), nonIdleSlackIssueCondition())!;
}

/** Issues created by an external chat (Telegram, Slack, email, ...) carry this origin kind. */
export const CHAT_CONVERSATION_ORIGIN_KIND = "chat_channel";

/** Task lists and counters omit chat conversations unless a caller opts in. */
export function nonChatConversationIssueCondition(): SQL {
  return ne(issues.originKind, CHAT_CONVERSATION_ORIGIN_KIND);
}
