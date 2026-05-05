/**
 * Reader page entry point: file loading, renderer lifecycle, pinyin
 * integration (direct imports), reading state persistence, settings,
 * and keyboard shortcuts.
 *
 * Because the reader is an extension page it can import background
 * modules directly -- no message passing needed.
 *
 * See: READER_SPEC.md Section 6 "Pinyin Integration",
 *      READER_SPEC.md Section 9 "Data Flow",
 *      READER_SPEC.md Section 10 "Reading State Persistence".
 */

import { handleVocabCapture } from "../shared/vocab-capture";
import {
  initClickFlow,
  setClickFlowSettings,
  setOnSentenceCommit,
  setSentenceTranslationProvider,
  dismissClickFlow,
} from "../content/click-flow";
import {
  setClickPopupVocabCallback,
  setClickPopupVocabSavedChecker,
} from "../content/click-popup";
import {
  initVocabSavedCache,
  isVocabSaved,
  markVocabSavedLocally,
} from "../shared/vocab-saved-cache";
import { ensureHighlightStylesInjected } from "../content/page-highlight";
import { queryLLMSentence } from "../background/llm-client";
import {
  hashSentenceKey,
  getSentenceFromCache,
  saveSentenceToCache,
} from "../background/sentence-cache";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
} from "../shared/constants";
import type { ExtensionSettings, LLMConfig } from "../shared/types";
import {
  partitionDropdownTheme,
  resolveEffectiveTheme,
  THEME_MIGRATION_FLAG,
} from "../shared/theme";
import { syncRangeFill } from "../shared/range-slider";
import { saveFileHandle, getFileHandle } from "./file-handle-store";
import { getRendererForFile, getSupportedExtensions } from "./renderers/renderer-registry";
import { EpubRenderer } from "./renderers/epub-renderer";
import {
  listBookmarks,
  addBookmark as storeAddBookmark,
  removeBookmark as storeRemoveBookmark,
} from "./bookmarks-store";
import type {
  FormatRenderer,
  BookMetadata,
  TocEntry,
  ReadingState,
  ReaderSettings,
  BookmarkAnchor,
  ManualBookmark,
} from "./reader-types";
import {
  DEFAULT_READER_SETTINGS,
  MAX_RECENT_FILES,
  AUTOSAVE_INTERVAL_MS,
  DEBOUNCE_SAVE_MS,
} from "./reader-types";

// ─── Module state ──────────────────────────────────────────────────

let currentRenderer: FormatRenderer | null = null;
let currentMetadata: BookMetadata | null = null;
let currentFileHash = "";
let currentRequestId = 0;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let debounceSaveTimer: ReturnType<typeof setTimeout> | null = null;
let readerSettings: ReaderSettings = { ...DEFAULT_READER_SETTINGS };

/**
 * In-memory mirror of the shared ExtensionSettings.theme so the
 * settings panel can surface the right value for the Theme dropdown
 * (which is the union of "sepia" and the shared light/dark/auto)
 * without re-reading storage on every interaction. Initialized in
 * initReader() and kept in sync via the chrome.storage.onChanged
 * listener so popup-side theme changes propagate live.
 */
let currentSharedTheme: ExtensionSettings["theme"] = DEFAULT_SETTINGS.theme;

/**
 * Module-level chrome.storage.onChanged handler reference so we can
 * verify-once / clean up if needed and so re-initReader() (called
 * after hot-reload in dev) doesn't stack duplicate listeners.
 */
let storageChangeListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
  | null = null;

/**
 * Word-precise anchor for the most recent successful selection. Updated
 * inside processSelection (single choke point for every renderer's
 * lookup) and persisted alongside the coarse `location` so reopening
 * the same file lands on the exact word the user last looked at.
 *
 * Reset to null at the top of openFile() so anchors don't leak between
 * different books in the same session.
 */
let lastCapturedAnchor: BookmarkAnchor | null = null;

/**
 * Snapshot taken right before the user navigates away from the reader
 * tab in the library shell. Used by restoreReaderPosition() because
 * epub.js's internal window-resize handler can fire when the pane
 * goes from absolute back to flex, calling clear()+display(start.cfi)
 * which collapses the user back to the spine-item-level CFI (chapter
 * top in scroll mode). Capturing here lets us re-apply the user's
 * actual scroll position regardless of what epub.js does to its own
 * `lastKnownCfi` in the meantime.
 */
let savedTabSwitchLocation: string | null = null;
let savedTabSwitchScrollTop: number | null = null;

/**
 * Pending dismiss timer for the toast. Only one toast is visible at a
 * time -- a second showToast() call cancels the pending dismiss and
 * resets it for the new message.
 */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const TOAST_DURATION_MS = 2400;

/**
 * Re-apply the most recent word anchor against whatever the renderer's
 * current state is. Used after live operations that disturb position
 * without explicit user intent: settings-panel changes (font, theme,
 * line spacing), reading-mode toggle, PDF zoom-induced rerender.
 */
async function refineToLastAnchor(): Promise<void> {
  if (!currentRenderer || !lastCapturedAnchor) return;
  try {
    await currentRenderer.goToAnchor(lastCapturedAnchor);
  } catch {
    // Anchor failed to resolve -- leave the renderer wherever it
    // settled, same fallback behavior as the openFile restore path.
  }
}

/**
 * Snapshot the reader's current position. Called by the library shell
 * when the user is about to navigate away from the reader tab.
 *
 * Captures both the renderer's coarse location string AND, for EPUB
 * scroll mode, the raw `.epub-container` scrollTop -- the latter
 * because epub.js's CFI resolution after its own resize handler runs
 * can collapse to chapter-start, and direct scroll restoration is the
 * only reliable way back. Other renderers' `getCurrentLocation()` is
 * already exact (DOM = scrollTop, PDF = page).
 */
export function captureReaderState(): void {
  if (!currentRenderer) return;
  flushDebouncedPersist();
  try {
    savedTabSwitchLocation = currentRenderer.getCurrentLocation() || null;
  } catch {
    savedTabSwitchLocation = null;
  }
  savedTabSwitchScrollTop = null;
  if (currentRenderer instanceof EpubRenderer) {
    const top = currentRenderer.getScrollContainerTop();
    if (top != null) savedTabSwitchScrollTop = top;
  }
}

/**
 * Restore the reader's position after the user navigates back to the
 * reader tab. Waits two animation frames so any browser-triggered
 * layout/resize (and epub.js's resulting clear+display dance) has
 * fully settled before we reassert the user's actual position.
 *
 * Restoration order, most precise first:
 *   1. The word-anchor bookmark (covers the case where the user has
 *      looked up at least one Chinese word in this session).
 *   2. The captured pre-switch location string (re-runs goTo).
 *   3. For EPUB scroll mode, the captured raw scrollTop on the
 *      `.epub-container` element -- bypasses epub.js's CFI logic.
 */
