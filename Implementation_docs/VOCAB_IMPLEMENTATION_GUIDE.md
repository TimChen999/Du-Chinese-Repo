# Encountered Words — Implementation Guide

This document breaks the [VOCAB_SPEC.md](VOCAB_SPEC.md) into **4 discrete implementation steps**, each with its own tests. Steps are ordered by dependency. The feature builds on top of the existing codebase produced by the main [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Dependency Graph](#dependency-graph)
- [Step 1: Vocab Store Module](#step-1-vocab-store-module)
- [Step 2: Wire Into Service Worker](#step-2-wire-into-service-worker)
- [Step 3: Popup Vocab Tab UI](#step-3-popup-vocab-tab-ui)
- [Step 4: Stop-Word Filtering](#step-4-stop-word-filtering)
- [Final Verification](#final-verification)

---

## Prerequisites

All prerequisites from the main [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) apply. Additionally, the following must already be implemented:

- **Step 3** (Service Worker) — `handleLLMPath()` in `src/background/service-worker.ts`
- **Step 5** (Caching Layer) — `src/background/cache.ts` and its integration into the service worker
- **Step 8** (Popup Settings UI) — `src/popup/popup.html`, `popup.ts`, `popup.css`

---

## Dependency Graph

```
Step 1: Vocab Store Module
  │
  ├──► Step 2: Wire Into Service Worker
  │
  ├──► Step 3: Popup Vocab Tab UI
  │
  └──► Step 4: Stop-Word Filtering (optional)
```

| Step | Depends on |
|------|-----------|
| 1 | Existing `types.ts`, `constants.ts` |
| 2 | Step 1, existing `service-worker.ts` |
| 3 | Step 1, existing `popup.html/ts/css` |
| 4 | Step 1, existing `constants.ts` |

---

## Step 1: Vocab Store Module

### Scope

Create the vocab persistence module, modeled on the existing `src/background/cache.ts`. It reads and writes vocab entries in `chrome.storage.local` under a single `vocabStore` key.

### Files to create

| File | Purpose |
|------|---------|
| `src/background/vocab-store.ts` | Record, retrieve, and clear vocab entries |
| `tests/background/vocab-store.test.ts` | Unit tests using `vitest-chrome-mv3` storage mock |

### Depends on

- `src/shared/types.ts` (`WordData`)
- `src/shared/constants.ts` (will import `MAX_VOCAB_ENTRIES` after Step 4, but start with a hardcoded cap)

### Detailed instructions

#### 1a. Add `VocabEntry` type to `src/shared/types.ts`

Add the following interface after the existing `WordData` interface:

```typescript
/**
 * A word recorded by the vocab tracker. Extends the core WordData fields
 * with frequency and timestamp metadata.
 * (VOCAB_SPEC.md Section 2 "Data Model")
 */
export interface VocabEntry {
  chars: string;
  pinyin: string;
  definition: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}
```

#### 1b. Add `MAX_VOCAB_ENTRIES` to `src/shared/constants.ts`

Add a new constant in the cache configuration section:

```typescript
// ─── Vocab Store Configuration ────────────────────────────────────
/** Maximum number of words to store in the vocab list. Least-frequent entries are dropped first. */
export const MAX_VOCAB_ENTRIES = 10_000;
```

#### 1c. Create `src/background/vocab-store.ts`

This module mirrors the patterns in `cache.ts` but with a different storage structure. All entries live under a single `vocabStore` key as a `Record<string, VocabEntry>`.

Export the following functions:

1. **`recordWords(words: Required<WordData>[]): Promise<void>`**
   - Reads the current `vocabStore` from `chrome.storage.local` (or initializes to `{}`).
   - For each word in `words`:
     - If the word's `chars` already exists, increment `count` and update `lastSeen`, `pinyin`, and `definition`.
     - If the word is new, create a `VocabEntry` with `count: 1`, `firstSeen: Date.now()`, `lastSeen: Date.now()`.
   - After processing all words, enforce `MAX_VOCAB_ENTRIES`: if the total count exceeds the cap, sort entries by `count` ascending and remove the lowest-frequency entries until the count is within the limit.
   - Write the updated record back to `chrome.storage.local`.

2. **`getAllVocab(): Promise<VocabEntry[]>`**
   - Reads the `vocabStore` from `chrome.storage.local`.
   - Returns `Object.values()` as an array.
   - Returns an empty array if no store exists.

3. **`clearVocab(): Promise<void>`**
   - Removes the `vocabStore` key from `chrome.storage.local`.

Key implementation details:
- Use a single read-modify-write pattern per `recordWords()` call. All words from one LLM response are batched into one storage write.
- The module header comment should reference `VOCAB_SPEC.md Section 4 "Storage Design"`.

### Test file: `tests/background/vocab-store.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordWords,
  getAllVocab,
  clearVocab,
} from "../../src/background/vocab-store";
import { MAX_VOCAB_ENTRIES } from "../../src/shared/constants";

const sampleWords = [
  { chars: "银行", pinyin: "yín háng", definition: "bank" },
  { chars: "工作", pinyin: "gōng zuò", definition: "to work; job" },
];

describe("vocab-store", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
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
      // Fill the store to capacity + 1
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
});
```

### Verification

```bash
npx vitest run tests/background/vocab-store.test.ts
```

All tests should pass. The `vitest-chrome-mv3` mock makes `chrome.storage.local` behave like a real in-memory store within each test.

---

## Step 2: Wire Into Service Worker

### Scope

Connect the vocab store to the existing LLM processing pipeline. Words are recorded on every successful LLM response and on every cache hit.

### Files to modify

| File | Change |
|------|--------|
| `src/background/service-worker.ts` | Import `recordWords`, call it after LLM response and cache hit |

### Depends on

- Step 1 (`vocab-store.ts`)
- Existing `service-worker.ts` (`handleLLMPath` function)

### Detailed instructions

#### 2a. Add import

At the top of `src/background/service-worker.ts`, add:

```typescript
import { recordWords } from "./vocab-store";
```

#### 2b. Record words on cache hit

In `handleLLMPath()`, after the cache hit branch sends the response to the content script (the `chrome.tabs.sendMessage` call inside the `if (cached)` block), add a `recordWords` call:

```typescript
if (cached) {
  chrome.tabs.sendMessage(tabId, {
    type: "PINYIN_RESPONSE_LLM",
    words: cached.words,
    translation: cached.translation,
  });
  recordWords(cached.words);   // <-- new
  return;
}
```

#### 2c. Record words on LLM response

In `handleLLMPath()`, after the successful LLM response branch saves to cache and sends the response, add a `recordWords` call:

```typescript
if (result) {
  await saveToCache(cacheKey, result);
  chrome.tabs.sendMessage(tabId, {
    type: "PINYIN_RESPONSE_LLM",
    words: result.words,
    translation: result.translation,
  });
  recordWords(result.words);   // <-- new
}
```

**Important:** `recordWords` is fire-and-forget — do not `await` it. Vocab recording should never block or delay the overlay response. If the storage write fails, the word is simply not recorded (no user-visible error).

### Test file: `tests/background/service-worker.test.ts` (additions)

Add the following tests to the existing service worker test file:

```typescript
import { recordWords } from "../../src/background/vocab-store";

vi.mock("../../src/background/vocab-store", () => ({
  recordWords: vi.fn(),
}));

describe("vocab recording", () => {
  it("calls recordWords after successful LLM response", async () => {
    // Set up a mock queryLLM that returns a valid result
    // Trigger handlePinyinRequest with LLM enabled and API key set
    // Assert recordWords was called with the LLM result words
    expect(recordWords).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ chars: expect.any(String) }),
      ]),
    );
  });

  it("calls recordWords on cache hit", async () => {
    // Pre-populate the cache with a known entry
    // Trigger handlePinyinRequest so handleLLMPath hits the cache
    // Assert recordWords was called with the cached words
    expect(recordWords).toHaveBeenCalled();
  });

  it("does not call recordWords when LLM is disabled", async () => {
    // Set settings.llmEnabled = false
    // Trigger handlePinyinRequest
    // Assert recordWords was NOT called
    expect(recordWords).not.toHaveBeenCalled();
  });
});
```

### Verification

```bash
npx vitest run tests/background/service-worker.test.ts
```

Existing service worker tests should still pass. New tests confirm vocab recording is wired correctly.

---

## Step 3: Popup Vocab Tab UI

### Scope

Add a tab bar to the existing popup and implement the Vocab tab that displays recorded words as a sorted list. No new HTML pages — everything lives inside the existing `popup.html`.

### Files to modify

| File | Change |
|------|--------|
| `src/popup/popup.html` | Add tab bar, vocab list section |
| `src/popup/popup.ts` | Tab switching logic, vocab loading and rendering |
| `src/popup/popup.css` | Tab bar and vocab list styles |

### Depends on

- Step 1 (`vocab-store.ts`)
- Existing popup files

### Detailed instructions

#### 3a. Update `src/popup/popup.html`

Add a tab bar below the `<h1>` and before the first `.form-group`. Wrap all existing form content in a `<div id="tab-settings">`. Add a new `<div id="tab-vocab" class="hidden">` after it.

The tab bar:

```html
<div class="tab-bar">
  <button class="tab-btn active" data-tab="settings">Settings</button>
  <button class="tab-btn" data-tab="vocab">Vocab</button>
