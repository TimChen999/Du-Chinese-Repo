/**
 * Vocab persistence module backed by chrome.storage.local.
 *
 * Records every word the LLM returns during Phase 2 processing, tracking
 * frequency counts and timestamps. All entries live under a single
 * `vocabStore` key as a Record<string, VocabEntry> keyed by `chars`.
 *
 * See: VOCAB_SPEC.md Section 4 "Storage Design"
 */

import type { VocabEntry, VocabExample, WordData } from "../shared/types";
import {
  MAX_VOCAB_ENTRIES,
  MAX_VOCAB_EXAMPLES,
  VOCAB_STOP_WORDS,
} from "../shared/constants";
import { applyReviewResult } from "../shared/srs";

const STORAGE_KEY = "vocabStore";

type VocabRecord = Record<string, VocabEntry>;

/**
 * Appends `candidate` into `entry.examples` when there's an open slot
 * (capped at MAX_VOCAB_EXAMPLES) and an example with the same
 * `sentence` is not already stored. Mutates the entry in place. The
 * append-only policy means a full word never has its examples
 * silently overwritten -- the user clears a slot via the X button
 * before a future capture can refill it.
 */
function tryAppendExample(entry: VocabEntry, candidate: VocabExample): void {
  if (!entry.examples) entry.examples = [];
  if (entry.examples.length >= MAX_VOCAB_EXAMPLES) return;
  if (entry.examples.some((e) => e.sentence === candidate.sentence)) return;
  // Clone so a later setExampleTranslation / removeExample mutates only
  // our copy -- callers sometimes reuse the same VocabExample literal
  // across calls (tests do this; nothing in the runtime forbids it).
  entry.examples.push({ ...candidate });
}

/**
 * Merges incoming `incoming` examples into `entry.examples` for the
 * import path: union with the existing list, deduped by sentence,
 * capped at MAX_VOCAB_EXAMPLES, with the existing entries kept in
 * front so a user's curated translations aren't accidentally
 * overwritten by an imported sibling.
 */
function mergeExamples(
  entry: VocabEntry,
  incoming: VocabExample[] | undefined,
): void {
  if (!incoming || incoming.length === 0) return;
  const merged: VocabExample[] = entry.examples ? [...entry.examples] : [];
  const seen = new Set(merged.map((e) => e.sentence));
  for (const candidate of incoming) {
    if (merged.length >= MAX_VOCAB_EXAMPLES) break;
    if (seen.has(candidate.sentence)) continue;
    merged.push({ ...candidate });
    seen.add(candidate.sentence);
  }
  if (merged.length > 0) entry.examples = merged;
}

/**
 * Records a batch of words from a single LLM response or cache hit.
 * New words are created with count 1; existing words get their count
 * incremented and pinyin/definition updated to the latest values.
 * If the total exceeds MAX_VOCAB_ENTRIES, least-frequent entries are evicted.
 *
 * `example`, when provided, is attached to the first non-stop-word in
 * the batch. The "+ Vocab" callback path always records exactly one
 * word, so this trivially attaches the captured sentence to the
 * intended target. Phase-2 batch recording paths don't pass an
 * example, so existing call sites are unaffected.
 */
export async function recordWords(
  words: Required<WordData>[],
  example?: VocabExample,
): Promise<void> {
  if (words.length === 0) return;

  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  const now = Date.now();

  let exampleAttached = false;

  for (const word of words) {
    if (VOCAB_STOP_WORDS.has(word.chars)) continue;
    const existing = store[word.chars];
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.pinyin = word.pinyin;
      existing.definition = word.definition;
      if (example && !exampleAttached) {
        tryAppendExample(existing, example);
        exampleAttached = true;
      }
    } else {
      const entry: VocabEntry = {
        chars: word.chars,
        pinyin: word.pinyin,
        definition: word.definition,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        wrongStreak: 0,
        totalReviews: 0,
        totalCorrect: 0,
        intervalDays: 0,
        nextDueAt: 0,
      };
      if (example && !exampleAttached) {
        entry.examples = [{ ...example }];
        exampleAttached = true;
      }
      store[word.chars] = entry;
    }
  }

  const keys = Object.keys(store);
  if (keys.length > MAX_VOCAB_ENTRIES) {
    const sorted = keys.sort((a, b) => store[a].count - store[b].count);
    const excess = keys.length - MAX_VOCAB_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete store[sorted[i]];
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/**
 * Returns all recorded vocab entries as an array.
 * Returns an empty array if no store exists.
 */
export async function getAllVocab(): Promise<VocabEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store = result[STORAGE_KEY] as VocabRecord | undefined;
  if (!store) return [];
  // Defaults guard against legacy entries persisted before the
  // review-stats fields existed; spread first so the entry's own
  // values take precedence whenever present.
  return Object.values(store).map((entry) => ({
    ...entry,
    wrongStreak: entry.wrongStreak ?? 0,
    totalReviews: entry.totalReviews ?? 0,
    totalCorrect: entry.totalCorrect ?? 0,
    intervalDays: entry.intervalDays ?? 0,
    nextDueAt: entry.nextDueAt ?? 0,
  }));
}

/**
 * Removes the entire vocab store from chrome.storage.local.
 */
