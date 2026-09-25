import { describe, expect, it } from "vitest";
import { trackLinks } from "./links.js";

describe("trackLinks", () => {
  const homepage = "https://somun.jiun.dev";

  it("tags links to the project's homepage with the channel", () => {
    expect(trackLinks("Try it: https://somun.jiun.dev/.", { channel: "x", homepage }))
      .toBe("Try it: https://somun.jiun.dev/?utm_source=x&utm_medium=social&utm_campaign=somun.");
    expect(trackLinks("https://www.somun.jiun.dev/docs?a=1", { channel: "linkedin", homepage: "https://www.somun.jiun.dev" }))
      .toBe("https://www.somun.jiun.dev/docs?a=1&utm_source=linkedin&utm_medium=social&utm_campaign=somun");
  });

  it("leaves GitHub, other hosts, and already-tagged links alone", () => {
    const text = "https://github.com/Open330/somun https://example.com https://somun.jiun.dev/?utm_source=mine";
    expect(trackLinks(text, { channel: "x", homepage })).toBe(text);
  });

  it("adds a campaign token only to App Store links that already carry a provider token", () => {
    expect(trackLinks("https://apps.apple.com/app/apple-store/id1?pt=123&mt=8", { channel: "threads" }))
      .toBe("https://apps.apple.com/app/apple-store/id1?pt=123&mt=8&ct=somun-threads");
    const plain = "https://apps.apple.com/app/id1";
    expect(trackLinks(plain, { channel: "x" })).toBe(plain);
  });

  it("does not touch community channels", () => {
    const text = "https://somun.jiun.dev/";
    expect(trackLinks(text, { channel: "show_hn", homepage })).toBe(text);
    expect(trackLinks(text, { channel: "show_gn", homepage })).toBe(text);
  });
});