</div>
```

The vocab tab content:

```html
<div id="tab-vocab" class="hidden">
  <div class="vocab-controls">
    <select id="vocab-sort">
      <option value="frequency">Most frequent</option>
      <option value="recent">Most recent</option>
    </select>
    <button type="button" id="clear-vocab">Clear List</button>
  </div>
  <div id="vocab-list"></div>
</div>
```

The existing form elements (everything between `<h1>` and the `<script>` tag, except the title itself) should be wrapped in:

```html
<div id="tab-settings">
  <!-- existing form groups, save button, and status div -->
</div>
```

#### 3b. Update `src/popup/popup.ts`

1. **Import** `getAllVocab` and `clearVocab` from the vocab store. Since the popup runs in the extension context, it can import background modules directly (they share the same bundled output).

2. **Add DOM references** to `getElements()`:

```typescript
tabButtons: document.querySelectorAll<HTMLButtonElement>(".tab-btn"),
tabSettings: document.getElementById("tab-settings") as HTMLDivElement,
tabVocab: document.getElementById("tab-vocab") as HTMLDivElement,
vocabSort: document.getElementById("vocab-sort") as HTMLSelectElement,
vocabList: document.getElementById("vocab-list") as HTMLDivElement,
clearVocabBtn: document.getElementById("clear-vocab") as HTMLButtonElement,
```

3. **Tab switching** — add event listeners to each `.tab-btn`:

```typescript
els.tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    const tab = btn.dataset.tab;
    els.tabSettings.classList.toggle("hidden", tab !== "settings");
    els.tabVocab.classList.toggle("hidden", tab !== "vocab");

    if (tab === "vocab") {
      renderVocabList(els);
    }
  });
});
```

4. **`renderVocabList(els)`** — async function that:
   - Calls `getAllVocab()` to get all entries.
   - Sorts them based on `els.vocabSort.value`:
     - `"frequency"` — descending by `count`
     - `"recent"` — descending by `lastSeen`
   - Clears `els.vocabList.innerHTML`.
   - If no entries, renders: `<div class="vocab-empty">No words recorded yet. Select Chinese text on any page to start building your list.</div>`
   - Otherwise, renders one `.vocab-row` per entry:

```html
<div class="vocab-row">
  <span class="vocab-chars">银行</span>
  <span class="vocab-pinyin">yín háng</span>
  <span class="vocab-def">bank</span>
  <span class="vocab-count">5</span>