export async function restoreReaderPosition(): Promise<void> {
  if (!currentRenderer) return;
  await waitTwoFrames();

  if (lastCapturedAnchor) {
    try {
      const ok = await currentRenderer.goToAnchor(lastCapturedAnchor);
      if (ok) {
        return;
      }
    } catch {
      // fall through to coarse fallback
    }
  }

  if (savedTabSwitchLocation) {
    try {
      await currentRenderer.goTo(savedTabSwitchLocation);
    } catch {
      // ignore
    }
  }
  if (
    currentRenderer instanceof EpubRenderer &&
    savedTabSwitchScrollTop != null
  ) {
    currentRenderer.setScrollContainerTop(savedTabSwitchScrollTop);
  }
}

function waitTwoFrames(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 16);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// ─── DOM references ────────────────────────────────────────────────

function getElements() {
  return {
    tocToggle: document.getElementById("toc-toggle") as HTMLButtonElement,
    tocSidebar: document.getElementById("toc-sidebar") as HTMLElement,
    tocList: document.getElementById("toc-list") as HTMLElement,
    bookTitle: document.getElementById("book-title") as HTMLElement,
    bookAuthor: document.getElementById("book-author") as HTMLElement,
    openFileBtn: document.getElementById("open-file-btn") as HTMLButtonElement,
    settingsToggle: document.getElementById("settings-toggle") as HTMLButtonElement,
    settingsPanel: document.getElementById("settings-panel") as HTMLElement,
    settingsClose: document.getElementById("settings-close") as HTMLButtonElement,
    landing: document.getElementById("landing") as HTMLElement,
    dropZone: document.getElementById("drop-zone") as HTMLElement,
    fileInput: document.getElementById("file-input") as HTMLInputElement,
    readerContent: document.getElementById("reader-content") as HTMLElement,
    readerFooter: document.getElementById("reader-footer") as HTMLElement,
    prevBtn: document.getElementById("prev-btn") as HTMLButtonElement,
    nextBtn: document.getElementById("next-btn") as HTMLButtonElement,
    progressBar: document.getElementById("progress-bar") as HTMLElement,
    chapterIndicator: document.getElementById("chapter-indicator") as HTMLElement,
    recentFiles: document.getElementById("recent-files") as HTMLElement,
    recentList: document.getElementById("recent-list") as HTMLElement,
    fontSizeSetting: document.getElementById("setting-font-size") as HTMLInputElement,
    fontSizeValue: document.getElementById("font-size-value") as HTMLElement,
    fontFamilySetting: document.getElementById("setting-font-family") as HTMLSelectElement,
    lineSpacingSetting: document.getElementById("setting-line-spacing") as HTMLInputElement,
    lineSpacingValue: document.getElementById("line-spacing-value") as HTMLElement,
    themeSetting: document.getElementById("setting-theme") as HTMLSelectElement,
    readingModeSetting: document.getElementById("setting-reading-mode") as HTMLSelectElement,
    bookmarkToggle: document.getElementById("bookmark-toggle") as HTMLButtonElement,
    bookmarkMenu: document.getElementById("bookmark-menu") as HTMLElement,
    bookmarkAdd: document.getElementById("bookmark-add") as HTMLButtonElement,
    bookmarkShow: document.getElementById("bookmark-show") as HTMLButtonElement,
    bookmarkSidebar: document.getElementById("bookmark-sidebar") as HTMLElement,
    bookmarkList: document.getElementById("bookmark-list") as HTMLElement,
    readerToast: document.getElementById("reader-toast") as HTMLElement,
  };
}

// ─── File hashing ──────────────────────────────────────────────────

export async function getFileHash(file: File): Promise<string> {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  const encoded = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// ─── Settings I/O ──────────────────────────────────────────────────

export async function loadReaderSettings(): Promise<ReaderSettings> {
  const result = await chrome.storage.sync.get("readerSettings");
  const stored = result.readerSettings as Partial<ReaderSettings> | undefined;
  return { ...DEFAULT_READER_SETTINGS, ...stored };
}

async function saveReaderSettings(settings: ReaderSettings): Promise<void> {
  await chrome.storage.sync.set({ readerSettings: settings });
}

async function getExtensionSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Reads only the canonical theme key from storage (light/dark/sepia/auto). */
async function loadSharedTheme(): Promise<ExtensionSettings["theme"]> {
  const stored = await chrome.storage.sync.get("theme");
  const value = stored.theme;
  if (
    value === "light" ||
    value === "dark" ||
    value === "sepia" ||
    value === "auto"
  ) {
    return value;
  }
  return DEFAULT_SETTINGS.theme;
}

/**
 * One-shot migration: promote any readerSettings.theme (legacy data
 * from when the reader's theme was independent, or sepia was a
 * reader-only override) up to the canonical shared `theme` key so
 * existing users don't perceive a silent reset to "auto" after the
 * popup, overlay, and reader unified onto a single theme value.
 * Idempotent via THEME_MIGRATION_FLAG.
 *
 * Only promotes when the shared key is at default ("auto") -- if the
 * user has already explicitly chosen a shared theme, that wins.
 *
 * Sepia is included because, as of this build, sepia is selectable
 * from the popup too, so it belongs in the shared key alongside
 * light/dark/auto.
 *
 * Exported so the library shell can run this before initReader/
 * applyCanonicalTheme so the first paint reflects the migrated value.
 */
export async function migrateThemeIfNeeded(): Promise<void> {
  const stored = await chrome.storage.sync.get([
    THEME_MIGRATION_FLAG,
    "theme",
    "readerSettings",
  ]);
  if (stored[THEME_MIGRATION_FLAG]) return;

  const sharedTheme = stored.theme as string | undefined;
  const reader = stored.readerSettings as Partial<ReaderSettings> | undefined;
  const readerTheme = reader?.theme;
  const sharedIsDefault = !sharedTheme || sharedTheme === "auto";

  if (
    (readerTheme === "light" || readerTheme === "dark" || readerTheme === "sepia") &&
    sharedIsDefault
  ) {
    await chrome.storage.sync.set({
      theme: readerTheme,
      readerSettings: { ...reader, theme: "auto" },
      [THEME_MIGRATION_FLAG]: true,
    });
    return;
  }

  await chrome.storage.sync.set({ [THEME_MIGRATION_FLAG]: true });
}

// ─── Reading state persistence ─────────────────────────────────────

export async function saveReadingState(state: ReadingState): Promise<void> {
  await chrome.storage.local.set({ [`reader_state_${state.fileHash}`]: state });
  await updateRecentFiles(state);
}

export async function loadReadingState(
  fileHash: string,
): Promise<ReadingState | null> {
  const key = `reader_state_${fileHash}`;
  const result = await chrome.storage.local.get(key);
  return (result[key] as ReadingState | undefined) ?? null;
}

export async function getRecentFiles(): Promise<ReadingState[]> {
  const result = await chrome.storage.local.get("reader_recent");
  return (result.reader_recent as ReadingState[] | undefined) ?? [];
}

export async function updateRecentFiles(state: ReadingState): Promise<void> {
  const recent = await getRecentFiles();
  const filtered = recent.filter((r) => r.fileHash !== state.fileHash);
  filtered.unshift(state);
  if (filtered.length > MAX_RECENT_FILES) filtered.length = MAX_RECENT_FILES;
  await chrome.storage.local.set({ reader_recent: filtered });
}

// ─── Theme resolution ──────────────────────────────────────────────

/**
 * Apply the effective body[data-theme] using the reader's sepia
 * override (if any) layered over the shared light/dark/auto value.
 * See src/shared/theme.ts for the routing rules.
 */
function applyTheme(): void {
  document.body.setAttribute(
    "data-theme",
    resolveEffectiveTheme(readerSettings.theme, currentSharedTheme),
  );
}

/**
 * Pick the dropdown value to surface in the settings panel:
 *   - "sepia" wins whenever the reader has the override set (because
 *     sepia is reader-only and the user expects the UI to show the
 *     active state)
 *   - otherwise mirror the shared theme so changing it from the
 *     reader is the same UX as changing it from the popup.
 */
function dropdownThemeValue(): ReaderSettings["theme"] {
  return readerSettings.theme === "sepia" ? "sepia" : currentSharedTheme;
}

/**
 * Synthesize a ReaderSettings whose `theme` field is the *effective*
 * value (sepia if overridden, else the shared light/dark/auto). The
 * format renderers (PDF dark-invert, EPUB iframe theme injection,
 * DOM renderer base) read this field to drive their own
 * format-specific theming and previously assumed it was the only
 * source of truth. With the shared/override split they need the
 * resolved value, not the storage-layer one.
 */
function effectiveReaderSettings(): ReaderSettings {
  if (readerSettings.theme === "sepia") return readerSettings;
  return { ...readerSettings, theme: currentSharedTheme };
}

// ─── TOC rendering ─────────────────────────────────────────────────

function renderToc(
  container: HTMLElement,
  entries: TocEntry[],
  onNavigate: (href: string) => void,
  level = 0,
): void {
  for (const entry of entries) {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = entry.label;
    link.setAttribute("data-href", entry.href);
    link.setAttribute("data-level", String(level));
    link.style.paddingLeft = `${16 + level * 16}px`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      onNavigate(entry.href);
    });
    container.appendChild(link);

    if (entry.children?.length) {
      renderToc(container, entry.children, onNavigate, level + 1);
    }
  }
}

