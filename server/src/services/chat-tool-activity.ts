import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { redactSensitiveText } from "../redaction.js";
import type { RunOutputChunk } from "./run-output-tap.js";

/**
 * Per-run "tool activity" message for chat destinations that opt into
 * showToolActivity (like Hermes `tool_progress: all`). One provider message per
 * run and conversation lists the tools the agent calls, edited in place at a
 * throttled cadence. Tool results are never shown, and every line is masked
 * before it leaves Paperclip.
 */

export const TOOL_ACTIVITY_MAX_LINES = 15;
export const TOOL_ACTIVITY_ARGUMENT_CHARS = 80;
/** Telegram allows ~20 messages per minute in a group; edits count too. */
export const TOOL_ACTIVITY_MIN_EDIT_INTERVAL_MS = 3_000;
/** Shown instead of the list when a NO_REPLY run's message cannot be deleted. */
export const TOOL_ACTIVITY_HIDDEN_TEXT = "🔧 …";
const MASK = "***";
const MAX_PARTIAL_LINE_CHARS = 512 * 1024;
const MAX_KEPT_LINES = 200;
const MAX_FAILURES = 3;
const SETTLE_WAIT_MS = 5_000;
const IDLE_RUN_TTL_MS = 60 * 60 * 1_000;

type StdoutParser = (line: string, ts: string) => TranscriptEntry[];

/**
 * Existing normalized transcript parsers (the same ones the run transcript UI
 * uses). Each understands both the adapter's CLI JSON stream and the ACPX
 * engine stream, so no second parser lives here.
 */
const STDOUT_PARSERS: Readonly<Record<string, StdoutParser>> = {
  codex_local: parseCodexStdoutLine,
  claude_local: parseClaudeStdoutLine,
};

export function toolActivityParserFor(adapterType: string): StdoutParser | null {
  return STDOUT_PARSERS[adapterType] ?? null;
}

// ---------------------------------------------------------------------------
// Masking

const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g;
// No leading \b: the token usually follows `/bot` in API URLs.
const TELEGRAM_BOT_TOKEN_RE = /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g;
const ACCESS_TOKEN_USERINFO_RE = /\bx-access-token:[^@\s'"]+@/gi;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PREFIXED_KEY_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pcp_[A-Za-z0-9_-]{6,}|itp_[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,})/g;
/** NAME=value / NAME: value for secret-looking names; `$VAR` values stay. */
const SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)(?!\$)([^\s"'&;|]{4,})/gi;
const LONG_OPAQUE_RE = /[A-Za-z0-9+/=_-]{40,}/g;

function looksLikeOpaqueSecret(candidate: string): boolean {
  // Paths and hex digests are long too: require one long segment that mixes
  // upper case, lower case, and digits, which ordinary words and SHAs do not.
  return candidate
    .split("/")
    .some(
      (segment) =>
        segment.length >= 32 &&
        /[A-Z]/.test(segment) &&
        /[a-z]/.test(segment) &&
        /\d/.test(segment),
    );
}

/**
 * Masks credential-shaped values and the run's own secret env values. Env
 * variable names (`$GITHUB_TOKEN`) are kept so the line stays readable.
 */
export function maskToolActivitySecrets(
  text: string,
  secretValues: readonly string[] = [],
): string {
  let masked = text;
  const exact = [...new Set(secretValues)]
    .filter((value) => typeof value === "string" && value.length >= 6)
    .sort((left, right) => right.length - left.length);
  for (const value of exact) masked = masked.split(value).join(MASK);
  masked = masked
    .replace(PEM_BLOCK_RE, `[private key ${MASK}]`)
    .replace(TELEGRAM_BOT_TOKEN_RE, MASK)
    .replace(ACCESS_TOKEN_USERINFO_RE, `x-access-token:${MASK}@`)
    .replace(URL_USERINFO_RE, `$1${MASK}@`)
    .replace(AUTH_SCHEME_RE, `$1 ${MASK}`)
    .replace(PREFIXED_KEY_RE, MASK)
    .replace(SECRET_ASSIGNMENT_RE, `$1$2$3${MASK}`)
    .replace(LONG_OPAQUE_RE, (candidate) =>
      looksLikeOpaqueSecret(candidate) ? MASK : candidate,
    );
  // The shared run-log redactor adds its JSON/header/command rules on top.
  return redactSensitiveText(masked);
}

// ---------------------------------------------------------------------------
// Line building

const PREFERRED_ARGUMENT_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "title",
  "name",
  "issueId",
  "issue_id",
  "identifier",
  "id",
] as const;

const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  command_execution: "shell",
};

