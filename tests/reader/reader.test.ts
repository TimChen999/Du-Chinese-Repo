/**
 * Tests for the reader page logic.
 *
 * Tests file hashing, reading state persistence, recent files management,
 * and settings load/save. Uses the mocked chrome.storage API from the
 * test setup.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getFileHash,
  loadReaderSettings,
  saveReadingState,
  loadReadingState,
  getRecentFiles,
  updateRecentFiles,
  openRecentFile,
  migrateThemeIfNeeded,
} from "../../src/reader/reader";
import { THEME_MIGRATION_FLAG } from "../../src/shared/theme";

vi.mock("../../src/reader/file-handle-store", () => ({
  saveFileHandle: vi.fn().mockResolvedValue(undefined),
  getFileHandle: vi.fn().mockResolvedValue(null),
  removeFileHandle: vi.fn().mockResolvedValue(undefined),
}));

import { getFileHandle as mockGetFileHandle } from "../../src/reader/file-handle-store";
import {
  DEFAULT_READER_SETTINGS,
  MAX_RECENT_FILES,
} from "../../src/reader/reader-types";
import type { ReadingState } from "../../src/reader/reader-types";

// ─── crypto.subtle mock ────────────────────────────────────────────

const mockDigest = vi.fn().mockImplementation(
  async (_algo: string, data: ArrayBuffer) => {
    const bytes = new Uint8Array(data);
    const hash = new Uint8Array(32);
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x6c62272e >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h1 ^= bytes[i];
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= bytes[i];
      h2 = Math.imul(h2, 0x5bd1e995) >>> 0;
      h2 = ((h2 ^ (h2 >>> 13)) >>> 0);
    }
    for (let i = 0; i < 32; i++) {
      const mix = (i < 16) ? h1 : h2;
      const shift = (i % 4) * 8;
      hash[i] = ((mix >>> shift) & 0xff) ^ ((h1 + h2 + i * 31) & 0xff);
    }
    return hash.buffer;
  },
);

Object.defineProperty(globalThis, "crypto", {
  value: {
    subtle: { digest: mockDigest },
  },
  writable: true,
});

// ─── Tests ─────────────────────────────────────────────────────────

describe("reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getFileHash()", () => {
    it("returns a hex string", async () => {
      const file = createMockFile("test.epub", 1024, 1000000);
      const hash = await getFileHash(file);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it("returns a 16-character hash", async () => {
      const file = createMockFile("test.epub", 1024, 1000000);
      const hash = await getFileHash(file);
      expect(hash).toHaveLength(16);
    });

    it("returns the same hash for the same file metadata", async () => {
      const file1 = createMockFile("test.epub", 1024, 1000000);
      const file2 = createMockFile("test.epub", 1024, 1000000);
      const hash1 = await getFileHash(file1);
      const hash2 = await getFileHash(file2);
      expect(hash1).toBe(hash2);
    });

    it("returns different hashes for different filenames", async () => {
      const file1 = createMockFile("book1.epub", 1024, 1000000);
      const file2 = createMockFile("book2.epub", 1024, 1000000);
      const hash1 = await getFileHash(file1);
      const hash2 = await getFileHash(file2);
      expect(hash1).not.toBe(hash2);
    });

    it("returns different hashes for different sizes", async () => {
      const file1 = createMockFile("test.epub", 1024, 1000000);
      const file2 = createMockFile("test.epub", 2048, 1000000);
      const hash1 = await getFileHash(file1);
      const hash2 = await getFileHash(file2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("loadReaderSettings()", () => {
    it("returns default settings when nothing is stored", async () => {
      chrome.storage.sync.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = {};
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const settings = await loadReaderSettings();
      expect(settings).toEqual(DEFAULT_READER_SETTINGS);
    });

    it("merges stored settings with defaults", async () => {
      chrome.storage.sync.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = { readerSettings: { fontSize: 22, theme: "dark" } };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const settings = await loadReaderSettings();
      expect(settings.fontSize).toBe(22);
      expect(settings.theme).toBe("dark");
      expect(settings.fontFamily).toBe(DEFAULT_READER_SETTINGS.fontFamily);
    });
  });

  describe("saveReadingState() / loadReadingState()", () => {
    it("round-trips a reading state", async () => {
      const stored: Record<string, any> = {};

      chrome.storage.local.set.mockImplementation(
        (items: Record<string, any>, callback?: Function) => {
          Object.assign(stored, items);
          if (callback) callback();
          return Promise.resolve();
        },
      );

      chrome.storage.local.get.mockImplementation(
        (keys: any, callback?: Function) => {
          const key = typeof keys === "string" ? keys : Object.keys(keys)[0];
          const result = { [key]: stored[key] };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const state = createReadingState("abc123");
      await saveReadingState(state);

      const loaded = await loadReadingState("abc123");
      expect(loaded).not.toBeNull();
      expect(loaded!.fileHash).toBe("abc123");
      expect(loaded!.title).toBe("Test Book");
    });

    it("returns null for unknown file hash", async () => {
      chrome.storage.local.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = {};
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const loaded = await loadReadingState("nonexistent");
      expect(loaded).toBeNull();
    });

    it("round-trips a state carrying a lastWordAnchor", async () => {
      const stored: Record<string, any> = {};
      chrome.storage.local.set.mockImplementation(
        (items: Record<string, any>, callback?: Function) => {
          Object.assign(stored, items);
          if (callback) callback();
          return Promise.resolve();
        },
      );
      chrome.storage.local.get.mockImplementation(
        (keys: any, callback?: Function) => {
          const key = typeof keys === "string" ? keys : Object.keys(keys)[0];
          const result = { [key]: stored[key] };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const state = createReadingState("anchored");
      state.lastWordAnchor = {
        word: "世界",
        contextBefore: "你好,",
        contextAfter: "。",
        payload: { kind: "dom", charOffset: 7 },
      };

      await saveReadingState(state);
      const loaded = await loadReadingState("anchored");
      expect(loaded?.lastWordAnchor?.word).toBe("世界");
      if (loaded?.lastWordAnchor?.payload.kind === "dom") {
        expect(loaded.lastWordAnchor.payload.charOffset).toBe(7);
      } else {
        throw new Error("expected dom payload");
      }
    });
  });

  describe("getRecentFiles()", () => {
    it("returns empty array when no recent files exist", async () => {
      chrome.storage.local.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = {};
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const recent = await getRecentFiles();
      expect(recent).toEqual([]);
    });

    it("returns stored recent files", async () => {
      const files = [createReadingState("a"), createReadingState("b")];

      chrome.storage.local.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = { reader_recent: files };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      const recent = await getRecentFiles();
      expect(recent).toHaveLength(2);
    });
  });

  describe("updateRecentFiles()", () => {
    it("adds a new entry to the front of the list", async () => {
      let stored: Record<string, any> = {
        reader_recent: [createReadingState("old")],
      };

      chrome.storage.local.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = { reader_recent: stored.reader_recent ?? [] };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      chrome.storage.local.set.mockImplementation(
        (items: Record<string, any>, callback?: Function) => {
          Object.assign(stored, items);
          if (callback) callback();
          return Promise.resolve();
        },
      );

      const newState = createReadingState("new");
      await updateRecentFiles(newState);

      expect(stored.reader_recent[0].fileHash).toBe("new");
      expect(stored.reader_recent).toHaveLength(2);
    });

    it("moves existing entry to front instead of duplicating", async () => {
      let stored: Record<string, any> = {
        reader_recent: [
          createReadingState("first"),
          createReadingState("second"),
        ],
      };

      chrome.storage.local.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = { reader_recent: stored.reader_recent ?? [] };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      chrome.storage.local.set.mockImplementation(
        (items: Record<string, any>, callback?: Function) => {
          Object.assign(stored, items);
          if (callback) callback();
          return Promise.resolve();
        },
      );

      const updated = createReadingState("second");
      updated.currentChapter = 5;
      await updateRecentFiles(updated);

      expect(stored.reader_recent).toHaveLength(2);
      expect(stored.reader_recent[0].fileHash).toBe("second");
      expect(stored.reader_recent[0].currentChapter).toBe(5);
    });

    it("caps the list at MAX_RECENT_FILES", async () => {
      const fullList = Array.from({ length: MAX_RECENT_FILES }, (_, i) =>
        createReadingState(`file-${i}`),
      );

      let stored: Record<string, any> = { reader_recent: fullList };

      chrome.storage.local.get.mockImplementation(
        (_keys: any, callback?: Function) => {
          const result = { reader_recent: stored.reader_recent ?? [] };
          if (callback) callback(result);
          return Promise.resolve(result);
        },
      );

      chrome.storage.local.set.mockImplementation(
        (items: Record<string, any>, callback?: Function) => {
          Object.assign(stored, items);
          if (callback) callback();
          return Promise.resolve();
        },
      );

      const overflow = createReadingState("overflow");
      await updateRecentFiles(overflow);

      expect(stored.reader_recent).toHaveLength(MAX_RECENT_FILES);
      expect(stored.reader_recent[0].fileHash).toBe("overflow");
    });
  });

  // ─── Theme migration ───────────────────────────────────────────
  //
  // The reader and the popup used to own independent `theme` storage
  // keys. Once they were unified onto the canonical
  // chrome.storage.sync.theme key, an existing user with
  // readerSettings.theme="dark" but no popup-side theme would have
  // perceived a silent reset to "auto" on first launch. The
  // migration promotes that value up so their preference survives.

  describe("migrateThemeIfNeeded()", () => {
    function buildStorage(initial: Record<string, any>) {
      const stored: Record<string, any> = { ...initial };
      chrome.storage.sync.get.mockImplementation((keys: any) => {
        if (Array.isArray(keys)) {
          const out: Record<string, any> = {};
          for (const k of keys) {
            if (k in stored) out[k] = stored[k];
          }
          return Promise.resolve(out);
        }
        if (typeof keys === "string") {
          return Promise.resolve(
            keys in stored ? { [keys]: stored[keys] } : {},
          );
        }
        return Promise.resolve({ ...stored });
      });
      chrome.storage.sync.set.mockImplementation((items: Record<string, any>) => {
        Object.assign(stored, items);
        return Promise.resolve();
      });
      return stored;
    }

    it("promotes a 'dark' reader theme into the shared key when shared is default", async () => {
      const stored = buildStorage({
        readerSettings: { theme: "dark", fontSize: 20 },
      });

      await migrateThemeIfNeeded();

      expect(stored.theme).toBe("dark");
      expect(stored.readerSettings.theme).toBe("auto");
      expect(stored.readerSettings.fontSize).toBe(20);
      expect(stored[THEME_MIGRATION_FLAG]).toBe(true);
    });

    it("promotes a 'light' reader theme when shared key is missing", async () => {
      const stored = buildStorage({
        readerSettings: { theme: "light" },
      });

      await migrateThemeIfNeeded();

      expect(stored.theme).toBe("light");
      expect(stored.readerSettings.theme).toBe("auto");
    });

    it("does not overwrite an explicit shared theme", async () => {
      const stored = buildStorage({
        theme: "light",
        readerSettings: { theme: "dark" },
      });

      await migrateThemeIfNeeded();

      // Shared theme already has user intent; reader value is left
      // alone, but the flag is still set so we don't run again.
      expect(stored.theme).toBe("light");
      expect(stored.readerSettings.theme).toBe("dark");
      expect(stored[THEME_MIGRATION_FLAG]).toBe(true);
    });

    it("promotes a 'sepia' reader theme into the shared key now that sepia is shared", async () => {
      const stored = buildStorage({
        readerSettings: { theme: "sepia" },
      });

      await migrateThemeIfNeeded();

      // Sepia used to be a reader-only override; it's now selectable
      // from the popup too, so the shared key is its rightful home.
      expect(stored.theme).toBe("sepia");
      expect(stored.readerSettings.theme).toBe("auto");
      expect(stored[THEME_MIGRATION_FLAG]).toBe(true);
    });

    it("is idempotent once the flag is set", async () => {
      const stored = buildStorage({
        [THEME_MIGRATION_FLAG]: true,
        readerSettings: { theme: "dark" },
      });

      await migrateThemeIfNeeded();
      await migrateThemeIfNeeded();

      // Reader theme is left at its original value because the flag
      // short-circuits any promotion logic.
      expect(stored.readerSettings.theme).toBe("dark");
      expect(stored.theme).toBeUndefined();
    });

    it("handles a brand-new install with no settings at all", async () => {
      const stored = buildStorage({});

      await migrateThemeIfNeeded();

      expect(stored[THEME_MIGRATION_FLAG]).toBe(true);
      expect(stored.theme).toBeUndefined();
      expect(stored.readerSettings).toBeUndefined();
    });
  });

  describe("openRecentFile()", () => {
    const mockEls = createMockElements();

    beforeEach(() => {
      vi.mocked(mockGetFileHandle).mockReset();
      vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    });

    it("shows alert when no handle is stored for the hash", async () => {
      vi.mocked(mockGetFileHandle).mockResolvedValue(null);

      const entry = createReadingState("missing-handle");
      await openRecentFile(entry, mockEls as any);

      expect(mockGetFileHandle).toHaveBeenCalledWith("missing-handle");
      expect(globalThis.alert).toHaveBeenCalledWith(
        expect.stringContaining("can no longer be opened"),
      );
    });

    it("calls getFileHandle with the correct fileHash", async () => {
      vi.mocked(mockGetFileHandle).mockResolvedValue(null);

      const entry = createReadingState("test-hash");
      await openRecentFile(entry, mockEls as any);

      expect(mockGetFileHandle).toHaveBeenCalledWith("test-hash");
    });

    it("requests permission when a handle is found", async () => {
      const mockHandle = {
        kind: "file" as const,
        name: "test.epub",
        getFile: vi.fn().mockResolvedValue(
          new File([new Uint8Array(10)], "test.epub", {
            type: "application/epub+zip",
            lastModified: 1000000,
          }),
        ),
        requestPermission: vi.fn().mockResolvedValue("denied" as PermissionState),
      };
      vi.mocked(mockGetFileHandle).mockResolvedValue(mockHandle as any);

      const entry = createReadingState("perm-test");
      await openRecentFile(entry, mockEls as any);

      expect(mockHandle.requestPermission).toHaveBeenCalledWith({ mode: "read" });
    });

    it("shows alert when permission is denied", async () => {
      const mockHandle = {
        kind: "file" as const,
        name: "test.epub",
        getFile: vi.fn(),
        requestPermission: vi.fn().mockResolvedValue("denied" as PermissionState),
      };
      vi.mocked(mockGetFileHandle).mockResolvedValue(mockHandle as any);

      const entry = createReadingState("denied-hash");
      await openRecentFile(entry, mockEls as any);

      expect(globalThis.alert).toHaveBeenCalledWith(
        expect.stringContaining("denied"),
      );
      expect(mockHandle.getFile).not.toHaveBeenCalled();
    });

    it("shows alert when requestPermission throws (file moved/deleted)", async () => {
      const mockHandle = {
        kind: "file" as const,
        name: "test.epub",
        getFile: vi.fn(),
        requestPermission: vi.fn().mockRejectedValue(new Error("not found")),
      };
      vi.mocked(mockGetFileHandle).mockResolvedValue(mockHandle as any);

      const entry = createReadingState("gone-hash");
      await openRecentFile(entry, mockEls as any);

      expect(globalThis.alert).toHaveBeenCalledWith(
        expect.stringContaining("moved or deleted"),
      );
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function createMockElements() {
  const div = () => document.createElement("div");
  const btn = () => document.createElement("button");
  const input = () => document.createElement("input");
  const select = () => document.createElement("select");
  return {
    tocToggle: btn(), tocSidebar: div(), tocList: div(),
    bookTitle: div(), bookAuthor: div(),
    settingsToggle: btn(), settingsPanel: div(), settingsClose: btn(),
    landing: div(), dropZone: div(), fileInput: input(),
    readerContent: div(), readerFooter: div(),
    prevBtn: btn(), nextBtn: btn(),
    progressBar: div(), chapterIndicator: div(),
    recentFiles: div(), recentList: div(),
    fontSizeSetting: input(), fontSizeValue: div(),
    fontFamilySetting: select(),
    lineSpacingSetting: input(), lineSpacingValue: div(),
    themeSetting: select(), readingModeSetting: select(),
    pinyinSetting: input(),
    bookmarkToggle: btn(), bookmarkMenu: div(),
    bookmarkAdd: btn(), bookmarkShow: btn(),
    bookmarkSidebar: div(), bookmarkList: div(),
    readerToast: div(),
  };
}

function createMockFile(
  name: string,
  size: number,
  lastModified: number,
): File {
  const content = new Uint8Array(size);
  const blob = new Blob([content]);
  return new File([blob], name, {
    type: "application/epub+zip",
    lastModified,
  });
}

function createReadingState(fileHash: string): ReadingState {
  return {
    fileHash,
    fileName: `${fileHash}.epub`,
    title: "Test Book",
    author: "Author",
    location: "epubcfi(/6/2)",
    currentChapter: 0,
    totalChapters: 10,
    lastOpened: Date.now(),
  };
}
