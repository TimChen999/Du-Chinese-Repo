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

import { convertToPinyin } from "../background/pinyin-service";
import { queryLLM } from "../background/llm-client";
import { hashText, getFromCache, saveToCache } from "../background/cache";
import { containsChinese } from "../shared/chinese-detect";
import {
  showOverlay,
  updateOverlay,
  dismissOverlay,
  setVocabCallback,
} from "../content/overlay";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  MAX_SELECTION_LENGTH,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
} from "../shared/constants";
import type { ExtensionSettings, LLMConfig } from "../shared/types";
import { saveFileHandle, getFileHandle } from "./file-handle-store";
import { getRendererForFile, getSupportedExtensions } from "./renderers/renderer-registry";
import { EpubRenderer } from "./renderers/epub-renderer";
import type {
  FormatRenderer,
  BookMetadata,
  TocEntry,
  ReadingState,
  ReaderSettings,
} from "./reader-types";
import {
  DEFAULT_READER_SETTINGS,
  MAX_RECENT_FILES,
  AUTOSAVE_INTERVAL_MS,
} from "./reader-types";

// ─── Module state ──────────────────────────────────────────────────

let currentRenderer: FormatRenderer | null = null;
let currentMetadata: BookMetadata | null = null;
let currentFileHash = "";
let currentRequestId = 0;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let readerSettings: ReaderSettings = { ...DEFAULT_READER_SETTINGS };

// ─── DOM references ────────────────────────────────────────────────