function displayToolName(name: string): string {
  const trimmed = name.trim() || "tool";
  const alias = TOOL_NAME_ALIASES[trimmed];
  if (alias) return alias;
  // Claude names MCP tools `mcp__<server>__<tool>`.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(trimmed);
  return mcp ? `${mcp[1]}.${mcp[2]}` : trimmed;
}

/** `/bin/zsh -lc 'git status'` → `git status`. */
function unwrapShellCommand(command: string): string {
  const match =
    /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-(?:l?c|cl)\s+(['"])([\s\S]*)\1\s*$/.exec(
      command.trim(),
    );
  return match ? match[2]! : command;
}

function argumentText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string")
  )
    return value.join(" ");
  return null;
}

function keyArgument(input: unknown): string | null {
  const direct = argumentText(input);
  if (direct !== null) return direct;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of PREFERRED_ARGUMENT_KEYS) {
    const text = argumentText(record[key]);
    if (text !== null) return text;
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim() && value.length <= 500)
      return value;
  }
  return null;
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars
    ? text
    : `${chars.slice(0, maxChars - 1).join("")}…`;
}

/**
 * One activity line: `🔧 <tool>: <key argument>`. Shell commands keep their
 * first ~80 characters; other tools show their most telling argument. The full
 * argument is masked before truncation so a cut can never expose a partial
 * secret that no longer matches a pattern.
 */
export function describeToolCall(
  call: { name: string; input: unknown },
  secretValues: readonly string[] = [],
): string {
  const name = maskToolActivitySecrets(
    truncate(displayToolName(call.name), 60),
    secretValues,
  );
  const rawArgument = keyArgument(call.input);
  if (rawArgument === null) return `🔧 ${name}`;
  const argument = truncate(
    maskToolActivitySecrets(
      unwrapShellCommand(rawArgument).replace(/\s+/g, " ").trim(),
      secretValues,
    ),
    TOOL_ACTIVITY_ARGUMENT_CHARS,
  );
  return argument ? `🔧 ${name}: ${argument}` : `🔧 ${name}`;
}

/** The message body: the last lines only, oldest first. */
export function renderToolActivity(
  lines: readonly string[],
  maxLines = TOOL_ACTIVITY_MAX_LINES,
): string {
  return lines.slice(-maxLines).join("\n");
}

// ---------------------------------------------------------------------------
// Relay

export interface ToolActivityRunRef {
  companyId: string;
  runId: string;
  agentId: string;
  issueId: string | null;
}

export interface ToolActivityTarget {
  conversationId: string;
}

export interface ToolActivityTransport<T extends ToolActivityTarget> {
  /** Posts a new message and returns its provider message id. */
  post(target: T, text: string): Promise<string>;
  edit(target: T, messageId: string, text: string): Promise<void>;
  /** Deletes the message; false when the provider cannot delete it. */
  remove(target: T, messageId: string): Promise<boolean>;
}

export interface ChatToolActivityRelayOptions<T extends ToolActivityTarget> {
  resolveTargets(run: ToolActivityRunRef): Promise<T[]>;
  transport: ToolActivityTransport<T>;
  minEditIntervalMs?: number;
  maxLines?: number;
  now?: () => number;
  onError?: (error: unknown, context: Record<string, unknown>) => void;
}

type OutputState<T extends ToolActivityTarget> = {
  target: T;
  messageId: string | null;
  sentText: string | null;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  posting: boolean;
  failures: number;
  closed: boolean;
};

type RunState<T extends ToolActivityTarget> = {
  run: ToolActivityRunRef;
  parser: StdoutParser;
  secretValues: () => readonly string[];
  targets: T[] | null;
  inactive: boolean;
  partial: string;
  queue: Promise<void>;
  lines: string[];
  toolUseIds: Set<string>;
  outputs: OutputState<T>[];
  lastActivityAt: number;
};

