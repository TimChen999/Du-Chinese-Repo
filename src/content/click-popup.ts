/**
 * Two-tier popup for the click-flow.
 *
 * Layout:
 *  - Word tier:     pinyin + (optional) gloss + +Vocab + close button
 *  - Sentence tier: English translation only (the original sentence is
 *                   visible on the page, highlighted by page-highlight.ts)
 *
 * Lives in the same Shadow DOM as the legacy overlay (`#hg-extension-root`)
 * so style isolation is shared, but uses its own root container element
 * `.pt-popup` so the legacy overlay (`.hg-overlay`) can still be opened
 * independently by the OCR / context-menu paths without interaction.
 *
 * State transitions:
 *  - showBootstrap()  -- word tier from CC-CEDICT, sentence tier "Translating..."
 *  - upgradeWord()    -- word tier with LLM contextual data
 *  - setSentenceText()-- sentence tier with the latest translation
 *  - setSentenceError -- inline error in the sentence tier
 *  - dismiss()        -- removes the popup and clears highlights via callback
 */

import overlayStyles from "./overlay.css?inline";
import type { LLMSentenceWord, PinyinStyle, Theme } from "../shared/types";
import {
  formatPinyin,
  lookupExact,
} from "../shared/cedict-lookup";
import type { CedictHit } from "../shared/cedict-types";

/**
 * Session-level pin for the pinyin-strip toggle. Once a user expands
 * the strip in this tab, subsequent clicks default to expanded so they
 * keep their study-mode preference without re-toggling each click.
 * Reset only on tab unload.
 */
let pinyinStripExpandedSession = false;

export interface StripWord {
  text: string;
  pinyin: string;
}

// ─── Module state ──────────────────────────────────────────────────

let shadowRoot: ShadowRoot | null = null;
let hostElement: HTMLElement | null = null;
let popupEl: HTMLElement | null = null;
let onDismiss: (() => void) | null = null;
let onSpeak: ((sentence: string) => void) | null = null;
let vocabCallback:
  | ((
      word: { chars: string; pinyin: string; definition: string },
      context: string,
    ) => void)
  | null = null;
let currentSentenceText = "";

/**
 * Live "should the speaker button be present?" snapshot. Captured at
 * popup creation and updated when settings change at runtime, so any
 * tier rebuild (setSentenceText / setSentenceError) can re-assert the
 * button's presence even if it was missing from the initial render
 * (e.g. content-script settings race) or wiped by a content swap.
 */
let currentTtsEnabled = false;

// ─── Public API ────────────────────────────────────────────────────

export function setClickPopupVocabCallback(
  cb: (
    word: { chars: string; pinyin: string; definition: string },
    context: string,
  ) => void,
): void {
  vocabCallback = cb;
}

/**
 * Registers a callback fired when the popup dismisses itself (via
 * the close button or Escape). Lets the content script clear page
 * highlights that the popup itself doesn't own.
 */
export function setClickPopupDismissHandler(cb: () => void): void {
  onDismiss = cb;
}

/**
 * Registers the callback fired when the user clicks the speaker button
 * on the popup's sentence tier. The callback receives the current
 * sentence text; the click-flow looks up the in-memory state for that
 * sentence (range + LLM words) and drives speech synthesis from there.
 */
export function setClickPopupSpeakHandler(
  cb: (sentence: string) => void,
): void {
  onSpeak = cb;
}

/**
 * Live setter for the popup's "should the speaker button be present?"
 * snapshot. Click-flow calls this when the ttsEnabled setting changes
 * at runtime so an already-open popup's next tier rebuild reflects the
 * new state. Doesn't mutate the DOM directly — the next setSentenceText
 * / setSentenceError pass picks it up.
 */
export function setClickPopupTtsEnabled(enabled: boolean): void {
  currentTtsEnabled = enabled;
}

export interface ShowBootstrapArgs {
  word: {
    chars: string;
    pinyin: string;
    gloss: string;
  };
  sentence: string;
  /** Bootstrap segmentation of the full sentence (for the pinyin strip). */
  sentenceWords: StripWord[];
  /** Position of the clicked word on screen (used to anchor the popup). */
  anchorRect: DOMRect;
  /** Bounding rect of the highlighted sentence; popup avoids covering it. */
  sentenceRect: DOMRect;
  theme: Theme;
  fontSize: number;
  /** True when LLM enrichment is on its way (sentence tier shows spinner). */
  expectLlm: boolean;
  /** True when the on-device translator can fill the sentence tier. */
  expectBootstrapTranslation: boolean;
  pinyinStyle: PinyinStyle;
  /**
   * True when TTS is enabled in settings AND a Chinese voice is
   * available; controls whether the speaker button is rendered.
   */
  ttsEnabled: boolean;
}

