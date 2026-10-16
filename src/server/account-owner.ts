import { getTableColumns, getTableName } from "drizzle-orm";
import { GenerationConflictError, type AppContext } from "../app/context.js";
import { schema } from "../infra/db/index.js";

/** Resolve verified subject aliases without moving or overwriting service data. */
export function createAccountOwnerResolver(ctx: AppContext) {
  const tables = Object.values(schema).flatMap(table => {
    const columns = getTableColumns(table);
    return "ownerId" in columns ? [{ name: getTableName(table), ownerColumn: columns.ownerId.name }] : [];
  });
  return (issuer: string, subject: string, aliases: readonly string[]): string => {
    const canonical = `${issuer}|${subject}`;
    if (!aliases.length) return canonical;
    const owners = [...new Set([canonical, ...aliases.map(id => `${issuer}|${id}`)])];
    const placeholders = owners.map(() => "?").join(",");
    const populated = new Set<string>();
    for (const table of tables) {
      const quoted = '"' + table.name.replaceAll('"', '""') + '"';
      const column = '"' + table.ownerColumn.replaceAll('"', '""') + '"';
      const rows = ctx.db.$client.prepare(`SELECT DISTINCT ${column} AS owner_id FROM ${quoted} WHERE ${column} IN (${placeholders})`).all(...owners) as { owner_id: string }[];
      for (const row of rows) populated.add(row.owner_id);
      if (populated.size > 1) throw new GenerationConflictError("Both linked accounts have separate Somun data. Their settings and drafts have been preserved; resolve the workspace conflict before continuing.");
    }
    return populated.values().next().value ?? canonical;
  };
}