async function withinTimeout(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export class ChatToolActivityRelay<T extends ToolActivityTarget> {
  private readonly runs = new Map<string, RunState<T>>();
  private readonly minEditIntervalMs: number;
  private readonly maxLines: number;
  private readonly now: () => number;

  constructor(private readonly options: ChatToolActivityRelayOptions<T>) {
    this.minEditIntervalMs =
      options.minEditIntervalMs ?? TOOL_ACTIVITY_MIN_EDIT_INTERVAL_MS;
    this.maxLines = options.maxLines ?? TOOL_ACTIVITY_MAX_LINES;
    this.now = options.now ?? Date.now;
  }

  /** Enqueue one run output chunk. Never throws and never blocks the run. */
  observe(chunk: RunOutputChunk): void {
    if (chunk.stream !== "stdout") return;
    let state = this.runs.get(chunk.runId);
    if (state?.inactive) return;
    if (!state) {
      const parser = toolActivityParserFor(chunk.adapterType);
      if (!parser || !chunk.issueId) return;
      this.sweepIdleRuns();
      const run: ToolActivityRunRef = {
        companyId: chunk.companyId,
        runId: chunk.runId,
        agentId: chunk.agentId,
        issueId: chunk.issueId,
      };
      const created: RunState<T> = {
        run,
        parser,
        secretValues: chunk.secretValues,
        targets: null,
        inactive: false,
        partial: "",
        queue: Promise.resolve(),
        lines: [],
        toolUseIds: new Set(),
        outputs: [],
        lastActivityAt: this.now(),
      };
      // Targets are resolved once per run; chunks queue behind it in order.
      created.queue = this.options
        .resolveTargets(run)
        .catch((error) => {
          this.report(error, { runId: run.runId, stage: "resolve" });
          return [] as T[];
        })
        .then((targets) => {
          created.targets = targets;
          created.inactive = targets.length === 0;
          created.outputs = targets.map((target) => ({
            target,
            messageId: null,
            sentText: null,
            lastSentAt: 0,
            timer: null,
            chain: Promise.resolve(),
            posting: false,
            failures: 0,
            closed: false,
          }));
        });
      this.runs.set(chunk.runId, created);
      state = created;
    }
    const current = state;
    current.lastActivityAt = this.now();
    current.queue = current.queue
      .then(() => this.consume(current, chunk.chunk))
      .catch((error) =>
        this.report(error, { runId: current.run.runId, stage: "parse" }),
      );
  }

  /** True when a live tool activity message may exist for the conversation. */
  tracksConversation(conversationId: string): boolean {
    for (const state of this.runs.values())
      if (
        !state.inactive &&
        (state.targets === null ||
          state.outputs.some(
            (output) => output.target.conversationId === conversationId,
          ))
      )
        return true;
    return false;
  }

  /**
   * Called right before an agent reply is published to the conversation.
   * Waits (bounded) for an in-flight post so the list stays above the reply.
   * A silent (NO_REPLY) reply deletes the message instead, or hides it when
   * the provider cannot delete.
   */
  async settle(input: {
    conversationId: string;
    runId: string | null;
    silent: boolean;
  }): Promise<void> {
    for (const state of this.runs.values()) {
      if (input.runId && state.run.runId !== input.runId) continue;
      await withinTimeout(state.queue, SETTLE_WAIT_MS);
      for (const output of state.outputs) {
        if (output.target.conversationId !== input.conversationId) continue;
        if (!input.silent) {
          await withinTimeout(output.chain, SETTLE_WAIT_MS);
          continue;
        }
        output.closed = true;
        if (output.timer) clearTimeout(output.timer);
        output.timer = null;
        output.chain = output.chain.then(() => this.discard(output));
        await withinTimeout(output.chain, SETTLE_WAIT_MS);
      }
    }
  }

  /**
   * Test/shutdown helper: process queued chunks and send pending edits now,
   * ignoring the throttle.
   */
  async flush(): Promise<void> {
    for (const state of this.runs.values()) {
      await state.queue.catch(() => undefined);
      for (const output of state.outputs) {
        await output.chain.catch(() => undefined);
        if (output.timer) {
          clearTimeout(output.timer);
          output.timer = null;
          output.chain = output.chain.then(() => this.sendEdit(state, output));
          await output.chain.catch(() => undefined);
        }
      }
    }
  }

  dispose(): void {
    for (const state of this.runs.values())
      for (const output of state.outputs) {
        if (output.timer) clearTimeout(output.timer);
        output.timer = null;
        output.closed = true;
      }
    this.runs.clear();
  }

  private sweepIdleRuns() {
    const cutoff = this.now() - IDLE_RUN_TTL_MS;
    for (const [runId, state] of this.runs)
      if (
        state.lastActivityAt < cutoff &&
        state.outputs.every((output) => !output.timer && !output.posting)
      )
        this.runs.delete(runId);
  }

  private consume(state: RunState<T>, chunk: string) {
    if (state.inactive) {
      state.partial = "";
      return;
    }
    const text = state.partial + chunk;
    const rawLines = text.split("\n");
    state.partial = rawLines.pop() ?? "";
    // A pathological unterminated line is dropped rather than buffered.
    if (state.partial.length > MAX_PARTIAL_LINE_CHARS) state.partial = "";
    const added: string[] = [];
    const ts = new Date(this.now()).toISOString();
    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line.startsWith("{")) continue;
      let entries: TranscriptEntry[];
      try {
        entries = state.parser(line, ts);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.kind !== "tool_call") continue;
        const identity = entry.toolUseId;
        if (identity) {
          if (state.toolUseIds.has(identity)) continue;
          state.toolUseIds.add(identity);
        }
        added.push(
          describeToolCall(
            { name: entry.name, input: entry.input },
            safeSecretValues(state.secretValues),
          ),
        );
      }
    }
    if (added.length === 0) return;
    state.lines.push(...added);
    if (state.lines.length > MAX_KEPT_LINES)
      state.lines.splice(0, state.lines.length - MAX_KEPT_LINES);
    for (const output of state.outputs) this.schedule(state, output);
  }

  private schedule(state: RunState<T>, output: OutputState<T>) {
    if (output.closed) return;
    if (output.messageId === null) {
      if (output.posting) return;
      output.posting = true;
      output.chain = output.chain.then(() => this.sendPost(state, output));
      return;
    }
    if (output.timer) return;
    const delay = Math.max(
      0,
      output.lastSentAt + this.minEditIntervalMs - this.now(),
    );
    output.timer = setTimeout(() => {
      output.timer = null;
      output.chain = output.chain.then(() => this.sendEdit(state, output));
    }, delay);
    (output.timer as { unref?: () => void }).unref?.();
  }

  private async sendPost(state: RunState<T>, output: OutputState<T>) {
    try {
      if (output.closed) return;
      const text = renderToolActivity(state.lines, this.maxLines);
      output.messageId = await this.options.transport.post(output.target, text);
      output.sentText = text;
      output.lastSentAt = this.now();
      output.failures = 0;
    } catch (error) {
      this.fail(output, error, state, "post");
    } finally {
      output.posting = false;
    }
    // Lines that arrived while posting go out with the next throttled edit.
    // A failed post is retried by the next tool call, not in a loop.
    if (
      !output.closed &&
      output.messageId !== null &&
      renderToolActivity(state.lines, this.maxLines) !== output.sentText
    )
      this.schedule(state, output);
  }

  private async sendEdit(state: RunState<T>, output: OutputState<T>) {
    if (output.closed || output.messageId === null) return;
    const text = renderToolActivity(state.lines, this.maxLines);
    if (text === output.sentText) return;
    try {
      await this.options.transport.edit(output.target, output.messageId, text);
      output.sentText = text;
      output.failures = 0;
    } catch (error) {
      this.fail(output, error, state, "edit");
    } finally {
      output.lastSentAt = this.now();
    }
  }

  private async discard(output: OutputState<T>) {
    if (output.messageId === null) return;
    const messageId = output.messageId;
    try {
      if (await this.options.transport.remove(output.target, messageId)) {
        output.messageId = null;
        return;
      }
    } catch (error) {
      this.report(error, {
        conversationId: output.target.conversationId,
        stage: "delete",
      });
    }
    try {
      await this.options.transport.edit(
        output.target,
        messageId,
        TOOL_ACTIVITY_HIDDEN_TEXT,
      );
    } catch (error) {
      this.report(error, {
        conversationId: output.target.conversationId,
        stage: "hide",
      });
    }
  }

  private fail(
    output: OutputState<T>,
    error: unknown,
    state: RunState<T>,
    stage: string,
  ) {
    output.failures += 1;
    // Progress is optional: stop after repeated provider failures so a rate
    // limit or a missing permission cannot turn into a retry storm.
    if (output.failures >= MAX_FAILURES) output.closed = true;
    this.report(error, {
      runId: state.run.runId,
      conversationId: output.target.conversationId,
      stage,
    });
  }

  private report(error: unknown, context: Record<string, unknown>) {
    try {
      this.options.onError?.(error, context);
    } catch {
      // Reporting is best-effort as well.
    }
  }
}

function safeSecretValues(values: () => readonly string[]): readonly string[] {
  try {
    return values();
  } catch {
    return [];
  }
}
