/**
 * Shared "+ Vocab" capture pipeline.
 *
 * The in-page content script (src/content/content.ts) and the
 * in-extension reader (src/reader/reader.ts) both register a vocab
 * callback with the overlay module. They used to inline identical
 * gate -> trim -> translate logic, which let one caller drift out of
 * sync with the wire format the service worker reads -- a real bug
 * we hit when only content.ts was migrated to the {word, example}
 * RECORD_WORD shape and the reader path silently kept sending
 * {word, context}, dropping every reader-side example sentence.
 *
 * Centralising the body here means there is one place to update the
 * pipeline, and one place a future regression has to slip through.
 *
 * Pipeline:
 *  1. Run the captured surrounding context through the
 *     example-quality gate (isUsableExample).
 *  2. If it passes, trim at clause boundaries (trimSentenceForExample)
 *     so the stored snippet reads like a single thought.
 *  3. Send RECORD_WORD with `{word, example}` so the service worker
 *     persists immediately. Awaiting the on-device Translator before
 *     this would block the user's "Saved" feedback in the overlay.
 *  4. Asynchronously translate via the on-device Translator API
 *     (which needs the user activation the +Vocab click supplies);
 *     when it resolves, ship SET_EXAMPLE_TRANSLATION so the SW
 *     patches the stored example with its English translation.
 *
 * Failure modes are silent on purpose: the word still lands in the
 * vocab list even when no usable context is captured or the
 * Translator API is unavailable. The user can re-trigger translation
 * later from the hub's "Translate" button.
 */

import { isUsableExample, trimSentenceForExample } from "./example-quality";
import { translateExampleSentence } from "./translate-example";
import { markVocabSavedLocally } from "./vocab-saved-cache";

export async function handleVocabCapture(
  word: { chars: string; pinyin: string; definition: string },
  context: string,
): Promise<void> {
  // Optimistically mark saved before the storage round-trip so the
  // popup's next isVocabSaved() read (and any other surface watching
  // the cache) sees the new state immediately rather than waiting on
  // chrome.storage.onChanged. Idempotent — the listener will arrive
  // and re-sync the full key set shortly after.
  markVocabSavedLocally(word.chars);

  let example: { sentence: string } | undefined;
  if (context && isUsableExample(word.chars, context)) {
    example = { sentence: trimSentenceForExample(context, word.chars) };
  }

  chrome.runtime.sendMessage({ type: "RECORD_WORD", word, example });

  if (!example) return;

  const result = await translateExampleSentence(example.sentence);
  if (!result.ok) return;

  chrome.runtime.sendMessage({
    type: "SET_EXAMPLE_TRANSLATION",
    chars: word.chars,
    sentence: example.sentence,
    translation: result.translation,
  });
}
