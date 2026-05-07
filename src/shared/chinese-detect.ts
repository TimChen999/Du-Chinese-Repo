/**
 * Utilities for detecting Chinese text in user selections.
 *
 * containsChinese() gates the entire extension flow -- if a selection
 * has no Chinese characters, no overlay is shown and no messages are sent.
 * extractSurroundingContext() grabs nearby paragraph text to give the
 * LLM context for polyphonic character disambiguation.
 *
 * See: SPEC.md Section 2.1 "Selection-Based Pinyin Overlay" for detection,
 *      SPEC.md Section 6 "Why LLM Disambiguation Matters" for context usage,
 *      IMPLEMENTATION_GUIDE.md Step 1k for implementation details.
 */

import { CHINESE_REGEX, MAX_CONTEXT_LENGTH } from "./constants";
import {
  isDecodablePuaChar,
  isPossiblyCipheredChar,
} from "./font-decoder";

/**
 * Returns true if the string contains at least one CJK Unified Ideograph.
 * Used by the content script's mouseup handler to decide whether to
 * trigger the pinyin flow. (SPEC.md Section 2.1)
 *
 * Also returns true for:
 *   - PUA chars already resolved by the font decoder
 *     (`isDecodablePuaChar`), and
 *   - PUA chars on a page known to use a cipher font even before any
 *     OCR has run (`isPossiblyCipheredChar`) — click-flow then runs
 *     decodeForText() to fill them in on the fly. Without this hook
 *     the user's very first click on an obfuscated char would be
 *     silently rejected.
 */
export function containsChinese(text: string): boolean {
  if (!text) return false;
  if (CHINESE_REGEX.test(text)) return true;
  for (const ch of text) {
    if (isDecodablePuaChar(ch) || isPossiblyCipheredChar(ch)) return true;
  }
  return false;
}

/**
 * Sentence-bounded context extractor used to feed the LLM just enough
 * surrounding text for polyphone disambiguation, without dragging the
 * full visible page/spine into every prompt.
 *
 * Strategy: take up to `pad` characters before and after the selection
 * inside `fullText`, then trim to the nearest sentence boundary on
 * each side using common CJK + ASCII delimiters. Finally, hard-cap the
 * result at MAX_CONTEXT_LENGTH so prefill latency stays predictable.
 *
 * If the selection cannot be located (e.g. fullText doesn't contain
 * it verbatim), falls back to returning the selection itself, which is
 * still safe input for the LLM.
 */
const SENTENCE_DELIMS_RIGHT = ["。", "！", "？", "!", "?"];
const SENTENCE_DELIMS_LEFT = SENTENCE_DELIMS_RIGHT;

export function sentenceContextAround(
  fullText: string,
  selection: string,
  pad = 200,
): string {
  if (!fullText || !selection) return selection;
  const idx = fullText.indexOf(selection);
  if (idx < 0) return selection;

  const before = fullText.slice(Math.max(0, idx - pad), idx);
  const after = fullText.slice(
    idx + selection.length,
    idx + selection.length + pad,
  );

  const lastDelim = Math.max(
    ...SENTENCE_DELIMS_LEFT.map((d) => before.lastIndexOf(d)),
  );
  const startCut = lastDelim >= 0 ? lastDelim + 1 : 0;

  const candidates = SENTENCE_DELIMS_RIGHT
    .map((d) => after.indexOf(d))
    .filter((i) => i >= 0);
  const endCut = candidates.length ? Math.min(...candidates) + 1 : after.length;

  const out = before.slice(startCut) + selection + after.slice(0, endCut);
  return out.length > MAX_CONTEXT_LENGTH ? out.slice(0, MAX_CONTEXT_LENGTH) : out;
}

/**
 * Returns a roughly `2*halfWindow + anchor.length` slice of `fullText`
 * centered on the first occurrence of `anchor`. Used by reader
 * renderers' getVisibleText() so the selection-based context flow
 * (LLM disambiguation + example-quality gate) doesn't lose its window
 * when the user looks up a word past the renderer's prefix cap.
 *
 * Falls back to the leading `fallbackPrefix` chars when `anchor` is
 * empty or not found, mirroring the legacy "first N chars" behaviour
 * callers relied on.
 */
export function windowAroundAnchor(
  fullText: string,
  anchor: string,
  halfWindow = 300,
  fallbackPrefix = 500,
): string {
  if (!fullText) return "";
  if (!anchor) {
    return fullText.length > fallbackPrefix
      ? fullText.slice(0, fallbackPrefix)
      : fullText;
  }
  const idx = fullText.indexOf(anchor);
  if (idx < 0) {
    return fullText.length > fallbackPrefix
      ? fullText.slice(0, fallbackPrefix)
      : fullText;
  }
  const start = Math.max(0, idx - halfWindow);
  const end = Math.min(fullText.length, idx + anchor.length + halfWindow);
  return fullText.slice(start, end);
}

/**
 * Walks up the DOM from the selection's anchor node to find the nearest
 * block-level parent (P, DIV, ARTICLE, SECTION, or BODY) and returns
 * the surrounding sentence(s) trimmed to MAX_CONTEXT_LENGTH.
 *
 * The full block text is captured first (capped at 1000 chars as a
 * safety bound to avoid pathological pages), then sentenceContextAround
 * trims it down using the user's actual selection as the pivot. This
 * keeps the prompt small and stabilizes the cache key (scrolling /
 * other DOM mutations don't perturb the hash anymore).
 *
 * This surrounding text is sent alongside the selected text in the
 * PinyinRequest so the LLM can disambiguate polyphonic characters
 * (e.g., 行 as "háng" in 银行 vs "xíng" in 行走).
 * (SPEC.md Section 6 "Why LLM Disambiguation Matters")
 */
export function extractSurroundingContext(selection: Selection): string {
  if (!selection.anchorNode) return "";

  let node: Node | null = selection.anchorNode;
  while (
    node &&
    node.nodeName !== "P" &&
    node.nodeName !== "DIV" &&
    node.nodeName !== "ARTICLE" &&
    node.nodeName !== "SECTION" &&
    node.nodeName !== "BODY" &&
    node.parentNode
  ) {
    node = node.parentNode;
  }

  const blockText = (node?.textContent ?? "").slice(0, 1000);
  const selectionText = selection.toString();
  return sentenceContextAround(blockText, selectionText);
}
