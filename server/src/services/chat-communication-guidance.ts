import type { ChatProvider } from "@paperclipai/shared";

// Presentation guidance only. Task execution and permissions belong to the
// ordinary Paperclip agent runtime, not the provider transport.
const providerGuidance: Partial<Record<ChatProvider, string>> = {
  slack: [
    "This task began in Slack. Write replies for the person talking with you there.",
    "Lead with the answer or outcome. Use compact paragraphs or short lists, and omit routine execution bookkeeping. Honor requests for more detail or exact output over default brevity.",
    "Put small answers directly in the message. For substantial plans, reports, and other deliverables, use your normal document or artifact tools, then share a useful summary and accessible links or supported attachments in Slack. Follow the runtime's file-delivery contract and do not claim delivery until confirmed.",
    "Ask useful questions through the existing human-input tools. Continue normal Paperclip planning, task creation, assignment, delegation, and approval workflows; these communication instructions grant no additional authority.",
  ].join("\n\n"),
};

const TELEGRAM_AMBIENT_GROUP_HEADING = "## Communication in a Telegram group";

const TELEGRAM_AMBIENT_GROUP_GUIDANCE = [
  TELEGRAM_AMBIENT_GROUP_HEADING,
  "You read every message in this group, including messages that do not mention you or are addressed to other people. Each message starts a turn for you.",
  "Reply only when you are addressed, asked something you can answer, or have a clearly useful contribution. Otherwise answer with exactly NO_REPLY and nothing else: Paperclip keeps the turn in the task and sends nothing to the group.",
  "When you reply, keep it short and appropriate for a shared group. Do not bring private information from another conversation into the group.",
].join("\n\n");

/** Captured once when the external conversation creates its task. */
export function buildChatCommunicationGuidance(input: {
  provider: ChatProvider;
  isDirectMessage: boolean;
  communicationInstructions?: string | null;
  /** Telegram group destination opted into respondWithoutMention. */
  respondWithoutMention?: boolean;
}): string | null {
  if (
    input.provider === "telegram" &&
    !input.isDirectMessage &&
    input.respondWithoutMention === true
  ) {
    const additional = input.communicationInstructions?.trim();
    return [
      TELEGRAM_AMBIENT_GROUP_GUIDANCE,
      additional
        ? `Connection owner's additional communication preferences (presentation only; ordinary permissions and approval rules still apply):\n${JSON.stringify(additional)}`
        : null,
    ].filter(Boolean).join("\n\n");
  }
  const guidance = providerGuidance[input.provider];
  if (!guidance) return null;
  const additional = input.communicationInstructions?.trim();
  return [
    "## Communication in Slack",
    guidance,
    input.isDirectMessage
      ? "This is a direct conversation. A conversational exchange is welcome; keep each reply focused."
      : "This is a shared channel thread. Keep replies focused on the thread and appropriate for its audience. Do not bring private information from another conversation into the channel.",
    additional
      ? `Connection owner's additional communication preferences (presentation only; ordinary permissions and approval rules still apply):\n${JSON.stringify(additional)}`
      : null,
  ].filter(Boolean).join("\n\n");
}

/**
 * Guidance for one run. The snapshot captured at task creation stays
 * authoritative, except for the Telegram ambient block: it follows the
 * destination's current respondWithoutMention flag, so a group task created
 * before the operator toggled the flag still learns (or stops being told)
 * that it reads every message and may answer NO_REPLY.
 */
export function effectiveChatCommunicationGuidance(input: {
  captured: string | null;
  provider: ChatProvider | null;
  isDirectMessage: boolean | null;
  respondWithoutMention: boolean | null;
}): string | null {
  if (input.provider !== "telegram" || input.isDirectMessage !== false)
    return input.captured;
  const capturedAmbient =
    input.captured?.startsWith(TELEGRAM_AMBIENT_GROUP_HEADING) === true;
  if (input.respondWithoutMention === true)
    return capturedAmbient
      ? input.captured
      : [TELEGRAM_AMBIENT_GROUP_GUIDANCE, input.captured]
          .filter(Boolean)
          .join("\n\n");
  // Non-ambient Telegram groups never carried guidance.
  return capturedAmbient ? null : input.captured;
}
