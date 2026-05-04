import { describe, it, expect, beforeEach } from "vitest";
import {
  recordWords,
  getAllVocab,
  clearVocab,
  removeWord,
  removeExample,
  setExampleTranslation,
  updateFlashcardResult,
  importVocab,
  markWordConfident,
} from "../../src/background/vocab-store";
import {
  MAX_VOCAB_ENTRIES,
  MAX_VOCAB_EXAMPLES,
  VOCAB_STOP_WORDS,
} from "../../src/shared/constants";
import { getVocabBucket, SRS_CONFIDENT_INTERVAL_DAYS } from "../../src/shared/srs";
import type { VocabEntry, VocabExample } from "../../src/shared/types";
import { mock } from "../test-helpers";

// ─── In-Memory Storage Backend ──────────────────────────────────────
// vitest-chrome-mv3 provides bare vi.fn() stubs for chrome.storage.local,
// so we wire up a Map-backed implementation before each test.

let store: Map<string, unknown>;

function setupStorageMocks() {
  store = new Map();

  mock(chrome.storage.local.get).mockImplementation(
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

  mock(chrome.storage.local.set).mockImplementation(
    (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
      return Promise.resolve();
    },
  );

  mock(chrome.storage.local.remove).mockImplementation(
    (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) store.delete(k);
      return Promise.resolve();
    },
  );

  mock(chrome.storage.local.clear).mockImplementation(() => {
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

  describe("backward compatibility", () => {
    it("getAllVocab backfills new flashcard fields on old entries", async () => {
      await recordWords(sampleWords);
      const vocab = await getAllVocab();

      for (const entry of vocab) {
        expect(entry.wrongStreak).toBe(0);
        expect(entry.totalReviews).toBe(0);
        expect(entry.totalCorrect).toBe(0);
        expect(entry.intervalDays).toBe(0);
        expect(entry.nextDueAt).toBe(0);
      }
    });

    it("getAllVocab preserves existing flashcard fields", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", false);
      await updateFlashcardResult("银行", false);
      await updateFlashcardResult("银行", true);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.wrongStreak).toBe(0);
      expect(bank.totalReviews).toBe(3);
      expect(bank.totalCorrect).toBe(1);
    });
  });

  describe("updateFlashcardResult", () => {
    it("increments totalReviews and totalCorrect on correct", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", true);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.totalReviews).toBe(1);
      expect(bank.totalCorrect).toBe(1);
      expect(bank.wrongStreak).toBe(0);
    });

    it("increments totalReviews and wrongStreak on wrong", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", false);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.totalReviews).toBe(1);
      expect(bank.totalCorrect).toBe(0);
      expect(bank.wrongStreak).toBe(1);
    });

    it("resets wrongStreak to 0 on correct after wrong answers", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", false);
      await updateFlashcardResult("银行", false);
      await updateFlashcardResult("银行", true);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.wrongStreak).toBe(0);
      expect(bank.totalReviews).toBe(3);
      expect(bank.totalCorrect).toBe(1);
    });

    it("accumulates wrongStreak on consecutive wrong answers", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", false);
      await updateFlashcardResult("银行", false);
      await updateFlashcardResult("银行", false);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.wrongStreak).toBe(3);
    });

    it("is a no-op for a non-existent word", async () => {
      await recordWords(sampleWords);
      await expect(updateFlashcardResult("不存在", true)).resolves.not.toThrow();

      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(2);
    });

    it("updates only the targeted word", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", true);
      await updateFlashcardResult("银行", false);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      const work = vocab.find((v) => v.chars === "工作")!;

      expect(bank.totalReviews).toBe(2);
      expect(work.totalReviews).toBe(0);
    });

    it("schedules a future review on correct (interval > 0, nextDueAt in future)", async () => {
      await recordWords(sampleWords);
      const before = Date.now();
      await updateFlashcardResult("银行", true);

      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.intervalDays).toBeGreaterThan(0);
      expect(bank.nextDueAt).toBeGreaterThan(before);
    });

    it("doubles the interval on a second correct answer", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", true);
      const first = (await getAllVocab()).find((v) => v.chars === "银行")!;
      const firstInterval = first.intervalDays;

      await updateFlashcardResult("银行", true);
      const second = (await getAllVocab()).find((v) => v.chars === "银行")!;
      expect(second.intervalDays).toBe(firstInterval * 2);
    });

    it("resets interval to 0 on a wrong answer (card becomes due immediately)", async () => {
      await recordWords(sampleWords);
      await updateFlashcardResult("银行", true);
      await updateFlashcardResult("银行", true);
      const before = (await getAllVocab()).find((v) => v.chars === "银行")!;
      expect(before.intervalDays).toBeGreaterThan(0);

      await updateFlashcardResult("银行", false);
      const after = (await getAllVocab()).find((v) => v.chars === "银行")!;
      expect(after.intervalDays).toBe(0);
      expect(after.nextDueAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("markWordConfident", () => {
    it("creates a fresh entry pre-graduated to the confident bucket", async () => {
      await markWordConfident({
        chars: "清",
        pinyin: "qīng",
        definition: "clear",
      });

      const all = await getAllVocab();
      expect(all).toHaveLength(1);
      const entry = all[0];
      expect(entry.chars).toBe("清");
      expect(entry.intervalDays).toBe(SRS_CONFIDENT_INTERVAL_DAYS);
      expect(entry.totalReviews).toBe(1);
      expect(entry.totalCorrect).toBe(1);
      expect(entry.wrongStreak).toBe(0);
      expect(getVocabBucket(entry)).toBe("confident");
    });

    it("promotes an existing entry without resetting count or examples", async () => {
      await recordWords([{ chars: "清", pinyin: "qīng", definition: "clear" }], {
        sentence: "天气很清",
        capturedAt: Date.now(),
      });
      // bump count further so we can detect a reset
      await recordWords([{ chars: "清", pinyin: "qīng", definition: "clear" }]);

      const before = (await getAllVocab()).find((e) => e.chars === "清")!;
      expect(before.count).toBe(2);
      expect(before.examples?.length).toBe(1);
      expect(getVocabBucket(before)).toBe("not-reviewed");

      await markWordConfident({
        chars: "清",
        pinyin: "qīng",
        definition: "clear, pure",
      });

      const after = (await getAllVocab()).find((e) => e.chars === "清")!;
      expect(after.count).toBe(2);
      expect(after.examples?.length).toBe(1);
      expect(after.definition).toBe("clear, pure");
      expect(getVocabBucket(after)).toBe("confident");
    });

    it("ignores stop words", async () => {
      const stopWord = Array.from(VOCAB_STOP_WORDS)[0];
      await markWordConfident({
        chars: stopWord,
        pinyin: "x",
        definition: "y",
      });
      const all = await getAllVocab();
      expect(all.find((e) => e.chars === stopWord)).toBeUndefined();
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

  // ─── Example sentences ────────────────────────────────────────

  describe("examples on recordWords", () => {
    const exampleA: VocabExample = {
      sentence: "我昨天去银行取钱了。",
      capturedAt: 1700000000000,
    };
    const exampleB: VocabExample = {
      sentence: "这家银行很大。",
      capturedAt: 1700000001000,
    };
    const exampleC: VocabExample = {
      sentence: "他在银行工作。",
      capturedAt: 1700000002000,
    };

    it("attaches the example to a freshly recorded word", async () => {
      await recordWords([sampleWords[0]], exampleA);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(1);
      expect(bank.examples![0].sentence).toBe(exampleA.sentence);
    });

    it("appends a second example into the open slot", async () => {
      await recordWords([sampleWords[0]], exampleA);
      await recordWords([sampleWords[0]], exampleB);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(2);
      expect(bank.examples!.map((e) => e.sentence)).toEqual([
        exampleA.sentence,
        exampleB.sentence,
      ]);
    });

    it("drops a third capture when both slots are full (no auto-replace)", async () => {
      await recordWords([sampleWords[0]], exampleA);
      await recordWords([sampleWords[0]], exampleB);
      await recordWords([sampleWords[0]], exampleC);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(MAX_VOCAB_EXAMPLES);
      expect(bank.examples!.map((e) => e.sentence)).toEqual([
        exampleA.sentence,
        exampleB.sentence,
      ]);
    });

    it("does not duplicate an example with the same sentence", async () => {
      await recordWords([sampleWords[0]], exampleA);
      await recordWords([sampleWords[0]], { ...exampleA, capturedAt: 99999 });
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(1);
    });

    it("does not attach an example to a stop-word entry", async () => {
      await recordWords(
        [{ chars: "的", pinyin: "de", definition: "particle" }],
        exampleA,
      );
      const vocab = await getAllVocab();
      expect(vocab).toHaveLength(0);
    });

    it("only attaches the example to the first non-stop word in a batch", async () => {
      await recordWords(
        [
          { chars: "的", pinyin: "de", definition: "particle" },
          sampleWords[0],
          sampleWords[1],
        ],
        exampleA,
      );
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      const work = vocab.find((v) => v.chars === "工作")!;
      expect(bank.examples).toHaveLength(1);
      expect(work.examples ?? []).toHaveLength(0);
    });
  });

  describe("removeExample", () => {
    const exA: VocabExample = { sentence: "A 银行 句。", capturedAt: 1 };
    const exB: VocabExample = { sentence: "B 银行 句。", capturedAt: 2 };

    it("removes a single slot without touching the other example", async () => {
      await recordWords([sampleWords[0]], exA);
      await recordWords([sampleWords[0]], exB);
      await removeExample("银行", 0);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(1);
      expect(bank.examples![0].sentence).toBe(exB.sentence);
    });

    it("preserves all non-example fields on the entry", async () => {
      await recordWords([sampleWords[0]], exA);
      await updateFlashcardResult("银行", true);
      await removeExample("银行", 0);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples ?? []).toHaveLength(0);
      expect(bank.totalReviews).toBe(1);
      expect(bank.totalCorrect).toBe(1);
      expect(bank.pinyin).toBe("yín háng");
    });

    it("is a no-op for an unknown word", async () => {
      await recordWords(sampleWords);
      await expect(removeExample("不存在", 0)).resolves.not.toThrow();
    });

    it("is a no-op for an out-of-range index", async () => {
      await recordWords([sampleWords[0]], exA);
      await removeExample("银行", 5);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(1);
    });
  });

  describe("setExampleTranslation", () => {
    const exA: VocabExample = { sentence: "A 银行 句。", capturedAt: 1 };
    const exB: VocabExample = { sentence: "B 银行 句。", capturedAt: 2 };

    it("attaches a translation to the targeted example only", async () => {
      await recordWords([sampleWords[0]], exA);
      await recordWords([sampleWords[0]], exB);
      await setExampleTranslation("银行", 1, "Sentence B translated.");
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples![0].translation).toBeUndefined();
      expect(bank.examples![1].translation).toBe("Sentence B translated.");
    });

    it("overwrites an existing translation on the same slot", async () => {
      await recordWords([sampleWords[0]], exA);
      await setExampleTranslation("银行", 0, "first");
      await setExampleTranslation("银行", 0, "second");
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples![0].translation).toBe("second");
    });

    it("is a no-op for an unknown word", async () => {
      await recordWords(sampleWords);
      await expect(
        setExampleTranslation("不存在", 0, "x"),
      ).resolves.not.toThrow();
    });

    it("is a no-op for an out-of-range index", async () => {
      await recordWords([sampleWords[0]], exA);
      await setExampleTranslation("银行", 9, "x");
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples![0].translation).toBeUndefined();
    });
  });

  describe("importVocab merges examples", () => {
    function makeImported(
      chars: string,
      examples: VocabExample[],
    ): VocabEntry {
      return {
        chars,
        pinyin: "test",
        definition: "test",
        count: 1,
        firstSeen: 1,
        lastSeen: 2,
        wrongStreak: 0,
        totalReviews: 0,
        totalCorrect: 0,
        intervalDays: 0,
        nextDueAt: 0,
        examples,
      };
    }

    it("round-trips examples for a brand-new word", async () => {
      const ex: VocabExample = {
        sentence: "导入的句子。",
        translation: "Imported sentence.",
        capturedAt: 100,
      };
      await importVocab([makeImported("新词", [ex])]);
      const vocab = await getAllVocab();
      const entry = vocab.find((v) => v.chars === "新词")!;
      expect(entry.examples).toHaveLength(1);
      expect(entry.examples![0].translation).toBe("Imported sentence.");
    });

    it("dedupes by sentence when merging into an existing word", async () => {
      const existing: VocabExample = { sentence: "共享句。", capturedAt: 1 };
      await recordWords([sampleWords[0]], existing);
      await importVocab([
        makeImported("银行", [
          { sentence: "共享句。", translation: "from import", capturedAt: 9 },
          { sentence: "新句子。", capturedAt: 10 },
        ]),
      ]);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(2);
      const sentences = bank.examples!.map((e) => e.sentence);
      expect(sentences).toContain("共享句。");
      expect(sentences).toContain("新句子。");
      // Existing entry kept (no translation overwrite from import).
      const shared = bank.examples!.find((e) => e.sentence === "共享句。")!;
      expect(shared.translation).toBeUndefined();
    });

    it("caps merged examples at MAX_VOCAB_EXAMPLES", async () => {
      const existing: VocabExample = { sentence: "first.", capturedAt: 1 };
      await recordWords([sampleWords[0]], existing);
      await importVocab([
        makeImported("银行", [
          { sentence: "second.", capturedAt: 2 },
          { sentence: "third.", capturedAt: 3 },
          { sentence: "fourth.", capturedAt: 4 },
        ]),
      ]);
      const vocab = await getAllVocab();
      const bank = vocab.find((v) => v.chars === "银行")!;
      expect(bank.examples).toHaveLength(MAX_VOCAB_EXAMPLES);
      // Existing-first ordering -> "first." stays in slot 0.
      expect(bank.examples![0].sentence).toBe("first.");
    });
  });
});
