/**
 * Click-flow controller — the new interaction model.
 *
 * Hover preview + click commit, backed by:
 *  - CC-CEDICT longest-match (offline) for instant word boundaries.
 *  - Chrome on-device translator for instant Bootstrap sentence translation.
 *  - LLM round-trip via the service worker for the contextual upgrade
 *    (Hot state) — better word boundaries, contextual pinyin/gloss,
 *    polished sentence translation.
 *
 * Per-sentence state machine: Cold → Bootstrap → Hot. Once Hot, hover
 * boundaries within that sentence come from the LLM's `words` array
 * instead of CC-CEDICT longest-match.
 *
 * See: .claude/ARCHITECTURE_REDESIGN.md sections 3-15.
 */

import {
  ensureDictionaryLoaded,
  findLongest,
  formatPinyin,
  isDictionaryReady,
  lookupExact,
  segmentSentence,
} from "../shared/cedict-lookup";
import {
  caretFromPoint,
  buildTextRange,
  type CaretPosition,
} from "./caret-from-point";
import { detectSentence, type SentenceResult } from "./sentence-detect";
import {
  clearAllHighlights,
  ensureHighlightStylesInjected,
  highlightApiAvailable,
  setHoverHighlight,
  setSentenceHighlight,
  setWordHighlight,
} from "./page-highlight";
import {
  bootstrapWordFromHit,
  dismiss as dismissPopup,
  getCurrentSentence,
  getCurrentWordChars,
  getPopupHostElement,
  isPopupOpen,
  isShowingSentence,
  refreshPinyinStripActiveWord,
  retargetWord,
  setClickPopupDismissHandler,
  setClickPopupSpeakHandler,
  setClickPopupTtsEnabled,
  setSentenceError,
  setSentenceText,
  showBootstrap,
  upgradeStripWithLlm,
  upgradeWord,
  type StripWord,
} from "./click-popup";
import {
  cancelSpeaking,
  ensureVoicesLoaded,
  speakSentence,
} from "./click-tts";
import {
  isTranslatorAvailable,
  prewarmTranslator,
  translateChineseToEnglish,
} from "../shared/translate-example";
import { containsChinese } from "../shared/chinese-detect";
import type {
  ExtensionMessage,
  LLMSentenceWord,
  PinyinStyle,
  SentenceTranslateResponseLLM,
  Theme,
} from "../shared/types";

// ─── Settings cache (mirrored from content.ts) ─────────────────────

interface ClickFlowSettings {
  theme: Theme;
  fontSize: number;
  pinyinStyle: PinyinStyle;
  llmEnabled: boolean;
  ttsEnabled: boolean;
  /** Master switch for the click flow. When false, only the legacy
   *  selection / context-menu / shortcut paths fire. */
  clickFlowEnabled: boolean;
}

let settings: ClickFlowSettings = {
  theme: "auto",
  fontSize: 16,
  pinyinStyle: "toneMarks",
  llmEnabled: true,
  ttsEnabled: true,
  clickFlowEnabled: true,
};

export function setClickFlowSettings(next: Partial<ClickFlowSettings>): void {
  settings = { ...settings, ...next };
  // Mirror ttsEnabled into the popup module so an already-open popup
  // re-asserts the speaker button on its next tier rebuild without
  // waiting for a fresh click. Idempotent.
  if (typeof next.ttsEnabled === "boolean") {
    setClickPopupTtsEnabled(next.ttsEnabled);
  }
}

// ─── Pluggable sentence-translation provider ───────────────────────

/**
 * Function signature for "ask the LLM (or cache) to translate a
 * sentence and route the response back into the popup."
 *
 * Default implementation (set in initClickFlow) sends a
 * SENTENCE_TRANSLATE_REQUEST via chrome.runtime.sendMessage, intended
 * for content scripts where the service worker owns the LLM client.
 *
 * The reader page registers its own provider that imports
 * queryLLMSentence + sentence-cache directly (extension pages can do
 * cross-origin fetches), so the reader doesn't pay the SW round-trip.
 */
export type SentenceTranslationProvider = (args: {
  sentence: string;
  pinyinStyle: PinyinStyle;
  requestId: number;
  onResponse: (msg: SentenceTranslateResponseLLM) => void;
  onError: (msg: { error: string; code: string }) => void;
}) => void;