// ─── Progress update ───────────────────────────────────────────────

function updateProgress(
  els: ReturnType<typeof getElements>,
  metadata: BookMetadata,
): void {
  const chapter = Math.max(0, Math.min(metadata.currentChapter, metadata.totalChapters - 1));
  const pct =
    metadata.totalChapters > 0
      ? ((chapter + 1) / metadata.totalChapters) * 100
      : 0;
  els.progressBar.style.width = `${pct}%`;
  els.chapterIndicator.textContent = `Chapter ${chapter + 1} of ${metadata.totalChapters}`;
}

// ─── Recent files rendering ────────────────────────────────────────

async function renderRecentFiles(els: ReturnType<typeof getElements>): Promise<void> {
  const recent = await getRecentFiles();
  els.recentList.innerHTML = "";

  if (recent.length === 0) {
    els.recentFiles.classList.add("hidden");
    return;
  }

  els.recentFiles.classList.remove("hidden");

  for (const entry of recent) {
    const item = document.createElement("div");
    item.className = "recent-item";
    item.innerHTML =
      `<span class="recent-item-icon">&#128214;</span>` +
      `<div class="recent-item-info">` +
      `<div class="recent-item-title">${escapeHtml(entry.title)}</div>` +
      `<div class="recent-item-meta">${escapeHtml(entry.author)} &mdash; Ch ${entry.currentChapter + 1}</div>` +
      `</div>`;
    item.addEventListener("click", () => openRecentFile(entry, els));
    els.recentList.appendChild(item);
  }
}

// ─── Re-open from recent list ───────────────────────────────────────

export async function openRecentFile(
  entry: ReadingState,
  els: ReturnType<typeof getElements>,
): Promise<void> {
  const handle = await getFileHandle(entry.fileHash);
  if (!handle) {
    alert(
      `"${entry.title}" can no longer be opened automatically.\n` +
      "Please re-open it using the file picker or drag-and-drop.",
    );
    return;
  }

  try {
    const permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") {
      alert("File access was denied. Please grant permission and try again.");
      return;
    }
  } catch {
    alert(
      `Could not access "${entry.title}".\n` +
      "The file may have been moved or deleted.",
    );
    return;
  }

  let file: File;
  try {
    file = await handle.getFile();
  } catch {
    alert(
      `Could not read "${entry.title}".\n` +
      "The file may have been moved or deleted.",
    );
    return;
  }

  await openFile(file, els, handle);
}

// ─── Pinyin integration ───────────────────────────────────────────
//
// The legacy two-phase reader pipeline (processSelection + showOverlay
// + queryLLM + cache.ts + runFallbackTranslation + runQuickTranslation
// Preview) has been retired. All renderers now route lookups through
// the click-flow installed in initReader(); the reader-side direct
// sentence-translation provider (readerSentenceProvider, defined
// below) calls queryLLMSentence + sentence-cache directly without a
// service-worker round-trip.


// ─── Click-flow integration (sentence-mode) ────────────────────────

/**
 * Reader-side sentence translation provider for click-flow. The
 * reader runs in an extension page so it can call queryLLMSentence
 * directly — no service-worker round-trip required, which keeps
 * latency lower than the content script's path.
 *
 * Layered: cache hit → bypass network entirely. Settings → choose
 * provider/model. Errors → surfaced to the popup via onError.
 */