</div>
```

5. **Sort change listener** — re-render the list when the sort dropdown changes:

```typescript
els.vocabSort.addEventListener("change", () => renderVocabList(els));
```

6. **Clear button** — calls `clearVocab()` after a `confirm()` prompt, then re-renders:

```typescript
els.clearVocabBtn.addEventListener("click", async () => {
  if (confirm("Clear all recorded words?")) {
    await clearVocab();
    renderVocabList(els);
  }
});
```

#### 3c. Update `src/popup/popup.css`

Add the following styles (both light and dark mode):

```css
/* ─── Tab bar ────────────────────────────────────────────────── */

.tab-bar {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  border-bottom: 1px solid #e5e7eb;
}

.tab-btn {
  flex: 1;
  padding: 8px;
  border: none;
  background: none;
  font-size: 13px;
  font-weight: 500;
  color: #6b7280;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tab-btn.active {
  color: #3b82f6;
  border-bottom-color: #3b82f6;
}

.tab-btn:hover:not(.active) {
  color: #374151;
}

/* ─── Vocab tab ──────────────────────────────────────────────── */

.vocab-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 8px;
}

.vocab-controls select {
  width: auto;
  flex: 1;
}

.vocab-controls button {
  padding: 4px 10px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #f9fafb;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  color: #374151;
}

.vocab-controls button:hover {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #991b1b;
}

.vocab-list {
  max-height: 320px;
  overflow-y: auto;
}

.vocab-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f3f4f6;
  font-size: 13px;
}

.vocab-chars {
  font-weight: 600;
  min-width: 48px;
}