/**
 * Renders the popup in Bootstrap state: word tier from CC-CEDICT,
 * pinyin strip (collapsed by default) reflecting the Bootstrap
 * segmentation, sentence tier waiting for translation. Replaces any
 * prior popup.
 */
export function showBootstrap(args: ShowBootstrapArgs): void {
  const root = ensureRoot();
  removeExistingPopup();

  if (hostElement) {
    hostElement.style.setProperty("--hg-font-size", `${args.fontSize}px`);
  }

  const resolvedTheme = resolveTheme(args.theme);

  const popup = document.createElement("div");
  popup.className = `pt-popup hg-${resolvedTheme}`;

  // Word tier
  const wordTier = document.createElement("div");
  wordTier.className = "pt-word-tier";
  wordTier.appendChild(makeWordHeader(args.word));
  if (args.word.gloss) {
    const gloss = document.createElement("div");
    gloss.className = "pt-gloss";
    gloss.textContent = args.word.gloss;
    wordTier.appendChild(gloss);
  }
  wordTier.appendChild(makeActionsRow(args.word, args.sentence));
  popup.appendChild(wordTier);

  // Pinyin strip — collapsed by default (1 thin row), expandable.
  popup.appendChild(makePinyinStrip(args.sentenceWords, args.word.chars));

  // Sentence tier
  const sentTier = document.createElement("div");
  sentTier.className = "pt-sent-tier";
  // Speaker button comes FIRST in the sentence tier so it sits to the
  // left of the translation text. Don't gate on hasChineseVoice() —
  // voices in Chrome load asynchronously and the first popup often
  // opens before the voiceschanged event fires; if no Chinese voice
  // is ever found the synth call is a graceful no-op.
  currentTtsEnabled = args.ttsEnabled;
  if (currentTtsEnabled) {
    sentTier.appendChild(makeSpeakerButton(args.sentence));
  }
  if (args.expectLlm || args.expectBootstrapTranslation) {
    sentTier.classList.add("pt-loading");
    sentTier.appendChild(makeLoadingSpinner());
    sentTier.appendChild(document.createTextNode("Translating sentence…"));
  } else {
    sentTier.classList.add("pt-empty");
    sentTier.appendChild(
      document.createTextNode(
        "Sentence translation requires AI Translations or Chrome's on-device translator.",
      ),
    );
  }
  popup.appendChild(sentTier);

  // Persistent LLM status badge in the popup's top-right corner.
  // Visible spinner while LLM is in flight; clears on success;
  // turns into a hoverable error icon on failure. This mirrors the
  // legacy overlay's `.hg-llm-status` so the user always has an
  // at-a-glance signal of LLM progress regardless of which tier
  // they're reading.
  if (args.expectLlm) {
    popup.appendChild(makeLlmStatusBadge());
  }

  // Close button
  const closeBtn = document.createElement("button");
  closeBtn.className = "pt-close-btn";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => dismiss());
  popup.appendChild(closeBtn);

  root.appendChild(popup);
  popupEl = popup;
  currentSentenceText = args.sentence;

  positionPopup(popup, args.anchorRect, args.sentenceRect);
}

/**
 * Replaces the word tier with LLM-contextual data after the LLM lands
 * for this sentence. If the popup has been dismissed since
 * showBootstrap, this is a no-op.
 */
export function upgradeWord(word: {
  chars: string;
  pinyin: string;
  gloss: string;
}): void {
  if (!popupEl) return;
  const tier = popupEl.querySelector(".pt-word-tier");
  if (!tier) return;
  const headers = tier.querySelector(".pt-word-header");
  if (headers) {
    headers.replaceWith(makeWordHeader(word));
  }
  let glossEl = tier.querySelector(".pt-gloss") as HTMLElement | null;
  if (word.gloss) {
    if (!glossEl) {
      glossEl = document.createElement("div");
      glossEl.className = "pt-gloss";
      // Insert gloss before actions row.
      const actions = tier.querySelector(".pt-actions");
      tier.insertBefore(glossEl, actions);
    }
    glossEl.textContent = word.gloss;
  } else if (glossEl) {
    glossEl.remove();
  }
  // Update the +Vocab button's payload so saving captures the upgraded
  // data, not the stale Bootstrap one.
  const vocabBtn = tier.querySelector(
    ".pt-add-vocab-btn",
  ) as HTMLButtonElement | null;
  if (vocabBtn) {
    vocabBtn.dataset.chars = word.chars;
    vocabBtn.dataset.pinyin = word.pinyin;
    vocabBtn.dataset.gloss = word.gloss;
  }
}