async function readerSentenceProvider(args: {
  sentence: string;
  pinyinStyle: import("../shared/types").PinyinStyle;
  requestId: number;
  onResponse: (msg: import("../shared/types").SentenceTranslateResponseLLM) => void;
  onError: (msg: { error: string; code: string }) => void;
}): Promise<void> {
  const settings = await getExtensionSettings();
  const cacheKey = await hashSentenceKey(
    args.sentence,
    args.pinyinStyle,
    settings.provider,
    settings.model,
  );

  const cached = await getSentenceFromCache(cacheKey);
  if (cached) {
    args.onResponse({
      type: "SENTENCE_TRANSLATE_RESPONSE_LLM",
      sentence: args.sentence,
      requestId: args.requestId,
      translation: cached.translation,
      words: cached.words,
    });
    return;
  }

  if (!settings.llmEnabled) {
    args.onError({
      error: "AI Translations are disabled in settings.",
      code: "DISABLED",
    });
    return;
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) {
    args.onError({
      error: "Set up an API key in extension settings for translations.",
      code: "AUTH_FAILED",
    });
    return;
  }

  const config: LLMConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
  };

  const result = await queryLLMSentence(args.sentence, args.pinyinStyle, config);
  if (result.ok) {
    await saveSentenceToCache(cacheKey, result.data);
    args.onResponse({
      type: "SENTENCE_TRANSLATE_RESPONSE_LLM",
      sentence: args.sentence,
      requestId: args.requestId,
      translation: result.data.translation,
      words: result.data.words,
    });
  } else {
    args.onError({ error: result.error.message, code: result.error.code });
  }
}

/**
 * Reads ExtensionSettings + ReaderSettings, pushes the click-flow's
 * relevant inputs (theme, font size, pinyinStyle, llmEnabled,
 * ttsEnabled, clickFlowEnabled). The reader honours the same
 * `overlayEnabled` master switch that gates the in-page click-flow
 * on regular web pages, so toggling it in the popup silences both.
 */
async function pushClickFlowSettings(): Promise<void> {
  const ext = await getExtensionSettings();
  setClickFlowSettings({
    theme: currentSharedTheme,
    fontSize: ext.fontSize,
    pinyinStyle: ext.pinyinStyle,
    llmEnabled: ext.llmEnabled,
    ttsEnabled: ext.ttsEnabled,
    clickFlowEnabled: ext.overlayEnabled,
  });
}

// ─── Forward iframe key events to parent navigation ────────────────

function attachKeyHandler(
  renderer: FormatRenderer,
  els: ReturnType<typeof getElements>,
): void {
  if (!(renderer instanceof EpubRenderer)) return;
  const rendition = renderer.getRendition();
  if (!rendition) return;

  rendition.on("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (e.key === "ArrowLeft") els.prevBtn.click();
      else els.nextBtn.click();
    }
  });
}

// ─── Selection handling ────────────────────────────────────────────

/**
 * EPUB renders each spine page inside its own iframe with its own
 * document. We hook epub.js's per-iframe "rendered" event so we can
 * install click-flow listeners + inject the `::highlight()` CSS rules
 * into each iframe document. The popup itself lives in the parent
 * document; click-flow translates iframe-relative rects to parent
 * coords for positioning.
 *
 * Bookmark anchor capture: handled by the commit-hook path in
 * initReader's setOnSentenceCommit — EpubRenderer.captureAnchor()
 * builds a CFI from the click-flow's wordRange directly.
 */
function attachClickFlowToEpub(renderer: FormatRenderer): void {
  if (!(renderer instanceof EpubRenderer)) return;

  renderer.onIframeRendered((iframeDoc) => {
    ensureHighlightStylesInjected(iframeDoc);
    initClickFlow(iframeDoc);
  });
}

// Non-EPUB renderers route single-click lookups through the click-
// flow installed in initReader(); the legacy mouseup-based handler
// that used to live here was retired in favor of that flow.

// ─── Core file loading ─────────────────────────────────────────────

async function openFile(
  file: File,
  els: ReturnType<typeof getElements>,
  handle?: FileSystemFileHandle,
): Promise<void> {
  if (currentRenderer) {
    flushDebouncedPersist();
    stopAutosave();
    currentRenderer.destroy();
    currentRenderer = null;
  }
  // Reset before loading the new file so a stale anchor from the
  // previous book can't be persisted against this one's hash.
  lastCapturedAnchor = null;
  savedTabSwitchLocation = null;
  savedTabSwitchScrollTop = null;

  const renderer = getRendererForFile(file);
  if (!renderer) {
    alert(`Unsupported format. Supported: ${getSupportedExtensions().join(", ")}`);
    return;
  }

  currentRenderer = renderer;
  currentFileHash = await getFileHash(file);

  if (handle) {
    saveFileHandle(currentFileHash, handle).catch(() => {});
  }

  let metadata: BookMetadata;
  try {
    metadata = await renderer.load(file);
  } catch (err) {
    currentRenderer = null;
    currentFileHash = "";
    const msg = err instanceof Error ? err.message : String(err);
    alert(`Could not load "${file.name}":\n${msg}`);
    return;
  }
  currentMetadata = metadata;

  els.bookTitle.textContent = metadata.title;
  els.bookAuthor.textContent = metadata.author ? `\u2014 ${metadata.author}` : "";
  document.title = `${metadata.title} \u2014 Pinyin Reader`;

  // Pre-populate the bookmark sidebar so it's ready the moment the
  // user clicks "Show all bookmarks" (no flash of empty state).
  await renderBookmarkList(els);

  els.tocList.innerHTML = "";
  renderToc(els.tocList, metadata.toc, async (href) => {
    await renderer.goTo(href);
    const spineIdx = renderer.getSpineIndex(href);
    if (spineIdx >= 0) {
      metadata.currentChapter = spineIdx;
    }
    updateProgress(els, metadata);
    persistCurrentState();
  });

  els.landing.classList.add("hidden");
  els.readerContent.classList.remove("hidden");
  els.readerFooter.classList.remove("hidden");
  els.openFileBtn.classList.remove("hidden");

  if (renderer instanceof EpubRenderer && readerSettings.readingMode === "paginated") {
    renderer.setInitialFlow("paginated");
  }
  await renderer.renderTo(els.readerContent);
  renderer.applySettings(effectiveReaderSettings());
  attachClickFlowToEpub(renderer);
  attachKeyHandler(renderer, els);

  renderer.onRelocated((spineIndex) => {
    if (metadata) {
      metadata.currentChapter = spineIndex;
      updateProgress(els, metadata);
      debouncedPersist();
    }
  });

  const savedState = await loadReadingState(currentFileHash);
  if (savedState?.location) {
    await renderer.goTo(savedState.location);
    metadata.currentChapter = savedState.currentChapter;
  }
  // Refine the coarse jump to the exact word the user last looked at.
  // Anchor failures are silent so we keep whatever position goTo()
  // already produced as the fallback.
  if (savedState?.lastWordAnchor) {
    try {
      await renderer.goToAnchor(savedState.lastWordAnchor);
      lastCapturedAnchor = savedState.lastWordAnchor;
    } catch {
      // ignore
    }
  }

  updateProgress(els, metadata);
  startAutosave();

  await saveReadingState({
    fileHash: currentFileHash,
    fileName: file.name,
    title: metadata.title,
    author: metadata.author,
    location: renderer.getCurrentLocation(),
    currentChapter: metadata.currentChapter,
    totalChapters: metadata.totalChapters,
    lastOpened: Date.now(),
    lastWordAnchor: lastCapturedAnchor ?? undefined,
  });
}