let sentenceProvider: SentenceTranslationProvider | null = null;

export function setSentenceTranslationProvider(
  provider: SentenceTranslationProvider,
): void {
  sentenceProvider = provider;
}

// ─── Commit-hook for host integrations (reader) ───────────────────

/**
 * Fired whenever a fresh sentence opens. Reader uses this to capture
 * its bookmark anchor (so reopening lands on the exact word the user
 * looked at). No-op by default.
 */
type CommitHook = (info: {
  sentence: string;
  word: string;
  textNode: Text;
  offset: number;
}) => void;
let onCommit: CommitHook | null = null;
export function setOnSentenceCommit(cb: CommitHook | null): void {
  onCommit = cb;
}

// ─── Per-sentence state ────────────────────────────────────────────

type SentenceState =
  | { kind: "bootstrap" }
  | {
      kind: "hot";
      words: LLMSentenceWord[];
      translation: string;
    };

/** All sentences engaged in this tab. Persists for the page session. */
const sentenceStates = new Map<string, SentenceState>();

/** The sentence currently shown in the popup. Used to drop late LLM responses. */
let currentSentence = "";
let currentRequestId = 0;
/**
 * Current click-flow popup's anchor: the text node + sentence start
 * offset on the page, plus the locked word range. Used by TTS to
 * rebuild per-word ranges as it speaks, and to restore the highlight
 * to the clicked word after speech ends.
 */
let currentSentenceAnchor: {
  textNode: Text;
  sentenceStartOffset: number;
  wordRange: Range;
} | null = null;

// ─── Init ──────────────────────────────────────────────────────────

let initialized = false;
const listenerDocs = new Set<Document>();

/**
 * Initialises the click flow on the given document(s). Idempotent —
 * each document only gets one set of listeners.
 *
 * @param docs Documents to install on. Defaults to the global document
 *             (content scripts). Reader passes its main document plus
 *             each EPUB iframe document as they're rendered.
 */
export function initClickFlow(...docs: Document[]): void {
  const targets = docs.length ? docs : [document];

  if (!initialized) {
    initialized = true;
    ensureHighlightStylesInjected();
    void ensureDictionaryLoaded().catch((err) => {
      console.error("[click-flow] Failed to load CC-CEDICT:", err);
    });
    if (isTranslatorAvailable()) {
      void prewarmTranslator();
    }

    setClickPopupDismissHandler(() => {
      clearAllHighlights();
      cancelSpeaking();
      currentSentenceAnchor = null;
    });
    setClickPopupSpeakHandler(handleSpeak);
    void ensureVoicesLoaded();

    if (!sentenceProvider) {
      // Default: route through the service worker.
      sentenceProvider = defaultServiceWorkerProvider;
      chrome.runtime.onMessage.addListener(onMessage);
    }
  }

  for (const doc of targets) {
    if (listenerDocs.has(doc)) continue;
    listenerDocs.add(doc);
    doc.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
    doc.addEventListener("click", onClick, { capture: true });
    doc.addEventListener("keydown", onKeyDown, { capture: true });
  }
}

/** Removes click-flow listeners from a document (e.g. iframe unload). */
export function removeClickFlowListeners(doc: Document): void {
  if (!listenerDocs.has(doc)) return;
  doc.removeEventListener("mousemove", onMouseMove, { capture: true } as EventListenerOptions);
  doc.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
  doc.removeEventListener("keydown", onKeyDown, { capture: true } as EventListenerOptions);
  listenerDocs.delete(doc);
}

/**
 * Default sentence-translation provider — sends the request to the
 * service worker via chrome.runtime.sendMessage. Used by content
 * scripts.
 */
function defaultServiceWorkerProvider(args: {
  sentence: string;
  pinyinStyle: PinyinStyle;
  requestId: number;
  onResponse: (msg: SentenceTranslateResponseLLM) => void;
  onError: (msg: { error: string; code: string }) => void;
}): void {
  // Route the response through the chrome.runtime.onMessage listener
  // installed in initClickFlow; no extra wiring needed here.
  chrome.runtime.sendMessage({
    type: "SENTENCE_TRANSLATE_REQUEST",
    sentence: args.sentence,
    pinyinStyle: args.pinyinStyle,
    requestId: args.requestId,
  });
}

