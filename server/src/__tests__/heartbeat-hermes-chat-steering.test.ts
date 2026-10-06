import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { execute, steering } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import { createDurableChatWakeupRequest } from "../services/durable-chat-wakeup.js";
import { restorePendingAdapterSteering } from "../services/adapter-chat-steering.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

async function gateway(status: number, ack: Record<string, unknown> = { accepted: true, run_id: "hermes-live" }) {
  const inputs: string[] = [];
  const headers: Array<string | undefined> = [];
  let events: ServerResponse | undefined;
  let ready!: () => void;
  const listening = new Promise<void>(resolve => { ready = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/runs" && request.method === "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ run_id: "hermes-live" }));
    } else if (request.url === "/v1/runs/hermes-live/events") {
      events = response;
      response.setHeader("Content-Type", "text/event-stream");
      response.write(": connected\n\n");
      ready();
    } else if (request.url === "/v1/runs/hermes-live/steer") {
      let body = "";
      for await (const chunk of request) body += chunk;
      inputs.push(JSON.parse(body).input);
      headers.push(request.headers.authorization);
      if (status === 0) { request.socket.destroy(); return; }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(ack));
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "running" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No gateway address");
  return {
    url: `http://127.0.0.1:${address.port}`, inputs, headers, listening,
    finish(pending?: string) {
      events?.end(`event: run.completed\ndata: ${JSON.stringify({ status: "completed", pending_steer: pending })}\n\n`);
      events = undefined;
    },
    async close() {
      events?.end();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe("Hermes chat steering through heartbeat admission", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hermes-steering-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 0 });
    await tempDb.cleanup();
  });

  async function fixture(status = 200, ack?: Record<string, unknown>) {
    const http = await gateway(status, ack);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const config = { apiBaseUrl: http.url, apiKey: "fixture-key", pollIntervalMs: 10_000 };
    await db.insert(companies).values({ id: companyId, name: "Steering", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "chat-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Hermes", status: "running", adapterType: "hermes_gateway", adapterConfig: config });
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId,
      source: "automation", status: "claimed", requestedByActorType: "user", requestedByActorId: "chat-user" });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", invocationSource: "automation",
      runtimeMode: "legacy", startedAt: new Date(), responsibleUserId: "chat-user",
      wakeupRequestId,
      contextSnapshot: { issueId, originalField: "preserved" },
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "chat-user", executionRunId: runId });
    runningProcesses.set(runId, { child: {} as never, graceSec: 0, processGroupId: null });
    const execution = execute({
      runId, agent: { id: agentId, companyId, name: "Hermes", adapterType: "hermes_gateway", adapterConfig: config },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config, context: { issueId }, onLog: async () => {},
    });
    await http.listening;
    const request = async (body: string, contextPatch: Record<string, unknown> = {}) => {
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "chat-user", body }).returning();
      const durable = createDurableChatWakeupRequest({
        id: randomUUID(), companyId, agentId, issueId, commentId: comment.id,
        requestedByActorType: "user", requestedByActorId: "chat-user", requestedAt: new Date(),
        authorize: async () => {},
      });
      const opts = {
        source: "automation" as const, triggerDetail: "system" as const, reason: "External chat message received",
        payload: { issueId, commentId: comment.id },
        contextSnapshot: { issueId, taskId: issueId, commentId: comment.id, wakeCommentId: comment.id, source: "chat:telegram", ...contextPatch },
        requestedByActorType: "user" as const, requestedByActorId: "chat-user", durableChatRequest: durable,
      };
      return { comment, durable, opts };
    };
    return {
      http, companyId, agentId, issueId, runId, request,
      heartbeat: heartbeatService(db, { runtimeEnv: {} }),
      async complete(pending?: string) {
        http.finish(pending);
        const result = await execution;
        await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: result.resultJson }).where(eq(heartbeatRuns.id, runId));
        return result;
      },
      async close() { http.finish(); await execution; runningProcesses.delete(runId); await http.close(); },
    };
  }

  it("steers into the current remote run and consumes one receipt despite redelivery", async () => {
    const f = await fixture();
    try {
      const r = await f.request("Please use the new requirements");
      expect((await f.heartbeat.wakeup(f.agentId, r.opts))?.id).toBe(f.runId);
      expect((await f.heartbeat.wakeup(f.agentId, r.opts))?.id).toBe(f.runId);
      expect(f.http.inputs).toHaveLength(1);
      expect(f.http.inputs[0]).toContain(r.comment.body);
      expect(f.http.headers).toEqual(["Bearer fixture-key"]);
      expect(await steering.steer({ runId: f.runId, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, deliveryId: r.durable.id, text: f.http.inputs[0] })).toBe(true);
      expect(f.http.inputs).toHaveLength(1);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.durable.id));
      expect(receipt).toMatchObject({ status: "coalesced", runId: f.runId });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.contextSnapshot).toMatchObject({ originalField: "preserved", wakeCommentIds: [r.comment.id] });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
      const result = await f.complete();
      expect(result.resultJson?.pendingSteeringDeliveryIds).toEqual([]);
      expect(await steering.steer({ runId: f.runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, deliveryId: randomUUID(), text: "late" })).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    [404, {}], [409, {}], [500, {}], [0, {}],
    [200, { accepted: false, run_id: "hermes-live" }],
    [200, { accepted: true, run_id: "different-run" }],
  ])("preserves normal deferred delivery on HTTP %s or invalid acknowledgement %j", async (status, ack) => {
    const f = await fixture(status, ack);
    try {
      const r = await f.request("Keep this message");
      expect(await f.heartbeat.wakeup(f.agentId, r.opts)).toBeNull();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.durable.id));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(receipt.payload?.adapterSteering).toBeUndefined();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.contextSnapshot?.wakeCommentIds).toBeUndefined();
    } finally { await f.close(); }
  });

  it("restores terminal leftovers to the original queue exactly once", async () => {
    const f = await fixture();
    try {
      const consumed = await f.request("Already consumed guidance");
      await f.heartbeat.wakeup(f.agentId, consumed.opts);
      const r = await f.request("Late guidance");
      await f.heartbeat.wakeup(f.agentId, r.opts);
      const result = await f.complete(f.http.inputs[1]);
      expect(result.resultJson?.pendingSteeringDeliveryIds).toEqual([r.durable.id]);
      await restorePendingAdapterSteering(db, f.companyId, f.runId);
      await restorePendingAdapterSteering(db, f.companyId, f.runId);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.durable.id));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.contextSnapshot?.wakeCommentIds).toEqual([consumed.comment.id]);
      expect((receipt.payload?._paperclipWakeContext as Record<string, unknown>)?.wakeCommentIds).toEqual([r.comment.id]);
    } finally { await f.close(); }
  });

  it("keeps a different requesting principal in the normal queue", async () => {
    const f = await fixture();
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" })
        .where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
      const r = await f.request("Another principal's message");
      expect(await f.heartbeat.wakeup(f.agentId, r.opts)).toBeNull();
      expect(f.http.inputs).toEqual([]);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.durable.id));
      expect(receipt.status).toBe("deferred_issue_execution");
    } finally { await f.close(); }
  });

  it("queues fresh-session input and rejects steering across company, agent or issue boundaries", async () => {
    const f = await fixture();
    try {
      const r = await f.request("Start fresh", { forceFreshSession: true });
      expect(await f.heartbeat.wakeup(f.agentId, r.opts)).toBeNull();
      const input = { runId: f.runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, deliveryId: randomUUID(), text: "wrong scope" };
      for (const field of ["companyId", "agentId", "issueId"] as const) {
        expect(await steering.steer({ ...input, [field]: randomUUID() })).toBe(false);
      }
      expect(f.http.inputs).toEqual([]);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(1);
    } finally { await f.close(); }
  });
});
