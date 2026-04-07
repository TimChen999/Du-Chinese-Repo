# Vocab Hub — Feature Specification

Adds a full-page "Study & Read" hub to the Pinyin Tool extension. The hub replaces the popup's "Open Reader" button with a richer destination that lets the user browse their saved vocabulary in a spacious layout, practice with simple flashcards that track right/wrong answers, and launch the EPUB reader — all from a single page.

This feature builds on the vocabulary tracking described in [VOCAB_SPEC.md](VOCAB_SPEC.md) and the reader page described in [READER_SPEC.md](READER_SPEC.md).

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Data Model Changes](#2-data-model-changes)
3. [Hub Page Structure](#3-hub-page-structure)
4. [Vocab List View](#4-vocab-list-view)
5. [Flashcard View](#5-flashcard-view)
6. [Flashcard Session Algorithm](#6-flashcard-session-algorithm)
7. [Storage Changes](#7-storage-changes)
8. [Popup Changes](#8-popup-changes)
9. [Build and Manifest Changes](#9-build-and-manifest-changes)
10. [File Change Summary](#10-file-change-summary)

---

## 1. Feature Overview

### What It Does

The popup currently has two top-level actions: "Select text from image" (OCR) and "Open Reader". The vocab list lives squeezed inside a 320px popup tab. This feature promotes vocabulary browsing and study to a full-page experience and makes the reader accessible from within it.

The interaction:

1. User clicks the extension icon to open the popup.
2. User clicks "Study & Read" (formerly "Open Reader").
3. A new tab opens with the vocab hub page.
4. The hub has two tabs: **Vocab List** and **Flashcards**, plus a header button to launch the EPUB reader.
5. In the Vocab List tab, the user sees all saved words in a full-width layout with large characters, pinyin, and definitions — plus muted metadata (seen count, last seen date).
6. In the Flashcards tab, the user picks a session size, then practices with flip-cards. Results are tracked per word.

### What It Does Not Do

- **No spaced repetition (SRS)** — there is no scheduling algorithm, no due dates, no interval calculations. Words are shuffled and prioritized by recent wrong answers, not by an SM-2 or similar algorithm. SRS may be added as a future feature.
- **No enriched word data** — the hub displays the same `chars`, `pinyin`, `definition` data that already exists. Stroke order, example sentences, and HSK levels are out of scope.
- **No export** — CSV or Anki deck export is not included in this version.
- **No separate settings** — the hub inherits the extension's existing theme setting (`auto` / `light` / `dark`) from `chrome.storage.sync`.

### Who It's For

The same target users defined in [SPEC.md](SPEC.md) Section 1 "Target Users" — learners who have been passively collecting vocabulary through the extension and now want an active way to review it without leaving the browser.

---

## 2. Data Model Changes

### Current VocabEntry

The existing `VocabEntry` in `src/shared/types.ts`:

```typescript
interface VocabEntry {
  chars: string;
  pinyin: string;
  definition: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}
```

### New Fields

Three fields are added to support flashcard tracking:

```typescript
interface VocabEntry {
  chars: string;
  pinyin: string;
  definition: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  wrongStreak: number;    // consecutive wrong answers (resets to 0 on correct)
  totalReviews: number;   // lifetime flashcard reviews for this word
  totalCorrect: number;   // lifetime correct answers for this word
}
```

| Field | Type | Default | Purpose |
|---|---|---|---|
| `wrongStreak` | `number` | `0` | Tracks consecutive incorrect answers. Resets to `0` when the user answers correctly. Words with `wrongStreak > 0` enter the priority pool for future sessions. |
| `totalReviews` | `number` | `0` | Lifetime count of flashcard reviews (correct + incorrect). |
| `totalCorrect` | `number` | `0` | Lifetime count of correct flashcard answers. Combined with `totalReviews`, gives an accuracy percentage. |

### Backward Compatibility

Existing vocab stores will not have these fields. All code that reads `VocabEntry` must treat missing fields as their defaults:

```typescript
const entry: VocabEntry = {
  wrongStreak: 0,
  totalReviews: 0,
  totalCorrect: 0,
  ...storedEntry,
};
```

This merge happens inside `getAllVocab()` so that every consumer receives fully-populated entries. No migration step is needed — old data is upgraded transparently on read.

---

## 3. Hub Page Structure

### New Files

| File | Purpose |
|---|---|
| `src/hub/hub.html` | HTML shell: header bar, tab bar, tab content areas |
| `src/hub/hub.ts` | Tab switching, vocab list rendering, flashcard logic, theme application |
| `src/hub/hub.css` | Full-page responsive styling for all hub views |

### Page Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  Header                                                              │
│  ┌────────────────────────────────────────────────┐  ┌─────────────┐ │
│  │  Pinyin Tool — Study & Read                    │  │ Open Reader │ │
│  └────────────────────────────────────────────────┘  └─────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│  Tab Bar                                                             │
│  [ Vocab List ]   [ Flashcards ]                                     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Tab Content Area                                                    │
│  (fills remaining viewport height, scrollable)                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Header

- Left: page title "Pinyin Tool — Study & Read".
- Right: an "Open Reader" button that opens `reader.html` in a new tab via `chrome.tabs.create()`. This is styled as a primary action button (solid blue, matching `#reader-btn` in the popup).

### Tab Bar

Two tabs, styled identically to the popup's `.tab-bar`:

- **Vocab List** (default active) — shows the full vocabulary list.
- **Flashcards** — shows the flashcard setup or active session.

### Theme

The hub reads the `theme` setting from `chrome.storage.sync` on load and applies a `data-theme` attribute to `<body>` — the same approach used by `reader.html`. Supported values: `light`, `dark`, `auto` (resolved via `prefers-color-scheme` media query).

---

## 4. Vocab List View

### Layout

The vocab list uses the full page width (max-width capped at ~720px, centered) instead of the popup's 320px constraint. Each word row has two visual tiers:

```
┌──────────────────────────────────────────────────────────────────┐
│  银行        yín háng        bank; financial institution         │
│  Seen 5 times · Last seen Apr 3, 2026                           │
├──────────────────────────────────────────────────────────────────┤
│  工作        gōng zuò        to work; job                       │
│  Seen 3 times · Last seen Apr 1, 2026                           │
├──────────────────────────────────────────────────────────────────┤
│  学生        xué shēng       student; pupil                     │
│  Seen 2 times · Last seen Mar 30, 2026                          │
└──────────────────────────────────────────────────────────────────┘
```

**Primary row** (full-size text):
- Characters — bold, ~18px
- Pinyin — muted color, ~14px
- Definition — regular color, fills remaining space, truncated with ellipsis if too long

**Secondary row** (smaller, muted):
- "Seen N times" from `count`
- "Last seen <date>" from `lastSeen`, formatted with `toLocaleDateString()`
- If the word has flashcard history: "Reviews: N · Accuracy: X%" from `totalReviews` and `totalCorrect`

### Controls

Above the list:

```
┌──────────────────────────────────────────────────────────────────┐
│  Sort: [ Most frequent ▼ ]                    [ Clear List ]     │
└──────────────────────────────────────────────────────────────────┘
```

- **Sort dropdown**: "Most frequent" (default, descending `count`), "Most recent" (descending `lastSeen`), "Alphabetical" (ascending `chars` by Unicode code point).
- **Clear List button**: same confirmation-then-wipe behavior as the popup's existing button.

### Word Detail Card

Clicking a word row opens a detail card overlay — the same modal pattern as the popup's `showVocabCard()`, but sized for the full page (max-width ~360px, centered):

```
┌──────────────────────────────────┐
│                              ×   │
│  银行                            │
│  yín háng                        │
│                                  │
│  bank; financial institution     │
│                                  │
│  Seen 5 times · Last: Apr 3     │
│  Reviews: 12 · Accuracy: 75%    │
│                                  │
│                      [ Delete ]  │
└──────────────────────────────────┘
```

The card shows the same data as the list row, plus flashcard stats if present. The "Delete" button calls `removeWord(chars)` and refreshes the list.

### Empty State

When no words have been recorded:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  No words saved yet.                                             │
│  Select Chinese text on any page to start building your list.    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Flashcard View

The flashcard view has three states: **setup**, **active session**, and **summary**.

### Setup Screen

Shown when no session is active:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Practice your vocabulary                                        │
│                                                                  │
│  How many cards?                                                 │
│  [ 10 ]  [ 20 ]  [ 50 ]  [ All ]                                │
│                                                                  │
│  42 words available                                              │
│                                                                  │
│                  [ Start ]                                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- Count buttons are mutually exclusive (radio-style). Default selection: `10`, or `All` if fewer than 10 words exist.
- "N words available" shows the total vocab count from `getAllVocab()`.
- If no words exist, the setup screen shows the same empty state as the vocab list tab and the Start button is disabled.

### Active Session — Card Display

```
┌──────────────────────────────────────────────────────────────────┐
│  Card 3 of 20                                              [×]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                                                                  │
│                          银行                                    │
│                                                                  │
│                                                                  │
│                       [ Flip ]                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- The card shows the Chinese characters in large text (~36px, bold, centered).
- Progress indicator "Card N of M" in the top-left.
- Close button `[×]` in the top-right ends the session early and goes to summary.
- "Flip" button (or press **Space** / **Enter**) reveals the answer.

### Active Session — After Flip

```
┌──────────────────────────────────────────────────────────────────┐
│  Card 3 of 20                                              [×]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                          银行                                    │
│                        yín háng                                  │
│                bank; financial institution                       │
│                                                                  │
│              [ Wrong ]            [ Right ]                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- After flipping, pinyin and definition appear below the characters.
- Two answer buttons: "Wrong" (red-tinted) and "Right" (green-tinted).
- Keyboard shortcuts: **Left arrow** or **1** = Wrong, **Right arrow** or **2** = Right.
- After answering, the next card appears automatically.

### Session Summary

Shown after the last card or when the user clicks `[×]`:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Session Complete                                                │
│                                                                  │
│  15 / 20 correct (75%)                                           │
│                                                                  │
│  Words to review:                                                │
│  · 银行  yín háng — bank                                        │
│  · 学生  xué shēng — student                                    │
│  · 工作  gōng zuò — to work                                     │
│  · 考试  kǎo shì — exam                                         │
│  · 医院  yī yuàn — hospital                                     │
│                                                                  │
│              [ Practice Again ]    [ Back to List ]              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- Score line: "N / M correct (X%)".
- "Words to review" lists every word the user marked Wrong in this session, showing chars, pinyin, and definition.
- "Practice Again" returns to the setup screen with the same count pre-selected.
- "Back to List" switches to the Vocab List tab.
- If all answers were correct, the "Words to review" section is replaced with a congratulatory message: "You got every word right!"

---

## 6. Flashcard Session Algorithm

### Pool Selection

When the user starts a session of size `N`:

1. Load all vocab entries via `getAllVocab()`.
2. Split into two pools:
   - **Wrong pool**: entries where `wrongStreak > 0`, sorted by `wrongStreak` descending (worst first).
   - **Normal pool**: entries where `wrongStreak === 0`, shuffled randomly.
3. Take up to `Math.ceil(N * 0.4)` entries from the wrong pool (40% priority). If the wrong pool has fewer entries, take all of them.
4. Fill the remaining slots from the normal pool.
5. Combine the two subsets and shuffle the final list.

This ensures the user practices words they've been getting wrong, without making the entire session feel like remedial work.

### Scoring

On each card answer:

- **Right**: `totalReviews += 1`, `totalCorrect += 1`, `wrongStreak = 0`.
- **Wrong**: `totalReviews += 1`, `wrongStreak += 1`.

Each answer is persisted immediately via a new `updateFlashcardResult()` function in `vocab-store.ts` (see [Section 7](#7-storage-changes)). This ensures that even if the user closes the tab mid-session, completed cards are already saved.

### Session State

The active session state is held in memory only (not persisted to storage):

```typescript
interface FlashcardSession {
  cards: VocabEntry[];     // ordered list for this session
  currentIndex: number;    // 0-based position
  results: ("right" | "wrong")[];  // parallel array, one per answered card
  isFlipped: boolean;      // whether the current card is showing the answer
}
```

If the user navigates away or closes the tab, the session is lost. This is intentional — flashcard sessions are short and stateless by design.

---

## 7. Storage Changes

### New Function: updateFlashcardResult

Added to `src/background/vocab-store.ts`:

```typescript
export async function updateFlashcardResult(
  chars: string,
  correct: boolean,
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = result[STORAGE_KEY] ?? {};
  const entry = store[chars];
  if (!entry) return;

  entry.totalReviews = (entry.totalReviews ?? 0) + 1;
  if (correct) {
    entry.totalCorrect = (entry.totalCorrect ?? 0) + 1;
    entry.wrongStreak = 0;
  } else {
    entry.wrongStreak = (entry.wrongStreak ?? 0) + 1;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}
```

The function uses `?? 0` fallbacks for each new field, matching the backward compatibility approach from [Section 2](#2-data-model-changes).

### Updated getAllVocab

The existing `getAllVocab()` function in `vocab-store.ts` is updated to backfill defaults for the new fields:

```typescript
export async function getAllVocab(): Promise<VocabEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord | undefined = result[STORAGE_KEY];
  if (!store) return [];
  return Object.values(store).map((entry) => ({
    wrongStreak: 0,
    totalReviews: 0,
    totalCorrect: 0,
    ...entry,
  }));
}
```

Placing the defaults before `...entry` ensures that existing stored values take precedence, while entries created before this feature get zeroes.

### New Constant

Added to `src/shared/constants.ts`:

```typescript
export const FLASHCARD_WRONG_POOL_RATIO = 0.4;
```

This controls the fraction of each flashcard session filled from the wrong-streak priority pool. Centralizing it here makes it easy to tune later.

---

## 8. Popup Changes

### Button Rename

In `src/popup/popup.html`, the existing reader button changes its label:

```html
<!-- Before -->
<button id="reader-btn">Open Reader</button>

<!-- After -->
<button id="reader-btn">Study & Read</button>
```

The element ID stays `reader-btn` to minimize churn in `popup.ts` and `popup.css`.

### URL Change

In `src/popup/popup.ts`, the click handler changes the target URL:

```typescript
// Before
els.readerBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("src/reader/reader.html"),
  });
  window.close();
});

// After
els.readerBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("src/hub/hub.html"),
  });
  window.close();
});
```

The reader is now accessed from the hub's header button, not directly from the popup.

---

## 9. Build and Manifest Changes

### Vite Configuration (`vite.config.ts`)

The hub page is added as an additional input alongside the reader:

```typescript
export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      additionalInputs: [
        "src/reader/reader.html",
        "src/hub/hub.html",
      ],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

### Manifest (`manifest.json`)

The hub files are added to `web_accessible_resources` so they can be opened via `chrome.runtime.getURL()`:

```json
{
  "web_accessible_resources": [
    {
      "resources": ["assets/*", "tesseract/*", "src/reader/*", "src/hub/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### No New Permissions

The hub uses `chrome.storage.local` (vocab data) and `chrome.storage.sync` (theme setting), both covered by the existing `storage` permission. No new permissions are needed.

---

## 10. File Change Summary

| Area | File | Change |
|---|---|---|
| Types | `src/shared/types.ts` | Add `wrongStreak`, `totalReviews`, `totalCorrect` fields to `VocabEntry` |
| Constants | `src/shared/constants.ts` | Add `FLASHCARD_WRONG_POOL_RATIO` constant |
| Vocab Store | `src/background/vocab-store.ts` | Add `updateFlashcardResult()` function; update `getAllVocab()` to backfill new field defaults |
| New: Hub HTML | `src/hub/hub.html` | Page shell with header (title + reader button), tab bar, tab content areas |
| New: Hub TS | `src/hub/hub.ts` | Tab switching, vocab list rendering with sort/detail/delete, flashcard setup/session/summary, theme application |
| New: Hub CSS | `src/hub/hub.css` | Full-page responsive layout, vocab list rows, flashcard card/buttons, detail card overlay, dark mode |
| Popup HTML | `src/popup/popup.html` | Change `#reader-btn` label from "Open Reader" to "Study & Read" |
| Popup TS | `src/popup/popup.ts` | Change `#reader-btn` click handler URL from `reader.html` to `hub.html` |
| Vite Config | `vite.config.ts` | Add `src/hub/hub.html` to `additionalInputs` |
| Manifest | `manifest.json` | Add `src/hub/*` to `web_accessible_resources` |

---

## Future Directions (Out of Scope)

- **Spaced repetition (SRS)** — add SM-2 or similar scheduling so flashcards appear on a review schedule rather than random shuffle.
- **Enriched word detail** — stroke order diagrams, example sentences, HSK level, radical breakdown.
- **Export** — CSV or Anki `.apkg` export of the vocab list with flashcard stats.
- **Reverse flashcard mode** — show definition first, reveal characters + pinyin. User-selectable direction toggle.
- **Session history** — persist completed session scores over time for a progress chart.
- **Per-site grouping** — tag words with the site URL they were encountered on, filterable in the hub.
