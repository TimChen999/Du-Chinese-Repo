# Encountered Words — Feature Specification

Adds a lightweight vocabulary tracking layer to the Pinyin Tool extension. Every word the LLM returns during Phase 2 processing is recorded with a frequency count, giving the user a cumulative list of Chinese words they keep encountering while browsing. The list is viewable from a new "Vocab" tab inside the existing popup — no flashcards, no spaced repetition, just a simple reference of words worth remembering.

This feature builds on the existing LLM integration described in [SPEC.md](SPEC.md) Section 6 and the caching layer from [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) Step 5.

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Data Model](#2-data-model)
3. [Data Flow](#3-data-flow)
4. [Storage Design](#4-storage-design)
5. [UI Design](#5-ui-design)
6. [Stop-Word Filtering](#6-stop-word-filtering)

---

## 1. Feature Overview

### What It Does

Every time the LLM processes a text selection and returns segmented words with pinyin and definitions (see [SPEC.md](SPEC.md) Section 5 "Two-Phase Rendering", Phase 2), those words are silently recorded in a persistent vocab store. If the user encounters the same word again — whether from a fresh LLM call or a cache hit — its frequency counter increments.

The user can open the extension popup and switch to the "Vocab" tab to see a list of all recorded words, sorted by how often they've appeared.

### What It Does Not Do

- **No flashcards or practice mode** — the list is read-only, not an SRS trainer. This may be added as a future feature.
- **No export** — out of scope for the initial version.
- **No per-site or per-session grouping** — all words go into one global list regardless of which site they came from.

### Who It's For

The same target users defined in [SPEC.md](SPEC.md) Section 1 "Target Users" — particularly heritage speakers and intermediate learners who want a passive way to track which words they keep running into. High-frequency words naturally surface to the top of the list, signaling what's worth committing to memory.

---

## 2. Data Model

### VocabEntry

Each recorded word is stored as a `VocabEntry`:

```typescript
interface VocabEntry {
  chars: string;       // Chinese characters, e.g. "银行"
  pinyin: string;      // Pinyin with tone marks, e.g. "yín háng"
  definition: string;  // English definition, e.g. "bank; financial institution"
  count: number;       // How many times this word has been encountered
  firstSeen: number;   // Unix timestamp (ms) of first encounter
  lastSeen: number;    // Unix timestamp (ms) of most recent encounter
}
```

- **`chars`** is the primary key — the same characters always map to the same entry, regardless of surrounding context. This is intentional: the goal is "how often do I see this word," not "how often in this exact sentence."
- **`pinyin`** and **`definition`** are overwritten on each encounter with the latest LLM-provided values. Since the LLM may produce slightly different definitions depending on context, the most recent one wins.
- **`count`** increments on every encounter, including cache hits (re-selecting previously looked-up text).

### Relationship to Existing Types

`VocabEntry` is a new type that extends the concept of `WordData` from [SPEC.md](SPEC.md) Section 5 "Message Protocol". The LLM response contains `Required<WordData>[]` (with `chars`, `pinyin`, and `definition`); `VocabEntry` adds `count`, `firstSeen`, and `lastSeen` on top.

---

## 3. Data Flow

### Capture Path (Write)

```
User selects Chinese text
        │
        ▼
  Service Worker: handleLLMPath()
        │
        ├── Cache hit ──► chrome.tabs.sendMessage (PINYIN_RESPONSE_LLM)
        │                        │
        │                        └──► vocab-store.recordWords(cached.words)
        │
        └── Cache miss ──► queryLLM() ──► saveToCache()
                                │
                                └──► chrome.tabs.sendMessage (PINYIN_RESPONSE_LLM)
                                         │
                                         └──► vocab-store.recordWords(result.words)
```

Words are recorded **after** the LLM response is sent to the content script so that vocab tracking never blocks or delays the overlay rendering.

### Read Path (Display)

```
User clicks extension icon
        │
        ▼
  Popup opens (popup.html)
        │
        ├── "Settings" tab (default, existing)
        │
        └── "Vocab" tab (new)
                │
                ▼
        vocab-store.getAllVocab()
                │
                ▼
        Sort by count (descending) or lastSeen (descending)
                │
                ▼
        Render table: chars | pinyin | definition | count
```

---

## 4. Storage Design

### Storage Backend

The vocab store uses `chrome.storage.local` — the same backend as the LLM response cache (see [SPEC.md](SPEC.md) Section 6 "Caching"). Both coexist without conflict because they use distinct key strategies:

| Store | Key pattern | Example |
|---|---|---|
| LLM cache | SHA-256 hex hash (64 chars) | `a3f1b2c4d5...` |
| Vocab store | Single key | `vocabStore` |

### Storage Shape

All vocab entries are stored under a single `chrome.storage.local` key called `vocabStore`, holding a `Record<string, VocabEntry>` keyed by `chars`:

```typescript
{
  "vocabStore": {
    "银行": { chars: "银行", pinyin: "yín háng", definition: "bank", count: 5, firstSeen: 1711234567890, lastSeen: 1711345678901 },
    "工作": { chars: "工作", pinyin: "gōng zuò", definition: "to work; job", count: 3, firstSeen: 1711234567890, lastSeen: 1711334567890 },
    ...
  }
}
```

### Limits

- **No TTL** — unlike the LLM cache, vocab entries persist indefinitely until the user explicitly clears them.
- **Max entries**: 10,000 — if the count exceeds this, the entries with the lowest `count` (least frequently encountered) are dropped first. This cap prevents unbounded storage growth.
- **Manual clear** — a "Clear List" button in the Vocab tab calls `clearVocab()` to wipe all entries.

### No New Permissions

The `storage` permission is already declared in `manifest.json` (see [SPEC.md](SPEC.md) Section 4 "Permissions Justification"). No additional permissions are needed.

---

## 5. UI Design

### Popup Tab Layout

The existing popup ([SPEC.md](SPEC.md) Section 7 "Popup Settings Panel") gains a tab bar at the top:

```
┌──────────────────────────────────────┐
│  [ Settings ]   [ Vocab ]            │
├──────────────────────────────────────┤
│                                      │
│  (tab content renders here)          │
│                                      │
└──────────────────────────────────────┘
```

- **Settings tab** — the existing form (provider, API key, model, pinyin style, font size, theme, LLM toggle, save button). Default active tab.
- **Vocab tab** — the new word list view.

### Vocab Tab Content

```
┌──────────────────────────────────────┐
│  Sort: [ Most frequent ▼ ]          │
├──────────────────────────────────────┤
│  银行    yín háng    bank         5  │
│  工作    gōng zuò    to work      3  │
│  学生    xué shēng   student      2  │
│  ...                                 │
├──────────────────────────────────────┤
│  [ Clear List ]                      │
└──────────────────────────────────────┘
```

**Sort options:**
- **Most frequent** (default) — descending by `count`
- **Most recent** — descending by `lastSeen`

**Empty state:** When no words have been recorded yet, the tab shows a muted message: "No words recorded yet. Select Chinese text on any page to start building your list."

### Interaction Patterns

| Action | Result |
|---|---|
| Click "Vocab" tab | Switches to vocab list view, loads entries from storage |
| Click "Settings" tab | Switches back to settings form |
| Change sort dropdown | Re-sorts the list immediately |
| Click "Clear List" | Confirmation prompt, then wipes all vocab entries |

### Styling

The vocab list reuses the existing popup CSS variables and theme. New classes are scoped under `.vocab-*` to avoid collision:

- `.vocab-list` — container for the word rows
- `.vocab-row` — individual word entry (flexbox: chars, pinyin, definition, count)
- `.vocab-empty` — empty state message
- `.vocab-controls` — sort dropdown and clear button container

---

## 6. Stop-Word Filtering

### Rationale

High-frequency function words like 的, 了, 是, 在, 不, 我, 他, 她, 这, 那, 也, 都, 就, 和, 有, 很 appear in nearly every sentence. Recording them inflates the list with words the user certainly already knows, pushing genuinely useful vocab further down.

### Implementation

A `VOCAB_STOP_WORDS` set is defined in `src/shared/constants.ts`:

```typescript
export const VOCAB_STOP_WORDS = new Set([
  "的", "了", "是", "在", "不", "我", "你", "他", "她", "它",
  "们", "这", "那", "也", "都", "就", "和", "有", "很", "会",
  "能", "要", "把", "被", "让", "给", "到", "从", "对", "为",
  "吗", "呢", "吧", "啊", "嗯",
]);
```

`recordWords()` in `vocab-store.ts` skips any word whose `chars` value is in this set. The set is small and fast to check (`O(1)` per word).

### Configurable

This is an initial hardcoded list. A future enhancement could expose it as a user setting, but that is out of scope for this feature.

---

## Future Directions (Out of Scope)

- **Flashcard / practice mode** — SRS-based review of recorded words
- **Export** — CSV or Anki deck export of the vocab list
- **Per-site grouping** — tag words with the site URL they were encountered on
- **User-configurable stop words** — let the user add/remove words from the filter list
- **Manual addition** — let the user add words to the list from the overlay (e.g. a "save word" button)