/**
 * Sets the sentence translation text. `source` is "bootstrap" (Chrome
 * translator) or "llm" — we render them slightly differently so the
 * user can tell which tier they're seeing.
 */
export function setSentenceText(
  text: string,
  source: "bootstrap" | "llm",
): void {
  if (!popupEl) return;
  const tier = popupEl.querySelector(".pt-sent-tier");
  if (!tier) return;
  tier.classList.remove("pt-loading", "pt-empty", "pt-error");
  tier.classList.toggle("pt-bootstrap", source === "bootstrap");
  tier.classList.toggle("pt-llm", source === "llm");
  // Replace contents (including any spinner) with the text. Re-assert
  // the speaker button so it survives the rebuild even if it was never
  // rendered initially (e.g. content-script settings race where
  // showBootstrap fired before chrome.storage.sync.get resolved).
  let speakBtn = tier.querySelector(".pt-speak-btn") as HTMLElement | null;
  while (tier.firstChild) tier.removeChild(tier.firstChild);
  tier.appendChild(document.createTextNode(text));
  if (currentTtsEnabled) {
    if (!speakBtn) speakBtn = makeSpeakerButton(currentSentenceText);
    tier.insertBefore(speakBtn, tier.firstChild);
  }
  // The corner LLM-status badge clears the moment the LLM lands —
  // independent of which tier the source is. The bootstrap path
  // doesn't clear it (LLM may still be in flight).
  if (source === "llm") clearLlmStatusBadge();
}

/**
 * Replaces the pinyin-strip's word data with the LLM's contextual
 * `words` array. Drops punctuation entries from the rendering. Called
 * from click-flow when SENTENCE_TRANSLATE_RESPONSE_LLM lands.
 */
export function upgradeStripWithLlm(
  words: LLMSentenceWord[],
  activeChars: string,
): void {
  if (!popupEl) return;
  const strip = popupEl.querySelector(".pt-pinyin-strip");
  if (!strip) return;
  const inner = strip.querySelector(".pt-strip-inner");
  if (!inner) return;
  const stripWords: StripWord[] = words
    .filter((w) => /[一-鿿㐀-䶿]/.test(w.text))
    .map((w) => ({ text: w.text, pinyin: w.pinyin }));
  while (inner.firstChild) inner.removeChild(inner.firstChild);
  for (const w of stripWords) inner.appendChild(makeStripRuby(w, activeChars));
}

/**
 * Updates the "active" highlight inside the pinyin strip to point at
 * `chars`. Called on retarget so the strip reflects which word is in
 * the word tier.
 */
export function refreshPinyinStripActiveWord(chars: string): void {
  if (!popupEl) return;
  const strip = popupEl.querySelector(".pt-pinyin-strip");
  if (!strip) return;
  const rubies = strip.querySelectorAll<HTMLElement>(".pt-strip-ruby");
  rubies.forEach((r) => {
    r.classList.toggle("pt-strip-active", r.dataset.chars === chars);
  });
}

/**
 * Replaces the word tier wholesale to point at a different word in the
 * same popup. Distinct from upgradeWord (which only refreshes header +
 * gloss in place after the LLM returns): retargetWord rebuilds the
 * actions row too, so a fresh "+ Vocab" button replaces a previously
 * "Added"-disabled one when the user clicks a new word.
 *
 * Pre-condition: the popup is already open. No-op otherwise.
 */
export function retargetWord(
  word: { chars: string; pinyin: string; gloss: string },
  sentence: string,
): void {
  if (!popupEl) return;
  const tier = popupEl.querySelector(".pt-word-tier");
  if (!tier) return;

  // Drop everything in the word tier and rebuild it cleanly. The
  // sentence-tier (translation, pinyin strip, etc.) is left alone so
  // the user keeps their cached LLM result + expanded pinyin strip.
  while (tier.firstChild) tier.removeChild(tier.firstChild);
  tier.appendChild(makeWordHeader(word));
  if (word.gloss) {
    const gloss = document.createElement("div");
    gloss.className = "pt-gloss";
    gloss.textContent = word.gloss;
    tier.appendChild(gloss);
  }
  tier.appendChild(makeActionsRow(word, sentence));
}

