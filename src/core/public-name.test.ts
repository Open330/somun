import { expect, it } from "vitest";
import { preferredPublicName } from "./public-name.js";

it("uses the product's own title casing over a lowercase CLI name", () => {
  expect(preferredPublicName("tend", { siteName: "Tend" })).toBe("Tend");
  expect(preferredPublicName("tend", { readme: '<img src="assets/logo.svg" alt="Tend logo" width="300" />\n\n`tend attend`' })).toBe("Tend");
  expect(preferredPublicName("haejo", { readme: "# Haejo\n\nhaejo run" })).toBe("Haejo");
  expect(preferredPublicName("barshelf", { siteName: "BarShelf — menu bar" })).toBe("BarShelf");
});

it("keeps the given name without a title, or when the title spells something else", () => {
  expect(preferredPublicName("aas", { readme: "# aas\n\nAAS is short for agent account switcher." })).toBe("aas");
  expect(preferredPublicName("aas", {})).toBe("aas");
  expect(preferredPublicName("tend", { siteName: "Tender" })).toBe("tend");
  expect(preferredPublicName("oh-my-prompt", { readme: "# Oh My Prompt" })).toBe("oh-my-prompt");
});
