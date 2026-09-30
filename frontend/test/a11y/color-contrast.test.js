import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pairContrast, readThemes } from "./contrast.js";

const themes = readThemes();
const card = { token: "surface", over: "page-bg" };
const input = { token: "surface-muted", over: "page-bg" };

const textPairs = [
  ["body text on the page", "ink", "page-bg"],
  ["body text on a card", "ink", card],
  ["secondary text on the page", "muted", "page-bg"],
  ["secondary text on a card", "muted", card],
  ["placeholder on an input", "faint", input],
  ["input text on an input", "ink", input],
  ["eyebrow on the page", "subtle", "page-bg"],
  ["link on the page", "link", "page-bg"],
  ["error text on the page", "danger", "page-bg"],
  ["primary button label", "#ffffff", "control"],
  ["primary button label on hover", "#ffffff", "control-hover"],
  ["badge label", "#ffffff", "danger-fill"],
];

describe("design token contrast", () => {
  for (const theme of ["light", "dark"]) {
    for (const [label, foreground, background] of textPairs) {
      it(`${theme}: ${label} meets WCAG AA (4.5:1)`, () => {
        const ratio = pairContrast(themes[theme], foreground, background);
        assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1 is below 4.5:1`);
      });
    }

    it(`${theme}: focus ring meets non-text contrast (3:1)`, () => {
      const ratio = pairContrast(themes[theme], "brand", "page-bg");
      assert.ok(ratio >= 3, `${ratio.toFixed(2)}:1 is below 3:1`);
    });
  }

  it("light: role chip text meets WCAG AA", () => {
    const ratio = pairContrast(themes.light, "brand-strong", "brand-soft");
    assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1 is below 4.5:1`);
  });

  it("dark: role chip text meets WCAG AA", () => {
    const ratio = pairContrast(themes.dark, "brand", { token: "brand-soft", over: "page-bg" });
    assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1 is below 4.5:1`);
  });
});
