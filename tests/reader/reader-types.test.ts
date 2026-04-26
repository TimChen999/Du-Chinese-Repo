/**
 * Tests for reader type definitions and constants.
 *
 * Validates that DEFAULT_READER_SETTINGS has the expected shape and
 * values, and that the exported constants are correct.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_READER_SETTINGS,
  MAX_RECENT_FILES,
  AUTOSAVE_INTERVAL_MS,
} from "../../src/reader/reader-types";
import type {
  FormatRenderer,
  BookMetadata,
  TocEntry,
  ReadingState,
  ReaderSettings,
  ReaderTheme,
} from "../../src/reader/reader-types";

describe("reader-types", () => {
  describe("DEFAULT_READER_SETTINGS", () => {
    it("has the correct default fontSize", () => {
      expect(DEFAULT_READER_SETTINGS.fontSize).toBe(18);
    });

    it("has the correct default fontFamily", () => {
      expect(DEFAULT_READER_SETTINGS.fontFamily).toBe("system");
    });

    it("has the correct default lineSpacing", () => {
      expect(DEFAULT_READER_SETTINGS.lineSpacing).toBe(1.8);
    });

    it("has the correct default theme", () => {
      expect(DEFAULT_READER_SETTINGS.theme).toBe("auto");
    });

    it("has the correct default readingMode", () => {
      expect(DEFAULT_READER_SETTINGS.readingMode).toBe("scroll");
    });

    it("satisfies the ReaderSettings interface", () => {
      const settings: ReaderSettings = DEFAULT_READER_SETTINGS;
      expect(settings).toBeDefined();
    });
  });

  describe("constants", () => {
    it("MAX_RECENT_FILES is 20", () => {
      expect(MAX_RECENT_FILES).toBe(20);
    });

    it("AUTOSAVE_INTERVAL_MS is 30 seconds", () => {
      expect(AUTOSAVE_INTERVAL_MS).toBe(30_000);
    });
  });

  describe("type shapes", () => {
    it("BookMetadata can be constructed with required fields", () => {
      const meta: BookMetadata = {
        title: "Test Book",
        author: "Author",
        toc: [],
        totalChapters: 5,
        currentChapter: 0,
      };
      expect(meta.title).toBe("Test Book");
      expect(meta.toc).toEqual([]);
    });

    it("BookMetadata accepts optional fields", () => {
      const meta: BookMetadata = {
        title: "Test",
        author: "A",
        language: "zh",
        coverUrl: "https://example.com/cover.jpg",
        toc: [],
        totalChapters: 1,
        currentChapter: 0,
      };
      expect(meta.language).toBe("zh");
      expect(meta.coverUrl).toBeDefined();
    });

    it("TocEntry supports nested children", () => {
      const entry: TocEntry = {
        label: "Chapter 1",
        href: "ch1.xhtml",
        level: 0,
        children: [
          { label: "Section 1.1", href: "ch1.xhtml#s1", level: 1 },
        ],
      };
      expect(entry.children).toHaveLength(1);
      expect(entry.children![0].label).toBe("Section 1.1");
    });

    it("ReadingState has all required fields", () => {
      const state: ReadingState = {
        fileHash: "abc123",
        fileName: "test.epub",
        title: "Test",
        author: "Author",
        location: "epubcfi(/6/2)",
        currentChapter: 2,
        totalChapters: 10,
        lastOpened: Date.now(),
      };
      expect(state.fileHash).toBe("abc123");
    });

    it("ReaderTheme union includes all expected values", () => {
      const themes: ReaderTheme[] = ["light", "dark", "sepia", "auto"];
      expect(themes).toHaveLength(4);
    });
  });
});
