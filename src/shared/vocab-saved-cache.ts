/**
 * In-memory cache of which words are currently in the user's vocab list.
 *
 * The click popup needs a synchronous "is this saved?" check at render
 * time so it can show "Saved" instead of "+ Vocab" without a flicker.
 * The authoritative store lives under `chrome.storage.local.vocabStore`,
 * which is async-only — so we mirror its key set into a Set<string>
 * here and keep it fresh via chrome.storage.onChanged.
 *
 * Init is fire-and-forget: callers get an empty cache immediately, the
 * first storage round-trip lands shortly after. A popup that opens
 * before init completes will paint "+ Vocab" once and re-render to
 * "Saved" only after the user clicks (because the post-click +Vocab
 * write triggers an onChanged that updates the cache). For the typical
 * page-load → click sequence the cache is warm well before any click.
 *
 * Used by both content scripts and extension pages — chrome.storage is
 * available in both contexts so no separate background round-trip is
 * needed.
 */

import { VOCAB_STORAGE_KEY } from "./constants";

const STORAGE_KEY = VOCAB_STORAGE_KEY;

let saved = new Set<string>();
let initialized = false;

/**
 * Loads the current vocab keys into the cache and subscribes to
 * onChanged so subsequent writes (saves, deletes, imports) keep the
 * cache in sync. Safe to call multiple times — only the first call
 * does any work.
 */
export function initVocabSavedCache(): void {
  if (initialized) return;
  initialized = true;

  // Initial load. If chrome.storage is unavailable (e.g. test env that
  // didn't stub it) we silently start with an empty cache.
  try {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const store = result?.[STORAGE_KEY] as
        | Record<string, unknown>
        | undefined;
      if (store && typeof store === "object") {
        saved = new Set(Object.keys(store));
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY];
      if (!change) return;
      const next = change.newValue as Record<string, unknown> | undefined;
      saved = next ? new Set(Object.keys(next)) : new Set();
    });
  } catch {
    /* no chrome.storage in this env — leave cache empty */
  }
}

/** Returns true when `chars` is currently in the vocab store. */
export function isVocabSaved(chars: string): boolean {
  return saved.has(chars);
}

/**
 * Optimistic local insertion. Lets the UI flip to "Saved" the moment a
 * "+ Vocab" click fires, without waiting on the storage round-trip.
 * The onChanged listener then confirms the same key shortly after.
 */
export function markVocabSavedLocally(chars: string): void {
  saved.add(chars);
}
