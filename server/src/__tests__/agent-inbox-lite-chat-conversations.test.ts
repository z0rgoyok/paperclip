import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// An agent works its own queue, and that queue includes chat conversations.
// The default list hiding must not reach /agents/me/inbox-lite.

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]),
  listDependencyReadiness: vi.fn(async () => new Map()),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({ listActiveForIssues: vi.fn(async () => new Map()) }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/instance-settings.js")>()),
  resolveWorktreeRunExecutionActivationState: vi.fn(async () => ({ armed: false, cutoff: null })),
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({})),
    getExperimental: vi.fn(async () => ({})),
  }),
}));

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "agent", agentId: AGENT, companyId: COMPANY, source: "agent_key" };
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("GET /agents/me/inbox-lite", () => {
  it("asks for chat conversations so an agent keeps its own conversations", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ assigneeAgentId: AGENT, includeChatConversations: true }),
    );
  });
});