// ─── Mouse move (hover preview) ────────────────────────────────────

let pendingHoverFrame = 0;
let lastHoverEvent: MouseEvent | null = null;

function onMouseMove(ev: MouseEvent): void {
  if (!settings.clickFlowEnabled) return;
  if (!highlightApiAvailable()) return;

  // Ignore moves over our own popup so the hover doesn't churn while the
  // user reads it.
  const host = getPopupHostElement();
  if (host && host.contains(ev.target as Node)) {
    setHoverHighlight(null);
    return;
  }

  // Opt-out zone: any ancestor marked [data-no-clickflow] (e.g. the
  // reader's bookmark sidebar) is excluded so its own buttons stay
  // clickable when they happen to contain Chinese text.
  if (isInNoClickflowZone(ev.target)) {
    setHoverHighlight(null);
    return;
  }

  lastHoverEvent = ev;
  if (pendingHoverFrame) return;
  pendingHoverFrame = requestAnimationFrame(() => {
    pendingHoverFrame = 0;
    const e = lastHoverEvent;
    lastHoverEvent = null;
    if (!e) return;
    handleHover(e);
  });
}

function handleHover(ev: MouseEvent): void {
  const doc = sourceDocFromEvent(ev);
  const caret = caretFromPoint(ev.clientX, ev.clientY, doc);
  if (!caret || caret.kind !== "text") {
    setHoverHighlight(null);
    return;
  }

  const range = previewRangeForCaret(caret);
  setHoverHighlight(range);
}

/** Returns the document an event originated from. For iframe events
 *  this is the iframe's document, not the parent's. */
function sourceDocFromEvent(ev: Event): Document {
  const target = ev.target as Node | null;
  return target?.ownerDocument ?? document;
}

/** True when the event target is inside an ancestor opted out of
 *  click-flow via the `data-no-clickflow` attribute. Used by the
 *  reader's bookmark sidebar so rows containing Chinese text remain
 *  clickable instead of triggering a word lookup. */
function isInNoClickflowZone(target: EventTarget | null): boolean {
  const node = target as Node | null;
  if (!node) return false;
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return !!el?.closest?.("[data-no-clickflow]");
}

/**
 * Builds the range that should be hover-highlighted for a caret position.
 * Uses LLM word boundaries when the surrounding sentence is Hot;
 * otherwise CC-CEDICT longest-match; otherwise a single-character span.
 */
function previewRangeForCaret(caret: CaretPosition): Range | null {
  const text = caret.text;
  const offset = caret.offset;
  if (offset >= text.length) return null;
  if (!containsChinese(text[offset])) return null;

  // Hot path: if we have an LLM segmentation for the sentence the caret
  // lives in, use those boundaries.
  const ownerDoc = (caret.node as Text).ownerDocument ?? document;
  const sentence = detectSentence(caret.node as Text, offset, ownerDoc);
  if (sentence) {
    const state = sentenceStates.get(sentence.text);
    if (state && state.kind === "hot") {
      const slot = findLlmWordAtOffset(state.words, sentence.text, offset, text);
      if (slot) {
        return buildTextRange(
          caret.node as Text,
          slot.startInTextNode,
          slot.endInTextNode,
        );
      }
    }
  }

  // Bootstrap: CC-CEDICT longest-match.
  if (isDictionaryReady()) {
    const slice = text.slice(offset);
    const hit = findLongest(slice);
    if (hit) {
      return buildTextRange(
        caret.node as Text,
        offset,
        offset + hit.length,
      );
    }
  }

  // Fallback: single-character preview.
  return buildTextRange(caret.node as Text, offset, offset + 1);
}

interface LlmSlot {
  word: LLMSentenceWord;
  startInTextNode: number;
  endInTextNode: number;
}

/**
 * Maps the caret's text-node offset to the LLM word it falls inside.
 *
 * The LLM segmentation is over the *sentence string*, but the caret
 * offset is into the *text node*. They line up only when the whole
 * sentence is in one text node — which is the common case but not
 * guaranteed. For a simple, robust mapping we find the offset of the
 * sentence in the text node first, then walk LLM words.
 */
