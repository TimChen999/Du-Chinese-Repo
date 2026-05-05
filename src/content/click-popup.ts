/**
 * Two-tier popup for the click-flow.
 *
 * Layout:
 *  - Word tier (top section): chars + pinyin + (optional) gloss +
 *      [+Vocab][readings] action row.
 *  - Bottom tier:  toolbar row containing the speaker (TTS) button, the
 *      segmented toggle (Translation / Pinyin), and the LLM status badge
 *      (spinner / error icon) — all on the same horizontal level, just
 *      below the divider. Below the toolbar is a single content slot
 *      that swaps between the English translation view and the per-word
 *      pinyin ruby strip. Only one view is visible at a time so the
 *      popup stays compact.
 *
 * Lives in the same Shadow DOM as the legacy overlay (`#hg-extension-root`)
 * so style isolation is shared, but uses its own root container element
 * `.pt-popup` so the legacy overlay (`.hg-overlay`) can still be opened
 * independently by the OCR / context-menu paths without interaction.
 *
 * State transitions:
 *  - showBootstrap()  -- word tier from CC-CEDICT, translation view shows
 *                        "Translating…" while pinyin view holds bootstrap segmentation
 *  - upgradeWord()    -- word tier with LLM contextual data
 *  - setSentenceText()-- translation view filled with latest translation
 *  - setSentenceError -- inline error inside the translation view
 *  - dismiss()        -- removes the popup and clears highlights via callback
 */

import overlayStyles from "./overlay.css?inline";
import type { LLMSentenceWord, PinyinStyle, Theme } from "../shared/types";
import {
  formatModifier,
  formatPinyin,
  lookupExact,
} from "../shared/cedict-lookup";
import type { CedictHit } from "../shared/cedict-types";

type ViewMode = "translation" | "pinyin";

/**
 * Session-level pin for the bottom-tier view. Once a user picks pinyin
 * (or stays on translation) in this tab, subsequent clicks default to
 * the same view so they keep their study-mode preference without
 * re-toggling each click. Reset only on tab unload.
 */
let activeViewSession: ViewMode = "translation";

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
/**
 * Synchronous predicate that tells the popup whether `chars` is already
 * in the user's vocab list. Defaults to "never saved" so popups still
 * render correctly in test envs that don't wire the cache. Backed by
 * shared/vocab-saved-cache.ts in production.
 */
let isVocabSavedFn: (chars: string) => boolean = () => false;
/**
 * Notified once per (popup-instance, word) pair when the popup is
 * opened or retargeted to a word. The host wires this to the vocab
 * "view count" bump pipeline; the popup itself just ensures it's only
 * fired once per word per popup so retargeting back-and-forth between
 * two words inside the same sentence doesn't double-count either.
 */
let wordViewedHandler: (chars: string, sentence: string) => void = () => {};
const wordsViewedThisPopup = new Set<string>();
let currentSentenceText = "";

/**
 * Anchor + sentence rects captured at popup creation, retained for the
 * popup's lifetime so we can re-run positionPopup after every content
 * mutation that can change the popup's height. The first positionPopup
 * call (at showBootstrap time) measures a popup whose bottom tier is
 * still in its loading placeholder; once setSentenceText / upgradeWord
 * etc. fill in real content, the popup's height grows and its previous
 * placement may no longer fit (popup clipped at viewport edge) or no
 * longer clear the selected sentence (above-slot bottom intrudes into
 * it). Repositioning with the post-mutation height fixes both.
 *
 * Caveat: these rects are in viewport coordinates frozen at click time.
 * If the user scrolls between bootstrap and translation arrival, the
 * stored rects no longer reflect where the sentence is on screen — but
 * that's a pre-existing limitation of the click flow.
 */
