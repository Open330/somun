// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { rememberWorkspace, workspaceHeaders } from "./workspaces";
const jwt = (iss: string, sub: string) => `header.${btoa(JSON.stringify({ iss, sub }))}.signature`;
afterEach(() => sessionStorage.clear());
it("scopes preferences to issuer and account and leaves non-JWT auth alone", () => {
  rememberWorkspace("issuer|alice", "issuer|old-alice");
  expect(workspaceHeaders(jwt("issuer", "alice"))).toEqual({ "X-Somun-Workspace": "issuer|old-alice" });
  expect(workspaceHeaders(jwt("issuer", "bob"))).toEqual({});
  expect(workspaceHeaders(jwt("other", "alice"))).toEqual({});
  expect(workspaceHeaders(null)).toEqual({});
  expect(workspaceHeaders("shared-secret")).toEqual({});
});
it("restores the selected workspace after reload", () => {
  sessionStorage.setItem("somun.workspace.v1:issuer|reload-user", "issuer|old");
  expect(workspaceHeaders(jwt("issuer", "reload-user"))).toEqual({ "X-Somun-Workspace": "issuer|old" });
});
