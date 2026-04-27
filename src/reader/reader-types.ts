/**
 * Type definitions for the built-in file reader.
 *
 * FormatRenderer is the adapter interface that each file format implements.
 * The reader shell operates exclusively through this interface, so adding a
 * new format only requires a new class + registry entry.
 *
 * See: READER_SPEC.md Section 3 "Architecture" for the adapter pattern,
 *      READER_SPEC.md Section 10 "Reading State Persistence" for state types.
 */

/**
 * Theme value persisted in readerSettings.theme.
 *
 * Only "sepia" is a reader-specific override that takes precedence
 * over the canonical extension theme (chrome.storage.sync.theme).
 * Any other value ("light" | "dark" | "auto") is informational only;
 * the effective body[data-theme] is resolved from the shared key
 * via resolveEffectiveTheme() in src/shared/theme.ts.
 *
 * The dropdown still presents all four choices so the user can pick
 * sepia OR change the shared theme from inside the reader. See
 * partitionDropdownTheme() for the routing logic.
 */
export type ReaderTheme = "light" | "dark" | "sepia" | "auto";

export interface TocEntry {
  label: string;
  href: string;
  level: number;
  children?: TocEntry[];
}

export interface BookMetadata {
  title: string;
  author: string;
  language?: string;
  coverUrl?: string;
  toc: TocEntry[];
  totalChapters: number;
  currentChapter: number;
}

/**
 * A word-precise bookmark anchor. Each renderer fills in its own payload
 * shape since "exact word" means something different per format:
 *   - EPUB: a CFI string that epub.js can `display()` directly.
 *   - DOM: an absolute character offset against `contentEl.textContent`.
 *   - Subtitle: cue index + offset within that cue (more resilient to
 *     parser changes than a transcript-wide offset).
 *   - PDF: page + textContent item index + offset within the item's str
 *     (survives zoom/rerender since item indices are stable).
 *
 * `word` plus `contextBefore`/`contextAfter` exist as a snippet-based
 * fallback for any renderer that wants to re-locate the word when its
 * primary anchor doesn't resolve cleanly (e.g. EPUB CFI drift across
 * epub.js version bumps, mammoth/marked output changes between sessions).
 */
export interface BookmarkAnchor {
  word: string;
  contextBefore: string;
  contextAfter: string;
  payload:
    | { kind: "epub"; cfi: string }
    | { kind: "dom"; charOffset: number }
    | { kind: "subtitle"; cueIndex: number; charOffset: number }
    | { kind: "pdf"; page: number; itemIndex: number; charOffset: number };
}

export interface FormatRenderer {
  readonly formatName: string;
  readonly extensions: string[];

  load(file: File): Promise<BookMetadata>;
  renderTo(container: HTMLElement): Promise<void>;
  goTo(location: string | number): Promise<void>;
  next(): Promise<boolean>;
  prev(): Promise<boolean>;
  getCurrentLocation(): string;
  /**
   * Returns text suitable for LLM context extraction.
   *
   * When `anchor` is provided the renderer should return a window
   * centred on the first occurrence of that anchor in the underlying
   * full text. Without an anchor it returns a leading prefix (legacy
   * behaviour). The window-around-anchor mode is what keeps the
   * sentence-context / example-quality flow working when the user
   * looks up a word past the prefix cap (e.g. mid-chapter selection
   * in a long EPUB / PDF).
   */
  getVisibleText(anchor?: string): string;
  getSpineIndex(href: string): number;
  onRelocated(callback: (spineIndex: number) => void): void;
  applySettings(settings: ReaderSettings): void;
  destroy(): void;

  /**
   * Produce a serializable anchor for the word the user just looked up.
   *
   * When `hint.wordRange` is provided (the click-flow path), renderers
   * should prefer it: it points at the exact clicked word in whichever
   * document the click came from (parent doc for DOM renderers, iframe
   * doc for EPUB). Without a hint, renderers fall back to whatever
   * implicit signal they have (window.getSelection, an epub.js CFI
   * stashed earlier, etc.).
   *
   * Returns null when no eligible target exists.
   */
  captureAnchor(hint?: { wordRange: Range }): BookmarkAnchor | null;

  /**
   * Restore a previously captured anchor: scroll/jump such that the
   * anchored word is visible. Returns false if the anchor's payload is
   * for a different format or could not be resolved against the current
   * document; the caller falls back to the coarse `location` in that case.
   */
  goToAnchor(anchor: BookmarkAnchor): Promise<boolean>;
}

export interface ReadingState {
  fileHash: string;
  fileName: string;
  title: string;
  author: string;
  location: string;
  currentChapter: number;
  totalChapters: number;
  lastOpened: number;
  coverDataUrl?: string;
  lastWordAnchor?: BookmarkAnchor;
}

export interface ReaderSettings {
  fontSize: number;
  fontFamily: string;
  lineSpacing: number;
  theme: ReaderTheme;
  readingMode: "scroll" | "paginated";
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: "system",
  lineSpacing: 1.8,
  theme: "auto",
  readingMode: "scroll",
};

export const MAX_RECENT_FILES = 20;
export const AUTOSAVE_INTERVAL_MS = 30_000;
export const DEBOUNCE_SAVE_MS = 2_000;

/**
 * User-created named bookmark. Wraps a BookmarkAnchor (the same shape
 * the auto-bookmark uses) with stable identity, file scoping, and a
 * human-readable label so the UI list can show "Ch 5 -- '世界...'"
 * style entries even when the underlying anchor's word is empty.
 *
 * Stored separately from ReadingState (which is overwritten on every
 * autosave) so the user's curated list is never clobbered.
 */
export interface ManualBookmark {
  id: string;
  fileHash: string;
  anchor: BookmarkAnchor;
  label: string;
  createdAt: number;
  /**
   * 0-based chapter / spine / page index captured at save time. Used by
   * the bookmark list to render a non-Chinese primary label like
   * "Chapter 5", which sidesteps the click-flow's word-lookup intercept
   * (clicking on Chinese characters inside the row used to fire the
   * popup instead of jumping to the bookmark). Optional so existing
   * stored bookmarks (pre-this-field) still load.
   */
  chapterIndex?: number;
  /**
   * Best-effort human-readable chapter name pulled from the renderer's
   * TOC at save time, e.g. "第三章 觉醒". Falls back to "Chapter N+1"
   * in the UI when absent.
   */
  chapterLabel?: string;
}

export const MAX_BOOKMARKS_PER_FILE = 100;