// ─── Autosave ──────────────────────────────────────────────────────

function persistCurrentState(): void {
  if (!currentRenderer || !currentMetadata) return;
  const location = currentRenderer.getCurrentLocation();
  if (!location) return;
  saveReadingState({
    fileHash: currentFileHash,
    fileName: currentMetadata.title,
    title: currentMetadata.title,
    author: currentMetadata.author,
    location,
    currentChapter: currentMetadata.currentChapter,
    totalChapters: currentMetadata.totalChapters,
    lastOpened: Date.now(),
    lastWordAnchor: lastCapturedAnchor ?? undefined,
  });
}

function debouncedPersist(): void {
  if (debounceSaveTimer !== null) clearTimeout(debounceSaveTimer);
  debounceSaveTimer = setTimeout(() => {
    debounceSaveTimer = null;
    persistCurrentState();
  }, DEBOUNCE_SAVE_MS);
}

function flushDebouncedPersist(): void {
  if (debounceSaveTimer !== null) {
    clearTimeout(debounceSaveTimer);
    debounceSaveTimer = null;
    persistCurrentState();
  }
}

function startAutosave(): void {
  stopAutosave();
  autosaveTimer = setInterval(persistCurrentState, AUTOSAVE_INTERVAL_MS);
}

function stopAutosave(): void {
  if (autosaveTimer !== null) {
    clearInterval(autosaveTimer);
    autosaveTimer = null;
  }
  if (debounceSaveTimer !== null) {
    clearTimeout(debounceSaveTimer);
    debounceSaveTimer = null;
  }
}

// ─── Settings panel wiring ─────────────────────────────────────────

function populateSettingsPanel(
  els: ReturnType<typeof getElements>,
  settings: ReaderSettings,
): void {
  els.fontSizeSetting.value = String(settings.fontSize);
  els.fontSizeValue.textContent = String(settings.fontSize);
  syncRangeFill(els.fontSizeSetting);
  els.fontFamilySetting.value = settings.fontFamily;
  els.lineSpacingSetting.value = String(settings.lineSpacing);
  els.lineSpacingValue.textContent = String(settings.lineSpacing);
  syncRangeFill(els.lineSpacingSetting);
  els.themeSetting.value = dropdownThemeValue();
  els.readingModeSetting.value = settings.readingMode;
}

/**
 * Consume the current panel state and update both the reader
 * settings and the in-memory mirror of the shared theme. Theme is
 * routed through partitionDropdownTheme(): "sepia" stays in the
 * reader override, anything else updates the shared mirror and
 * clears the reader override so subsequent loads track shared.
 *
 * Storage writes happen in the panel-close handler, not here -- this
 * function is also used during live preview where we don't want to
 * thrash chrome.storage on every slider tick.
 */
function syncPanelToState(els: ReturnType<typeof getElements>): void {
  const fontSize = parseInt(els.fontSizeSetting.value, 10);
  const fontFamily = els.fontFamilySetting.value;
  const lineSpacing = parseFloat(els.lineSpacingSetting.value);
  const readingMode = els.readingModeSetting.value as ReaderSettings["readingMode"];

  const { readerTheme, sharedTheme } = partitionDropdownTheme(
    els.themeSetting.value,
  );

  readerSettings = {
    fontSize,
    fontFamily,
    lineSpacing,
    theme: readerTheme,
    readingMode,
  };
  if (sharedTheme !== null) {
    currentSharedTheme = sharedTheme;
  }
}

// ─── Live settings application ─────────────────────────────────────

function applyCurrentSettings(els: ReturnType<typeof getElements>): void {
  syncPanelToState(els);
  applyTheme();
  if (currentRenderer) {
    currentRenderer.applySettings(effectiveReaderSettings());
    // DOM renderers reflow text without touching scrollTop, so the
    // pixel position now points at different words. PDF rerenders
    // (rebuilds pages) handle their own page-level restore. Either
    // way we want to land back on the user's last word if we have it.
    void refineToLastAnchor();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Toast ─────────────────────────────────────────────────────────

/**
 * Show an ephemeral status message at the bottom of the reader pane.
 * Used by the bookmark feature for "Bookmark added", "Click a Chinese
 * word first", and jump-failure messages. Single-toast policy: a
 * second call cancels the previous timer and replaces the text.
 */
function showToast(els: ReturnType<typeof getElements>, message: string): void {
  if (!els.readerToast) return;
  els.readerToast.textContent = message;
  els.readerToast.classList.remove("hidden");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.readerToast.classList.add("hidden");
    toastTimer = null;
  }, TOAST_DURATION_MS);
}

// ─── Bookmark sidebar / popover ────────────────────────────────────

/**
 * Hide the bookmark popover and reflect the closed state in
 * aria-expanded so screen readers see the right disclosure value.
 */
function closeBookmarkMenu(els: ReturnType<typeof getElements>): void {
  els.bookmarkMenu.classList.add("hidden");
  els.bookmarkToggle.setAttribute("aria-expanded", "false");
}

function openBookmarkMenu(els: ReturnType<typeof getElements>): void {
  els.bookmarkMenu.classList.remove("hidden");
  els.bookmarkToggle.setAttribute("aria-expanded", "true");
}

/**
 * Show one sidebar at a time. The TOC and Bookmark sidebars share the
 * same screen position (left edge) so leaving both open would have
 * them stack invisibly; mutual exclusion keeps the user oriented.
 */
function showOnlySidebar(
  els: ReturnType<typeof getElements>,
  which: "toc" | "bookmark" | "none",
): void {
  els.tocSidebar.classList.toggle("collapsed", which !== "toc");
  els.bookmarkSidebar.classList.toggle("collapsed", which !== "bookmark");
}

function isBookmarkSidebarOpen(els: ReturnType<typeof getElements>): boolean {
  return !els.bookmarkSidebar.classList.contains("collapsed");
}

function isTocSidebarOpen(els: ReturnType<typeof getElements>): boolean {
  return !els.tocSidebar.classList.contains("collapsed");
}

/**
 * Re-render the bookmark sidebar's list from storage. Empty-state
 * message lives in the same container so the layout stays stable.
 */
async function renderBookmarkList(els: ReturnType<typeof getElements>): Promise<void> {
  els.bookmarkList.innerHTML = "";
  if (!currentFileHash) {
    appendBookmarkEmptyState(els);
    return;
  }
  const bookmarks = await listBookmarks(currentFileHash);
  if (bookmarks.length === 0) {
    appendBookmarkEmptyState(els);
    return;
  }
  for (const bm of bookmarks) {
    els.bookmarkList.appendChild(buildBookmarkRow(els, bm));
  }
}

