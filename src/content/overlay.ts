/**
 * Shadow DOM overlay for displaying pinyin annotations, translations,
 * and per-word definition cards over any webpage.
 *
 * All rendering lives inside a Shadow DOM attached to #hg-extension-root,
 * so the overlay's styles never leak into or inherit from the host page.
 * This module is DOM-only -- no Chrome extension APIs -- making it
 * testable with jsdom.
 *
 * Lifecycle (driven by the content script in Step 7):
 *   1. showOverlay()   -- Phase 1: local pinyin + loading indicator
 *   2. updateOverlay() -- Phase 2: LLM words + translation
 *   3. dismissOverlay() -- user clicks outside or presses Escape
 *
 * See: SPEC.md Section 7 "UI/UX Design",
 *      IMPLEMENTATION_GUIDE.md Step 6.
 */

import type { WordData, Theme } from "../shared/types";

import overlayStyles from "./overlay.css?inline";

// ─── Module state ──────────────────────────────────────────────────
let shadowRoot: ShadowRoot | null = null;
let hostElement: HTMLElement | null = null;
let voicesReady = false;
let vocabCallback:
  | ((
      word: { chars: string; pinyin: string; definition: string },
      context: string,
    ) => void)
  | null = null;

/**
 * Sentence-bounded context for the currently displayed overlay,
 * stashed by content.ts via setOverlayContext() right before
 * showOverlay() runs. The "+ Vocab" button in each card forwards
 * this string to vocabCallback so the service worker can run it
 * through the example-quality gate. Reset to "" between lookups so
 * a stale paragraph from a prior selection is never paired with a
 * fresh word.
 */
let currentContext = "";

/**
 * Registers a callback invoked when the user clicks "+ Vocab" in a
 * definition card. The callback receives the word plus the captured
 * page context (sentence-bounded surroundings of the original
 * selection) so the service worker can attach it as an example
 * sentence when the quality gate passes.
 */
export function setVocabCallback(
  cb: (
    word: { chars: string; pinyin: string; definition: string },
    context: string,
  ) => void,
): void {
  vocabCallback = cb;
}

/**
 * Stashes the page context that surrounds the current selection so
 * the "+ Vocab" click handler can ship it alongside the word. Called
 * by content.ts immediately before showOverlay so every card the
 * user opens carries the latest context. Pass "" to clear (e.g. on
 * dismiss).
 */
