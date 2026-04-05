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
  return Object.values(store);
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
export async function removeWord(chars: string): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = result[STORAGE_KEY] ?? {};
  delete store[chars];
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}
