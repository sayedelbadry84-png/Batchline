// Derives the whole accent token family (accent/accent-strong/accent-soft/
// accent-glow/on-accent, plus the body's ambient glow wash) from ONE hex
// color a plant picks as their brand color — see Site.accentColor. Every
// other token (--bg, --surface, --ink, ...) stays exactly as globals.css
// already defines it for light/dark; only the accent hue changes per
// site, everything else about the theme (glass panels, spacing, type)
// stays the same app-wide look.
//
// The light/dark adjustment ratios below aren't arbitrary — they're
// reverse-engineered from the app's own hand-tuned default amber
// (globals.css's --accent/--accent-strong/--accent-soft/--accent-glow,
// light and dark) so a custom color gets the same kind of treatment a
// human designer already gave amber, not a generic algorithm's guess.
export type AccentTokens = {
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentGlow: string;
  onAccent: string;
  glow1: string;
};
export type AccentTheme = { light: AccentTokens; dark: AccentTokens };

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.trim().replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = clamp(s, 0, 100) / 100, ln = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = ln - c / 2;
  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Standard YIQ perceived-brightness formula — cheap, well-established way
// to pick legible text (white or the app's own dark ink) against an
// arbitrary background color, since a hue-matched "on-accent" (like the
// other derived tokens get) doesn't reliably stay legible across the full
// range of colors a plant might pick as their brand color.
function pickOnAccent(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? "#1b2027" : "#ffffff";
}

// Renders the derived theme as a <style> block for the root layout (see
// src/app/layout.tsx) — every declaration is !important specifically so
// this always wins over globals.css's own (non-important) default amber
// regardless of where Next.js actually places this tag relative to the
// compiled stylesheet in <head>; relying on source order alone would be
// fragile since this app doesn't control that ordering directly. Mirrors
// globals.css's own three-state light/dark structure exactly (bare
// :root, the prefers-color-scheme media query, and the explicit
// [data-theme="dark"] override) so it stays correct through both the
// system-default and the user's own light/dark toggle.
export function accentThemeCss(theme: AccentTheme): string {
  const decls = (t: AccentTokens) =>
    `--accent:${t.accent} !important;--accent-strong:${t.accentStrong} !important;--accent-soft:${t.accentSoft} !important;--accent-glow:${t.accentGlow} !important;--on-accent:${t.onAccent} !important;--glow-1:${t.glow1} !important;`;
  return `:root{${decls(theme.light)}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${decls(theme.dark)}}}
:root[data-theme="dark"]{${decls(theme.dark)}}`;
}

export function deriveAccentTheme(baseHex: string): AccentTheme {
  const { h, s, l } = rgbToHsl(...(Object.values(hexToRgb(baseHex)) as [number, number, number]));

  const lightAccent = baseHex.toLowerCase();
  const lightStrong = hslToHex(h, clamp(s + 5, 0, 100), clamp(l - 9, 15, 88));
  const lightSoft = hslToHex(h, clamp(s + 8, 20, 100), clamp(l + 42, 80, 95));

  // Dark mode needs a brighter, more saturated version of the same hue to
  // read clearly against a near-black background — a color tuned to look
  // right on white (a plant's logo, typically) often looks muddy as-is on
  // dark backgrounds.
  const darkL = clamp(l + 5, 42, 68);
  const darkAccent = hslToHex(h, s, darkL);
  const darkStrong = hslToHex(h, clamp(s + 22, 0, 100), clamp(darkL + 15, 55, 82));

  return {
    light: {
      accent: lightAccent,
      accentStrong: lightStrong,
      accentSoft: lightSoft,
      accentGlow: hexToRgba(lightAccent, 0.32),
      onAccent: pickOnAccent(lightAccent),
      glow1: hexToRgba(lightAccent, 0.14),
    },
    dark: {
      accent: darkAccent,
      accentStrong: darkStrong,
      accentSoft: hexToRgba(darkAccent, 0.18),
      accentGlow: hexToRgba(darkAccent, 0.75),
      onAccent: pickOnAccent(darkStrong),
      glow1: hslToHex(h, clamp(s - 10, 0, 100), 15),
    },
  };
}
