import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentWakeupRequests, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DurableChatWakeupRequest } from "./durable-chat-wakeup.js";
import { queuedCommentIdsFromRunContext } from "./issue-queued-comment-queue.js";

/** Admission has authorized the durable chat request and locked its issue. */
export async function steerAdapterChatMessage(input: {
  tx: Db;
  adapter: ServerAdapterModule;
  request: DurableChatWakeupRequest;
  activeRunId: string;
  source: typeof agentWakeupRequests.$inferInsert.source;
  triggerDetail: typeof agentWakeupRequests.$inferInsert.triggerDetail;
  reason: string | null;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<typeof heartbeatRuns.$inferSelect | null> {
  const { tx, request, adapter } = input;
  if (!adapter.steering || request.failedRunRetry || input.context.forceFreshSession === true ||
      input.context.interactionId || input.context.conversationReset === true) return null;
  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.activeRunId), eq(heartbeatRuns.companyId, request.companyId),
    eq(heartbeatRuns.agentId, request.agentId), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.runtimeMode, "legacy"),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${request.issueId}`,
  )).for("update");
  if (!run || run.contextSnapshot?.interactionId) return null;
  // Preserve the existing chat coalescing rule: a different principal gets its own turn.
  if (!run.wakeupRequestId) return null;
  const [origin] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, request.companyId),
  ));
  if (origin?.requestedByActorType !== request.requestedByActorType ||
      origin?.requestedByActorId !== request.requestedByActorId) return null;
  const [comment] = await tx.select().from(issueComments).where(and(
    eq(issueComments.id, request.commentId), eq(issueComments.companyId, request.companyId),
    eq(issueComments.issueId, request.issueId), isNull(issueComments.deletedAt),
    isNull(issueComments.createdByRunId),
  ));
  if (!comment?.body.trim()) return null;
  let accepted = false;
  try {
    accepted = await adapter.steering.steer({
      runId: run.id, companyId: request.companyId, agentId: request.agentId,
      issueId: request.issueId, deliveryId: request.id,
      text: `[Paperclip chat delivery ${request.id}; comment ${comment.id}]\n${comment.body}`,
    });
  } catch {
    // The ordinary queue remains the durable owner on rejection, timeout or transport error.
  }
  if (!accepted) return null;
  const now = new Date();
  const contextSnapshot = {
    ...run.contextSnapshot,
    wakeCommentIds: [...new Set([...queuedCommentIdsFromRunContext(run.contextSnapshot), comment.id])],
  };
  const [updated] = await tx.update(heartbeatRuns).set({ contextSnapshot, updatedAt: now })
    .where(eq(heartbeatRuns.id, run.id)).returning();
  await tx.insert(agentWakeupRequests).values({
    id: request.id, companyId: request.companyId, agentId: request.agentId,
    source: input.source, triggerDetail: input.triggerDetail, reason: input.reason,
    payload: {
      ...input.payload, issueId: request.issueId,
      _paperclipWakeContext: input.context,
      adapterSteering: { runId: run.id, commentId: comment.id },
    },
    requestedAt: request.requestedAt, requestedByActorType: request.requestedByActorType,
    requestedByActorId: request.requestedByActorId, idempotencyKey: request.idempotencyKey,
    status: "coalesced", runId: run.id, finishedAt: now,
  });
  return updated ?? null;
}

/** Hermes returns accepted input left over at the terminal boundary. Restore its original receipts. */
export async function restorePendingAdapterSteering(db: Db, companyId: string, runId: string): Promise<void> {
  const [snapshot] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
  ));
  const ids = snapshot?.resultJson?.pendingSteeringDeliveryIds;
  const issueId = snapshot?.contextSnapshot?.issueId;
  if (!Array.isArray(ids) || !ids.length || typeof issueId !== "string") return;
  const deliveryIds = ids.filter((id): id is string => typeof id === "string");
  if (!deliveryIds.length) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from issues where id = ${issueId} and company_id = ${companyId} for update`);
    const receipts = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.runId, runId),
      eq(agentWakeupRequests.status, "coalesced"), inArray(agentWakeupRequests.id, deliveryIds),
      sql`${agentWakeupRequests.payload}->'adapterSteering'->>'runId' = ${runId}`,
    ));
    if (!receipts.length) return;
    const comments = new Set(receipts.map(receipt =>
      (receipt.payload?.adapterSteering as { commentId?: string } | undefined)?.commentId));
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    const context = { ...run.contextSnapshot };
    context.wakeCommentIds = queuedCommentIdsFromRunContext(context).filter(id => !comments.has(id));
    if (comments.has(String(context.wakeCommentId))) delete context.wakeCommentId;
    await tx.update(heartbeatRuns).set({ contextSnapshot: context, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await tx.update(agentWakeupRequests).set({
      status: "deferred_issue_execution", runId: null, finishedAt: null, updatedAt: new Date(),
    }).where(inArray(agentWakeupRequests.id, receipts.map(receipt => receipt.id)));
  });
}