let currentAnchorRect: DOMRect | null = null;
let currentSentenceRect: DOMRect | null = null;

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
 * Registers the predicate the popup uses to decide whether to render
 * the action button as "+ Vocab" (default) or "Saved" (already in the
 * user's vocab list). Called once at host init; subsequent renders pick
 * up the live state because the cache it points at is mutated in place.
 */
export function setClickPopupVocabSavedChecker(
  fn: (chars: string) => boolean,
): void {
  isVocabSavedFn = fn;
}

/**
 * Registers the host-side handler invoked once per (popup-instance,
 * word) pair when the popup opens or retargets onto a word. The host
 * uses this to bump the saved word's "times seen" count exactly once
 * per popup view, even if the user retargets back to the same word
 * later within the same popup.
 */
export function setClickPopupWordViewHandler(
  fn: (chars: string, sentence: string) => void,
): void {
  wordViewedHandler = fn;
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
  /**
   * Absolute URL of the `<a href>` ancestor containing the clicked
   * word, or undefined when the click landed outside any link. When set,
   * the actions row renders an extra button that opens the URL in a new
   * tab (the click-flow's preventDefault() otherwise swallows native
   * link navigation).
   */
  linkHref?: string | null;
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

  // ── Word tier (top section) ─────────────────────────────────────
  // Hosts: header (chars + pinyin), gloss, actions row.
  currentTtsEnabled = args.ttsEnabled;

  const wordTier = document.createElement("div");
  wordTier.className = "pt-word-tier";
  wordTier.appendChild(makeWordHeader(args.word));
  if (args.word.gloss) {
    const gloss = document.createElement("div");
    gloss.className = "pt-gloss";
    gloss.textContent = args.word.gloss;
    wordTier.appendChild(gloss);
  }
  wordTier.appendChild(makeActionsRow(args.word, args.sentence, args.linkHref ?? null));

  popup.appendChild(wordTier);

  // ── Bottom tier (translation ⇄ pinyin) ─────────────────────────
  // Speaker and LLM status badge live on the toolbar row alongside the
  // Translation/Pinyin toggle, so they share one horizontal lane and
  // don't add vertical height.
  popup.appendChild(
    makeBottomTier({
      sentence: args.sentence,
      sentenceWords: args.sentenceWords,
      activeChars: args.word.chars,
      expectTranslation: args.expectLlm || args.expectBootstrapTranslation,
      ttsEnabled: currentTtsEnabled,
      expectLlm: args.expectLlm,
    }),
  );

  // Close button — top-right of the entire popup.
  const closeBtn = document.createElement("button");
  closeBtn.className = "pt-close-btn";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => dismiss());
  popup.appendChild(closeBtn);

  root.appendChild(popup);
  popupEl = popup;
  currentSentenceText = args.sentence;
  currentAnchorRect = args.anchorRect;
  currentSentenceRect = args.sentenceRect;

  // Reset the per-popup view-dedup set so the very first showBootstrap
  // for a sentence always counts as a fresh view, then immediately mark
  // the initial word as viewed to avoid re-firing on no-op retargets to
  // the same chars.
  wordsViewedThisPopup.clear();
  notifyWordViewed(args.word.chars, args.sentence);

  positionPopup(popup, args.anchorRect, args.sentenceRect);
}

/**
 * Fires the host's word-view handler the first time a given chars
 * string appears in this popup instance. Retargeting back to a
 * previously-seen word during the same popup is a no-op so the user
 * doesn't accidentally inflate their seen count by toggling between
 * two words.
 */
function notifyWordViewed(chars: string, sentence: string): void {
  if (!chars) return;
  if (wordsViewedThisPopup.has(chars)) return;
  wordsViewedThisPopup.add(chars);
  try {
    wordViewedHandler(chars, sentence);
  } catch (err) {
    console.error("[click-popup] word-viewed handler threw:", err);
  }
}

/**
 * Re-runs positionPopup with the rects captured at showBootstrap time.
 * Called after any content mutation that can change the popup's height
 * (translation arrival, word upgrade, pinyin strip swap, retarget) so
 * the slot decisions and above-slot top are computed against the
 * popup's actual current size, not the loading-state size.
 */
