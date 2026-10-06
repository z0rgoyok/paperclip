import { EventEmitter } from "node:events";

/**
 * In-process tap on direct-adapter run output (`codex exec --json`,
 * `claude --output-format stream-json`, ...). Heartbeat publishes every
 * sanitized stdout/stderr chunk exactly as it persists it to the run log;
 * observers (the chat tool activity relay) derive what they need from it.
 *
 * Observers run synchronously on the adapter's output path, so they must only
 * enqueue work. A throwing observer never affects the run.
 */
export interface RunOutputChunk {
  companyId: string;
  runId: string;
  agentId: string;
  issueId: string | null;
  adapterType: string;
  stream: "stdout" | "stderr";
  /** Already redacted the same way as the persisted run log. */
  chunk: string;
  /** Resolved values of the run's secret env bindings, for masking. */
  secretValues: () => readonly string[];
}

type RunOutputListener = (chunk: RunOutputChunk) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const CHUNK_EVENT = "chunk";

export function hasRunOutputObservers(): boolean {
  return emitter.listenerCount(CHUNK_EVENT) > 0;
}

export function publishRunOutputChunk(chunk: RunOutputChunk): void {
  for (const listener of emitter.listeners(CHUNK_EVENT) as RunOutputListener[]) {
    try {
      listener(chunk);
    } catch {
      // Observation is best-effort and must never fail the run.
    }
  }
}

export function subscribeRunOutputChunks(listener: RunOutputListener) {
  emitter.on(CHUNK_EVENT, listener);
  return () => {
    emitter.off(CHUNK_EVENT, listener);
  };
}
