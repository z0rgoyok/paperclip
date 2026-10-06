import { classifyChatPublicationError } from "./chat-publication-errors.js";

export const CHAT_TYPING_REFRESH_MS = 4_000;
export const CHAT_TYPING_SUCCESS_GRACE_MS = 60_000;
export const CHAT_TYPING_MAX_LIFETIME_MS = 60 * 60_000;

type TypingSource = { id: string; conversationId: string };
type TypingLane<T> = {
  sources: Map<string, T>;
  timer: ReturnType<typeof setInterval>;
  pending: Promise<void> | null;
  nextSendAt: number;
  retryUntil: number;
  expiresAt: number;
};

/** One serialized, best-effort typing heartbeat per admitted conversation. */
export class ChatTypingRelay<T extends TypingSource> {
  private readonly lanes = new Map<string, TypingLane<T>>();
  private disposed = false;

  constructor(
    private readonly options: {
      isActive: (source: T) => Promise<boolean>;
      send: (source: T) => Promise<void>;
      onError: (error: unknown) => void;
    },
  ) {}

  async start(source: T): Promise<void> {
    if (this.disposed) return;
    const existing = this.lanes.get(source.conversationId);
    if (existing) {
      existing.sources.set(source.id, source);
      return;
    }
    const lane: TypingLane<T> = {
      sources: new Map([[source.id, source]]),
      timer: setInterval(() => {
        void this.tick(source.conversationId);
      }, CHAT_TYPING_REFRESH_MS),
      pending: null,
      nextSendAt: 0,
      retryUntil: 0,
      expiresAt: Date.now() + CHAT_TYPING_MAX_LIFETIME_MS,
    };
    lane.timer.unref?.();
    this.lanes.set(source.conversationId, lane);
    await this.tick(source.conversationId);
  }

  private tick(conversationId: string, send = true): Promise<void> {
    const lane = this.lanes.get(conversationId);
    const tickStartedAt = Date.now();
    if (!lane) return Promise.resolve();
    if (tickStartedAt >= lane.expiresAt) {
      clearInterval(lane.timer);
      this.lanes.delete(conversationId);
      return Promise.resolve();
    }
    if (lane.pending) return lane.pending;
    const current = () =>
      !this.disposed && this.lanes.get(conversationId) === lane;
    lane.pending = (async () => {
      try {
        let active: T | undefined;
        for (const source of lane.sources.values()) {
          if (await this.options.isActive(source)) active = source;
          else lane.sources.delete(source.id);
        }
        if (!current()) return;
        if (!active || Date.now() >= lane.expiresAt) {
          clearInterval(lane.timer);
          this.lanes.delete(conversationId);
          return;
        }
        // Anchor cadence before awaited reads; variable check latency must
        // never turn a four-second interval into an eight-second interval.
        if (
          !send ||
          tickStartedAt < lane.nextSendAt ||
          Date.now() < lane.retryUntil
        )
          return;
        lane.nextSendAt = tickStartedAt + CHAT_TYPING_REFRESH_MS;
        await this.options.send(active);
      } catch (error) {
        const disposition = classifyChatPublicationError(error, 1);
        if (disposition.kind === "retry") {
          lane.retryUntil = Math.max(
            lane.retryUntil,
            Date.now() + disposition.retryAfterMs,
          );
        }
        this.options.onError(error);
      }
    })().finally(() => {
      lane.pending = null;
    });
    return lane.pending;
  }

  /** Recheck after publication without sending another typing action. */
  async settle(conversationId: string): Promise<void> {
    await this.lanes.get(conversationId)?.pending;
    await this.tick(conversationId, false);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.lanes.values()].map((lane) => lane.pending));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const lane of this.lanes.values()) clearInterval(lane.timer);
    await this.flush();
    this.lanes.clear();
  }
}
