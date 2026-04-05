import { describe, it, expect, beforeEach } from "vitest";
import {
  recordWords,
  getAllVocab,
  clearVocab,
  removeWord,
} from "../../src/background/vocab-store";
import { MAX_VOCAB_ENTRIES, VOCAB_STOP_WORDS } from "../../src/shared/constants";

// ─── In-Memory Storage Backend ──────────────────────────────────────
// vitest-chrome-mv3 provides bare vi.fn() stubs for chrome.storage.local,
// so we wire up a Map-backed implementation before each test.

let store: Map<string, unknown>;

function setupStorageMocks() {
  store = new Map();

  chrome.storage.local.get.mockImplementation(
    (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null) {
        const all: Record<string, unknown> = {};
        store.forEach((v, k) => (all[k] = v));
        return Promise.resolve(all);
      }
      const keyList = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object);
      const result: Record<string, unknown> = {};
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      return Promise.resolve(result);
    },
  );

  chrome.storage.local.set.mockImplementation(
    (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
      return Promise.resolve();
    },
  );

  chrome.storage.local.remove.mockImplementation(
    (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) store.delete(k);
      return Promise.resolve();
    },
  );

  chrome.storage.local.clear.mockImplementation(() => {
    store.clear();
    return Promise.resolve();
  });
}

const sampleWords = [
  { chars: "银行", pinyin: "yín háng", definition: "bank" },
  { chars: "工作", pinyin: "gōng zuò", definition: "to work; job" },
];

describe("vocab-store", () => {
  beforeEach(() => {
    setupStorageMocks();
  });

  describe("recordWords", () => {
    it("records new words with count 1", async () => {
      await recordWords(sampleWords);
      const vocab = await getAllVocab();

      expect(vocab).toHaveLength(2);
      const bank = vocab.find((v) => v.chars === "银行");
      expect(bank).toBeDefined();
      expect(bank!.count).toBe(1);
      expect(bank!.pinyin).toBe("yín háng");
      expect(bank!.definition).toBe("bank");
      expect(bank!.firstSeen).toBeGreaterThan(0);
      expect(bank!.lastSeen).toBeGreaterThan(0);
    });

    it("increments count on repeated encounter", async () => {
      await recordWords(sampleWords);
      await recordWords(sampleWords);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行");
      expect(bank!.count).toBe(2);
    });

    it("updates pinyin and definition on re-encounter", async () => {
      await recordWords([
        { chars: "行", pinyin: "xíng", definition: "to walk" },
      ]);
      await recordWords([
        { chars: "行", pinyin: "háng", definition: "row; line" },
      ]);

      const vocab = await getAllVocab();
      const entry = vocab.find((v) => v.chars === "行");
      expect(entry!.pinyin).toBe("háng");
      expect(entry!.definition).toBe("row; line");
      expect(entry!.count).toBe(2);
    });

    it("preserves firstSeen on re-encounter", async () => {
      await recordWords([
        { chars: "好", pinyin: "hǎo", definition: "good" },
      ]);
      const first = (await getAllVocab()).find((v) => v.chars === "好");
      const originalFirstSeen = first!.firstSeen;

      await recordWords([
        { chars: "好", pinyin: "hǎo", definition: "good; well" },
      ]);
      const updated = (await getAllVocab()).find((v) => v.chars === "好");
      expect(updated!.firstSeen).toBe(originalFirstSeen);
      expect(updated!.lastSeen).toBeGreaterThanOrEqual(originalFirstSeen);
    });

    it("handles empty word array", async () => {
      await recordWords([]);
      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(0);
    });
  });

  describe("getAllVocab", () => {
    it("returns empty array when no words recorded", async () => {
      const vocab = await getAllVocab();
      expect(vocab).toEqual([]);
    });

    it("returns all recorded words", async () => {
      await recordWords(sampleWords);
      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(2);
    });
  });

  describe("clearVocab", () => {
    it("removes all vocab entries", async () => {
      await recordWords(sampleWords);
      await clearVocab();
      const vocab = await getAllVocab();
      expect(vocab).toEqual([]);
    });

    it("does not throw when already empty", async () => {
      await expect(clearVocab()).resolves.not.toThrow();
    });
  });

  describe("eviction", () => {
    it("drops least-frequent entries when exceeding MAX_VOCAB_ENTRIES", async () => {
      const words = Array.from({ length: MAX_VOCAB_ENTRIES + 1 }, (_, i) => ({
        chars: `word${i}`,
        pinyin: `pinyin${i}`,
        definition: `def${i}`,
      }));
      await recordWords(words);

      const vocab = await getAllVocab();
      expect(vocab.length).toBeLessThanOrEqual(MAX_VOCAB_ENTRIES);
    });
  });

  describe("stop-word filtering", () => {
    it("does not record stop words", async () => {
      await recordWords([
        { chars: "的", pinyin: "de", definition: "possessive particle" },
        { chars: "银行", pinyin: "yín háng", definition: "bank" },
      ]);

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(1);
      expect(vocab[0].chars).toBe("银行");
    });

    it("filters all stop words from VOCAB_STOP_WORDS set", async () => {
      const stopWords = Array.from(VOCAB_STOP_WORDS).map((chars) => ({
        chars,
        pinyin: "test",
        definition: "test",
      }));
      await recordWords(stopWords);

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(0);
    });

    it("still records non-stop words alongside stop words", async () => {
      await recordWords([
        { chars: "的", pinyin: "de", definition: "particle" },
        { chars: "了", pinyin: "le", definition: "particle" },
        { chars: "学习", pinyin: "xué xí", definition: "to study" },
        { chars: "中文", pinyin: "zhōng wén", definition: "Chinese" },
      ]);

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(2);
      expect(vocab.map((v) => v.chars).sort()).toEqual(["中文", "学习"]);
    });
  });

  describe("removeWord", () => {
    it("removes a specific word leaving others intact", async () => {
      await recordWords(sampleWords);
      await removeWord("银行");

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(1);
      expect(vocab[0].chars).toBe("工作");
    });

    it("does not throw when removing a word that does not exist", async () => {
      await recordWords(sampleWords);
      await expect(removeWord("不存在")).resolves.not.toThrow();

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(2);
    });

    it("results in empty store after removing the only word", async () => {
      await recordWords([sampleWords[0]]);
      await removeWord("银行");

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(0);
    });
  });
});