function getElements() {
  return {
    tocToggle: document.getElementById("toc-toggle") as HTMLButtonElement,
    tocSidebar: document.getElementById("toc-sidebar") as HTMLElement,
    tocList: document.getElementById("toc-list") as HTMLElement,
    bookTitle: document.getElementById("book-title") as HTMLElement,
    bookAuthor: document.getElementById("book-author") as HTMLElement,
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
    pinyinSetting: document.getElementById("setting-pinyin") as HTMLInputElement,
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
  return { ...DEFAULT_READER_SETTINGS, ...result.readerSettings };
}

async function saveReaderSettings(settings: ReaderSettings): Promise<void> {
  await chrome.storage.sync.set({ readerSettings: settings });
}

async function getExtensionSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Reading state persistence ─────────────────────────────────────

export async function saveReadingState(state: ReadingState): Promise<void> {
  await chrome.storage.local.set({ [`reader_state_${state.fileHash}`]: state });
  await updateRecentFiles(state);
}

export async function loadReadingState(
  fileHash: string,
): Promise<ReadingState | null> {
  const result = await chrome.storage.local.get(`reader_state_${fileHash}`);
  return result[`reader_state_${fileHash}`] ?? null;
}

export async function getRecentFiles(): Promise<ReadingState[]> {
  const result = await chrome.storage.local.get("reader_recent");
  return result.reader_recent ?? [];
}

export async function updateRecentFiles(state: ReadingState): Promise<void> {
  const recent = await getRecentFiles();
  const filtered = recent.filter((r) => r.fileHash !== state.fileHash);
  filtered.unshift(state);
  if (filtered.length > MAX_RECENT_FILES) filtered.length = MAX_RECENT_FILES;
  await chrome.storage.local.set({ reader_recent: filtered });
}

// ─── Theme resolution ──────────────────────────────────────────────

function resolveTheme(theme: ReaderSettings["theme"]): "light" | "dark" | "sepia" {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ReaderSettings["theme"]): void {
  document.body.setAttribute("data-theme", resolveTheme(theme));
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

// ─── Pinyin integration (two-phase) ────────────────────────────────

async function processSelection(
  text: string,
  rect: DOMRect,
): Promise<void> {
  const requestId = ++currentRequestId;
  const truncated = text.length > MAX_SELECTION_LENGTH
    ? text.slice(0, MAX_SELECTION_LENGTH)
    : text;

  const settings = await getExtensionSettings();
  const words = convertToPinyin(truncated, settings.pinyinStyle);
  if (requestId !== currentRequestId) return;
  showOverlay(words, rect, settings.theme, settings.ttsEnabled);

  if (!settings.llmEnabled || !readerSettings.pinyinEnabled) return;

  const context = currentRenderer?.getVisibleText() ?? "";
  const cacheKey = await hashText(truncated + context);
  const cached = await getFromCache(cacheKey);

  if (cached) {
    if (requestId !== currentRequestId) return;
    updateOverlay(cached.words, cached.translation, settings.ttsEnabled);
    return;
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) return;

  const config: LLMConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
  };

  const result = await queryLLM(truncated, context, config);

  if (result && requestId === currentRequestId) {
    await saveToCache(cacheKey, result);
    updateOverlay(result.words, result.translation, settings.ttsEnabled);
  }
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

// ─── Selection handling for epub.js renditions ─────────────────────

function attachSelectionHandler(renderer: FormatRenderer): void {
  if (!(renderer instanceof EpubRenderer)) return;
  const rendition = renderer.getRendition();
  if (!rendition) return;

  rendition.on("selected", (_cfiRange: string, contents: any) => {
    if (!readerSettings.pinyinEnabled) return;

    const selection = contents.window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    if (!text || !containsChinese(text)) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    const frameEl = contents.document.defaultView?.frameElement;
    if (frameEl) {
      const iframeRect = frameEl.getBoundingClientRect();
      const adjustedRect = new DOMRect(
        rect.left + iframeRect.left,
        rect.top + iframeRect.top,
        rect.width,
        rect.height,
      );
      processSelection(text, adjustedRect);
    } else {
      processSelection(text, rect);
    }
  });
}

// ─── Core file loading ─────────────────────────────────────────────

async function openFile(
  file: File,
  els: ReturnType<typeof getElements>,
  handle?: FileSystemFileHandle,
): Promise<void> {
  if (currentRenderer) {
    stopAutosave();
    currentRenderer.destroy();
    currentRenderer = null;
  }

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

  const metadata = await renderer.load(file);
  currentMetadata = metadata;

  els.bookTitle.textContent = metadata.title;
  els.bookAuthor.textContent = metadata.author ? `\u2014 ${metadata.author}` : "";
  document.title = `${metadata.title} \u2014 Pinyin Reader`;

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

  if (renderer instanceof EpubRenderer && readerSettings.readingMode === "paginated") {
    renderer.setInitialFlow("paginated");
  }
  await renderer.renderTo(els.readerContent);
  renderer.applySettings(readerSettings);
  attachSelectionHandler(renderer);
  attachKeyHandler(renderer, els);

  renderer.onRelocated((spineIndex) => {
    if (metadata) {
      metadata.currentChapter = spineIndex;
      updateProgress(els, metadata);
    }
  });

  const savedState = await loadReadingState(currentFileHash);
  if (savedState?.location) {
    await renderer.goTo(savedState.location);
    metadata.currentChapter = savedState.currentChapter;
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
  });
}

// ─── Autosave ──────────────────────────────────────────────────────

function persistCurrentState(): void {
  if (!currentRenderer || !currentMetadata) return;
  saveReadingState({
    fileHash: currentFileHash,
    fileName: currentMetadata.title,
    title: currentMetadata.title,
    author: currentMetadata.author,
    location: currentRenderer.getCurrentLocation(),
    currentChapter: currentMetadata.currentChapter,
    totalChapters: currentMetadata.totalChapters,
    lastOpened: Date.now(),
  });
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
}

// ─── Settings panel wiring ─────────────────────────────────────────

function populateSettingsPanel(
  els: ReturnType<typeof getElements>,
  settings: ReaderSettings,
): void {
  els.fontSizeSetting.value = String(settings.fontSize);
  els.fontSizeValue.textContent = String(settings.fontSize);
  els.fontFamilySetting.value = settings.fontFamily;
  els.lineSpacingSetting.value = String(settings.lineSpacing);
  els.lineSpacingValue.textContent = String(settings.lineSpacing);
  els.themeSetting.value = settings.theme;
  els.readingModeSetting.value = settings.readingMode;
  els.pinyinSetting.checked = settings.pinyinEnabled;
}

function readSettingsFromPanel(
  els: ReturnType<typeof getElements>,
): ReaderSettings {
  return {
    fontSize: parseInt(els.fontSizeSetting.value, 10),
    fontFamily: els.fontFamilySetting.value,
    lineSpacing: parseFloat(els.lineSpacingSetting.value),
    theme: els.themeSetting.value as ReaderSettings["theme"],
    readingMode: els.readingModeSetting.value as ReaderSettings["readingMode"],
    pinyinEnabled: els.pinyinSetting.checked,
  };
}

// ─── Live settings application ─────────────────────────────────────

function applyCurrentSettings(els: ReturnType<typeof getElements>): void {
  readerSettings = readSettingsFromPanel(els);
  applyTheme(readerSettings.theme);
  if (currentRenderer) {
    currentRenderer.applySettings(readerSettings);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Initialization ────────────────────────────────────────────────

export async function initReader(): Promise<void> {
  const els = getElements();
  readerSettings = await loadReaderSettings();
  applyTheme(readerSettings.theme);
  populateSettingsPanel(els, readerSettings);

  setVocabCallback((word) => {
    chrome.runtime.sendMessage({ type: "RECORD_WORD", word });
  });

  await renderRecentFiles(els);

  // ── File loading ──────────────────────────────────────────────

  if (typeof window.showOpenFilePicker === "function") {
    const label = els.fileInput.closest("label") ?? els.fileInput.parentElement;
    if (label) {
      label.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: "EPUB files", accept: { "application/epub+zip": [".epub"] } }],
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

  els.tocToggle.addEventListener("click", () => {
    const isNarrow = window.innerWidth <= 900;
    if (isNarrow) {
      els.tocSidebar.classList.toggle("open");
    } else {
      els.tocSidebar.classList.toggle("collapsed");
    }
  });

  // ── Settings panel ────────────────────────────────────────────

  els.settingsToggle.addEventListener("click", () => {
    els.settingsPanel.classList.remove("hidden");
  });

  els.settingsClose.addEventListener("click", async () => {
    const prevMode = readerSettings.readingMode;
    readerSettings = readSettingsFromPanel(els);
    applyTheme(readerSettings.theme);

    if (
      currentRenderer instanceof EpubRenderer &&
      readerSettings.readingMode !== prevMode
    ) {
      await currentRenderer.applyReadingMode(readerSettings.readingMode, readerSettings);
      attachSelectionHandler(currentRenderer);
      attachKeyHandler(currentRenderer, els);
    }

    els.settingsPanel.classList.add("hidden");
    await saveReaderSettings(readerSettings);
  });

  els.fontSizeSetting.addEventListener("input", () => {
    els.fontSizeValue.textContent = els.fontSizeSetting.value;
    applyCurrentSettings(els);
  });

  els.fontFamilySetting.addEventListener("change", () => {
    applyCurrentSettings(els);
  });

  els.lineSpacingSetting.addEventListener("input", () => {
    els.lineSpacingValue.textContent = els.lineSpacingSetting.value;
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
      dismissOverlay();
    }
  });

  // ── Dismiss overlay on outside click ──────────────────────────

  document.addEventListener("mousedown", (e) => {
    const root = document.getElementById("hg-extension-root");
    if (root && !root.contains(e.target as Node)) {
      dismissOverlay();
    }
  });

  // ── Save state on tab close ───────────────────────────────────

  window.addEventListener("beforeunload", () => {
    persistCurrentState();
  });
}

// ─── Auto-init ─────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initReader();
});