function repositionPopup(): void {
  if (!popupEl || !currentAnchorRect || !currentSentenceRect) return;
  positionPopup(popupEl, currentAnchorRect, currentSentenceRect);
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
  // data, not the stale Bootstrap one. If the LLM resegmented and now
  // points at chars the user has already saved (rare but possible),
  // flip the button into the "Saved" disabled state so the user
  // doesn't see a "+ Vocab" affordance for something already on their
  // list.
  const vocabBtn = tier.querySelector(
    ".pt-add-vocab-btn",
  ) as HTMLButtonElement | null;
  if (vocabBtn) {
    if (isVocabSavedFn(word.chars)) {
      applyVocabBtnSavedState(vocabBtn);
    } else {
      vocabBtn.dataset.chars = word.chars;
      vocabBtn.dataset.pinyin = word.pinyin;
      vocabBtn.dataset.gloss = word.gloss;
    }
  }
  // upgradeWord can change which chars the popup points at when the
  // LLM resegments — treat that as a fresh view of the new chars so
  // the host can bump its count if the new chars are saved.
  notifyWordViewed(word.chars, currentSentenceText);
  repositionPopup();
}

/**
 * Sets the sentence translation text. `source` is "bootstrap" (Chrome
 * translator) or "llm" — we render them slightly differently so the
 * user can tell which source they're seeing.
 */
export function setSentenceText(
  text: string,
  source: "bootstrap" | "llm",
): void {
  if (!popupEl) return;
  const view = popupEl.querySelector(".pt-view-translation");
  if (!view) return;
  view.classList.remove("pt-loading", "pt-empty", "pt-error");
  view.classList.toggle("pt-bootstrap", source === "bootstrap");
  view.classList.toggle("pt-llm", source === "llm");
  while (view.firstChild) view.removeChild(view.firstChild);
  view.appendChild(document.createTextNode(text));
  // The LLM-status badge clears the moment the LLM lands — independent
  // of which view is currently active. The bootstrap path doesn't clear
  // it (LLM may still be in flight).
  if (source === "llm") clearLlmStatusBadge();
  repositionPopup();
}

/**
 * Replaces the pinyin view's word data with the LLM's contextual
 * `words` array. Drops punctuation entries from the rendering. Called
 * from click-flow when SENTENCE_TRANSLATE_RESPONSE_LLM lands.
 */
export function upgradeStripWithLlm(
  words: LLMSentenceWord[],
  activeChars: string,
): void {
  if (!popupEl) return;
  const view = popupEl.querySelector(".pt-view-pinyin");
  if (!view) return;
  const stripWords: StripWord[] = words
    .filter((w) => /[一-鿿㐀-䶿]/.test(w.text))
    .map((w) => ({ text: w.text, pinyin: w.pinyin }));
  while (view.firstChild) view.removeChild(view.firstChild);
  for (const w of stripWords) view.appendChild(makeStripRuby(w, activeChars));
  repositionPopup();
}

/**
 * Updates the "active" highlight inside the pinyin view to point at
 * `chars`. Called on retarget so the strip reflects which word is in
 * the word tier.
 */
export function refreshPinyinStripActiveWord(chars: string): void {
  if (!popupEl) return;
  const view = popupEl.querySelector(".pt-view-pinyin");
  if (!view) return;
  const rubies = view.querySelectorAll<HTMLElement>(".pt-strip-ruby");
  rubies.forEach((r) => {
    r.classList.toggle("pt-strip-active", r.dataset.chars === chars);
  });
}

/**
 * Replaces the word tier wholesale to point at a different word in the
 * same popup. Distinct from upgradeWord (which only refreshes header +
 * gloss in place after the LLM returns): retargetWord rebuilds the
 * actions row too, so a fresh "+ Vocab" button replaces a previously
 * "Saved"-disabled one when the user clicks a new word.
 *
 * Pre-condition: the popup is already open. No-op otherwise.
 */
