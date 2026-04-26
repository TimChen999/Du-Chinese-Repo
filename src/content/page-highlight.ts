/**
 * CSS Custom Highlight API controller for the click-flow.
 *
 * Three named highlights live on the document:
 *  - "pt-hover"    -- follows the cursor; lightest tint
 *  - "pt-word"     -- the clicked word; saturated tint
 *  - "pt-sentence" -- the surrounding sentence of the clicked word; lighter tint
 *
 * Operations are cheap because the API paints ranges directly without
 * mutating the DOM. That means we don't risk breaking page event
 * handlers, layout, or the page's own structure.
 *
 * Browser support: Chromium, Firefox 140+, Safari 18+. When the API
 * is missing, all setters are no-ops — the click flow still works,
 * users just don't see the colored backdrop.
 *
 * The highlight color itself is page-CSS-injected in content.ts (we
 * append a <style> tag once with `::highlight(pt-...)` rules).
 */

const HOVER = "pt-hover";
const WORD = "pt-word";
const SENTENCE = "pt-sentence";

interface HighlightLike {
  // The Highlight constructor is `new Highlight(...ranges)`; clear() is
  // called via the same Set-like interface. We type minimally.
  clear(): void;
  add(range: Range): void;
}

interface HighlightRegistry {
  set(name: string, value: HighlightLike): void;
  delete(name: string): boolean;
  has(name: string): boolean;
}

/**
 * Tracks which document each named highlight currently lives in,
 * so a transition from iframe range -> parent range (or vice versa)
 * deletes the old paint before installing the new one.
 *
 * Per spec, CSS.highlights is per-document (per-window): an iframe
 * range painted via the parent's CSS.highlights does not paint at
 * all. Each document needs its own registry call.
 */
const lastHighlightDoc = new Map<string, Document>();

/** True when the (parent) browser supports the Custom Highlight API. */
export function highlightApiAvailable(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  );
}

function highlightCtorFor(
  win: Window | null,
): (new (range: Range) => HighlightLike) | null {
  const ctor = (win as unknown as { Highlight?: new (range: Range) => HighlightLike })
    ?.Highlight;
  return typeof ctor === "function" ? ctor : null;
}

function highlightsRegistryFor(win: Window | null): HighlightRegistry | null {
  const css = (win as unknown as { CSS?: { highlights?: HighlightRegistry } })?.CSS;
  if (!css || !css.highlights) return null;
  return css.highlights;
}

function setOne(name: string, range: Range | null): void {
  if (range === null) {
    // Clear from whichever document last held this highlight.
    const prevDoc = lastHighlightDoc.get(name);
    if (prevDoc) {
      const prevReg = highlightsRegistryFor(prevDoc.defaultView);
      prevReg?.delete(name);
      lastHighlightDoc.delete(name);
    }
    // Also clear from parent (defensive — pre-iframe-tracking state
    // could have left a stale entry).
    if (typeof CSS !== "undefined" && "highlights" in CSS) {
      try {
        (CSS as unknown as { highlights: HighlightRegistry }).highlights.delete(name);
      } catch {
        // ignore
      }
    }
    return;
  }

  const doc = range.startContainer.ownerDocument ?? document;
  const win = doc.defaultView;
  const reg = highlightsRegistryFor(win);
  const Ctor = highlightCtorFor(win);
  if (!reg || !Ctor) return;

  // If the highlight previously lived in a DIFFERENT document, clear
  // it there so we don't leave a phantom highlight behind when the
  // user moves between iframe and parent text.
  const prevDoc = lastHighlightDoc.get(name);
  if (prevDoc && prevDoc !== doc) {
    highlightsRegistryFor(prevDoc.defaultView)?.delete(name);
  }

  reg.set(name, new Ctor(range));
  lastHighlightDoc.set(name, doc);
}

/** Replaces (or clears) the hover highlight. Cheap; called from rAF. */
export function setHoverHighlight(range: Range | null): void {
  setOne(HOVER, range);
}

/** Locks the clicked word's highlight. Survives until clearWordHighlights(). */
export function setWordHighlight(range: Range | null): void {
  setOne(WORD, range);
}

/** Locks the sentence highlight (lighter than the word). */
export function setSentenceHighlight(range: Range | null): void {
  setOne(SENTENCE, range);
}

/** Clears word + sentence (locked highlights). Hover is left alone so
 * the user keeps seeing the cursor preview after dismiss. */
export function clearWordHighlights(): void {
  setOne(WORD, null);
  setOne(SENTENCE, null);
}

/** Clears every highlight we set. Called on overlay dismiss. */
export function clearAllHighlights(): void {
  setOne(HOVER, null);
  setOne(WORD, null);
  setOne(SENTENCE, null);
}

const STYLE_ID = "pt-page-highlight-styles";

/**
 * Injects the document-level `::highlight(...)` CSS rules so the
 * Custom Highlight API has something to paint with. Idempotent —
 * safe to call from the content script's init even on multiple loads.
 *
 * `doc` defaults to `document` (parent context). EPUB iframe support
 * passes the iframe's document so highlights paint inside the iframe
 * too — Custom Highlight API rules and registry are per-document.
 */
export function ensureHighlightStylesInjected(doc: Document = document): void {
  if (!doc) return;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
::highlight(pt-hover)    { background-color: rgba(255, 200, 0, 0.30); }
::highlight(pt-word)     { background-color: rgba(255, 200, 0, 0.55); }
::highlight(pt-sentence) { background-color: rgba(255, 200, 0, 0.18); }
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}
