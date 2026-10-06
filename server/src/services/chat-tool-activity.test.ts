import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatToolActivityRelay,
  TOOL_ACTIVITY_HIDDEN_TEXT,
  describeToolCall,
  maskToolActivitySecrets,
  renderToolActivity,
} from "./chat-tool-activity.js";
import type { RunOutputChunk } from "./run-output-tap.js";

const TELEGRAM_TOKEN = "7123456789:AAH4k3Jx9qLmNoPqRsTuVwXyZaBcDeFgHiJ";

describe("tool activity masking", () => {
  it("masks credential-shaped values and keeps env variable names", () => {
    const masked = maskToolActivitySecrets(
      [
        `curl https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`,
        "git push https://x-access-token:ghs_abcdefghijklmnopqrstuvwx@github.com/o/r.git",
        "curl -H 'Authorization: Bearer abcdefghijklmnop.qrstuv'",
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
        "pcp_live_1234567890abcdef itp_9876543210fedcba ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
        "echo $GITHUB_TOKEN $TELEGRAM_BOT_TOKEN",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
        "blob QmFzZTY0U2VjcmV0VmFsdWVXaXRoTWl4ZWRDYXNlMTIzNDU2Nzg5MA==",
      ].join("\n"),
    );
    expect(masked).not.toContain(TELEGRAM_TOKEN.split(":")[1]);
    expect(masked).not.toContain("ghs_abcdefghijklmnopqrstuvwx");
    expect(masked).not.toContain("abcdefghijklmnop.qrstuv");
    expect(masked).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(masked).not.toContain("pcp_live_1234567890abcdef");
    expect(masked).not.toContain("itp_9876543210fedcba");
    expect(masked).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(masked).not.toContain("github_pat_11ABCDEFG");
    expect(masked).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(masked).not.toContain("QmFzZTY0U2VjcmV0VmFsdWVXaXRoTWl4ZWRDYXNlMTIzNDU2Nzg5MA");
    expect(masked).toContain("$GITHUB_TOKEN $TELEGRAM_BOT_TOKEN");
    expect(masked).toContain("https://***@github.com/o/r.git");
    expect(masked).toContain("https://api.telegram.org/bot***/getMe");
  });

  it("masks the run's secret env values by value and leaves ordinary text", () => {
    expect(
      maskToolActivitySecrets("psql postgres://app@db/hunter2-database-pass", [
        "hunter2-database-pass",
        "1",
      ]),
    ).toBe("psql postgres://app@db/***");
    const ordinary =
      "git log --oneline 2a086c0bd5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0 -- /Users/someone/dev/paperclip/server/src/services/chat-channels.ts";
    expect(maskToolActivitySecrets(ordinary)).toBe(ordinary);
  });
});

describe("tool activity lines", () => {
  it("summarizes shell commands, file tools, and MCP calls", () => {
    expect(
      describeToolCall({
        name: "command_execution",
        input: { id: "item_1", command: "/bin/zsh -lc 'git status --short'" },
      }),
    ).toBe("🔧 shell: git status --short");
    expect(
      describeToolCall({ name: "Read", input: { file_path: "/repo/README.md" } }),
    ).toBe("🔧 Read: /repo/README.md");
    expect(
      describeToolCall({
        name: "mcp__paperclip__get_issue",
        input: { issueId: "PAP-12", verbose: true },
      }),
    ).toBe("🔧 paperclip.get_issue: PAP-12");
    expect(describeToolCall({ name: "TodoWrite", input: { todos: [] } })).toBe(
      "🔧 TodoWrite",
    );
  });

  it("keeps the first ~80 characters and masks before truncating", () => {
    const line = describeToolCall({
      name: "Bash",
      input: { command: `echo ${"x".repeat(200)}` },
    });
    expect([...line.slice("🔧 Bash: ".length)].length).toBe(80);
    expect(line.endsWith("…")).toBe(true);
    const secretLine = describeToolCall({
      name: "Bash",
      input: {
        command: `${"a ".repeat(36)}curl https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`,
      },
    });
    expect(secretLine).not.toMatch(/AAH4k3/);
  });

  it("renders only the last lines", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `🔧 t${index}`);
    expect(renderToolActivity(lines).split("\n")).toEqual(lines.slice(-15));
  });
});

type Target = { conversationId: string };

function harness(input: { targets?: Target[]; minEditIntervalMs?: number } = {}) {
  const calls: Array<{ op: string; messageId?: string; text?: string }> = [];
  let clock = 1_000;
  let failPost = false;
  let canDelete = true;
  const relay = new ChatToolActivityRelay<Target>({
    resolveTargets: async () => input.targets ?? [{ conversationId: "c1" }],
    minEditIntervalMs: input.minEditIntervalMs ?? 3_000,
    now: () => clock,
    transport: {
      post: async (_target, text) => {
        if (failPost) throw new Error("rate limited");
        calls.push({ op: "post", text });
        return "m1";
      },
      edit: async (_target, messageId, text) => {
        calls.push({ op: "edit", messageId, text });
      },
      remove: async (_target, messageId) => {
        if (!canDelete) return false;
        calls.push({ op: "delete", messageId });
        return true;
      },
    },
  });
  const chunk = (text: string, overrides: Partial<RunOutputChunk> = {}): RunOutputChunk => ({
    companyId: "co",
    runId: "run-1",
    agentId: "agent",
    issueId: "issue",
    adapterType: "codex_local",
    stream: "stdout",
    chunk: text,
    secretValues: () => ["s3cr3t-value"],
    ...overrides,
  });
  const command = (id: string, cmd: string) =>
    `${JSON.stringify({ type: "item.started", item: { id, type: "command_execution", command: cmd, status: "in_progress" } })}\n`;
  return {
    relay,
    calls,
    chunk,
    command,
    advance: (ms: number) => {
      clock += ms;
    },
    setFailPost: (value: boolean) => {
      failPost = value;
    },
    setCanDelete: (value: boolean) => {
      canDelete = value;
    },
  };
}