export function retargetWord(
  word: { chars: string; pinyin: string; gloss: string },
  sentence: string,
  linkHref: string | null = null,
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
  tier.appendChild(makeActionsRow(word, sentence, linkHref));
  // Same-sentence retarget — count the new word as viewed (deduped
  // against the per-popup set) so first-open-per-word tracking holds
  // across in-popup word swaps.
  notifyWordViewed(word.chars, sentence);
  repositionPopup();
}

export function setSentenceError(message: string): void {
  if (!popupEl) return;
  // Promote the corner badge to its error state regardless of what the
  // translation view looks like — the user always has a clear,
  // hoverable error indicator in the word tier corner.
  setLlmStatusBadgeError(message);

  const view = popupEl.querySelector(".pt-view-translation");
  if (!view) return;
  // Don't clobber an existing successful translation with an error. The
  // Bootstrap path may have filled the view and the LLM may then fail —
  // we'd rather keep the bootstrap text. The corner badge already
  // surfaces the error state.
  if (
    view.classList.contains("pt-bootstrap") ||
    view.classList.contains("pt-llm")
  ) {
    return;
  }
  view.classList.remove("pt-loading", "pt-empty");
  view.classList.add("pt-error");
  while (view.firstChild) view.removeChild(view.firstChild);
  view.appendChild(document.createTextNode(message));
  repositionPopup();
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
  currentAnchorRect = null;
  currentSentenceRect = null;
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

/**
 * Switches a "+ Vocab" button into its terminal "Saved" disabled
 * state. Used both at button-creation time when a word is already in
 * the vocab list and after a successful "+ Vocab" click. Removing the
 * dataset attributes prevents a stale click from re-firing the callback
 * with old data should the disabled flag ever fail to take effect.
 */
function applyVocabBtnSavedState(btn: HTMLButtonElement): void {
  btn.textContent = "Saved";
  btn.classList.add("pt-added");
  btn.disabled = true;
  delete btn.dataset.chars;
  delete btn.dataset.pinyin;
  delete btn.dataset.gloss;
}

function makeActionsRow(
  word: { chars: string; pinyin: string; gloss: string },
  sentence: string,
  linkHref: string | null,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "pt-actions";

  if (vocabCallback) {
    const btn = document.createElement("button");
    btn.className = "pt-add-vocab-btn";
    if (isVocabSavedFn(word.chars)) {
      // Already in the user's vocab — render directly into the disabled
      // "Saved" state, no click handler attached.
      applyVocabBtnSavedState(btn);
    } else {
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
        applyVocabBtnSavedState(btn);
      });
    }
    row.appendChild(btn);
  }

  if (linkHref) {
    const linkBtn = document.createElement("button");
    linkBtn.className = "pt-link-btn";
    linkBtn.type = "button";
    linkBtn.textContent = "↗ Open link";
    linkBtn.title = linkHref;
    linkBtn.setAttribute("aria-label", `Open link: ${linkHref}`);
    linkBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      window.open(linkHref, "_blank", "noopener");
      dismiss();
    });
    row.appendChild(linkBtn);
  }

  // CC-CEDICT "definition card" affordance. Shown whenever the headword
  // has multiple readings OR any reading carries modifiers (classifiers,
  // "abbr. for", surname tag, alternate pronunciations, etc.). The
  // modifiers are *only* visible inside this expanded card -- they are
  // intentionally stripped from the compact gloss line above so the
  // first-glance popup stays free of CC-CEDICT raw notation.
  const others = lookupExact(word.chars);
  const hasMultipleReadings = !!others && others.length > 1;
  const hasModifiers = !!others && others.some((e) => e.modifiers.length > 0);
  if (others && (hasMultipleReadings || hasModifiers)) {
    const altBtn = document.createElement("button");
    altBtn.className = "pt-alt-btn";
    altBtn.textContent = hasMultipleReadings
      ? `${others.length} readings`
      : "Details";
    altBtn.title = hasMultipleReadings
      ? "Show all dictionary readings"
      : "Show dictionary details";
    altBtn.addEventListener("click", () =>
      toggleAltReadings(altBtn, others, hasMultipleReadings),
    );
    row.appendChild(altBtn);
  }

  return row;
}