export function setSentenceError(message: string): void {
  if (!popupEl) return;
  // Promote the corner badge to its error state regardless of what the
  // sentence tier looks like — the user always has a clear, hoverable
  // error indicator.
  setLlmStatusBadgeError(message);

  const tier = popupEl.querySelector(".pt-sent-tier");
  if (!tier) return;
  // Don't clobber an existing successful translation with an error. The
  // Bootstrap path may have filled the tier and the LLM may then fail —
  // we'd rather keep the bootstrap text. The corner badge already
  // surfaces the error state.
  if (
    tier.classList.contains("pt-bootstrap") ||
    tier.classList.contains("pt-llm")
  ) {
    return;
  }
  tier.classList.remove("pt-loading", "pt-empty");
  tier.classList.add("pt-error");
  // Re-assert the speaker button (same logic as setSentenceText).
  let speakBtn = tier.querySelector(".pt-speak-btn") as HTMLElement | null;
  while (tier.firstChild) tier.removeChild(tier.firstChild);
  tier.appendChild(document.createTextNode(message));
  if (currentTtsEnabled) {
    if (!speakBtn) speakBtn = makeSpeakerButton(currentSentenceText);
    tier.insertBefore(speakBtn, tier.firstChild);
  }
}

/**
 * Returns true when the popup is currently shown for the given sentence.
 * Used by the content script when a late LLM response arrives — if the
 * sentence has changed, ignore.
 */
export function isShowingSentence(sentence: string): boolean {
  return Boolean(popupEl) && currentSentenceText === sentence;
}

/** Whether the popup is currently shown for any sentence. */
export function isPopupOpen(): boolean {
  return Boolean(popupEl);
}

/** Returns the current sentence the popup was opened for, or "". */
export function getCurrentSentence(): string {
  return currentSentenceText;
}

/** Returns the chars currently shown in the word tier, or null. */
export function getCurrentWordChars(): string | null {
  if (!popupEl) return null;
  const charsEl = popupEl.querySelector(".pt-chars");
  return charsEl ? charsEl.textContent : null;
}

export function dismiss(): void {
  removeExistingPopup();
  popupEl = null;
  currentSentenceText = "";
  if (onDismiss) onDismiss();
}

/** Returns the Shadow-host element so the content script can ignore
 * clicks/mouseups originating inside the popup. */
export function getPopupHostElement(): HTMLElement | null {
  return hostElement;
}

// ─── Internals ─────────────────────────────────────────────────────