describe("tool activity relay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts nothing until the agent calls a tool", async () => {
    const h = harness();
    h.relay.observe(
      h.chunk(
        `${JSON.stringify({ type: "thread.started", thread_id: "t" })}\n${JSON.stringify({ type: "item.completed", item: { id: "a", type: "agent_message", text: "hi" } })}\n`,
      ),
    );
    await h.relay.flush();
    expect(h.calls).toEqual([]);
  });

  it("posts one message on the first tool call and throttles edits", async () => {
    vi.useFakeTimers();
    const h = harness();
    // A JSON line split across chunks is reassembled.
    const first = h.command("i1", "git status");
    h.relay.observe(h.chunk(first.slice(0, 20)));
    h.relay.observe(h.chunk(first.slice(20)));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual([{ op: "post", text: "🔧 shell: git status" }]);

    h.relay.observe(h.chunk(h.command("i2", "ls s3cr3t-value")));
    h.relay.observe(h.chunk(h.command("i2", "ls s3cr3t-value")));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls).toHaveLength(1);
    h.advance(3_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.calls).toEqual([
      { op: "post", text: "🔧 shell: git status" },
      {
        op: "edit",
        messageId: "m1",
        text: "🔧 shell: git status\n🔧 shell: ls ***",
      },
    ]);
  });

  it("deletes the message for a silent reply and hides it when deletion is unavailable", async () => {
    const h = harness({ minEditIntervalMs: 0 });
    h.relay.observe(h.chunk(h.command("i1", "pwd")));
    await h.relay.flush();
    await h.relay.settle({ conversationId: "c1", runId: "run-1", silent: true });
    expect(h.calls.map((call) => call.op)).toEqual(["post", "delete"]);
    // Late output after the silent settle never recreates the message.
    h.relay.observe(h.chunk(h.command("i2", "whoami")));
    await h.relay.flush();
    expect(h.calls.map((call) => call.op)).toEqual(["post", "delete"]);

    const hidden = harness({ minEditIntervalMs: 0 });
    hidden.setCanDelete(false);
    hidden.relay.observe(hidden.chunk(hidden.command("i1", "pwd")));
    await hidden.relay.flush();
    await hidden.relay.settle({ conversationId: "c1", runId: null, silent: true });
    expect(hidden.calls.at(-1)).toEqual({
      op: "edit",
      messageId: "m1",
      text: TOOL_ACTIVITY_HIDDEN_TEXT,
    });
  });

  it("keeps the message for an ordinary reply and ignores other adapters or no targets", async () => {
    const h = harness({ minEditIntervalMs: 0 });
    h.relay.observe(h.chunk(h.command("i1", "pwd")));
    await h.relay.settle({ conversationId: "c1", runId: "run-1", silent: false });
    expect(h.calls.map((call) => call.op)).toEqual(["post"]);

    h.relay.observe(
      h.chunk(h.command("x", "pwd"), { runId: "run-2", adapterType: "process" }),
    );
    const none = harness({ targets: [] });
    none.relay.observe(none.chunk(none.command("i1", "pwd")));
    await Promise.all([h.relay.flush(), none.relay.flush()]);
    expect(h.calls.map((call) => call.op)).toEqual(["post"]);
    expect(none.calls).toEqual([]);
    expect(none.relay.tracksConversation("c1")).toBe(false);
  });

  it("never throws when the provider rejects the activity message", async () => {
    const h = harness({ minEditIntervalMs: 0 });
    h.setFailPost(true);
    h.relay.observe(h.chunk(h.command("i1", "pwd")));
    await expect(h.relay.flush()).resolves.toBeUndefined();
    h.setFailPost(false);
    h.relay.observe(h.chunk(h.command("i2", "ls")));
    await h.relay.flush();
    expect(h.calls).toEqual([
      { op: "post", text: "🔧 shell: pwd\n🔧 shell: ls" },
    ]);
  });

  it("reads Claude stream-json tool_use blocks", async () => {
    const h = harness();
    h.relay.observe(
      h.chunk(
        `${JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Checking" },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Bash",
                input: { command: "npm test", description: "Run tests" },
              },
            ],
          },
        })}\n`,
        { adapterType: "claude_local" },
      ),
    );
    await h.relay.flush();
    expect(h.calls).toEqual([{ op: "post", text: "🔧 Bash: npm test" }]);
  });
});
