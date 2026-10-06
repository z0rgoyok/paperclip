import { and, eq, isNull } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";

type DbOrTransaction = Pick<Db, "select">;

/**
 * A chat conversation belongs to a project only when its assigned agent leads
 * exactly one active project. With none or several candidates the choice would
 * be a guess, so the conversation stays project-less.
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
      ),
    )
    .limit(2);
  return led.length === 1 ? led[0]!.id : null;
}
