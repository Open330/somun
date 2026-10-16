import { getTableColumns, getTableName } from "drizzle-orm";
import { ForbiddenError, type AppContext } from "../app/context.js";
import { schema } from "../infra/db/index.js";
import type { AccountWorkspaces } from "../shared/workspaces.js";

/** Verified aliases grant access to separate workspaces; no content or settings are moved. */
export function createAccountOwnerResolver(ctx: AppContext) {
  const tables = Object.values(schema).flatMap(table => {
    const columns = getTableColumns(table);
    return "ownerId" in columns ? [{ name: getTableName(table), ownerColumn: columns.ownerId.name }] : [];
  });
  return (issuer: string, subject: string, aliases: readonly string[], selected?: string, describe = false): AccountWorkspaces => {
    const accountId = `${issuer}|${subject}`;
    const owners = [accountId, ...[...new Set(aliases.map(id => `${issuer}|${id}`))].filter(id => id !== accountId).sort()];
    if (selected && !owners.includes(selected)) throw new ForbiddenError("Workspace is not linked to this account");
    // Explicitly selected requests need no database discovery. /me describes every workspace.
    const populated = new Set<string>();
    if (describe || (!selected && owners.length > 1)) {
      const placeholders = owners.map(() => "?").join(",");
      for (const table of tables) {
        const quoted = '"' + table.name.replaceAll('"', '""') + '"';
        const column = '"' + table.ownerColumn.replaceAll('"', '""') + '"';
        const rows = ctx.db.$client.prepare(`SELECT DISTINCT ${column} AS owner_id FROM ${quoted} WHERE ${column} IN (${placeholders})`).all(...owners) as { owner_id: string }[];
        for (const row of rows) populated.add(row.owner_id);
      }
    }
    // Keep the sole populated workspace. Prefer existing legacy data even after the primary workspace gets its first write.
    const ownerId = selected || [...owners.slice(1), accountId].find(owner => populated.has(owner)) || accountId;
    return { accountId, ownerId, workspaces: describe ? owners.map(ownerId => ({ ownerId, primary: ownerId === accountId, hasData: populated.has(ownerId) })) : [] };
  };
}
