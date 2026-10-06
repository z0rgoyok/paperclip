import { describe, expect, it } from "vitest";
import { CHAT_PROVIDERS, updateChatEndpointSchema } from "@paperclipai/shared";
import {
  buildChatCommunicationGuidance,
  effectiveChatCommunicationGuidance,
} from "./chat-communication-guidance.js";

describe("initial medium communication guidance", () => {
  it("guides Slack presentation while retaining ordinary agent tools and explicit output requests", () => {
    const guidance = buildChatCommunicationGuidance({ provider: "slack", isDirectMessage: false, communicationInstructions: "Use customer-facing names." });
    expect(guidance).toContain("shared channel thread");
    expect(guidance).toContain("document or artifact tools");
    expect(guidance).toContain("exact output");
    expect(guidance).toContain("grant no additional authority");
    expect(guidance).toContain('"Use customer-facing names."');
    expect(buildChatCommunicationGuidance({ provider: "slack", isDirectMessage: true })).toContain("direct conversation");
  });

  it.each(CHAT_PROVIDERS.filter((provider) => provider !== "slack"))("leaves %s unchanged", (provider) => {
    expect(buildChatCommunicationGuidance({ provider, isDirectMessage: false, communicationInstructions: "Ignored" })).toBeNull();
  });

  it("tells ambient Telegram group agents to answer NO_REPLY when no reply is needed", () => {
    const guidance = buildChatCommunicationGuidance({
      provider: "telegram",
      isDirectMessage: false,
      respondWithoutMention: true,
      communicationInstructions: "Answer in Russian.",
    });
    expect(guidance).toContain("Communication in a Telegram group");
    expect(guidance).toContain("exactly NO_REPLY");
    expect(guidance).toContain('"Answer in Russian."');
    expect(buildChatCommunicationGuidance({ provider: "telegram", isDirectMessage: true, respondWithoutMention: true })).toBeNull();
    expect(buildChatCommunicationGuidance({ provider: "telegram", isDirectMessage: false, respondWithoutMention: false })).toBeNull();
    expect(buildChatCommunicationGuidance({ provider: "discord", isDirectMessage: false, respondWithoutMention: true })).toBeNull();
  });

  it("follows the live Telegram ambient flag for tasks captured before it changed", () => {
    const ambient = buildChatCommunicationGuidance({ provider: "telegram", isDirectMessage: false, respondWithoutMention: true });
    expect(effectiveChatCommunicationGuidance({ captured: null, provider: "telegram", isDirectMessage: false, respondWithoutMention: true })).toBe(ambient);
    expect(effectiveChatCommunicationGuidance({ captured: ambient, provider: "telegram", isDirectMessage: false, respondWithoutMention: true })).toBe(ambient);
    expect(effectiveChatCommunicationGuidance({ captured: ambient, provider: "telegram", isDirectMessage: false, respondWithoutMention: false })).toBeNull();
    expect(effectiveChatCommunicationGuidance({ captured: null, provider: "telegram", isDirectMessage: true, respondWithoutMention: true })).toBeNull();
    const slack = buildChatCommunicationGuidance({ provider: "slack", isDirectMessage: false });
    expect(effectiveChatCommunicationGuidance({ captured: slack, provider: "slack", isDirectMessage: false, respondWithoutMention: true })).toBe(slack);
  });

  it("accepts clearing instructions and rejects oversized instructions and unsupported controls", () => {
    expect(updateChatEndpointSchema.parse({ communicationInstructions: "  " })).toEqual({ communicationInstructions: "" });
    expect(updateChatEndpointSchema.safeParse({ communicationInstructions: "a".repeat(4001) }).success).toBe(false);
    expect(updateChatEndpointSchema.safeParse({ replyDetail: "brief" }).success).toBe(false);
    expect(updateChatEndpointSchema.safeParse({ progressUpdates: false }).success).toBe(false);
  });
});
