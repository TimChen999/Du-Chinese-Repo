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
 * (SPEC.md Section 5 "Two-Phase Rendering", Phase 1)
 */
export function showOverlay(
  words: WordData[],
  rect: DOMRect,
  theme: Theme,
): void {
  const root = createOverlay();

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
  overlay.appendChild(pinyinRow);

  const translation = document.createElement("div");
  translation.className = "hg-translation hg-loading";
  translation.textContent = "Loading translation\u2026";
  overlay.appendChild(translation);

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
): void {
  if (!shadowRoot) return;

  const overlay = shadowRoot.querySelector(".hg-overlay");
  if (!overlay) return;

  const pinyinRow = overlay.querySelector(".hg-pinyin-row");
  if (pinyinRow) {
    pinyinRow.innerHTML = renderRubyText(words);
    attachWordClickHandlers(pinyinRow as HTMLElement, overlay as HTMLElement);
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
      return `<ruby class="hg-word" data-chars="${escapeAttr(w.chars)}"${defAttr}>${escapeHtml(w.chars)}<rt>${escapeHtml(w.pinyin)}</rt></ruby>`;
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
  const top =
    spaceBelow >= overlayHeight + gap
      ? rect.bottom + gap
      : rect.top - overlayHeight - gap;

  const idealLeft = rect.left + rect.width / 2 - overlayWidth / 2;
  const left = Math.max(0, Math.min(idealLeft, vpWidth - overlayWidth));

  return { top, left };
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
  card.textContent = `${chars} — ${definition}`;

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
