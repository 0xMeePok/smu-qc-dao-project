import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = join(dirname(fileURLToPath(import.meta.url)), "../../src/styles.css");

function channel(value) {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function parseColor(value) {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    return [
      Number.parseInt(raw.slice(0, 2), 16),
      Number.parseInt(raw.slice(2, 4), 16),
      Number.parseInt(raw.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = value.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (!rgb) throw new Error(`Unsupported color: ${value}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] == null ? 1 : Number(rgb[4])];
}

function composite(foreground, background) {
  const alpha = foreground[3];
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
  ];
}

function extractBlock(css, selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${selector} block in styles.css`);
  let depth = 1;
  let index = start + marker.length;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") depth -= 1;
    index += 1;
  }
  const tokens = {};
  for (const match of css.slice(start + marker.length, index - 1).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

export function readThemes(css = readFileSync(STYLES, "utf8")) {
  const light = extractBlock(css, ":root");
  return { light, dark: { ...light, ...extractBlock(css, ':root[data-theme="dark"]') } };
}

function resolve(tokens, name) {
  const value = name.startsWith("#") ? name : tokens[name];
  if (!value) throw new Error(`Missing token --${name}`);
  return parseColor(value);
}

/**
 * `background` is a token name, a hex color, or `{ token, over }` when the
 * fill is translucent and has to be flattened onto another token first.
 */
export function pairContrast(tokens, foreground, background) {
  const fg = resolve(tokens, foreground);
  const bg = typeof background === "string"
    ? resolve(tokens, background)
    : composite(resolve(tokens, background.token), resolve(tokens, background.over));
  if (fg[3] < 1 || bg.length < 3) throw new Error("Foreground colors in contrast checks must be opaque");
  return contrastRatio(fg, bg.slice(0, 3));
}
