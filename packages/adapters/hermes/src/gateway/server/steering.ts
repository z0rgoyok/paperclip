import type { ServerAdapterModule } from "@paperclipai/adapter-utils";

type Input = Parameters<NonNullable<ServerAdapterModule["steering"]>["steer"]>[0];
type Binding = Pick<Input, "companyId" | "agentId" | "issueId">;
type Delivery = { text: string; accepted: Promise<boolean> };
const activeRuns = new Map<string, {
  binding: Binding;
  send: (text: string) => Promise<boolean>;
  deliveries: Map<string, Delivery>;
}>();

export const steering: NonNullable<ServerAdapterModule["steering"]> = {
  async steer(input) {
    const active = activeRuns.get(input.runId);
    if (!active || !input.text.trim() ||
        active.binding.companyId !== input.companyId ||
        active.binding.agentId !== input.agentId ||
        active.binding.issueId !== input.issueId) return false;
    const previous = active.deliveries.get(input.deliveryId);
    // Retain acknowledgement through admission retries; Hermes steer has no idempotency key.
    if (previous) return previous.text === input.text && await previous.accepted;
    const accepted = active.send(input.text).catch(() => false);
    active.deliveries.set(input.deliveryId, { text: input.text, accepted });
    return accepted;
  },
};

/** Capture resolved credentials in the live invocation; never reload mutable agent config. */
export function registerSteeringRun(runId: string, binding: Binding, send: (text: string) => Promise<boolean>) {
  const active = { binding, send, deliveries: new Map<string, Delivery>() };
  activeRuns.set(runId, active);
  return async (pendingSteer: unknown, replayAll = false): Promise<string[]> => {
    if (activeRuns.get(runId) === active) activeRuns.delete(runId);
    const pending = typeof pendingSteer === "string" ? pendingSteer : "";
    const undelivered: string[] = [];
    for (const [id, delivery] of active.deliveries) {
      if (await delivery.accepted && (replayAll || pending.includes(delivery.text))) undelivered.push(id);
    }
    return undelivered;
  };
}
