import { expect, it } from "vitest";
import { outranks, parseTag, representative } from "./releases.js";

it("parses release lines, versions, and prereleases", () => {
  expect(parseTag("v8.3.3")).toEqual({ line: "v", version: [8, 3, 3], pre: undefined });
  expect(parseTag("pkg2@0.1.0")).toEqual({ line: "pkg2@", version: [0, 1, 0], pre: undefined });
  expect(parseTag("v2.0.0-rc.1")).toEqual({ line: "v", version: [2, 0, 0], pre: "rc.1" });
});

it("ranks releases: version within a line, stable over prerelease, recency across packages", () => {
  expect(outranks("v6.4.4", 3, "v8.3.3", 1)).toBe(false); // 늦은 백포트
  expect(outranks("v2.0.0", 2, "v2.0.0-rc.1", 1)).toBe(true); // 정식판이 rc를 대신한다
  expect(outranks("v3.0.0-beta.1", 2, "v2.5.0", 1)).toBe(false); // 프리릴리스는 정식판을 대신하지 않는다
  expect(outranks("v2.0.0-rc.2", 2, "v2.0.0-rc.1", 1)).toBe(true);
  expect(outranks("pkg1@5.0.0", 3, "pkg2@0.1.0", 2)).toBe(true); // 숫자가 든 패키지 이름도 다른 줄기
  expect(outranks("pkg1@5.0.0", 1, "pkg2@0.1.0", 2)).toBe(false);
  expect(outranks("2026.10.01", 2, "2026.09.30", 1)).toBe(true);
});

it("picks the representative release regardless of input order", () => {
  const rs = [["v6.4.4", 5], ["v8.3.3", 1], ["v9.0.0-beta.1", 6], ["v7.3.7", 4]] as const;
  expect(representative([...rs], (r) => r[0], (r) => r[1])?.[0]).toBe("v8.3.3");
  expect(representative([...rs].reverse(), (r) => r[0], (r) => r[1])?.[0]).toBe("v8.3.3");
});
