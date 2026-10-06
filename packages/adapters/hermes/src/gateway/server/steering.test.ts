import { describe, expect, it, vi } from "vitest";
import { registerSteeringRun, steering } from "./steering.js";

const binding = { companyId: "company", agentId: "agent", issueId: "issue" };
describe("live gateway steering ownership", () => {
  it("deduplicates concurrent admissions and clears ownership at the terminal boundary", async () => {
    const send = vi.fn(async () => true);
    const finish = registerSteeringRun("run", binding, send);
    const input = { ...binding, runId: "run", deliveryId: "delivery", text: "guidance" };
    expect(await Promise.all([steering.steer(input), steering.steer(input)])).toEqual([true, true]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await steering.steer({ ...input, text: "changed retry" })).toBe(false);
    expect(await finish("guidance")).toEqual(["delivery"]);
    expect(await steering.steer(input)).toBe(false);
  });

  it("restores accepted deliveries conservatively when final status cannot be read", async () => {
    const finish = registerSteeringRun("unavailable-status", binding, async () => true);
    await steering.steer({ ...binding, runId: "unavailable-status", deliveryId: "delivery", text: "guidance" });
    expect(await finish(null, true)).toEqual(["delivery"]);
  });

  it("does not claim rejected or failed input as accepted", async () => {
    const finish = registerSteeringRun("error", binding, async () => { throw new Error("transport"); });
    expect(await steering.steer({ ...binding, runId: "error", deliveryId: "delivery", text: "guidance" })).toBe(false);
    expect(await finish("guidance", true)).toEqual([]);
  });
});
