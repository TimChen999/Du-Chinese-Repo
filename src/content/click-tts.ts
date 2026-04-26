/**
 * Sentence-level TTS with per-word karaoke highlighting.
 *
 * The user clicks the speaker button on the popup's sentence tier; we
 * speak the entire sentence with one SpeechSynthesisUtterance (so
 * prosody is preserved), and schedule per-word timers that re-paint
 * the `::highlight(pt-word)` range to each word's location as it's
 * spoken. At end, we restore the originally-clicked word's highlight.
 *
 * Why timers and not boundary events: many Chinese voices in Chrome
 * don't fire word-level `boundary` events at all. We approximate with
 * ~MS_PER_CHAR_AT_RATE_1 ms per character at rate 1.0, scaled by the
 * utterance's actual rate. This was the proven approach in the legacy
 * overlay — kept verbatim here.
 */

import { buildTextRange } from "./caret-from-point";
import { setWordHighlight } from "./page-highlight";
import type { LLMSentenceWord } from "../shared/types";
import type { StripWord } from "./click-popup";

/** Mid-of-range estimate for Chinese TTS at rate=1.0. */
const MS_PER_CHAR_AT_RATE_1 = 200;
/** Same rate the legacy overlay used; mild slowdown for clarity. */
const TTS_RATE = 0.85;

let voicesReady = false;
let activeTimers: number[] = [];

/** True if the platform exposes a Chinese voice for utterance.lang="zh-CN". */
export function hasChineseVoice(): boolean {
  if (typeof window === "undefined" || !window.speechSynthesis) return false;
  const voices = window.speechSynthesis.getVoices();
  return voices.some((v) => v.lang.startsWith("zh"));
}

/**
 * Idempotent voice-ready primer. Voices load asynchronously in Chrome;
 * the first call triggers a getVoices() probe and listens for
 * `voiceschanged` once. Subsequent calls fast-path.
 */
export function ensureVoicesLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      voicesReady = true;
      resolve();
      return;
    }
    if (voicesReady) {
      resolve();
      return;
    }
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      voicesReady = true;
      resolve();
      return;
    }
    window.speechSynthesis.addEventListener(
      "voiceschanged",
      () => {
        voicesReady = true;
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Speak the given sentence. The `words` array drives the per-word
 * highlight timeline; `sentenceTextNode` + `sentenceStartOffset`
 * locate the sentence inside the page DOM so we can re-build the
 * word-by-word ranges.
 *
 * On end / error / cancellation, we restore the highlight to the
 * originally-clicked word range so the popup state stays coherent.
 */
export interface SpeakArgs {
  text: string;
  words: Array<StripWord | LLMSentenceWord>;
  /** Anchor to compute word ranges inside the page DOM. */
  textNode: Text;
  /** Offset of the sentence's first character inside textNode.data. */
  sentenceStartOffset: number;
  /** Range to restore the highlight to when speech finishes. */
  restoreRange: Range | null;
}

export function speakSentence(args: SpeakArgs): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (!args.text) return;

  cancelSpeaking();

  const utterance = new SpeechSynthesisUtterance(args.text);
  utterance.lang = "zh-CN";
  utterance.rate = TTS_RATE;

  const msPerChar = MS_PER_CHAR_AT_RATE_1 / utterance.rate;

  utterance.onstart = () => {
    let cursor = 0;
    for (const w of args.words) {
      const wordText = "text" in w ? w.text : (w as StripWord).text;
      const offsetMs = cursor * msPerChar;
      const startInNode = args.sentenceStartOffset + cursor;
      const endInNode = startInNode + wordText.length;
      const id = window.setTimeout(() => {
        const range = buildTextRange(args.textNode, startInNode, endInNode);
        if (range) setWordHighlight(range);
      }, offsetMs);
      activeTimers.push(id);
      cursor += wordText.length;
    }
  };

  const restore = () => {
    clearTimers();
    if (args.restoreRange) setWordHighlight(args.restoreRange);
  };
  utterance.onend = restore;
  utterance.onerror = restore;

  window.speechSynthesis.speak(utterance);
}

export function cancelSpeaking(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  clearTimers();
}

function clearTimers(): void {
  for (const id of activeTimers) window.clearTimeout(id);
  activeTimers = [];
}