function findLlmWordAtOffset(
  words: LLMSentenceWord[],
  sentence: string,
  caretOffsetInTextNode: number,
  textNodeData: string,
): LlmSlot | null {
  const sentStart = textNodeData.indexOf(sentence);
  if (sentStart < 0) return null;
  const within = caretOffsetInTextNode - sentStart;
  if (within < 0 || within >= sentence.length) return null;

  let cursor = 0;
  for (const w of words) {
    const next = cursor + w.text.length;
    if (within >= cursor && within < next) {
      return {
        word: w,
        startInTextNode: sentStart + cursor,
        endInTextNode: sentStart + next,
      };
    }
    cursor = next;
  }
  return null;
}

// ─── Click (commit) ────────────────────────────────────────────────

function onClick(ev: MouseEvent): void {
  if (!settings.clickFlowEnabled) return;
  // Let clicks inside our own popup keep their default behaviour.
  const host = getPopupHostElement();
  if (host && host.contains(ev.target as Node)) return;

  // Opt-out zone: any ancestor marked [data-no-clickflow] is left
  // alone so its own click handlers (e.g. the bookmark list's "jump
  // to bookmark" rows) fire normally even when the click lands on a
  // Chinese character inside that subtree.
  if (isInNoClickflowZone(ev.target)) return;

  // We only handle primary-button clicks.
  if (ev.button !== 0) return;

  const doc = sourceDocFromEvent(ev);
  const caret = caretFromPoint(ev.clientX, ev.clientY, doc);
  if (!caret || caret.kind !== "text") return;
  if (caret.offset >= caret.text.length) return;
  if (!containsChinese(caret.text[caret.offset])) return;

  // We are committing — prevent the page's own click handlers (links,
  // page-level menus) from running.
  ev.preventDefault();
  ev.stopPropagation();

  void commitClick(caret).catch((err) => {
    console.error("[click-flow] commit failed:", err);
  });
}