function ensureRoot(): ShadowRoot {
  const existing = document.getElementById("hg-extension-root");
  if (existing && existing.shadowRoot) {
    hostElement = existing as HTMLElement;
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

function removeExistingPopup(): void {
  if (!shadowRoot) return;
  const old = shadowRoot.querySelector(".pt-popup");
  if (old) old.remove();
}

function makeWordHeader(word: {
  chars: string;
  pinyin: string;
  gloss: string;
}): HTMLElement {
  const header = document.createElement("div");
  header.className = "pt-word-header";

  const chars = document.createElement("span");
  chars.className = "pt-chars";
  chars.textContent = word.chars;
  header.appendChild(chars);

  if (word.pinyin) {
    const pinyin = document.createElement("span");
    pinyin.className = "pt-pinyin";
    pinyin.textContent = word.pinyin;
    header.appendChild(pinyin);
  }

  return header;
}

function makeActionsRow(
  word: { chars: string; pinyin: string; gloss: string },
  sentence: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-actions";

  if (vocabCallback) {
    const btn = document.createElement("button");
    btn.className = "pt-add-vocab-btn";
    btn.textContent = "+ Vocab";
    btn.dataset.chars = word.chars;
    btn.dataset.pinyin = word.pinyin;
    btn.dataset.gloss = word.gloss;
    btn.addEventListener("click", () => {
      const chars = btn.dataset.chars ?? word.chars;
      const pinyin = btn.dataset.pinyin ?? word.pinyin;
      const gloss = btn.dataset.gloss ?? word.gloss;
      if (!chars || !gloss) return;
      vocabCallback!(
        { chars, pinyin, definition: gloss },
        sentence,
      );
      btn.textContent = "Added";
      btn.classList.add("pt-added");
      btn.disabled = true;
    });
    row.appendChild(btn);
  }

  // Optional: a CC-CEDICT "more readings" button — collapsed for now
  // unless we detect homographs. Lookup once at row build.
  const others = lookupExact(word.chars);
  if (others && others.length > 1) {
    const altBtn = document.createElement("button");
    altBtn.className = "pt-alt-btn";
    altBtn.textContent = `${others.length} readings`;
    altBtn.title = "Show all dictionary readings";
    altBtn.addEventListener("click", () => toggleAltReadings(altBtn, others));
    row.appendChild(altBtn);
  }

  return row;
}

function toggleAltReadings(btn: HTMLElement, hits: ReturnType<typeof lookupExact> extends infer R ? R : never): void {
  if (!hits) return;
  const tier = btn.closest(".pt-word-tier");
  if (!tier) return;
  const existing = tier.querySelector(".pt-alt-list");
  if (existing) {
    existing.remove();
    return;
  }
  const list = document.createElement("ul");
  list.className = "pt-alt-list";
  for (const entry of hits) {
    const li = document.createElement("li");
    const ph = document.createElement("span");
    ph.className = "pt-alt-pinyin";
    ph.textContent = formatPinyin(entry.pinyinNumeric, "toneMarks");
    const def = document.createElement("span");
    def.className = "pt-alt-def";
    def.textContent = entry.definitions.slice(0, 2).join("; ");
    li.appendChild(ph);
    li.appendChild(document.createTextNode(" — "));
    li.appendChild(def);
    list.appendChild(li);
  }
  tier.appendChild(list);
}

/**
 * Positions the popup so it never covers the highlighted sentence.
 *
 *  1. Below the sentence rect (preferred).
 *  2. Above the sentence rect.
 *  3. To the right (column margin), then to the left.
 *  4. Bottom-clamped fallback.
 *
 * Horizontal anchor centres on the clicked word's x-midpoint when
 * placing above/below the sentence (so the user's eye doesn't have to
 * travel far) — clamped within the viewport.
 */
function positionPopup(
  popup: HTMLElement,
  wordRect: DOMRect,
  sentenceRect: DOMRect,
): void {
  const gap = 8;
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  const popupRect = popup.getBoundingClientRect();
  const w = popupRect.width || 320;
  const h = popupRect.height || 120;

  type Slot = { top: number; left: number };

  const slots: Slot[] = [];

  // 1. Below the sentence.
  if (sentenceRect.bottom + gap + h <= vpH) {
    const idealLeft = wordRect.left + wordRect.width / 2 - w / 2;
    slots.push({
      top: sentenceRect.bottom + gap,
      left: clamp(idealLeft, gap, vpW - w - gap),
    });
  }

  // 2. Above the sentence.
  if (sentenceRect.top - gap - h >= 0) {
    const idealLeft = wordRect.left + wordRect.width / 2 - w / 2;
    slots.push({
      top: sentenceRect.top - gap - h,
      left: clamp(idealLeft, gap, vpW - w - gap),
    });
  }

  // 3. To the right.
  if (sentenceRect.right + gap + w <= vpW) {
    slots.push({
      top: clamp(sentenceRect.top, gap, vpH - h - gap),
      left: sentenceRect.right + gap,
    });
  }

  // 4. To the left.
  if (sentenceRect.left - gap - w >= 0) {
    slots.push({
      top: clamp(sentenceRect.top, gap, vpH - h - gap),
      left: sentenceRect.left - gap - w,
    });
  }

  // 5. Fallback: bottom-clamped, horizontally centred under word.
  if (slots.length === 0) {
    const idealLeft = wordRect.left + wordRect.width / 2 - w / 2;
    slots.push({
      top: Math.max(gap, vpH - h - gap),
      left: clamp(idealLeft, gap, vpW - w - gap),
    });
  }

  const chosen = slots[0];
  popup.style.top = `${chosen.top}px`;
  popup.style.left = `${chosen.left}px`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

// ─── Pinyin strip ──────────────────────────────────────────────────

/**
 * Builds the collapsible pinyin strip element. Collapsed by default
 * (single thin row with toggle), expanded reveals a ruby annotation
 * for each Chinese word in the sentence. Sticky session preference:
 * once the user expands it, subsequent popup opens default to expanded.
 */
function makePinyinStrip(
  sentenceWords: StripWord[],
  activeChars: string,
): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "pt-pinyin-strip";
  if (pinyinStripExpandedSession) strip.classList.add("pt-strip-expanded");

  const toggle = document.createElement("button");
  toggle.className = "pt-strip-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(pinyinStripExpandedSession));
  toggle.addEventListener("click", () => {
    const expanded = strip.classList.toggle("pt-strip-expanded");
    pinyinStripExpandedSession = expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    // Re-position once expand/collapse changes the popup height.
    if (popupEl) {
      // We don't have the rects on hand; re-running the rect-based
      // positioning here would need the click-flow to re-supply them.
      // Skip — the strip itself sits inside the popup and only
      // changes height; horizontal alignment is unaffected and the
      // popup may scroll internally if it gets too tall.
    }
  });
  strip.appendChild(toggle);

  const inner = document.createElement("div");
  inner.className = "pt-strip-inner";
  for (const w of sentenceWords) {
    if (!w.text || !/[一-鿿㐀-䶿]/.test(w.text)) continue;
    inner.appendChild(makeStripRuby(w, activeChars));
  }
  strip.appendChild(inner);

  return strip;
}

function makeStripRuby(w: StripWord, activeChars: string): HTMLElement {
  const ruby = document.createElement("ruby");
  ruby.className = "pt-strip-ruby";
  ruby.dataset.chars = w.text;
  if (w.text === activeChars) ruby.classList.add("pt-strip-active");
  ruby.appendChild(document.createTextNode(w.text));
  const rt = document.createElement("rt");
  rt.textContent = w.pinyin;
  ruby.appendChild(rt);
  return ruby;
}

// ─── Loading spinner ───────────────────────────────────────────────

function makeLoadingSpinner(): HTMLElement {
  const spinner = document.createElement("span");
  spinner.className = "pt-spinner";
  spinner.setAttribute("aria-hidden", "true");
  return spinner;
}

// ─── LLM status badge ──────────────────────────────────────────────

/**
 * Persistent badge in the popup's top-right corner indicating LLM
 * progress. Starts as a spinner; clears (removed) on Hot transition;
 * turns into a hoverable "!" on failure.
 */
function makeLlmStatusBadge(): HTMLElement {
  const badge = document.createElement("div");
  badge.className = "pt-llm-status pt-llm-loading";
  badge.title = "AI translation is still running.";
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-label", "AI translation is still running");
  return badge;
}

/** Removes the LLM status badge from the popup (LLM finished). */
function clearLlmStatusBadge(): void {
  if (!popupEl) return;
  popupEl.querySelector(".pt-llm-status")?.remove();
}

/** Promotes the LLM status badge to an error state (still visible). */
function setLlmStatusBadgeError(message: string): void {
  if (!popupEl) return;
  let badge = popupEl.querySelector(".pt-llm-status") as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "pt-llm-status";
    popupEl.appendChild(badge);
  }
  badge.classList.remove("pt-llm-loading");
  badge.classList.add("pt-llm-error");
  badge.textContent = "!";
  badge.title = message;
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-label", message);
  badge.tabIndex = 0;
}

// ─── Speaker button (TTS) ──────────────────────────────────────────

function makeSpeakerButton(sentence: string): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "pt-speak-btn";
  btn.type = "button";
  btn.title = "Speak sentence";
  btn.setAttribute("aria-label", "Speak sentence");
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>' +
    "</svg>";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (onSpeak) onSpeak(sentence);
  });
  return btn;
}

function resolveTheme(theme: Theme): "light" | "dark" | "sepia" {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  // jsdom doesn't expose matchMedia; fall back to "light" in tests.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Builds the Bootstrap word-tier display from a CC-CEDICT longest-match.
 * Picks the first entry's pinyin + first definition slot.
 */
export function bootstrapWordFromHit(
  hit: CedictHit,
  pinyinStyle: "toneMarks" | "toneNumbers" | "none",
): { chars: string; pinyin: string; gloss: string } {
  const entry = hit.entries[0];
  const pinyin = formatPinyin(entry.pinyinNumeric, pinyinStyle);
  // Combine the first 2-3 definitions for a richer view, since CC-CEDICT
  // often splits subtle senses across slots.
  const gloss = entry.definitions.slice(0, 3).join("; ");
  return { chars: hit.word, pinyin, gloss };
}
