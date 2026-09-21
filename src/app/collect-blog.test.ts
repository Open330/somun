import { describe, expect, it } from "vitest";
import { parseFeed } from "./collect-blog.js";

describe("parseFeed", () => {
  it("reads RSS 2.0", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>b</title><item><title><![CDATA[Hello & world]]></title><link>https://x.dev/p/1</link><pubDate>Mon, 15 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>First <b>post</b></p>]]></description></item></channel></rss>`;
    const [i] = parseFeed(xml);
    expect(i.title).toBe("Hello & world");
    expect(i.url).toBe("https://x.dev/p/1");
    expect(i.summary).toBe("First post");
    expect(new Date(i.publishedAt).toISOString()).toBe("2026-09-15T10:00:00.000Z");
  });
  it("reads Atom", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link rel="alternate" href="https://x.dev/a"/><published>2026-09-16T00:00:00Z</published><summary>s</summary></entry></feed>`;
    const [i] = parseFeed(xml);
    expect(i.url).toBe("https://x.dev/a");
    expect(i.summary).toBe("s");
  });
});