async function commitClick(caret: CaretPosition): Promise<void> {
  // detectSentence creates a Range — must be the *same* document the
  // text node belongs to (iframe doc when this fires from EPUB).
  const ownerDoc = (caret.node as Text).ownerDocument ?? document;
  const sentence = detectSentence(caret.node as Text, caret.offset, ownerDoc);
  if (!sentence) return;

  // Pick the word range using current state for this sentence.
  const wordRange = pickWordRangeOnClick(caret, sentence);
  if (!wordRange) return;

  const word = wordRange.toString();
  if (!word) return;

  // ── Same-sentence retarget ────────────────────────────────────
  //
  // If the popup is already open for THIS sentence, clicking a
  // different word just retargets the word tier (and the
  // ::highlight(pt-word) range) without re-opening, re-firing the
  // LLM, or losing the pinyin strip / sentence translation that's
  // already on screen. Same-word click is a no-op (avoids flashing
  // the popup on accidental double-clicks).
  if (isPopupOpen() && getCurrentSentence() === sentence.text) {
    if (getCurrentWordChars() === word) {
      // Already showing this exact word; nothing to do.
      setHoverHighlight(null);
      return;
    }
    setWordHighlight(wordRange);
    setHoverHighlight(null);
    // Update the anchor so TTS restores to the new clicked word.
    if (currentSentenceAnchor) {
      currentSentenceAnchor.wordRange = wordRange.cloneRange();
    }

    const state = sentenceStates.get(sentence.text);
    let wordData: { chars: string; pinyin: string; gloss: string };
    if (state && state.kind === "hot") {
      const match = state.words.find((w) => w.text === word);
      wordData = match
        ? { chars: match.text, pinyin: match.pinyin, gloss: match.gloss }
        : buildBootstrapWord(word);
    } else {
      wordData = buildBootstrapWord(word);
    }
    retargetWord(wordData, sentence.text);
    refreshPinyinStripActiveWord(word);
    return;
  }

  // ── Fresh-sentence open ───────────────────────────────────────
  const bootstrapWord = buildBootstrapWord(word);

  setWordHighlight(wordRange);
  setSentenceHighlight(sentence.range);
  // Hover follows the cursor afterwards; clear the stale hover paint.
  setHoverHighlight(null);
  // Cancel any TTS still running from a previous popup.
  cancelSpeaking();

  // Stash the sentence anchor so TTS can rebuild per-word ranges.
  // We only support TTS when the sentence lives inside a single text
  // node (which is the common case); for cross-node sentences the
  // restore-range works but per-word highlighting may be approximate.
  const startContainer = sentence.range.startContainer;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    currentSentenceAnchor = {
      textNode: startContainer as Text,
      sentenceStartOffset: sentence.range.startOffset,
      wordRange: wordRange.cloneRange(),
    };
  } else {
    currentSentenceAnchor = null;
  }

  const expectLlm = settings.llmEnabled;
  const expectBootstrapTranslation = isTranslatorAvailable();

  const wordRect = safeRangeRect(wordRange);
  const sentenceRect = safeRangeRect(sentence.range);
  showBootstrap({
    word: bootstrapWord,
    sentence: sentence.text,
    sentenceWords: bootstrapSentenceWords(sentence.text),
    anchorRect: wordRect,
    sentenceRect,
    theme: settings.theme,
    fontSize: settings.fontSize,
    expectLlm,
    expectBootstrapTranslation,
    pinyinStyle: settings.pinyinStyle,
    // Render the speaker button when TTS is enabled in settings.
    // Don't gate on hasChineseVoice() at click time — voices in Chrome
    // load asynchronously and the first popup often opens before the
    // voiceschanged event fires. We just render the button; if no
    // Chinese voice is ever available, speakSentence() falls through
    // (the SpeechSynthesisUtterance with lang="zh-CN" will use the
    // closest match or be silent — no crash, no error).
    ttsEnabled: settings.ttsEnabled,
  });

  currentSentence = sentence.text;
  const requestId = ++currentRequestId;

  const existingState = sentenceStates.get(sentence.text);
  if (!existingState) {
    sentenceStates.set(sentence.text, { kind: "bootstrap" });
  }

  // If the sentence is already Hot (cached from earlier in this tab),
  // skip both the Bootstrap translator and the network round-trip.
  if (existingState && existingState.kind === "hot") {
    applyHotData(existingState.words, existingState.translation, sentence.text, word);
    return;
  }

  // Bootstrap sentence translation via on-device translator (when
  // available). Doesn't affect state — we don't promote to Hot here.
  if (expectBootstrapTranslation) {
    void translateChineseToEnglish(sentence.text).then((res) => {
      if (!isShowingSentence(sentence.text)) return;
      // Don't overwrite an LLM result if it landed first.
      const state = sentenceStates.get(sentence.text);
      if (state && state.kind === "hot") return;
      if (res.ok) setSentenceText(res.translation, "bootstrap");
    });
  }

  // Fire the host-integration commit hook (reader uses this for
  // bookmark-anchor capture).
  if (onCommit && currentSentenceAnchor) {
    try {
      onCommit({
        sentence: sentence.text,
        word,
        textNode: currentSentenceAnchor.textNode,
        offset: caret.offset,
      });
    } catch (err) {
      console.error("[click-flow] commit hook threw:", err);
    }
  }

  // Ask the LLM for the Hot upgrade through the registered provider.
  if (expectLlm && sentenceProvider) {
    sentenceProvider({
      sentence: sentence.text,
      pinyinStyle: settings.pinyinStyle,
      requestId,
      onResponse: (msg) => handleSentenceLLM(msg),
      onError: (e) => {
        if (currentSentence === sentence.text && requestId === currentRequestId) {
          setSentenceError(e.error);
        }
      },
    });
  }
}

function pickWordRangeOnClick(
  caret: CaretPosition,
  sentence: SentenceResult,
): Range | null {
  const node = caret.node as Text;
  const text = caret.text;
  const offset = caret.offset;

  const state = sentenceStates.get(sentence.text);
  if (state && state.kind === "hot") {
    const slot = findLlmWordAtOffset(state.words, sentence.text, offset, text);
    if (slot) {
      return buildTextRange(node, slot.startInTextNode, slot.endInTextNode);
    }
  }

  if (isDictionaryReady()) {
    const slice = text.slice(offset);
    const hit = findLongest(slice);
    if (hit) {
      return buildTextRange(node, offset, offset + hit.length);
    }
  }

  return buildTextRange(node, offset, offset + 1);
}

