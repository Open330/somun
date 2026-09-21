import { describe, expect, it } from "vitest";
import { limitationsFrom } from "./collect.js";

describe("limitationsFrom", () => {
  it("skips an operational note in an IMPORTANT block", () => {
    const readme = "# x\n\n> [!IMPORTANT]\n> After changing `bootstrap.sh`, run `scripts/sync-gh-pages.sh --push`. The copy once went stale.\n\n## Usage\n";
    expect(limitationsFrom(readme)).toEqual([]);
  });
  it("keeps an IMPORTANT block that states a limitation", () => {
    const readme = "# x\n\n> [!WARNING]\n> Windows is not supported yet.\n\n## Usage\n";
    expect(limitationsFrom(readme)).toEqual(["Windows is not supported yet."]);
  });
  it("reads a Limitations section", () => {
    const readme = "# x\n\n## Limitations\n- Requires tmux 3.x\n- No Windows build\n\n## License\nMIT";
    expect(limitationsFrom(readme)).toEqual(["Requires tmux 3.x", "No Windows build"]);
  });
});
