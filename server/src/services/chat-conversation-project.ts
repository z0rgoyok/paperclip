import { and, eq, isNull, notInArray } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";

type DbOrTransaction = Pick<Db, "select">;

/**
 * A chat conversation is grouped under a project only when its assigned agent
 * leads exactly one active project (not archived, completed or cancelled).
 * With none or several candidates the choice would be a guess, so the
 * conversation stays ungrouped.
 */
export async function resolveChatConversationProjectId(
  dbOrTx: DbOrTransaction,
  companyId: string,
  assignedAgentId: string,
): Promise<string | null> {
  const led = await dbOrTx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.companyId, companyId),
        eq(projects.leadAgentId, assignedAgentId),
        isNull(projects.archivedAt),
        notInArray(projects.status, ["completed", "cancelled"]),
      ),
    )
    .limit(2);
  return led.length === 1 ? led[0]!.id : null;
}