export function setOverlayContext(context: string): void {
  currentContext = context;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Creates (or reuses) the Shadow DOM host element in document.body.
 * Injects overlay.css into the shadow root so styles are fully isolated
 * from the host page. (SPEC.md Section 3 "Shadow DOM")
 */
export function createOverlay(): ShadowRoot {
  const existing = document.getElementById("hg-extension-root");
  if (existing?.shadowRoot) {
    hostElement = existing;
    shadowRoot = existing.shadowRoot;
    return shadowRoot;
  }

  hostElement = document.createElement("div");
  hostElement.id = "hg-extension-root";
  document.body.appendChild(hostElement);

  shadowRoot = hostElement.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = overlayStyles;
  shadowRoot.appendChild(style);

  return shadowRoot;
}

/**
 * Renders the Phase 1 overlay: ruby-annotated pinyin with a loading
 * indicator in the translation area (replaced by updateOverlay once
 * the LLM responds). Positions near the selection rect.
 *
 * When llmEnabled is false, the .hg-translation row is omitted
 * entirely -- no Phase-2 message will ever arrive, so showing a
 * permanent "Loading translation..." indicator would be misleading.
 * The overlay collapses up around the pinyin row instead.
 *
 * fontSize controls the overlay's character size in px; pinyin and
 * translation text are derived from it via CSS calc() multipliers in
 * overlay.css. Defaults to 16 to match the historical hardcoded sizing.
 * (SPEC.md Section 5 "Two-Phase Rendering", Phase 1)
 */
export function showOverlay(
  words: WordData[],
  rect: DOMRect,
  theme: Theme,
  ttsEnabled = false,
  llmEnabled = true,
  fontSize = 16,
): void {
  const root = createOverlay();

  if (hostElement) {
    hostElement.style.setProperty("--hg-font-size", `${fontSize}px`);
  }

  const styleEl = root.querySelector("style");
  while (root.lastChild && root.lastChild !== styleEl) {
    root.removeChild(root.lastChild);
  }

  const resolvedTheme = resolveTheme(theme);

  const overlay = document.createElement("div");
  overlay.className = `hg-overlay hg-${resolvedTheme}`;

  const closeBtn = document.createElement("button");
  closeBtn.className = "hg-close-btn";
  closeBtn.textContent = "\u00D7";
  closeBtn.addEventListener("click", dismissOverlay);
  overlay.appendChild(closeBtn);

  const pinyinRow = document.createElement("div");
  pinyinRow.className = "hg-pinyin-row";
  pinyinRow.innerHTML = renderRubyText(words);
  attachWordClickHandlers(pinyinRow, overlay);
  appendTtsButton(pinyinRow, words, ttsEnabled);
  overlay.appendChild(pinyinRow);

  if (llmEnabled) {
    const translation = document.createElement("div");
    translation.className = "hg-translation hg-loading";
    translation.textContent = "Loading translation\u2026";
    overlay.appendChild(translation);
    appendLlmStatus(overlay);
  }

  root.appendChild(overlay);

  const pos = calculatePosition(rect, 500, 300);
  overlay.style.top = `${pos.top}px`;
  overlay.style.left = `${pos.left}px`;
}

/**
 * Replaces Phase 1 content with LLM-enhanced data: contextually
 * disambiguated pinyin, per-word definitions, and a full sentence
 * translation. Words become clickable to reveal definition cards.
 * (SPEC.md Section 5 "Two-Phase Rendering", Phase 2)
 */
export function updateOverlay(
  words: Required<WordData>[],
  translation: string,
  ttsEnabled = false,
): void {
  if (!shadowRoot) return;

  const overlay = shadowRoot.querySelector(".hg-overlay");
  if (!overlay) return;

  const pinyinRow = overlay.querySelector(".hg-pinyin-row");
  if (pinyinRow) {
    pinyinRow.innerHTML = renderRubyText(words);
    attachWordClickHandlers(pinyinRow as HTMLElement, overlay as HTMLElement);
    appendTtsButton(pinyinRow as HTMLElement, words, ttsEnabled);
  }

  const translationEl = overlay.querySelector(".hg-translation");
  if (translationEl) {
    translationEl.classList.remove("hg-loading");
    translationEl.textContent = translation;
  }
  clearLlmStatus(overlay as HTMLElement);
}

/**
 * Phase 2 update for the non-LLM fallback path: full sentence
 * translation from Chrome's on-device Translator API in the
 * `.hg-translation` row, and per-segment translations surfaced via
 * the same definition-card mechanism that LLM definitions use.
 *
 * Visually almost identical to updateOverlay() with two intentional
 * differences:
 *  - Each ruby is tagged with `data-source="fallback"` so the click
 *    handler labels the popped card as a "Translation" rather than
 *    a contextual definition; the on-device API doesn't disambiguate
 *    senses the way the LLM does and we don't want to mislead the
 *    user about the depth of analysis.
 *  - The translation row is created on the fly if Phase 1 omitted it
 *    (e.g. when llmEnabled was false at showOverlay() time and the
 *    caller didn't expect the fallback path to be available).
 */
export function updateOverlayFallback(
  words: Required<WordData>[],
  translation: string,
  ttsEnabled = false,
): void {
  if (!shadowRoot) return;

  const overlay = shadowRoot.querySelector(".hg-overlay");
  if (!overlay) return;

  const pinyinRow = overlay.querySelector(".hg-pinyin-row");
  if (pinyinRow) {
    pinyinRow.innerHTML = renderRubyText(words, "fallback");
    attachWordClickHandlers(pinyinRow as HTMLElement, overlay as HTMLElement);
    appendTtsButton(pinyinRow as HTMLElement, words, ttsEnabled);
  }

  let translationEl = overlay.querySelector(".hg-translation");
  if (!translationEl) {
    translationEl = document.createElement("div");
    translationEl.className = "hg-translation";
    overlay.appendChild(translationEl);
  }
  translationEl.classList.remove("hg-loading");
  translationEl.classList.add("hg-translation-fallback");
  translationEl.textContent = translation;
}

/**
 * Replaces the Phase 1 loading indicator with an error message.
 * The overlay keeps its local pinyin from Phase 1; only the
 * translation area is affected. Used when the LLM call fails
 * or the provider isn't configured.
 * (SPEC.md Section 6 "Fallback Strategy")
 */
export function showOverlayError(message: string): void {
  if (!shadowRoot) return;
  const overlay = shadowRoot.querySelector(".hg-overlay") as HTMLElement | null;
  const el = shadowRoot.querySelector(".hg-translation");
  if (overlay) {
    setLlmStatusError(overlay, message);
  }
  if (el) {
    // If the quick on-device preview has already filled the translation
    // row, preserve it. The LLM failure is shown by the status badge so
    // users still keep the useful fallback translation.
    if (el.classList.contains("hg-translation-fallback")) return;
    el.classList.remove("hg-loading");
    el.textContent = message;
  }
}

/**
 * Appends a muted notice to the overlay when the user's selection
 * exceeded MAX_SELECTION_LENGTH and was truncated before processing.
 * (SPEC.md Section 10.2, IMPLEMENTATION_GUIDE.md Step 8d)
 */
export function showTruncationNotice(): void {
  if (!shadowRoot) return;
  const overlay = shadowRoot.querySelector(".hg-overlay");
  if (!overlay) return;

  const existing = overlay.querySelector(".hg-truncation-notice");
  if (existing) return;

  const notice = document.createElement("div");
  notice.className = "hg-truncation-notice";
  notice.textContent = "Showing results for the first 500 characters.";
  overlay.appendChild(notice);
}

/**
 * Removes the overlay host element from the DOM entirely.
 * Called on click-outside, Escape, or new selection.
 */
export function dismissOverlay(): void {
  if (hostElement?.parentNode) {
    hostElement.parentNode.removeChild(hostElement);
  }
  hostElement = null;
  shadowRoot = null;
}

/**
 * Converts a WordData array into an HTML string of <ruby> elements.
 * Each word carries data attributes for the click-to-define handler.
 * Returns empty string for an empty array.
 *
 * `source` discriminates LLM definitions from on-device fallback
 * translations: when set to "fallback" each ruby gains a
 * `data-source="fallback"` attribute that the click handler reads
 * to label the popped card as a translation rather than a
 * contextual definition.
 * (SPEC.md Section 7 "Ruby annotation HTML structure")
 */
export function renderRubyText(
  words: WordData[],
  source: "llm" | "fallback" = "llm",
): string {
  if (words.length === 0) return "";

  const sourceAttr = source === "fallback" ? ` data-source="fallback"` : "";

  return words
    .map((w) => {
      const defAttr = w.definition
        ? ` data-definition="${escapeAttr(w.definition)}"`
        : "";
      return `<ruby class="hg-word" data-chars="${escapeAttr(w.chars)}" data-pinyin="${escapeAttr(w.pinyin)}"${defAttr}${sourceAttr}>${escapeHtml(w.chars)}<rt>${escapeHtml(w.pinyin)}</rt></ruby>`;
    })
    .join("");
}

/**
 * Pure positioning function: places the overlay below the selection
 * rect with an 8px gap, or above if there isn't enough viewport space
 * below. Clamps horizontally to stay within the viewport.
 * (SPEC.md Section 7 "Overlay Positioning")
 */
export function calculatePosition(
  rect: DOMRect,
  overlayWidth: number,
  overlayHeight: number,
): { top: number; left: number } {
  const gap = 8;
  const vpWidth = window.innerWidth;
  const vpHeight = window.innerHeight;

  const spaceBelow = vpHeight - rect.bottom;
  const spaceAbove = rect.top;
  let top: number;
  if (spaceBelow >= overlayHeight + gap) {
    top = rect.bottom + gap;
  } else if (spaceAbove >= overlayHeight + gap) {
    top = rect.top - overlayHeight - gap;
  } else {
    top = Math.max(gap, vpHeight - overlayHeight - gap);
  }
  top = Math.max(0, Math.min(top, vpHeight - overlayHeight));

  const idealLeft = rect.left + rect.width / 2 - overlayWidth / 2;
  const left = Math.max(0, Math.min(idealLeft, vpWidth - overlayWidth));

  return { top, left };
}

// ─── TTS helpers ───────────────────────────────────────────────────

function ensureVoicesLoaded(): Promise<void> {
  return new Promise((resolve) => {
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

function hasChineseVoice(): boolean {
  const voices = window.speechSynthesis.getVoices();
  return voices.some((v) => v.lang.startsWith("zh"));
}

/**
 * Speaks the selected text as a single natural utterance and drives
 * the karaoke highlight from a setTimeout-scheduled per-word timeline
 * pegged to ~MS_PER_CHAR_AT_RATE_1 ms per Chinese character.
 *
 * Why timers and not `boundary` events: many Chinese voices in Chrome
 * don't fire word-level `boundary` events at all, so a boundary-only
 * implementation left users with audio but no highlight.
 * Why timers and not one-utterance-per-word: per-word utterances sync
 * perfectly but introduce audible micro-pauses between words that
 * break sentence prosody, which the user explicitly wanted preserved.
 *
 * The estimate isn't sample-accurate: drift of a few hundred ms is
 * expected over long sentences, since real cadence varies by voice
 * and content. For short reading-aid selections it tracks the audio
 * closely enough to read along.
 */

// Mid-of-range estimate for Chinese TTS at rate=1.0; the actual
// utterance rate is re-scaled at use time. Don't try to derive this
// from `onend - onstart`: that interval includes the browser's
// trailing silence + event-loop delay (~200-300 ms), so any
// self-calibration loop fed by it inflates the estimate and makes
// the highlight progressively lag the audio.
const MS_PER_CHAR_AT_RATE_1 = 200;

let activeHighlightTimers: number[] = [];

function clearHighlightTimers(): void {
  activeHighlightTimers.forEach((id) => window.clearTimeout(id));
  activeHighlightTimers = [];
}

function clearRubyHighlights(pinyinRow: Element): void {
  pinyinRow
    .querySelectorAll(".hg-tts-active")
    .forEach((r) => r.classList.remove("hg-tts-active"));
}

function speakText(
  btn: HTMLElement,
  words: WordData[],
  pinyinRow: Element,
): void {
  window.speechSynthesis.cancel();
  clearHighlightTimers();
  clearRubyHighlights(pinyinRow);

  if (words.length === 0) return;

  const text = words.map((w) => w.chars).join("");
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 0.85;

  const rubies = pinyinRow.querySelectorAll<HTMLElement>("ruby.hg-word");
  const msPerChar = MS_PER_CHAR_AT_RATE_1 / utterance.rate;

  utterance.onstart = () => {
    btn.classList.add("hg-tts-speaking");

    let cursor = 0;
    words.forEach((w, i) => {
      const offsetMs = cursor * msPerChar;
      const id = window.setTimeout(() => {
        clearRubyHighlights(pinyinRow);
        if (i < rubies.length) rubies[i].classList.add("hg-tts-active");
      }, offsetMs);
      activeHighlightTimers.push(id);
      cursor += w.chars.length;
    });
  };

  utterance.onend = () => {
    btn.classList.remove("hg-tts-speaking");
    clearHighlightTimers();
    clearRubyHighlights(pinyinRow);
  };
  utterance.onerror = () => {
    btn.classList.remove("hg-tts-speaking");
    clearHighlightTimers();
    clearRubyHighlights(pinyinRow);
  };

  window.speechSynthesis.speak(utterance);
}

/**
 * Creates a TTS button and appends it to the pinyin row.
 * Skips rendering when TTS is disabled or no Chinese voice is available.
 */
function appendTtsButton(
  pinyinRow: Element,
  words: WordData[],
  ttsEnabled: boolean,
): void {
  if (!ttsEnabled) return;

  if (!voicesReady) {
    ensureVoicesLoaded().then(() => {
      if (hasChineseVoice()) {
        appendTtsBtnElement(pinyinRow, words);
      }
    });
    return;
  }

  if (!hasChineseVoice()) return;
  appendTtsBtnElement(pinyinRow, words);
}

function appendTtsBtnElement(pinyinRow: Element, words: WordData[]): void {
  const existing = pinyinRow.querySelector(".hg-tts-btn");
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.className = "hg-tts-btn";
  btn.title = "Play pronunciation";
  btn.setAttribute("aria-label", "Play pronunciation");
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
</svg>`;
  btn.addEventListener("click", () => {
    speakText(btn, words, pinyinRow);
  });
  pinyinRow.appendChild(btn);
}

// ─── Internal helpers ──────────────────────────────────────────────

function appendLlmStatus(overlay: HTMLElement): void {
  const status = document.createElement("div");
  status.className = "hg-llm-status hg-llm-loading";
  status.title = "LLM translation is still running.";
  status.setAttribute("role", "status");
  status.setAttribute("aria-label", "LLM translation is still running");
  overlay.appendChild(status);
}

function clearLlmStatus(overlay: HTMLElement): void {
  overlay.querySelector(".hg-llm-status")?.remove();
}

function setLlmStatusError(overlay: HTMLElement, message: string): void {
  let status = overlay.querySelector(".hg-llm-status") as HTMLElement | null;
  if (!status) {
    status = document.createElement("div");
    status.className = "hg-llm-status";
    overlay.appendChild(status);
  }
  status.classList.remove("hg-llm-loading");
  status.classList.add("hg-llm-error");
  status.textContent = "!";
  status.title = message;
  status.dataset.error = message;
  status.tabIndex = 0;
  status.setAttribute("role", "status");
  status.setAttribute("aria-label", message);
}

/**
 * Resolves the user's Theme preference to a concrete CSS class
 * suffix used on .hg-overlay (.hg-light / .hg-dark / .hg-sepia).
 *
 * "auto" collapses via prefers-color-scheme between light and dark
 * (sepia is never an OS-driven default). Sepia is now a fully shared
 * theme value -- when set, the in-page overlay tints to match the
 * popup, library, and reader.
 */
function resolveTheme(theme: Theme): "light" | "dark" | "sepia" {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Attaches click handlers to .hg-word elements for definition toggle. */
function attachWordClickHandlers(
  container: Element,
  overlay: Element,
): void {
  container.querySelectorAll(".hg-word").forEach((el) => {
    el.addEventListener("click", () => {
      handleWordClick(el as HTMLElement, overlay as HTMLElement);
    });
  });
}

/**
 * Toggles a definition card below the clicked word. If the card is
 * already visible for this word, removes it. Otherwise creates a new
 * card with the word's data-definition content.
 *
 * When the ruby was rendered with `data-source="fallback"` (i.e. the
 * gloss came from Chrome's on-device Translator, not the LLM), the
 * card carries a small "(translation)" note so the user understands
 * they're seeing a literal word translation, not a context-aware
 * definition. The "+ Vocab" button still appears so the word can be
 * saved with the gloss as its definition.
 */
function handleWordClick(wordEl: HTMLElement, overlay: HTMLElement): void {
  const definition = wordEl.getAttribute("data-definition");
  if (!definition) return;

  const chars = wordEl.getAttribute("data-chars") ?? "";
  const pinyin = wordEl.getAttribute("data-pinyin") ?? "";
  const isFallback = wordEl.getAttribute("data-source") === "fallback";

  const existingCard = overlay.querySelector(".hg-definition-card");
  if (
    existingCard &&
    existingCard.getAttribute("data-for") === chars
  ) {
    existingCard.remove();
    return;
  }

  if (existingCard) existingCard.remove();

  const card = document.createElement("div");
  card.className = "hg-definition-card";
  card.setAttribute("data-for", chars);

  const textNode = document.createTextNode(`${chars} — ${definition}`);
  card.appendChild(textNode);

  if (isFallback) {
    const note = document.createElement("span");
    note.className = "hg-fallback-note";
    note.textContent = " (translation)";
    card.appendChild(note);
  }

  if (vocabCallback) {
    const btn = document.createElement("button");
    btn.className = "hg-add-vocab-btn";
    btn.textContent = "+ Vocab";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      vocabCallback!({ chars, pinyin, definition }, currentContext);
      btn.textContent = "Added";
      btn.classList.add("hg-added");
      btn.disabled = true;
    });
    card.appendChild(btn);
  }

  const pinyinRow = overlay.querySelector(".hg-pinyin-row");
  if (pinyinRow?.nextSibling) {
    overlay.insertBefore(card, pinyinRow.nextSibling);
  } else {
    overlay.appendChild(card);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