.vocab-pinyin {
  color: #6b7280;
  min-width: 64px;
}

.vocab-def {
  flex: 1;
  color: #374151;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vocab-count {
  color: #9ca3af;
  font-size: 12px;
  min-width: 20px;
  text-align: right;
}

.vocab-empty {
  color: #9ca3af;
  font-size: 12px;
  text-align: center;
  padding: 24px 8px;
}
```

Dark mode additions (inside the existing `@media (prefers-color-scheme: dark)` block):

```css
.tab-bar {
  border-bottom-color: #374151;
}

.tab-btn {
  color: #9ca3af;
}

.tab-btn.active {
  color: #60a5fa;
  border-bottom-color: #60a5fa;
}

.tab-btn:hover:not(.active) {
  color: #d1d5db;
}

.vocab-controls button {
  background: #374151;
  border-color: #4b5563;
  color: #d1d5db;
}

.vocab-controls button:hover {
  background: #7f1d1d;
  border-color: #fca5a5;
  color: #fca5a5;
}

.vocab-row {
  border-bottom-color: #374151;
}

.vocab-pinyin {
  color: #9ca3af;
}

.vocab-def {
  color: #d1d5db;
}

.vocab-count {
  color: #6b7280;
}

.vocab-empty {
  color: #6b7280;
}
```

### Test file: `tests/popup/vocab-tab.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllVocab, clearVocab, recordWords } from "../../src/background/vocab-store";

vi.mock("../../src/background/vocab-store", () => ({
  getAllVocab: vi.fn(),
  clearVocab: vi.fn(),
  recordWords: vi.fn(),
}));

const sampleVocab = [
  { chars: "银行", pinyin: "yín háng", definition: "bank", count: 5, firstSeen: 1000, lastSeen: 5000 },
  { chars: "工作", pinyin: "gōng zuò", definition: "to work", count: 3, firstSeen: 2000, lastSeen: 4000 },
  { chars: "学生", pinyin: "xué shēng", definition: "student", count: 7, firstSeen: 500, lastSeen: 3000 },
];

describe("vocab tab", () => {
  describe("rendering", () => {
    it("displays all vocab entries", async () => {
      (getAllVocab as any).mockResolvedValue(sampleVocab);
      // Call renderVocabList, verify 3 .vocab-row elements exist
    });

    it("shows empty state when no words recorded", async () => {
      (getAllVocab as any).mockResolvedValue([]);
      // Call renderVocabList, verify .vocab-empty element is present
      // Verify text contains "No words recorded"
    });

    it("displays chars, pinyin, definition, and count in each row", async () => {
      (getAllVocab as any).mockResolvedValue([sampleVocab[0]]);
      // Call renderVocabList
      // Verify row contains "银行", "yín háng", "bank", "5"
    });
  });

  describe("sorting", () => {
    it("sorts by frequency descending by default", async () => {
      (getAllVocab as any).mockResolvedValue(sampleVocab);
      // Call renderVocabList with sort = "frequency"
      // Verify first row is 学生 (count 7), then 银行 (5), then 工作 (3)
    });

    it("sorts by most recent when selected", async () => {
      (getAllVocab as any).mockResolvedValue(sampleVocab);
      // Call renderVocabList with sort = "recent"
      // Verify first row is 银行 (lastSeen 5000), then 工作 (4000), then 学生 (3000)
    });
  });

  describe("clear button", () => {
    it("calls clearVocab and re-renders on confirm", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));
      (getAllVocab as any).mockResolvedValue([]);
      (clearVocab as any).mockResolvedValue(undefined);

      // Simulate click on clear button
      expect(clearVocab).toHaveBeenCalled();
    });

    it("does not clear when user cancels", async () => {
      vi.stubGlobal("confirm", vi.fn(() => false));

      // Simulate click on clear button
      expect(clearVocab).not.toHaveBeenCalled();
    });
  });

  describe("tab switching", () => {
    it("shows settings tab by default", () => {
      // Verify #tab-settings does not have .hidden class
      // Verify #tab-vocab has .hidden class
    });

    it("switches to vocab tab on click", () => {
      // Simulate click on vocab tab button
      // Verify #tab-settings has .hidden class
      // Verify #tab-vocab does not have .hidden class
    });

    it("switches back to settings tab", () => {
      // Click vocab tab, then click settings tab
      // Verify #tab-settings does not have .hidden class
    });
  });
});
```

### Verification

```bash
npx vitest run tests/popup/vocab-tab.test.ts
```

All tests should pass. Open the extension popup in Chrome to verify the tab bar renders and switching works visually.

---

## Step 4: Stop-Word Filtering

### Scope

Add a set of high-frequency function words that should be excluded from vocab recording. These are words every learner already knows (的, 了, 是, etc.) that would otherwise dominate the list.

### Files to modify

| File | Change |
|------|--------|
| `src/shared/constants.ts` | Add `VOCAB_STOP_WORDS` set |
| `src/background/vocab-store.ts` | Filter out stop words in `recordWords()` |
| `tests/background/vocab-store.test.ts` | Add stop-word filtering tests |

### Depends on

- Step 1 (`vocab-store.ts`)
- Existing `constants.ts`

### Detailed instructions

#### 4a. Add `VOCAB_STOP_WORDS` to `src/shared/constants.ts`

Add the following after the `MAX_VOCAB_ENTRIES` constant:

```typescript
/**
 * Common function words excluded from vocab recording.
 * These appear in nearly every sentence and would inflate the list
 * with words the user certainly already knows.
 * (VOCAB_SPEC.md Section 6 "Stop-Word Filtering")
 */
