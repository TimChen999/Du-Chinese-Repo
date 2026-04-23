/**
 * Shared theme resolution shared by every surface (popup, library
 * shell, reader, hub, overlay).
 *
 * The canonical state lives in chrome.storage.sync.theme as one of
 * "light" | "dark" | "sepia" | "auto". Every surface reads that key
 * (with "auto" collapsing to light/dark via prefers-color-scheme)
 * so flipping the value in any UI propagates everywhere.
 *
 * readerSettings.theme is kept as a legacy storage field for
 * back-compat with builds where sepia was a reader-only override.
 * resolveEffectiveTheme() still honors it as a sepia override so
 * pre-migration data renders correctly, and migrateThemeIfNeeded()
 * (in src/reader/reader.ts) promotes any sepia value up to the
 * shared key on first launch.
 *
 * The functions in this module are stringly-typed on purpose so they
 * can be reused across modules without dragging the heavier
 * ExtensionSettings / ReaderSettings types (and their import chains)
 * into the popup or content script.
 */

/** Resolved theme value applied to body[data-theme]. */
export type EffectiveTheme = "light" | "dark" | "sepia";

/** Storage migration flag. Bumped if migration logic ever changes. */
export const THEME_MIGRATION_FLAG = "themeMigratedToShared_v1";

/**
 * True when the user's OS reports a dark color scheme. Defensive
 * against jsdom and other matchMedia-less environments so the popup
 * tests can keep running without stubbing matchMedia for every case.
 */
export function prefersOSDark(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Collapse the shared light/dark/auto theme to a concrete state.
 * "auto" follows prefers-color-scheme; explicit values pass through.
 * For resilience, also accepts "sepia" as a pass-through so legacy
 * data from earlier builds (where sepia could land in the shared
 * key) doesn't crash the popup or library shell.
 */
export function resolveSharedTheme(theme: string | undefined): EffectiveTheme {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  return prefersOSDark() ? "dark" : "light";
}

/**
 * Apply the reader's sepia override on top of the shared theme.
 * Used by the reader and the library shell so the body[data-theme]
 * value is identical regardless of which module wrote it.
 */
export function resolveEffectiveTheme(
  readerTheme: string | undefined,
  sharedTheme: string | undefined,
): EffectiveTheme {
  if (readerTheme === "sepia") return "sepia";
  return resolveSharedTheme(sharedTheme);
}

/**
 * Split a value coming from the reader's Theme dropdown into the two
 * storage destinations.
 *
 * All four choices (light, dark, sepia, auto) are canonical and go
 * to the shared `theme` key so the popup, in-page overlay, library,
 * hub, and reader stay in sync. The reader-only override field
 * (readerSettings.theme) is always cleared to "auto" so legacy data
 * doesn't fight the shared value the next time the resolver runs.
 */
export interface PartitionedTheme {
  /** Value to persist into readerSettings.theme. */
  readerTheme: "auto";
  /** Value to persist into the shared `theme` key. */
  sharedTheme: "light" | "dark" | "sepia" | "auto";
}

export function partitionDropdownTheme(picked: string): PartitionedTheme {
  if (
    picked === "light" ||
    picked === "dark" ||
    picked === "sepia" ||
    picked === "auto"
  ) {
    return { readerTheme: "auto", sharedTheme: picked };
  }
  return { readerTheme: "auto", sharedTheme: "auto" };
}
