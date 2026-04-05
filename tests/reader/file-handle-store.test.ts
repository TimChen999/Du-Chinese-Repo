/**
 * Tests for the IndexedDB file-handle persistence layer.
 *
 * Uses a manual IndexedDB mock because fake-indexeddb cannot
 * structured-clone FileSystemFileHandle objects (which real Chrome
 * can). The mock simulates the IDB transaction lifecycle that
 * file-handle-store.ts depends on.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── IndexedDB mock ────────────────────────────────────────────────

let store: Map<string, unknown>;

function createMockIDB() {
  store = new Map();

  const mockObjectStore = (mode: string) => ({
    put: (value: unknown, key: string) => {
      store.set(key, value);
      return { onsuccess: null, onerror: null };
    },
    get: (key: string) => {
      const result = store.get(key) ?? undefined;
      const req = { result, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
    delete: (key: string) => {
      store.delete(key);
      return { onsuccess: null, onerror: null };
    },
  });

  const mockTransaction = (mode: string) => {
    const tx = {
      objectStore: () => mockObjectStore(mode),
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      error: null,
    };
    queueMicrotask(() => tx.oncomplete?.());
    return tx;
  };

  const mockDB = {
    transaction: (_storeName: string, mode: string) => mockTransaction(mode),
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    close: vi.fn(),
  };

  const mockOpen = {
    result: mockDB,
    onupgradeneeded: null as (() => void) | null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
    error: null,
  };

  vi.stubGlobal("indexedDB", {
    open: () => {
      queueMicrotask(() => mockOpen.onsuccess?.());
      return mockOpen;
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────

function createMockHandle(name: string): FileSystemFileHandle {
  return {
    kind: "file" as const,
    name,
    getFile: async () => new File([], name),
    requestPermission: async () => "granted" as PermissionState,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  createMockIDB();
});

describe("file-handle-store", () => {
  describe("saveFileHandle + getFileHandle", () => {
    it("round-trips a handle by fileHash", async () => {
      const { saveFileHandle, getFileHandle } = await import("../../src/reader/file-handle-store");
      const handle = createMockHandle("book.epub");
      await saveFileHandle("abc123", handle);

      const retrieved = await getFileHandle("abc123");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("book.epub");
    });

    it("returns null for an unknown key", async () => {
      const { getFileHandle } = await import("../../src/reader/file-handle-store");
      const result = await getFileHandle("nonexistent");
      expect(result).toBeNull();
    });

    it("overwrites an existing entry for the same key", async () => {
      const { saveFileHandle, getFileHandle } = await import("../../src/reader/file-handle-store");
      const first = createMockHandle("old.epub");
      const second = createMockHandle("new.epub");

      await saveFileHandle("hash1", first);
      await saveFileHandle("hash1", second);

      const retrieved = await getFileHandle("hash1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("new.epub");
    });
  });

  describe("removeFileHandle", () => {
    it("removes a previously stored handle", async () => {
      const { saveFileHandle, getFileHandle, removeFileHandle } = await import("../../src/reader/file-handle-store");
      const handle = createMockHandle("remove-me.epub");
      await saveFileHandle("del1", handle);

      await removeFileHandle("del1");

      const retrieved = await getFileHandle("del1");
      expect(retrieved).toBeNull();
    });

    it("does not throw when removing a nonexistent key", async () => {
      const { removeFileHandle } = await import("../../src/reader/file-handle-store");
      await expect(removeFileHandle("nope")).resolves.toBeUndefined();
    });
  });

  describe("multiple handles", () => {
    it("stores and retrieves handles independently", async () => {
      const { saveFileHandle, getFileHandle } = await import("../../src/reader/file-handle-store");
      await saveFileHandle("a", createMockHandle("book-a.epub"));
      await saveFileHandle("b", createMockHandle("book-b.epub"));
      await saveFileHandle("c", createMockHandle("book-c.epub"));

      expect((await getFileHandle("a"))!.name).toBe("book-a.epub");
      expect((await getFileHandle("b"))!.name).toBe("book-b.epub");
      expect((await getFileHandle("c"))!.name).toBe("book-c.epub");
    });

    it("removing one handle does not affect others", async () => {
      const { saveFileHandle, getFileHandle, removeFileHandle } = await import("../../src/reader/file-handle-store");
      await saveFileHandle("x", createMockHandle("x.epub"));
      await saveFileHandle("y", createMockHandle("y.epub"));

      await removeFileHandle("x");

      expect(await getFileHandle("x")).toBeNull();
      expect((await getFileHandle("y"))!.name).toBe("y.epub");
    });
  });
});