export const VOCAB_STOP_WORDS = new Set([
  "的", "了", "是", "在", "不", "我", "你", "他", "她", "它",
  "们", "这", "那", "也", "都", "就", "和", "有", "很", "会",
  "能", "要", "把", "被", "让", "给", "到", "从", "对", "为",
  "吗", "呢", "吧", "啊", "嗯",
]);
```

#### 4b. Update `recordWords()` in `src/background/vocab-store.ts`

Import `VOCAB_STOP_WORDS` from `constants.ts`. At the start of the word-processing loop, skip any word whose `chars` value is in the stop-word set:

```typescript
import { VOCAB_STOP_WORDS, MAX_VOCAB_ENTRIES } from "../shared/constants";

// Inside recordWords():
for (const word of words) {
  if (VOCAB_STOP_WORDS.has(word.chars)) continue;
  // ... existing upsert logic
}
```

### Test additions: `tests/background/vocab-store.test.ts`

Add the following tests to the existing test file:

```typescript
import { VOCAB_STOP_WORDS } from "../../src/shared/constants";

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
```

### Test additions: `tests/shared/constants.test.ts`

Add to the existing constants test file:

```typescript
import { VOCAB_STOP_WORDS, MAX_VOCAB_ENTRIES } from "../../src/shared/constants";

describe("vocab constants", () => {
  it("VOCAB_STOP_WORDS is a non-empty Set", () => {
    expect(VOCAB_STOP_WORDS).toBeInstanceOf(Set);
    expect(VOCAB_STOP_WORDS.size).toBeGreaterThan(0);
  });

  it("VOCAB_STOP_WORDS contains common function words", () => {
    expect(VOCAB_STOP_WORDS.has("的")).toBe(true);
    expect(VOCAB_STOP_WORDS.has("了")).toBe(true);
    expect(VOCAB_STOP_WORDS.has("是")).toBe(true);
  });

  it("MAX_VOCAB_ENTRIES is a positive number", () => {
    expect(MAX_VOCAB_ENTRIES).toBeGreaterThan(0);
  });
});
```

### Verification

```bash
npx vitest run tests/background/vocab-store.test.ts
npx vitest run tests/shared/constants.test.ts
```

All tests should pass.

---

## Final Verification

### 1. Run the full test suite

```bash
npm test
```

All existing tests plus the new vocab tests should pass.

### 2. Build

```bash
npm run build
```

Build should succeed with no errors.

### 3. Manual smoke test in Chrome

Load the unpacked extension from `dist/` in `chrome://extensions`, then:

| Test | Expected |
|------|----------|
| Select Chinese text on a page with LLM enabled | Overlay appears; no visible change to existing behavior |
| Open popup, click "Vocab" tab | Vocab tab shows list of encountered words |
| Check word from previous selection appears | Word is listed with count 1 |
| Select the same text again | Count increments to 2 |
| Select text containing 的, 了, 是 | Stop words do not appear in the vocab list |
| Change sort to "Most recent" | List reorders by last seen timestamp |
| Click "Clear List" and confirm | List empties, shows empty state message |
| Switch back to "Settings" tab | Settings form is intact and functional |

### 4. Verify no regressions

- Existing overlay behavior is unchanged
- Existing settings save/load works
- LLM responses and caching still function normally
- No new permissions in `manifest.json`