/**
 * jsdom (used in tests) doesn't implement Range.getBoundingClientRect.
 * Real browsers do. This helper returns a zero rect when the API is
 * absent so positioning code can run without throwing in tests; in
 * real browsers the actual rect is returned.
 *
 * For ranges that live inside an iframe (EPUB), the rect is relative
 * to the iframe's viewport; the popup lives in the parent document so
 * we add the iframe's bounding offset before returning. Result: the
 * caller always gets parent-document coords.
 */
function safeRangeRect(range: Range): DOMRect {
  const fn = (range as Range & { getBoundingClientRect?: () => DOMRect })
    .getBoundingClientRect;
  let raw: DOMRect | null = null;
  if (typeof fn === "function") {
    try {
      raw = fn.call(range);
    } catch {
      raw = null;
    }
  }
  if (!raw) return new DOMRect(0, 0, 0, 0);

  // Translate to parent coords if range lives in an iframe.
  const doc = range.startContainer.ownerDocument;
  if (!doc || doc === document) return raw;
  const frameEl = (doc.defaultView as Window & { frameElement?: Element | null })
    ?.frameElement;
  if (!frameEl) return raw;
  const frameFn = (frameEl as Element & { getBoundingClientRect?: () => DOMRect })
    .getBoundingClientRect;
  if (typeof frameFn !== "function") return raw;
  let frameRect: DOMRect;
  try {
    frameRect = frameFn.call(frameEl);
  } catch {
    return raw;
  }
  return new DOMRect(
    raw.left + frameRect.left,
    raw.top + frameRect.top,
    raw.width,
    raw.height,
  );
}

/**
 * Builds the initial pinyin-strip word list (Bootstrap state) by
 * walking the sentence with CC-CEDICT longest-match. Returns just
 * Chinese words; punctuation/non-CJK are filtered later by the strip
 * renderer.
 */
function bootstrapSentenceWords(sentence: string): StripWord[] {
  if (!isDictionaryReady()) return [];
  return segmentSentence(sentence, settings.pinyinStyle);
}

function buildBootstrapWord(word: string): {
  chars: string;
  pinyin: string;
  gloss: string;
} {
  const entries = lookupExact(word);
  if (entries && entries.length > 0) {
    const hit = { word, length: word.length, entries };
    return bootstrapWordFromHit(hit, settings.pinyinStyle);
  }
  // Single character that wasn't in the dictionary; pick a degraded
  // representation so the popup still has something useful.
  return {
    chars: word,
    pinyin: "",
    gloss: isDictionaryReady()
      ? "(no dictionary entry)"
      : "(loading dictionary…)",
  };
}

// ─── Incoming messages ─────────────────────────────────────────────

function onMessage(message: ExtensionMessage): void {
  if (message.type === "SENTENCE_TRANSLATE_RESPONSE_LLM") {
    handleSentenceLLM(message);
    return;
  }
  if (message.type === "SENTENCE_TRANSLATE_ERROR") {
    if (message.requestId === currentRequestId && currentSentence === message.sentence) {
      setSentenceError(message.error);
    }
    return;
  }
}

function handleSentenceLLM(msg: SentenceTranslateResponseLLM): void {
  // Cache regardless of whether it's still showing — we want it for
  // future clicks in this tab.
  sentenceStates.set(msg.sentence, {
    kind: "hot",
    words: msg.words,
    translation: msg.translation,
  });

  if (!isShowingSentence(msg.sentence)) return;
  if (msg.requestId !== currentRequestId) return;

  // Refresh the pinyin strip with LLM contextual segmentation.
  const popupWord = currentClickedWord() ?? "";
  upgradeStripWithLlm(msg.words, popupWord);

  // Find the clicked word in the LLM's segmentation. We don't know the
  // caret offset anymore at this point; we use the word currently shown
  // in the popup as the lookup key.
  if (popupWord) {
    const match = msg.words.find((w) => w.text === popupWord);
    if (match) {
      upgradeWord({
        chars: match.text,
        pinyin: match.pinyin || "",
        gloss: match.gloss,
      });
    }
  }

  setSentenceText(msg.translation, "llm");
}