function toggleAltReadings(
  btn: HTMLElement,
  hits: ReturnType<typeof lookupExact> extends infer R ? R : never,
  showReadingHeader: boolean,
): void {
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
    if (showReadingHeader) {
      const ph = document.createElement("span");
      ph.className = "pt-alt-pinyin";
      ph.textContent = formatPinyin(entry.pinyinNumeric, "toneMarks");
      const def = document.createElement("span");
      def.className = "pt-alt-def";
      def.textContent = entry.definitions.slice(0, 2).join("; ");
      li.appendChild(ph);
      li.appendChild(document.createTextNode(" — "));
      li.appendChild(def);
    }
    for (const mod of entry.modifiers) {
      const modEl = document.createElement("div");
      modEl.className = "pt-alt-modifier";
      modEl.textContent = formatModifier(mod, "toneMarks");
      li.appendChild(modEl);
    }
    if (li.childNodes.length > 0) list.appendChild(li);
  }
  if (list.childNodes.length > 0) tier.appendChild(list);
}

/**
 * Positions the popup so it never covers the highlighted sentence.
 * Slot preference:
 *
 *  1. Below or above the sentence rect — whichever side has more
 *     available viewport space gets tried first.
 *  2. The other vertical side.
 *  3. To the right (column margin), then to the left.
 *  4. Bottom-clamped fallback.
 *
 * Slots 1-4 are placed strictly outside `sentenceRect`, so as long as
 * one of them is chosen the selected sentence stays visible. The
 * fit-checks gate each slot on the popup's actual measured size, so
 * callers must re-run positionPopup after any DOM mutation that grows
 * the popup (translation arrival, etc.) — otherwise the slot picker
 * decides on the loading-state size and the popup overflows or
 * intrudes back into the sentence after content fills in.
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

  const idealLeft = wordRect.left + wordRect.width / 2 - w / 2;
  const clampedLeft = clamp(idealLeft, gap, vpW - w - gap);
  const spaceBelow = vpH - sentenceRect.bottom;
  const spaceAbove = sentenceRect.top;
  const belowFits = sentenceRect.bottom + gap + h <= vpH;
  const aboveFits = sentenceRect.top - gap - h >= 0;
  const belowSlot: Slot = { top: sentenceRect.bottom + gap, left: clampedLeft };
  const aboveSlot: Slot = { top: sentenceRect.top - gap - h, left: clampedLeft };

  // 1 & 2. Vertical slots, ordered by which side has more room.
  if (spaceAbove > spaceBelow) {
    if (aboveFits) slots.push(aboveSlot);
    if (belowFits) slots.push(belowSlot);
  } else {
    if (belowFits) slots.push(belowSlot);
    if (aboveFits) slots.push(aboveSlot);
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

// ─── Bottom tier (translation ⇄ pinyin) ────────────────────────────

interface BottomTierArgs {
  sentence: string;
  /** Bootstrap segmentation of the full sentence (for the pinyin view). */
  sentenceWords: StripWord[];
  /** The chars currently shown in the word tier — highlighted in pinyin view. */
  activeChars: string;
  /** True while translation is in flight (translation view shows spinner). */
  expectTranslation: boolean;
  /** Whether to render the speaker (TTS) button on the toolbar row. */
  ttsEnabled: boolean;
  /** Whether the LLM is in flight — controls the spinner badge presence. */
  expectLlm: boolean;
}

/**
 * Builds the bottom tier: a toolbar row (speaker + Translation/Pinyin
 * toggle + LLM status badge) on top of a single content slot that swaps
 * between the translation view and the per-word pinyin ruby strip. The
 * active view is session-pinned — picking pinyin once means the next
 * popup opens to pinyin too.
 */
