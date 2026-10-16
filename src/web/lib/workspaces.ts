/** Display preference only. The server verifies the JWT and workspace membership. */
const PREFIX = "somun.workspace.v1:";
const selected = new Map<string, string>();
export function rememberWorkspace(accountId: string, ownerId: string): void {
  selected.set(accountId, ownerId);
  try {
    sessionStorage.setItem(PREFIX + accountId, ownerId);
  } catch {
    /* memory only */
  }
}
export function workspaceHeaders(accessJwt: string | null): Record<string, string> {
  if (!accessJwt) return {};
  try {
    const claims = JSON.parse(atob(accessJwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.iss !== "string" || typeof claims.sub !== "string") return {};
    const accountId = `${claims.iss}|${claims.sub}`;
    let owner = selected.get(accountId);
    try {
      owner ??= sessionStorage.getItem(PREFIX + accountId) ?? undefined;
    } catch {
      /* memory only */
    }
    return owner ? { "X-Somun-Workspace": owner } : {};
  } catch {
    return {};
  }
}
