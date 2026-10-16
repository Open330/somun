export type WorkspaceView = { ownerId: string; primary: boolean; hasData: boolean };
export type AccountWorkspaces = { accountId: string; ownerId: string; workspaces: WorkspaceView[] };