function currentClickedWord(): string | null {
  // Read the chars from the popup's word header. The popup renders it
  // via `.pt-chars` so we extract from there. This avoids threading
  // another piece of state through commitClick.
  const host = getPopupHostElement();
  if (!host || !host.shadowRoot) return null;
  const charsEl = host.shadowRoot.querySelector(".pt-popup .pt-chars");
  return charsEl ? charsEl.textContent : null;
}

function applyHotData(
  words: LLMSentenceWord[],
  translation: string,
  sentence: string,
  clickedWord: string,
): void {
  upgradeStripWithLlm(words, clickedWord);
  const match = words.find((w) => w.text === clickedWord);
  if (match) {
    upgradeWord({
      chars: match.text,
      pinyin: match.pinyin || formatPinyin("", settings.pinyinStyle),
      gloss: match.gloss,
    });
  }
  setSentenceText(translation, "llm");
  // Make sure state is up to date.
  sentenceStates.set(sentence, { kind: "hot", words, translation });
}

// ─── TTS ───────────────────────────────────────────────────────────

/**
 * Fired when the user clicks the speaker button on the popup.
 * Constructs the per-word timeline (using LLM segmentation when Hot,
 * CC-CEDICT longest-match otherwise) and hands it to speakSentence.
 */
function handleSpeak(sentence: string): void {
  if (!currentSentenceAnchor) return;
  if (currentSentence !== sentence) return;

  const state = sentenceStates.get(sentence);
  let words: Array<{ text: string; pinyin: string }> = [];
  if (state && state.kind === "hot") {
    // Skip non-Chinese punctuation entries; their offsets stay implicit
    // because the legacy timer model is char-rate-based and pinyin is
    // unused for highlighting.
    words = state.words.map((w) => ({ text: w.text, pinyin: w.pinyin }));
  } else {
    words = bootstrapSentenceWords(sentence);
  }

  speakSentence({
    text: sentence,
    words,
    textNode: currentSentenceAnchor.textNode,
    sentenceStartOffset: currentSentenceAnchor.sentenceStartOffset,
    restoreRange: currentSentenceAnchor.wordRange,
  });
}

// ─── Keyboard ──────────────────────────────────────────────────────

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    // Only dismiss if our popup is actually showing.
    const host = getPopupHostElement();
    if (host && host.shadowRoot && host.shadowRoot.querySelector(".pt-popup")) {
      dismissPopup();
    }
  }
}

// ─── External entry points (right-click / shortcut / OCR strip) ───

/**
 * Synthesises a click on the first Chinese character of `selection`.
 * Used by the right-click context menu and the Alt+Shift+P shortcut so
 * the legacy "I have a selection, translate it" muscle memory still
 * works under the click-flow.
 */
export function triggerFromSelection(selection: Selection | null): void {
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const textNode = node as Text;

  // Find the first Chinese char at-or-after the selection's start
  // offset within this text node.
  let off = range.startOffset;
  const data = textNode.data;
  while (off < data.length && !/[㐀-䶿一-鿿]/.test(data[off])) {
    off++;
  }
  if (off >= data.length) return;

  void commitClick({
    kind: "text",
    node: textNode,
    offset: off,
    text: data,
  }).catch((err) => {
    console.error("[click-flow] triggerFromSelection failed:", err);
  });
}

/**
 * Synthesises a click on the first Chinese character inside `textNode`.
 * Used by the OCR clickable result strip so the click flow runs against
 * OCR'd text the same way it would against page text.
 */
export function triggerFromTextNode(textNode: Text, offset = 0): void {
  const data = textNode.data;
  let off = offset;
  while (off < data.length && !/[㐀-䶿一-鿿]/.test(data[off])) {
    off++;
  }
  if (off >= data.length) return;
  void commitClick({
    kind: "text",
    node: textNode,
    offset: off,
    text: data,
  }).catch((err) => {
    console.error("[click-flow] triggerFromTextNode failed:", err);
  });
}

// ─── Manual dismiss (used by the content script when a click outside
//     the popup happens through a non-text path) ────────────────────

export function dismissClickFlow(): void {
  dismissPopup();
}

// Suppress unused-import warning for formatPinyin if the LLM always
// returns formatted pinyin. We keep the import because the fallback
// branch above may reference it and tree-shake on the production build.
void formatPinyin;
