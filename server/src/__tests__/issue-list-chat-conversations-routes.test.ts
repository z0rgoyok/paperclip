import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, issueRelations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { errorHandler } from "../middleware/index.js";
import { __clearIssueListResponseCacheForTests, issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("issue list routes: chat conversations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-chat-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    __clearIssueListResponseCacheForTests();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskId = randomUUID();
    const chatId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maya",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { id: taskId, companyId, createdByUserId: "local-board", title: "Task", status: "todo", priority: "medium", assigneeAgentId: agentId },
      { id: chatId, companyId, createdByUserId: "local-board", title: "Chat", status: "todo", priority: "medium", assigneeAgentId: agentId, originKind: "chat_channel", originId: `chat:${chatId}` },
    ]);
    return { companyId, agentId, taskId, chatId };
  }

  const boardActor = (companyId: string) => ({
    type: "board",
    userId: "local-board",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: true,
  });

  it("hides chat conversations from a board user unless asked", async () => {
    const f = await seed();
    const app = createApp(boardActor(f.companyId));
    const hidden = await request(app).get(`/api/companies/${f.companyId}/issues`).expect(200);
    expect(hidden.body.map((issue: { id: string }) => issue.id)).toEqual([f.taskId]);
    const shown = await request(app).get(`/api/companies/${f.companyId}/issues?includeChatConversations=true`).expect(200);
    expect(shown.body.map((issue: { id: string }) => issue.id).sort()).toEqual([f.taskId, f.chatId].sort());
  });

  it("excludes board Inbox chats before pagination and from counts, with personal and search list filters", async () => {
    const f = await seed();
    const app = createApp(boardActor(f.companyId));
    for (const personal of ["touchedByUserId=me", "inboxArchivedByUserId=me", ""]) {
      const res = await request(app).get(`/api/companies/${f.companyId}/issues?${personal}&excludeChatConversations=true&limit=1&sortField=updated&sortDir=desc`).expect(200);
      expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([f.taskId]);
    }
    const search = await request(app).get(`/api/companies/${f.companyId}/issues?q=Chat&excludeChatConversations=true`).expect(200);
    expect(search.body).toEqual([]);
    const service = issueService(db);
    expect(await service.count(f.companyId, { touchedByUserId: "local-board", excludeChatConversations: true })).toBe(1);
    const shown = await request(app).get(`/api/companies/${f.companyId}/issues?touchedByUserId=me&includeChatConversations=true`).expect(200);
    expect(shown.body.map((issue: { id: string }) => issue.id).sort()).toEqual([f.taskId, f.chatId].sort());
  });

  it("keeps blocked chat conversations in the Blocked list and count", async () => {
    const f = await seed();
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.chatId));
    const app = createApp(boardActor(f.companyId));
    const res = await request(app).get(`/api/companies/${f.companyId}/issues?attention=blocked&excludeChatConversations=true`).expect(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([f.chatId]);
    const count = await request(app).get(`/api/companies/${f.companyId}/issues/count?attention=blocked&excludeChatConversations=true`).expect(200);
    expect(count.body.count).toBe(1);
  });

  it("keeps conversation metadata in dependency and ancestor references", async () => {
    const f = await seed();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.chatId, relatedIssueId: f.taskId, type: "blocks" });
    const service = issueService(db);
    expect((await service.getRelationSummaries(f.taskId)).blockedBy[0]).toMatchObject({ id: f.chatId, originKind: "chat_channel" });
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ parentId: f.chatId }).where(eq(issues.id, f.taskId));
    expect((await service.getAncestors(f.taskId))[0]).toMatchObject({ id: f.chatId, originKind: "chat_channel" });
  });

  it("always includes chat conversations for an agent working its own queue", async () => {
    const f = await seed();
    const app = createApp({ type: "agent", agentId: f.agentId, companyId: f.companyId, source: "agent_key" });
    const res = await request(app).get(`/api/companies/${f.companyId}/issues?assigneeAgentId=${f.agentId}&excludeChatConversations=true`).expect(200);
    expect(res.body.map((issue: { id: string }) => issue.id).sort()).toEqual([f.taskId, f.chatId].sort());
  });
});