function makeBottomTier(args: BottomTierArgs): HTMLElement {
  const tier = document.createElement("div");
  tier.className = "pt-bottom-tier";
  tier.dataset.view = activeViewSession;

  // Toolbar row: speaker (left) + segmented toggle + LLM badge (right).
  // All sit on a single horizontal lane so none of them adds height.
  const toolbar = document.createElement("div");
  toolbar.className = "pt-bottom-toolbar";
  // Don't gate the speaker on hasChineseVoice() — voices in Chrome load
  // asynchronously and the first popup often opens before the
  // voiceschanged event fires; if no Chinese voice is ever found the
  // synth call is a graceful no-op.
  if (args.ttsEnabled) {
    toolbar.appendChild(makeSpeakerButton(args.sentence));
  }
  const seg = document.createElement("div");
  seg.className = "pt-view-segmented";
  seg.setAttribute("role", "tablist");
  seg.appendChild(makeSegmentedBtn("translation", "Translation", tier));
  seg.appendChild(makeSegmentedBtn("pinyin", "Pinyin", tier));
  toolbar.appendChild(seg);
  if (args.expectLlm) {
    toolbar.appendChild(makeLlmStatusBadge());
  }
  tier.appendChild(toolbar);

  // Translation view.
  const tv = document.createElement("div");
  tv.className = "pt-view pt-view-translation";
  if (args.expectTranslation) {
    tv.classList.add("pt-loading");
    tv.appendChild(makeLoadingSpinner());
    tv.appendChild(document.createTextNode("Translating sentence…"));
  } else {
    tv.classList.add("pt-empty");
    tv.appendChild(
      document.createTextNode(
        "Sentence translation requires AI Translations or Chrome's on-device translator.",
      ),
    );
  }
  tier.appendChild(tv);

  // Pinyin view.
  const pv = document.createElement("div");
  pv.className = "pt-view pt-view-pinyin";
  for (const w of args.sentenceWords) {
    if (!w.text || !/[一-鿿㐀-䶿]/.test(w.text)) continue;
    pv.appendChild(makeStripRuby(w, args.activeChars));
  }
  tier.appendChild(pv);

  return tier;
}

function makeSegmentedBtn(
  view: ViewMode,
  label: string,
  tier: HTMLElement,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pt-view-seg-btn";
  btn.dataset.view = view;
  btn.textContent = label;
  btn.setAttribute("role", "tab");
  if (activeViewSession === view) {
    btn.classList.add("pt-seg-active");
    btn.setAttribute("aria-selected", "true");
  } else {
    btn.setAttribute("aria-selected", "false");
  }
  btn.addEventListener("click", () => {
    if (tier.dataset.view === view) return;
    tier.dataset.view = view;
    activeViewSession = view;
    const siblings = tier.querySelectorAll<HTMLButtonElement>(
      ".pt-view-seg-btn",
    );
    siblings.forEach((s) => {
      const isActive = s.dataset.view === view;
      s.classList.toggle("pt-seg-active", isActive);
      s.setAttribute("aria-selected", String(isActive));
    });
  });
  return btn;
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
 * Persistent badge that lives on the bottom-tier toolbar row (right of
 * the segmented toggle). Starts as a spinner; cleared (removed) on Hot
 * transition; turns into a hoverable "!" on failure.
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
    // Anchor on the bottom-tier toolbar so positioning matches the
    // loading-state badge (right end of the Translation/Pinyin row).
    const toolbar = popupEl.querySelector(".pt-bottom-toolbar");
    (toolbar ?? popupEl).appendChild(badge);
  }
  badge.classList.remove("pt-llm-loading");
  badge.classList.add("pt-llm-error");
  badge.textContent = "!";
  // data-error feeds the CSS ::after tooltip (same pattern as the reader
  // overlay's .hg-llm-error). title is kept as a native fallback.
  badge.setAttribute("data-error", message);
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
