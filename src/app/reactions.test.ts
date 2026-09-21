import { describe, expect, it } from "vitest";
import { parseHnItem, parseXStatus } from "./reactions.js";

describe("reaction url parsing", () => {
  it("parses x and twitter status urls", () => {
    expect(parseXStatus("https://x.com/baejiun/status/1712345678901234567?s=20")).toEqual({ user: "baejiun", id: "1712345678901234567" });
    expect(parseXStatus("https://twitter.com/baejiun/status/17")).toEqual({ user: "baejiun", id: "17" });
    expect(parseXStatus("https://www.linkedin.com/posts/x")).toBeNull();
  });
  it("parses hn item urls", () => {
    expect(parseHnItem("https://news.ycombinator.com/item?id=49711544")).toBe("49711544");
  });
});
