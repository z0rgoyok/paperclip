import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_TYPING_MAX_LIFETIME_MS,
  CHAT_TYPING_REFRESH_MS,
  ChatTypingRelay,
} from "./chat-typing.js";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";

const relays: ChatTypingRelay<{ id: string; conversationId: string }>[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  vi.useFakeTimers();
  const active = new Set(["run-1", "run-2"]);
  const send = vi.fn<
    (source: { id: string; conversationId: string }) => Promise<void>
  >(async () => undefined);
  const onError = vi.fn();
  const isActive = vi.fn(
    async (source: { id: string; conversationId: string }) =>
      active.has(source.id),
  );
  const relay = new ChatTypingRelay({
    isActive,
    send,
    onError,
  });
  relays.push(relay);
  const source = { id: "run-1", conversationId: "topic-12813" };
  return { active, send, onError, relay, source, isActive };
}

describe("conversation typing heartbeat", () => {
  it("starts once, refreshes every four seconds, and stops when the source settles", async () => {
    const { active, send, relay, source } = fixture();
    await relay.start(source);
    await relay.start(source);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHAT_TYPING_REFRESH_MS - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(send).toHaveBeenCalledTimes(4);
    active.clear();
    await relay.settle(source.conversationId);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(send).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps refresh gaps below 4.5 seconds with alternating authorization latency", async () => {
    const { send, isActive, relay, source } = fixture();
    const sends: number[] = [];
    let check = 0;
    isActive.mockImplementation(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, check++ % 2 === 0 ? 60 : 10),
      );
      return true;
    });
    send.mockImplementation(async () => {
      sends.push(Date.now());
    });
    const starting = relay.start(source);
    await vi.advanceTimersByTimeAsync(60);
    await starting;
    await vi.advanceTimersByTimeAsync(36_000);
    await relay.flush();
    expect(sends).toHaveLength(10);
    const gaps = sends.slice(1).map((at, index) => at - sends[index]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(4_500);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3_000);
  });

  it("caps a conversation lifetime even if active sources are added or probes fail", async () => {
    const { send, isActive, relay, source } = fixture();
    await relay.start(source);
    await vi.advanceTimersByTimeAsync(CHAT_TYPING_MAX_LIFETIME_MS - 8_000);
    await relay.start({ ...source, id: "run-2" });
    const beforeCap = send.mock.calls.length;
    isActive.mockRejectedValue(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(send).toHaveBeenCalledTimes(beforeCap);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces sources in a topic without stopping a successor or another topic", async () => {
    const { active, send, relay, source } = fixture();
    await relay.start(source);
    await relay.start({ ...source, id: "run-2" });
    await relay.start({ id: "run-2", conversationId: "topic-1269" });
    expect(send).toHaveBeenCalledTimes(2);
    active.delete("run-1");
    await relay.settle(source.conversationId);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(4);
    expect(
      send.mock.calls
        .slice(2)
        .map(([value]) => value.conversationId)
        .sort(),
    ).toEqual(["topic-1269", "topic-12813"]);
  });

  it("does not send or keep timers for an unauthorized source", async () => {
    const { active, send, relay, source } = fixture();
    active.clear();
    await relay.start(source);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps slow provider requests and drains them on shutdown", async () => {
    const { send, relay, source } = fixture();
    let release!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const starting = relay.start(source);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(send).toHaveBeenCalledTimes(1);
    const disposed = relay.dispose();
    release();
    await Promise.all([starting, disposed]);
    await vi.advanceTimersByTimeAsync(12_000);
    await relay.start(source);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors provider Retry-After and resumes without a retry burst", async () => {
    const { send, relay, source, onError } = fixture();
    send.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { status: 429, retryAfter: 10 }),
    );
    await relay.start(source);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("contains a failed state check and rechecks before retrying", async () => {
    const { send, relay, source, onError, isActive } = fixture();
    isActive.mockRejectedValueOnce(new Error("temporary read failure"));
    await relay.start(source);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("Telegram SDK typing scope", () => {
  it("does not send implicit private typing before Paperclip admits the sender", async () => {
    const onMessage = vi.fn();
    const actions: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = url.pathname.split("/").at(-1)!;
      actions.push(method);
      if (url.hostname !== "api.telegram.org")
        throw new Error("Unexpected provider");
      if (method === "getMe")
        return Response.json({
          ok: true,
          result: {
            id: 123,
            is_bot: true,
            first_name: "Fixture",
            username: "fixture_bot",
          },
        });
      if (method === "getChat")
        return Response.json({
          ok: true,
          result: { id: 77115569, type: "private", first_name: "Fixture" },
        });
      if (method === "sendChatAction")
        return Response.json({ ok: true, result: true });
      throw new Error(`Unexpected method ${method}`);
    });
    const runtime = createChatSdkEndpointRuntime({
      companyId: "typing-company",
      endpointId: "typing-endpoint",
      logger: "silent",
      callbacks: { onMessage },
      persistence: {
        async read() {
          return null;
        },
        async compareAndSet() {
          return true;
        },
        async deleteIfVersion() {
          return true;
        },
      },
      providerConfig: {
        provider: "telegram",
        userName: "fixture_bot",
        credentials: { botToken: "123:synthetic", secretToken: "synthetic" },
      },
    });
    try {
      await runtime.initialize();
      const response = await runtime.handleWebhook(
        new Request("https://paperclip.test/telegram", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "synthetic",
          },
          body: JSON.stringify({
            update_id: 71,
            message: {
              message_id: 41,
              date: 1_788_900_000,
              chat: { id: 77115569, type: "private" },
              from: { id: 77115569, is_bot: false, first_name: "Fixture" },
              text: "Hello",
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(actions).not.toContain("sendChatAction");
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    ["telegram:77115569", 77115569, undefined],
    ["telegram:-10077119988", -10077119988, undefined],
    ["telegram:-10077119988:12813", -10077119988, 12813],
    ["telegram:-10077119988:1269", -10077119988, 1269],
  ])(
    "keeps %s scoped on initial and refreshed actions",
    async (threadId, chatId, topicId) => {
      vi.useFakeTimers();
      const actions: unknown[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const method = url.pathname.split("/").at(-1);
        if (url.hostname !== "api.telegram.org")
          throw new Error("Unexpected provider");
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: 123,
              is_bot: true,
              first_name: "Fixture",
              username: "fixture_bot",
            },
          });
        if (method !== "sendChatAction")
          throw new Error(`Unexpected method ${method}`);
        actions.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, result: true });
      });
      const runtime = createChatSdkEndpointRuntime({
        companyId: "typing-company",
        endpointId: "typing-endpoint",
        logger: "silent",
        callbacks: { onMessage() {} },
        persistence: {
          async read() {
            return null;
          },
          async compareAndSet() {
            return true;
          },
          async deleteIfVersion() {
            return true;
          },
        },
        providerConfig: {
          provider: "telegram",
          userName: "fixture_bot",
          credentials: { botToken: "123:synthetic", secretToken: "synthetic" },
        },
      });
      const relay = new ChatTypingRelay({
        isActive: async () => true,
        send: async () => {
          await runtime.thread(String(threadId)).startTyping("Working…");
        },
        onError: (error) => {
          throw error;
        },
      });
      relays.push(relay);
      try {
        await runtime.initialize();
        await relay.start({ id: "run", conversationId: String(threadId) });
        await vi.advanceTimersByTimeAsync(8_000);
        expect(actions).toEqual(
          Array.from({ length: 3 }, () => ({
            chat_id: String(chatId),
            ...(topicId ? { message_thread_id: topicId } : {}),
            action: "typing",
          })),
        );
      } finally {
        await relay.dispose();
        await runtime.shutdown();
      }
    },
  );
});