function appendBookmarkEmptyState(els: ReturnType<typeof getElements>): void {
  const empty = document.createElement("div");
  empty.className = "bookmark-list-empty";
  empty.textContent =
    "No bookmarks yet. Click the bookmark icon while reading to save your spot.";
  els.bookmarkList.appendChild(empty);
}

/**
 * Format the bookmark's primary line — a non-Chinese, scannable label
 * the user can confidently click without the click-flow's word-lookup
 * hijacking it. Pattern: "Chapter N · Apr 26" with optional TOC name
 * appended when one was captured at save time.
 */
function formatBookmarkPrimary(bm: ManualBookmark): string {
  const date = new Date(bm.createdAt);
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  let head: string;
  if (typeof bm.chapterIndex === "number" && bm.chapterIndex >= 0) {
    head = `Chapter ${bm.chapterIndex + 1}`;
    if (bm.chapterLabel) head += ` · ${bm.chapterLabel}`;
  } else {
    head = "Bookmark";
  }
  return `${head} · ${dateStr}`;
}

function buildBookmarkRow(
  els: ReturnType<typeof getElements>,
  bm: ManualBookmark,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "bookmark-list-item";
  row.dataset.bookmarkId = bm.id;

  // Primary jump target. The whole button is one click target so the
  // user can't miss; its visible content is plain ASCII metadata, which
  // means click-flow has nothing to intercept even without the
  // [data-no-clickflow] guard on the parent.
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "bookmark-jump";
  jump.title = "Jump to bookmark";

  const primary = document.createElement("span");
  primary.className = "bookmark-primary";
  primary.textContent = formatBookmarkPrimary(bm);
  jump.appendChild(primary);

  // Snippet is decorative context only — small, dimmed, two-line clamp.
  // It is *inside* the jump button, so clicking on the Chinese chars
  // still fires the jump handler (helped by the sidebar's
  // data-no-clickflow opt-out so click-flow doesn't preempt).
  const snippetText = (bm.label ?? "").trim();
  if (snippetText) {
    const snippet = document.createElement("span");
    snippet.className = "bookmark-snippet";
    snippet.textContent = snippetText;
    jump.appendChild(snippet);
  }

  jump.addEventListener("click", async () => {
    await jumpToBookmark(els, bm);
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "bookmark-delete";
  del.title = "Delete bookmark";
  del.setAttribute("aria-label", "Delete bookmark");
  del.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!currentFileHash) return;
    await storeRemoveBookmark(currentFileHash, bm.id);
    await renderBookmarkList(els);
  });

  row.append(jump, del);
  return row;
}

async function jumpToBookmark(
  els: ReturnType<typeof getElements>,
  bm: ManualBookmark,
): Promise<void> {
  if (!currentRenderer) return;
  let ok = false;
  try {
    ok = await currentRenderer.goToAnchor(bm.anchor);
  } catch {
    ok = false;
  }
  if (!ok) {
    showToast(
      els,
      "Could not jump to bookmark - file content may have changed.",
    );
    return;
  }
  // Adopt the jumped-to anchor as the latest captured one so a tab
  // switch right after a jump restores to where the user just landed
  // rather than where they were before clicking the bookmark.
  lastCapturedAnchor = bm.anchor;
  showOnlySidebar(els, "none");
}

async function handleAddBookmark(els: ReturnType<typeof getElements>): Promise<void> {
  if (!currentFileHash) {
    showToast(els, "Open a file first to bookmark a position.");
    return;
  }
  if (!lastCapturedAnchor) {
    showToast(
      els,
      "Click a Chinese word first - bookmarks anchor on the last word you looked up.",
    );
    return;
  }
  // Snapshot the chapter info at save time. Stored on the bookmark so
  // the list can render a non-Chinese primary label even after the
  // user has navigated elsewhere.
  const chapterIndex = currentMetadata?.currentChapter;
  const chapterLabel =
    chapterIndex !== undefined
      ? resolveTocLabelForChapter(chapterIndex)
      : undefined;
  await storeAddBookmark(currentFileHash, lastCapturedAnchor, undefined, {
    index: chapterIndex,
    label: chapterLabel,
  });
  await renderBookmarkList(els);
  closeBookmarkMenu(els);
  showToast(els, "Bookmark added");
}

/**
 * Best-effort lookup of a TOC label for the given chapter / spine
 * index. Walks the TOC depth-first and asks the renderer to map each
 * entry's href back to its spine index; the deepest matching entry's
 * label wins (so a sub-chapter "Section 2.3" beats the parent
 * "Chapter 2" when both resolve to the same spine item). Returns
 * undefined when the renderer / metadata aren't available yet or
 * nothing matches — the UI falls back to "Chapter N+1" alone in
 * that case.
 */
function resolveTocLabelForChapter(chapterIndex: number): string | undefined {
  if (!currentRenderer || !currentMetadata) return undefined;
  let best: { label: string; level: number } | undefined;
  const walk = (entries: TocEntry[], level: number): void => {
    for (const entry of entries) {
      try {
        const idx = currentRenderer!.getSpineIndex(entry.href);
        if (idx === chapterIndex && (!best || level > best.level)) {
          best = { label: entry.label, level };
        }
      } catch {
        // Some renderers throw on unknown hrefs; treat as a non-match.
      }
      if (entry.children?.length) walk(entry.children, level + 1);
    }
  };
  walk(currentMetadata.toc, 0);
  return best?.label;
}

// ─── Return to landing ─────────────────────────────────────────────

/**
 * Tear down the active book and re-show the landing screen so the
 * user can pick a different file. Mirrors the cleanup in openFile()
 * so that a subsequent load starts from a clean slate.
 */
async function goToLanding(els: ReturnType<typeof getElements>): Promise<void> {
  if (currentRenderer) {
    flushDebouncedPersist();
    stopAutosave();
    currentRenderer.destroy();
    currentRenderer = null;
  }
  // Tear down any open click-flow popup so it doesn't anchor over the
  // landing screen.
  dismissClickFlow();
  currentMetadata = null;
  currentFileHash = "";

  els.bookTitle.textContent = "ZiPinYin-Reader";
  els.bookAuthor.textContent = "";
  document.title = "ZiPinYin-Library";

  els.tocList.innerHTML = "";
  els.bookmarkList.innerHTML = "";
  els.readerContent.innerHTML = "";
  els.readerContent.classList.add("hidden");
  els.readerFooter.classList.add("hidden");
  els.openFileBtn.classList.add("hidden");
  els.landing.classList.remove("hidden");
  // Both sidebars get collapsed when leaving a book so the landing
  // screen isn't pushed to the side by a stale, empty sidebar.
  showOnlySidebar(els, "none");
  closeBookmarkMenu(els);

  await renderRecentFiles(els);
}

// ─── Initialization ────────────────────────────────────────────────

