/**
 * Tests for the shared theme resolution helpers.
 *
 * These functions are the single source of truth for collapsing
 * "auto" via prefers-color-scheme and for routing the reader's
 * sepia-only override on top of the canonical shared theme. Every
 * other surface (popup, library shell, hub, reader) delegates here
 * so a single set of cases pins the behavior end-to-end.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveSharedTheme,
  resolveEffectiveTheme,
  partitionDropdownTheme,
  prefersOSDark,
  THEME_MIGRATION_FLAG,
} from "../../src/shared/theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSharedTheme", () => {
  it("passes 'light' through unchanged", () => {
    expect(resolveSharedTheme("light")).toBe("light");
  });

  it("passes 'dark' through unchanged", () => {
    expect(resolveSharedTheme("dark")).toBe("dark");
  });

  it("collapses 'auto' to 'light' when matchMedia is unavailable", () => {
    // jsdom default: window.matchMedia is undefined.
    expect(resolveSharedTheme("auto")).toBe("light");
  });

  it("collapses missing/undefined values via prefers-color-scheme", () => {
    expect(resolveSharedTheme(undefined)).toBe("light");
  });

  it("collapses 'auto' to 'dark' when prefers-color-scheme reports dark", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    expect(resolveSharedTheme("auto")).toBe("dark");
  });

  it("tolerates legacy sepia in the shared key (back-compat)", () => {
    // Earlier builds could leak sepia into the shared `theme` key.
    // The resolver passes it through rather than crashing or guessing.
    expect(resolveSharedTheme("sepia")).toBe("sepia");
  });

  it("falls back to 'light' for an unknown string", () => {
    expect(resolveSharedTheme("hot-pink")).toBe("light");
  });
});

describe("resolveEffectiveTheme", () => {
  it("uses sepia from readerSettings even when shared is light", () => {
    expect(resolveEffectiveTheme("sepia", "light")).toBe("sepia");
  });

  it("uses sepia from readerSettings even when shared is dark", () => {
    expect(resolveEffectiveTheme("sepia", "dark")).toBe("sepia");
  });

  it("ignores non-sepia readerSettings values and uses shared", () => {
    expect(resolveEffectiveTheme("light", "dark")).toBe("dark");
    expect(resolveEffectiveTheme("dark", "light")).toBe("light");
    expect(resolveEffectiveTheme("auto", "dark")).toBe("dark");
  });

  it("collapses shared 'auto' the same way as resolveSharedTheme", () => {
    expect(resolveEffectiveTheme("auto", "auto")).toBe("light");

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    expect(resolveEffectiveTheme("auto", "auto")).toBe("dark");
  });

  it("works when both readerTheme and sharedTheme are undefined", () => {
    expect(resolveEffectiveTheme(undefined, undefined)).toBe("light");
  });
});

describe("partitionDropdownTheme", () => {
  it("routes sepia to the shared key (sepia is now a shared theme)", () => {
    expect(partitionDropdownTheme("sepia")).toEqual({
      readerTheme: "auto",
      sharedTheme: "sepia",
    });
  });

  it("routes light to the shared key and clears the reader override", () => {
    expect(partitionDropdownTheme("light")).toEqual({
      readerTheme: "auto",
      sharedTheme: "light",
    });
  });

  it("routes dark to the shared key and clears the reader override", () => {
    expect(partitionDropdownTheme("dark")).toEqual({
      readerTheme: "auto",
      sharedTheme: "dark",
    });
  });

  it("routes auto to the shared key and clears the reader override", () => {
    expect(partitionDropdownTheme("auto")).toEqual({
      readerTheme: "auto",
      sharedTheme: "auto",
    });
  });

  it("falls back to a safe default for an unknown value", () => {
    // Defensive path so a stray HTML edit can't poison the shared store.
    expect(partitionDropdownTheme("octarine")).toEqual({
      readerTheme: "auto",
      sharedTheme: "auto",
    });
  });
});

describe("prefersOSDark", () => {
  it("returns false when matchMedia is unavailable", () => {
    expect(prefersOSDark()).toBe(false);
  });

  it("returns true when prefers-color-scheme: dark matches", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    expect(prefersOSDark()).toBe(true);
  });

  it("returns false when prefers-color-scheme: dark does NOT match", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia,
    );
    expect(prefersOSDark()).toBe(false);
  });
});

describe("THEME_MIGRATION_FLAG", () => {
  it("is a stable storage key string", () => {
    // Pinned so a typo in the migration code doesn't silently rerun
    // the migration on every launch.
    expect(THEME_MIGRATION_FLAG).toBe("themeMigratedToShared_v1");
  });
});
