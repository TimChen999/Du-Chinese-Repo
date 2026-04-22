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
let vocabCallback: ((word: { chars: string; pinyin: string; definition: string }) => void) | null = null;

/**
 * Registers a callback invoked when the user clicks "Add to Vocab"
 * in a definition card. Keeps overlay.ts free of Chrome extension APIs.
 */
export function setVocabCallback(
  cb: (word: { chars: string; pinyin: string; definition: string }) => void,
): void {
  vocabCallback = cb;
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
  const el = shadowRoot.querySelector(".hg-translation");
  if (el) {
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
 * (SPEC.md Section 7 "Ruby annotation HTML structure")
 */
export function renderRubyText(words: WordData[]): string {
  if (words.length === 0) return "";

  return words
    .map((w) => {
      const defAttr = w.definition
        ? ` data-definition="${escapeAttr(w.definition)}"`
        : "";
      return `<ruby class="hg-word" data-chars="${escapeAttr(w.chars)}" data-pinyin="${escapeAttr(w.pinyin)}"${defAttr}>${escapeHtml(w.chars)}<rt>${escapeHtml(w.pinyin)}</rt></ruby>`;
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

function speakText(text: string, btn: HTMLElement): void {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 0.85;
  utterance.onstart = () => btn.classList.add("hg-tts-speaking");
  utterance.onend = () => btn.classList.remove("hg-tts-speaking");
  utterance.onerror = () => btn.classList.remove("hg-tts-speaking");
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
  btn.setAttribute("data-text", words.map((w) => w.chars).join(""));
  btn.addEventListener("click", () => {
    speakText(btn.getAttribute("data-text") ?? "", btn);
  });
  pinyinRow.appendChild(btn);
}

// ─── Internal helpers ──────────────────────────────────────────────

/** Resolves "auto" theme to concrete "light" or "dark" via matchMedia. */
function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
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
 */
function handleWordClick(wordEl: HTMLElement, overlay: HTMLElement): void {
  const definition = wordEl.getAttribute("data-definition");
  if (!definition) return;

  const chars = wordEl.getAttribute("data-chars") ?? "";
  const pinyin = wordEl.getAttribute("data-pinyin") ?? "";

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

  if (vocabCallback) {
    const btn = document.createElement("button");
    btn.className = "hg-add-vocab-btn";
    btn.textContent = "+ Vocab";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      vocabCallback!({ chars, pinyin, definition });
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