export async function clearVocab(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Removes a single word from the vocab store by its chars key.
 * No-op if the word does not exist.
 */
/**
 * Updates a single word's flashcard stats after a review and runs the
 * SRS scheduler so the next-due timestamp reflects the new interval.
 * See shared/srs.ts for the doubling-interval rules and bucket
 * thresholds. Persists immediately so partial sessions are not lost.
 */
export async function updateFlashcardResult(
  chars: string,
  correct: boolean,
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  const entry = store[chars];
  if (!entry) return;

  const next = applyReviewResult(
    {
      intervalDays: entry.intervalDays ?? 0,
      wrongStreak: entry.wrongStreak ?? 0,
      totalReviews: entry.totalReviews ?? 0,
      totalCorrect: entry.totalCorrect ?? 0,
    },
    correct,
    Date.now(),
  );
  entry.intervalDays = next.intervalDays;
  entry.nextDueAt = next.nextDueAt;
  entry.wrongStreak = next.wrongStreak;
  entry.totalReviews = next.totalReviews;
  entry.totalCorrect = next.totalCorrect;

  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/**
 * Overwrites a single word's SRS scheduling fields with the supplied
 * snapshot. Used by the flashcard rewind path to undo an answer that
 * was already persisted -- updateFlashcardResult writes immediately
 * (so partial sessions are not lost on tab close), so rewind needs an
 * inverse that restores the pre-answer state captured before that
 * write. No-op when the word is missing. Persists immediately so a
 * rewind followed by a re-answer applies on top of the restored state.
 */
export async function restoreFlashcardState(
  chars: string,
  state: {
    intervalDays: number;
    nextDueAt: number;
    wrongStreak: number;
    totalReviews: number;
    totalCorrect: number;
  },
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  const entry = store[chars];
  if (!entry) return;

  entry.intervalDays = state.intervalDays;
  entry.nextDueAt = state.nextDueAt;
  entry.wrongStreak = state.wrongStreak;
  entry.totalReviews = state.totalReviews;
  entry.totalCorrect = state.totalCorrect;

  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

export async function removeWord(chars: string): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  delete store[chars];
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/**
 * Batch-removes a list of vocab entries in a single storage roundtrip.
 * Returns the number of entries actually deleted (missing keys are
 * silently skipped) so the UI can show an accurate "Cleared N words"
 * status. Used by the Clear popover's pruning flow, which can target
 * dozens to hundreds of entries at once.
 */
export async function removeWords(charsArr: string[]): Promise<number> {
  if (charsArr.length === 0) return 0;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  let removed = 0;
  for (const chars of charsArr) {
    if (store[chars]) {
      delete store[chars];
      removed++;
    }
  }
  if (removed > 0) {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  }
  return removed;
}

/**
 * Clears a single example slot on a vocab entry by its array index.
 * Frees the slot so a future high-quality capture can refill it. No-op
 * when the word or index is missing. Persists immediately so the UI
 * sees the change on its next read.
 */
export async function removeExample(
  chars: string,
  index: number,
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  const entry = store[chars];
  if (!entry || !entry.examples) return;
  if (index < 0 || index >= entry.examples.length) return;
  entry.examples.splice(index, 1);
  if (entry.examples.length === 0) delete entry.examples;
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/**
 * Attaches (or overwrites) the translation field on a single example
 * slot. Used both by the auto-translate path on RECORD_WORD and by
 * the on-demand "Translate" button in the vocab card / flashcard
 * flip view. No-op when the word or index is missing.
 */
export async function setExampleTranslation(
  chars: string,
  index: number,
  translation: string,
): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  const entry = store[chars];
  if (!entry || !entry.examples) return;
  if (index < 0 || index >= entry.examples.length) return;
  entry.examples[index].translation = translation;
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/**
 * Merges an array of imported VocabEntry objects into the local store.
 * For duplicates, takes the higher count, earliest firstSeen, latest
 * lastSeen, and the review stats from whichever side has more reviews.
 * Enforces MAX_VOCAB_ENTRIES via the same eviction as recordWords.
 */
export async function importVocab(
  entries: VocabEntry[],
): Promise<{ added: number; updated: number }> {
  if (entries.length === 0) return { added: 0, updated: 0 };

  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = (result[STORAGE_KEY] as VocabRecord | undefined) ?? {};
  let added = 0;
  let updated = 0;

  for (const entry of entries) {
    const existing = store[entry.chars];
    if (existing) {
      existing.count = Math.max(existing.count, entry.count);
      existing.firstSeen = Math.min(existing.firstSeen, entry.firstSeen);
      existing.lastSeen = Math.max(existing.lastSeen, entry.lastSeen);
      if ((entry.totalReviews ?? 0) > (existing.totalReviews ?? 0)) {
        existing.totalReviews = entry.totalReviews ?? 0;
        existing.totalCorrect = entry.totalCorrect ?? 0;
        existing.wrongStreak = entry.wrongStreak ?? 0;
        existing.intervalDays = entry.intervalDays ?? 0;
        existing.nextDueAt = entry.nextDueAt ?? 0;
      }
      existing.pinyin = entry.pinyin;
      existing.definition = entry.definition;
      mergeExamples(existing, entry.examples);
      updated++;
    } else {
      const fresh: VocabEntry = {
        chars: entry.chars,
        pinyin: entry.pinyin,
        definition: entry.definition,
        count: entry.count,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        wrongStreak: entry.wrongStreak ?? 0,
        totalReviews: entry.totalReviews ?? 0,
        totalCorrect: entry.totalCorrect ?? 0,
        intervalDays: entry.intervalDays ?? 0,
        nextDueAt: entry.nextDueAt ?? 0,
      };
      if (entry.examples && entry.examples.length > 0) {
        fresh.examples = entry.examples
          .slice(0, MAX_VOCAB_EXAMPLES)
          .map((e) => ({ ...e }));
      }
      store[entry.chars] = fresh;
      added++;
    }
  }

  const keys = Object.keys(store);
  if (keys.length > MAX_VOCAB_ENTRIES) {
    const sorted = keys.sort((a, b) => store[a].count - store[b].count);
    const excess = keys.length - MAX_VOCAB_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete store[sorted[i]];
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: store });
  return { added, updated };
}
