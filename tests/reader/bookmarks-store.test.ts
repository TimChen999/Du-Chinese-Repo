/**
 * Tests for the manual bookmark store.
 *
 * Verifies CRUD against a Map-backed chrome.storage.local mock (same
 * pattern as cache.test.ts and reader.test.ts), per-file isolation,
 * newest-first ordering, the MAX_BOOKMARKS_PER_FILE cap, and the
 * deriveLabel snippet helper used to render bookmark rows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  listBookmarks,
  addBookmark,
  removeBookmark,
  deriveLabel,
} from "../../src/reader/bookmarks-store";
import type { BookmarkAnchor } from "../../src/reader/reader-types";
import { MAX_BOOKMARKS_PER_FILE } from "../../src/reader/reader-types";

// ─── Storage mock ──────────────────────────────────────────────────

// vi.mocked() bridges the vitest-chrome-mv3 mock surface to the real
// @types/chrome signatures so .mockImplementation / .mockImplementationOnce
// type-check without `any`-casting every call.
const mockGet = vi.mocked(chrome.storage.local.get);
const mockSet = vi.mocked(chrome.storage.local.set);

function installStorageMock(): Map<string, unknown> {
  const stored = new Map<string, unknown>();
  mockGet.mockImplementation(((keys: any) => {
    const out: Record<string, unknown> = {};
    if (typeof keys === "string") {
      if (stored.has(keys)) out[keys] = stored.get(keys);
    } else if (Array.isArray(keys)) {
      for (const k of keys) {
        if (stored.has(k)) out[k] = stored.get(k);
      }
    }
    return Promise.resolve(out);
  }) as never);
  mockSet.mockImplementation(((items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) stored.set(k, v);
    return Promise.resolve();
  }) as never);
  return stored;
}

const sampleAnchor = (word = "世界"): BookmarkAnchor => ({
  word,
  contextBefore: "你好,",
  contextAfter: "。",
  payload: { kind: "dom", charOffset: 7 },
});

// ─── Tests ─────────────────────────────────────────────────────────

describe("bookmarks-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installStorageMock();
  });

  describe("listBookmarks()", () => {
    it("returns an empty array when the file has no bookmarks", async () => {
      expect(await listBookmarks("nonexistent")).toEqual([]);
    });

    it("returns an empty array for empty fileHash", async () => {
      expect(await listBookmarks("")).toEqual([]);
    });

    it("survives a malformed stored value", async () => {
      // Manually plant a non-array value to simulate storage corruption.
      mockGet.mockImplementationOnce((() =>
        Promise.resolve({ reader_bookmarks_x: "not an array" })) as never);
      expect(await listBookmarks("x")).toEqual([]);
    });
  });

  describe("addBookmark()", () => {
    it("returns a bookmark with id, createdAt, and derived label", async () => {
      const bm = await addBookmark("file1", sampleAnchor());
      expect(bm.id).toBeTruthy();
      expect(typeof bm.id).toBe("string");
      expect(bm.createdAt).toBeGreaterThan(0);
      expect(bm.label).toContain("世界");
      expect(bm.fileHash).toBe("file1");
    });

    it("uses an explicit label when provided", async () => {
      const bm = await addBookmark("file1", sampleAnchor(), "My label");
      expect(bm.label).toBe("My label");
    });

    it("falls back to deriveLabel when explicit label is whitespace", async () => {
      const bm = await addBookmark("file1", sampleAnchor(), "   ");
      expect(bm.label).toContain("世界");
    });

    it("round-trips through listBookmarks", async () => {
      const bm = await addBookmark("file1", sampleAnchor());
      const list = await listBookmarks("file1");
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(bm.id);
    });

    it("persists chapterIndex and chapterLabel when supplied", async () => {
      const bm = await addBookmark("file1", sampleAnchor(), undefined, {
        index: 4,
        label: "第五章",
      });
      expect(bm.chapterIndex).toBe(4);
      expect(bm.chapterLabel).toBe("第五章");
      const [restored] = await listBookmarks("file1");
      expect(restored.chapterIndex).toBe(4);
      expect(restored.chapterLabel).toBe("第五章");
    });

    it("omits chapter fields entirely when chapter info is absent", async () => {
      const bm = await addBookmark("file1", sampleAnchor());
      expect("chapterIndex" in bm).toBe(false);
      expect("chapterLabel" in bm).toBe(false);
    });
  });

  describe("ordering", () => {
    it("returns bookmarks newest-first", async () => {
      const a = await addBookmark("file1", sampleAnchor("一"));
      // Force a measurable createdAt gap without slowing the test.
      vi.useFakeTimers();
      vi.setSystemTime(a.createdAt + 1000);
      const b = await addBookmark("file1", sampleAnchor("二"));
      vi.setSystemTime(a.createdAt + 2000);
      const c = await addBookmark("file1", sampleAnchor("三"));
      vi.useRealTimers();

      const list = await listBookmarks("file1");
      expect(list.map((bm) => bm.id)).toEqual([c.id, b.id, a.id]);
    });
  });

  describe("removeBookmark()", () => {
    it("removes only the matching id", async () => {
      const a = await addBookmark("file1", sampleAnchor("一"));
      const b = await addBookmark("file1", sampleAnchor("二"));

      await removeBookmark("file1", a.id);
      const list = await listBookmarks("file1");
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(b.id);
    });

    it("is a no-op for an unknown id", async () => {
      const a = await addBookmark("file1", sampleAnchor());
      await removeBookmark("file1", "no-such-id");
      const list = await listBookmarks("file1");
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(a.id);
    });
  });

  describe("per-file isolation", () => {
    it("doesn't leak bookmarks across fileHash buckets", async () => {
      await addBookmark("fileA", sampleAnchor("一"));
      await addBookmark("fileB", sampleAnchor("二"));

      const a = await listBookmarks("fileA");
      const b = await listBookmarks("fileB");
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0].anchor.word).toBe("一");
      expect(b[0].anchor.word).toBe("二");
    });

    it("removeBookmark in one file leaves another untouched", async () => {
      const a = await addBookmark("fileA", sampleAnchor());
      await addBookmark("fileB", sampleAnchor());
      await removeBookmark("fileA", a.id);
      expect(await listBookmarks("fileA")).toEqual([]);
      expect(await listBookmarks("fileB")).toHaveLength(1);
    });
  });

  describe("MAX_BOOKMARKS_PER_FILE cap", () => {
    it("caps the list and drops the oldest entry", async () => {
      vi.useFakeTimers();
      const start = 1_700_000_000_000;
      vi.setSystemTime(start);
      // Fill to the cap, each with a unique createdAt so ordering is
      // deterministic.
      for (let i = 0; i < MAX_BOOKMARKS_PER_FILE; i++) {
        vi.setSystemTime(start + i);
        await addBookmark("file1", sampleAnchor(`w${i}`));
      }
      // Adding one more should evict the oldest.
      vi.setSystemTime(start + MAX_BOOKMARKS_PER_FILE);
      const overflow = await addBookmark("file1", sampleAnchor("overflow"));
      vi.useRealTimers();

      const list = await listBookmarks("file1");
      expect(list).toHaveLength(MAX_BOOKMARKS_PER_FILE);
      expect(list[0].id).toBe(overflow.id);
      // The oldest entry (w0) should have been evicted.
      const words = list.map((bm) => bm.anchor.word);
      expect(words).not.toContain("w0");
    });
  });

  describe("deriveLabel()", () => {
    it("wraps the word in brackets between context", () => {
      expect(deriveLabel(sampleAnchor("世界"))).toBe("你好,[世界]。");
    });

    it("truncates long contextBefore with leading ellipsis", () => {
      const long = "x".repeat(50);
      const label = deriveLabel({
        word: "Y",
        contextBefore: long,
        contextAfter: "",
        payload: { kind: "dom", charOffset: 0 },
      });
      expect(label.startsWith("\u2026")).toBe(true);
      expect(label).toContain("[Y]");
    });

    it("truncates long contextAfter with trailing ellipsis", () => {
      const long = "x".repeat(50);
      const label = deriveLabel({
        word: "Y",
        contextBefore: "",
        contextAfter: long,
        payload: { kind: "dom", charOffset: 0 },
      });
      expect(label.endsWith("\u2026")).toBe(true);
      expect(label).toContain("[Y]");
    });

    it("returns just context when word is empty", () => {
      expect(
        deriveLabel({
          word: "",
          contextBefore: "abc",
          contextAfter: "def",
          payload: { kind: "dom", charOffset: 0 },
        }),
      ).toBe("abcdef");
    });

    it("returns a placeholder when word and context are all empty", () => {
      expect(
        deriveLabel({
          word: "",
          contextBefore: "",
          contextAfter: "",
          payload: { kind: "dom", charOffset: 0 },
        }),
      ).toBe("(empty bookmark)");
    });

    it("collapses internal whitespace in context", () => {
      const label = deriveLabel({
        word: "Y",
        contextBefore: "a  b\nc",
        contextAfter: "",
        payload: { kind: "dom", charOffset: 0 },
      });
      expect(label).toBe("a b c[Y]");
    });
  });
});