export async function initReader(): Promise<void> {
  const els = getElements();
  readerSettings = await loadReaderSettings();
  currentSharedTheme = await loadSharedTheme();
  applyTheme();
  populateSettingsPanel(els, readerSettings);

  // Live-propagate shared theme changes (e.g. user picks Dark in the
  // popup while the library tab is open) without requiring a reload.
  // Bound exactly once per reader-init -- the listener guard removes
  // the previous one if initReader runs again (hot reload, tests).
  if (typeof chrome.storage?.onChanged?.addListener === "function") {
    if (storageChangeListener) {
      try {
        chrome.storage.onChanged.removeListener(storageChangeListener);
      } catch {
        // older Chrome shims may throw if the listener wasn't attached
      }
    }
    storageChangeListener = (changes, area) => {
      if (area !== "sync") return;
      // Push relevant changes into the click-flow settings cache.
      const cfPatch: Partial<{
        theme: ExtensionSettings["theme"];
        fontSize: number;
        pinyinStyle: ExtensionSettings["pinyinStyle"];
        llmEnabled: boolean;
        ttsEnabled: boolean;
        clickFlowEnabled: boolean;
      }> = {};
      if (changes.theme && typeof changes.theme.newValue !== "undefined") {
        cfPatch.theme = changes.theme.newValue as ExtensionSettings["theme"];
      }
      if (typeof changes.fontSize?.newValue === "number") {
        cfPatch.fontSize = changes.fontSize.newValue;
      }
      if (changes.pinyinStyle?.newValue) {
        cfPatch.pinyinStyle = changes.pinyinStyle.newValue as ExtensionSettings["pinyinStyle"];
      }
      if (typeof changes.llmEnabled?.newValue === "boolean") {
        cfPatch.llmEnabled = changes.llmEnabled.newValue;
      }
      if (typeof changes.ttsEnabled?.newValue === "boolean") {
        cfPatch.ttsEnabled = changes.ttsEnabled.newValue;
      }
      if (typeof changes.overlayEnabled?.newValue === "boolean") {
        cfPatch.clickFlowEnabled = changes.overlayEnabled.newValue;
      }
      if (Object.keys(cfPatch).length > 0) {
        setClickFlowSettings(cfPatch);
        // Mirror content.ts: dismiss any open popup the moment the
        // master switch flips off, so a stale popup doesn't sit there
        // until the user manually closes it.
        if (cfPatch.clickFlowEnabled === false) dismissClickFlow();
      }

      const change = changes.theme;
      if (!change) return;
      const next = change.newValue;
      if (
        next === "light" ||
        next === "dark" ||
        next === "sepia" ||
        next === "auto"
      ) {
        currentSharedTheme = next;
      } else if (next === undefined) {
        currentSharedTheme = DEFAULT_SETTINGS.theme;
      }
      applyTheme();
      // Keep the dropdown in sync if the panel is currently open so
      // the user doesn't see a stale selection.
      els.themeSetting.value = dropdownThemeValue();
      // Re-apply the renderer's settings so format-specific theming
      // (PDF dark inversion, EPUB iframe colors) flips along with
      // the rest of the page when the popup writes a new value.
      // effectiveReaderSettings() folds in the legacy sepia override
      // so pre-migration data still wins over the shared key.
      if (currentRenderer) {
        currentRenderer.applySettings(effectiveReaderSettings());
      }
    };
    chrome.storage.onChanged.addListener(storageChangeListener);
  }

  els.openFileBtn?.classList.add("hidden");

  // Shared "+ Vocab" pipeline -- same handler the in-page content
  // script registers, so reader captures stay on one wire format.
  // See src/shared/vocab-capture.ts. Also wire the saved-state cache
  // so the popup paints "Saved" instead of "+ Vocab" for words already
  // in the user's vocab list, and so post-save the local cache stays
  // ahead of the storage onChanged round-trip.
  initVocabSavedCache();
  setClickPopupVocabSavedChecker(isVocabSaved);
  setClickPopupVocabCallback((word, context) => {
    markVocabSavedLocally(word.chars);
    return handleVocabCapture(word, context);
  });

  // ── Click-flow integration ────────────────────────────────────
  //
  // The reader runs in an extension page so it can call the LLM
  // client directly (no service-worker round-trip). We register a
  // reader-side sentence-translation provider before initClickFlow
  // so the default (chrome.runtime.sendMessage to SW) isn't used.
  //
  // EPUB renders each spine page into its own iframe; click-flow's
  // initClickFlow(iframeDoc) is wired up per-render via
  // attachClickFlowToEpub() — the EpubRenderer fires onIframeRendered
  // callbacks on every "rendered" event, and we attach listeners +
  // inject ::highlight() rules per iframe. Popup positioning translates
  // iframe-relative rects to parent coords inside click-flow.
  setSentenceTranslationProvider(readerSentenceProvider);
  setOnSentenceCommit((info) => {
    // Capture word-precise anchor on every click (fresh sentence OR
    // same-sentence retarget) so the bookmark icon saves the user's
    // current reading position rather than a stale earlier one. The
    // click-flow's wordRange is the single source of truth for every
    // renderer — DOM/PDF/subtitle anchor on it directly; EPUB derives
    // a CFI from it via cfiFromRange on the owning spine iframe.
    if (currentRenderer) {
      const anchor = currentRenderer.captureAnchor({
        wordRange: info.wordRange,
      });
      if (anchor) lastCapturedAnchor = anchor;
    }
  });
  await pushClickFlowSettings();
  initClickFlow();

  await renderRecentFiles(els);

  // Click-flow listeners (installed in initClickFlow above) own
  // every renderer's lookups. EPUB additionally hooks each rendered
  // iframe via attachClickFlowToEpub() so click-flow listeners reach
  // into the iframe document tree.

  els.openFileBtn?.addEventListener("click", () => {
    goToLanding(els);
  });

  // ── File loading ──────────────────────────────────────────────

  if (typeof window.showOpenFilePicker === "function") {
    const label = els.fileInput.closest("label") ?? els.fileInput.parentElement;
    if (label) {
      label.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [
              { description: "EPUB files", accept: { "application/epub+zip": [".epub"] } },
              { description: "PDF files", accept: { "application/pdf": [".pdf"] } },
              { description: "Word documents", accept: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] } },
              { description: "Plain text", accept: { "text/plain": [".txt"] } },
              { description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } },
              { description: "HTML", accept: { "text/html": [".html", ".htm"] } },
              { description: "Subtitles", accept: { "text/plain": [".srt", ".vtt", ".ass", ".ssa"] } },
            ],
            multiple: false,
          });
          const file = await handle.getFile();
          await openFile(file, els, handle);
        } catch {
          // User cancelled the picker
        }
      });
    }
  } else {
    els.fileInput.addEventListener("change", () => {
      const file = els.fileInput.files?.[0];
      if (file) openFile(file, els);
    });
  }

  // ── Drag and drop ─────────────────────────────────────────────

  els.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropZone.classList.add("drag-over");
  });

  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("drag-over");
  });

  els.dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("drag-over");

    const item = e.dataTransfer?.items?.[0];
    if (item && typeof item.getAsFileSystemHandle === "function") {
      try {
        const handle = await item.getAsFileSystemHandle() as FileSystemFileHandle;
        if (handle?.kind === "file") {
          const file = await handle.getFile();
          await openFile(file, els, handle);
          return;
        }
      } catch {
        // Fall through to legacy path
      }
    }

    const file = e.dataTransfer?.files[0];
    if (file) openFile(file, els);
  });

  // ── Navigation ────────────────────────────────────────────────

  els.prevBtn.addEventListener("click", async () => {
    if (!currentRenderer || !currentMetadata) return;
    await currentRenderer.prev();
    if (currentMetadata.currentChapter > 0) currentMetadata.currentChapter--;
    updateProgress(els, currentMetadata);
    persistCurrentState();
  });

  els.nextBtn.addEventListener("click", async () => {
    if (!currentRenderer || !currentMetadata) return;
    await currentRenderer.next();
    if (currentMetadata.currentChapter < currentMetadata.totalChapters - 1) {
      currentMetadata.currentChapter++;
    }
    updateProgress(els, currentMetadata);
    persistCurrentState();
  });

  // ── TOC sidebar toggle ────────────────────────────────────────

  // TOC and Bookmark sidebars are mutually exclusive (same screen
  // position) -- toggling one closes the other so the user always
  // sees a single panel rather than a stack.
  els.tocToggle.addEventListener("click", () => {
    if (isTocSidebarOpen(els)) {
      showOnlySidebar(els, "none");
    } else {
      showOnlySidebar(els, "toc");
    }
  });

  // ── Bookmark popover + sidebar ────────────────────────────────

  els.bookmarkToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    // If the bookmark sidebar is already showing, the icon acts as a
    // single close affordance -- mirrors how the hamburger toggles
    // the TOC sidebar directly. Re-opening the popover here would be
    // redundant since its only useful action ("Show all bookmarks")
    // would just close the sidebar the user is already looking at.
    if (isBookmarkSidebarOpen(els)) {
      showOnlySidebar(els, "none");
      closeBookmarkMenu(els);
      return;
    }
    if (els.bookmarkMenu.classList.contains("hidden")) {
      if (isTocSidebarOpen(els)) {
        showOnlySidebar(els, "none");
      }
      openBookmarkMenu(els);
    } else {
      closeBookmarkMenu(els);
    }
  });

  els.bookmarkAdd.addEventListener("click", () => {
    void handleAddBookmark(els);
  });

  els.bookmarkShow.addEventListener("click", async () => {
    closeBookmarkMenu(els);
    if (isBookmarkSidebarOpen(els)) {
      showOnlySidebar(els, "none");
    } else {
      await renderBookmarkList(els);
      showOnlySidebar(els, "bookmark");
    }
  });

  // ── Settings panel ────────────────────────────────────────────

  els.settingsToggle.addEventListener("click", () => {
    els.settingsPanel.classList.remove("hidden");
  });

  els.settingsClose.addEventListener("click", async () => {
    const prevMode = readerSettings.readingMode;
    const { sharedTheme: pickedShared } = partitionDropdownTheme(
      els.themeSetting.value,
    );
    syncPanelToState(els);
    applyTheme();

    if (
      currentRenderer instanceof EpubRenderer &&
      readerSettings.readingMode !== prevMode
    ) {
      await currentRenderer.applyReadingMode(
        readerSettings.readingMode,
        effectiveReaderSettings(),
      );
      attachClickFlowToEpub(currentRenderer);
      attachKeyHandler(currentRenderer, els);
      // applyReadingMode rebuilds the rendition and only restores the
      // chapter-level CFI; refine to the exact word if we have one.
      await refineToLastAnchor();
    }

    els.settingsPanel.classList.add("hidden");
    await saveReaderSettings(readerSettings);
    // The picked dropdown value (light/dark/sepia/auto) is the
    // canonical theme for every surface, so persist it to the shared
    // key. partitionDropdownTheme always returns a non-null value
    // now that sepia is shared, but we keep the type guard to stay
    // forward-compatible with any future reader-only override.
    if (pickedShared !== null) {
      await chrome.storage.sync.set({ theme: pickedShared });
    }
  });

  els.fontSizeSetting.addEventListener("input", () => {
    els.fontSizeValue.textContent = els.fontSizeSetting.value;
    syncRangeFill(els.fontSizeSetting);
    applyCurrentSettings(els);
  });

  els.fontFamilySetting.addEventListener("change", () => {
    applyCurrentSettings(els);
  });

  els.lineSpacingSetting.addEventListener("input", () => {
    els.lineSpacingValue.textContent = els.lineSpacingSetting.value;
    syncRangeFill(els.lineSpacingSetting);
    applyCurrentSettings(els);
  });

  els.themeSetting.addEventListener("change", () => {
    applyCurrentSettings(els);
  });

  // ── Keyboard shortcuts ────────────────────────────────────────

  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    const isInput = tag === "input" || tag === "textarea" || tag === "select";
    if (isInput) return;

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (e.key === "ArrowLeft") els.prevBtn.click();
      else els.nextBtn.click();
    } else if (e.key === "Escape") {
      dismissClickFlow();
      // Escape also closes the bookmark menu so the user has a single
      // dismiss key for both the overlay and any toolbar popover.
      if (!els.bookmarkMenu.classList.contains("hidden")) {
        closeBookmarkMenu(els);
      }
      // ...and either sidebar. TOC included for symmetry so keyboard
      // users don't have to think about which panel is open.
      if (isBookmarkSidebarOpen(els) || isTocSidebarOpen(els)) {
        showOnlySidebar(els, "none");
      }
    }
  });

  // ── Dismiss overlay + bookmark popover on outside click ───────

  document.addEventListener("mousedown", (e) => {
    const root = document.getElementById("hg-extension-root");
    if (root && !root.contains(e.target as Node)) {
      dismissClickFlow();
    }
    // Close the bookmark popover when clicking outside it (and outside
    // its toggle button -- the toggle has its own click handler that
    // would re-open the menu if we closed it here).
    if (
      !els.bookmarkMenu.classList.contains("hidden") &&
      !els.bookmarkMenu.contains(e.target as Node) &&
      !els.bookmarkToggle.contains(e.target as Node)
    ) {
      closeBookmarkMenu(els);
    }
  });

  // ── Save state on tab close ───────────────────────────────────

  window.addEventListener("beforeunload", () => {
    flushDebouncedPersist();
    persistCurrentState();
  });
}

// initReader() is invoked by the library shell (src/library/library.ts);
// the reader no longer ships as a standalone page.
