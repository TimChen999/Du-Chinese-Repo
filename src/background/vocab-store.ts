/**
 * Vocab persistence module backed by chrome.storage.local.
 *
 * Records every word the LLM returns during Phase 2 processing, tracking
 * frequency counts and timestamps. All entries live under a single
 * `vocabStore` key as a Record<string, VocabEntry> keyed by `chars`.
 *
 * See: VOCAB_SPEC.md Section 4 "Storage Design"
 */

import type { VocabEntry, WordData } from "../shared/types";
import { MAX_VOCAB_ENTRIES, VOCAB_STOP_WORDS } from "../shared/constants";

const STORAGE_KEY = "vocabStore";

type VocabRecord = Record<string, VocabEntry>;

/**
 * Records a batch of words from a single LLM response or cache hit.
 * New words are created with count 1; existing words get their count
 * incremented and pinyin/definition updated to the latest values.
 * If the total exceeds MAX_VOCAB_ENTRIES, least-frequent entries are evicted.
 */
export async function recordWords(
  words: Required<WordData>[],
): Promise<void> {
  if (words.length === 0) return;

  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = result[STORAGE_KEY] ?? {};
  const now = Date.now();

  for (const word of words) {
    if (VOCAB_STOP_WORDS.has(word.chars)) continue;
    const existing = store[word.chars];
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.pinyin = word.pinyin;
      existing.definition = word.definition;
    } else {
      store[word.chars] = {
        chars: word.chars,
        pinyin: word.pinyin,
        definition: word.definition,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      };
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
  const store: VocabRecord | undefined = result[STORAGE_KEY];
  if (!store) return [];
  return Object.values(store).map((entry) => ({
    wrongStreak: 0,
    totalReviews: 0,
    totalCorrect: 0,
    ...entry,
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
 * Updates a single word's flashcard stats after a review.
 * Persists immediately so partial sessions are not lost.
 */
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

export async function removeWord(chars: string): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = result[STORAGE_KEY] ?? {};
  delete store[chars];
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
  const store: VocabRecord = result[STORAGE_KEY] ?? {};
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
      }
      existing.pinyin = entry.pinyin;
      existing.definition = entry.definition;
      updated++;
    } else {
      store[entry.chars] = {
        chars: entry.chars,
        pinyin: entry.pinyin,
        definition: entry.definition,
        count: entry.count,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        wrongStreak: entry.wrongStreak ?? 0,
        totalReviews: entry.totalReviews ?? 0,
        totalCorrect: entry.totalCorrect ?? 0,
      };
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
