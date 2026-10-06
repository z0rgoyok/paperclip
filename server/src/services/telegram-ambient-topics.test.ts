import { describe, expect, it } from "vitest";
import {
  normalizeTelegramAmbientThreadIds,
  telegramAmbientTopicAllowed,
  telegramTopicIdFromThreadId,
} from "./telegram-ambient-topics.js";

describe("Telegram ambient topic scope", () => {
  it("reads the forum topic from the Chat SDK thread id, General when absent", () => {
    expect(telegramTopicIdFromThreadId("telegram:-1001234:42")).toBe("42");
    expect(telegramTopicIdFromThreadId("telegram:-1001234")).toBe("1");
  });

  it("treats a missing or empty list as the whole group", () => {
    for (const list of [null, undefined, [], [" "]])
      expect(telegramAmbientTopicAllowed(list, "telegram:-100:7")).toBe(true);
    expect(normalizeTelegramAmbientThreadIds([" 42", "42", "", "1"])).toEqual([
      "42",
      "1",
    ]);
    expect(normalizeTelegramAmbientThreadIds([])).toBeNull();
  });

  it("admits only listed topics, with General as 1", () => {
    expect(telegramAmbientTopicAllowed(["42"], "telegram:-100:42")).toBe(true);
    expect(telegramAmbientTopicAllowed(["42"], "telegram:-100:7")).toBe(false);
    expect(telegramAmbientTopicAllowed(["42"], "telegram:-100")).toBe(false);
    expect(telegramAmbientTopicAllowed(["1"], "telegram:-100")).toBe(true);
  });
});
