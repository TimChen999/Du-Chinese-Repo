/**
 * Typography and theme tokens shared by every FormatRenderer.
 *
 * Lives in _shared/ so the EPUB renderer (which feeds these into
 * epub.js's `themes.override()` API for cross-iframe content) and
 * every DOM-based renderer (which writes them as inline CSS on its
 * content element) pull from the same source. Keeping a single
 * definition prevents the EPUB and non-EPUB code paths from drifting
 * apart on font stacks or theme colors.
 */

export const FONT_FAMILY_MAP: Record<string, string> = {
  "system": 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  "serif": 'Georgia, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  "sans-serif": 'system-ui, -apple-system, "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  "noto-sans": '"Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif',
  "noto-serif": '"Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif',
};

export const THEME_COLORS: Record<string, { bg: string; text: string }> = {
  light: { bg: "#ffffff", text: "#1a1a1a" },
  dark: { bg: "#1a1a2e", text: "#e2e8f0" },
  sepia: { bg: "#f4ecd8", text: "#5c4b37" },
};

export function resolveFontFamily(key: string): string {
  return FONT_FAMILY_MAP[key] ?? FONT_FAMILY_MAP["system"];
}

export function resolveThemeColors(
  theme: "light" | "dark" | "sepia" | "auto",
): { bg: string; text: string } {
  if (theme === "light" || theme === "dark" || theme === "sepia") {
    return THEME_COLORS[theme];
  }
  const prefersDark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return THEME_COLORS[prefersDark ? "dark" : "light"];
}
