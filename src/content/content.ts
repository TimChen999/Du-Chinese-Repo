/**
 * Content script entry point -- injected into every page by manifest.json.
 *
 * Wires user text selections to the background service worker and manages
 * the overlay lifecycle. This is the "glue" between page interaction and
 * the extension's pinyin/translation pipeline.
 *
 * Flow: mouseup -> debounce -> containsChinese? -> PINYIN_REQUEST ->
 *   Phase 1 showOverlay (local pinyin) -> Phase 2 updateOverlay (LLM)
 *
 * Also handles context menu triggers (CONTEXT_MENU_TRIGGER) and
 * keyboard shortcut triggers (COMMAND_TRIGGER) from the service worker.
 *
 * See: SPEC.md Section 5 "Data Flow" for the full message protocol,
 *      IMPLEMENTATION_GUIDE.md Step 7 for implementation details.
 */

import { containsChinese, extractSurroundingContext } from "../shared/chinese-detect";
import { DEBOUNCE_MS, MAX_SELECTION_LENGTH } from "../shared/constants";
import type {
  ExtensionMessage,
  PinyinResponseLocal,
  Theme,
} from "../shared/types";
import {
  showOverlay,
  updateOverlay,
  showOverlayError,
  showTruncationNotice,
  dismissOverlay,
  setVocabCallback,
} from "./overlay";
import { startOCRSelection } from "./ocr-selection";

// ─── Module state ──────────────────────────────────────────────────

/** Monotonic counter to discard responses from superseded requests. */
let currentRequestId = 0;

/** Cached theme setting so each overlay doesn't need a storage read. */
let cachedTheme: Theme = "auto";

/** Cached TTS toggle so each overlay doesn't need a storage read. */
let cachedTtsEnabled = true;

/** Viewport rect from the most recent OCR area selection, awaiting capture result. */
let pendingOCRRect: { x: number; y: number; width: number; height: number } | null = null;

// ─── Debounce utility ──────────────────────────────────────────────

/**
 * Returns a debounced wrapper that delays invocation until DEBOUNCE_MS
 * of inactivity, preventing rapid-fire processing during click-drag
 * text highlighting. (SPEC.md Section 10.4)
 */
function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

// ─── Selection processing ──────────────────────────────────────────

/**
 * Core selection handler shared by mouseup, context menu, and keyboard
 * triggers. Validates Chinese content, truncates to MAX_SELECTION_LENGTH,
 * sends PINYIN_REQUEST to the service worker, and shows the overlay
 * on the Phase 1 (local pinyin) response.
 *
 * Uses a request ID to drop responses from superseded selections.
 * (SPEC.md Section 5 "Two-Phase Rendering")
 */
function processSelection(text: string, rect: DOMRect, context: string): void {
  if (!containsChinese(text)) return;

  const wasTruncated = text.length > MAX_SELECTION_LENGTH;
  const truncated = wasTruncated
    ? text.slice(0, MAX_SELECTION_LENGTH)
    : text;

  const requestId = ++currentRequestId;

  chrome.runtime.sendMessage(
    {
      type: "PINYIN_REQUEST",
      text: truncated,
      context,
      selectionRect: {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      },
    },
    (response: PinyinResponseLocal) => {
      if (requestId !== currentRequestId) return;
      if (!response || response.type !== "PINYIN_RESPONSE_LOCAL") return;
      showOverlay(response.words, rect, cachedTheme, cachedTtsEnabled);
      if (wasTruncated) showTruncationNotice();
    },
  );
}

// ─── Mouseup handler ───────────────────────────────────────────────

/**
 * Debounced mouseup listener. On each mouseup, checks the current
 * text selection for Chinese content and kicks off the pinyin flow.
 * Debouncing at DEBOUNCE_MS prevents firing during click-drag.
 * (IMPLEMENTATION_GUIDE.md Step 7a.1)
 */
const handleMouseup = debounce(() => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const context = extractSurroundingContext(selection);

  processSelection(text, rect, context);
}, DEBOUNCE_MS);

document.addEventListener("mouseup", handleMouseup);

// ─── Incoming message listener ─────────────────────────────────────

/**
 * Listens for Phase 2 responses and trigger messages from the service
 * worker, delivered via chrome.tabs.sendMessage.
 *
 * PINYIN_RESPONSE_LLM -> updateOverlay with contextual definitions
 * PINYIN_ERROR (llm)   -> showOverlayError with fallback message
 * CONTEXT_MENU_TRIGGER -> process the right-clicked selection text
 * COMMAND_TRIGGER      -> process the current keyboard-selected text
 *
 * (SPEC.md Section 5 "Message Protocol")
 */
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage) => {
    switch (message.type) {
      case "PINYIN_RESPONSE_LLM":
        updateOverlay(message.words, message.translation, cachedTtsEnabled);
        break;

      case "PINYIN_ERROR":
        if (message.phase === "llm") {
          showOverlayError(message.error);
        }
        break;

      case "CONTEXT_MENU_TRIGGER":
        handleContextMenuTrigger(message.text);
        break;

      case "COMMAND_TRIGGER":
        handleCommandTrigger();
        break;

      case "OCR_START_SELECTION":
        handleOCRStartSelection();
        break;

      case "OCR_CAPTURE_RESULT":
        handleOCRCaptureResult(message.dataUrl);
        break;
    }
  },
);

// ─── Trigger handlers ──────────────────────────────────────────────

/**
 * Processes text forwarded from the context menu. Since the service
 * worker already extracted the selection text, we synthesize a rect
 * from the current selection (if available) or a fallback position.
 * (IMPLEMENTATION_GUIDE.md Step 7a.3)
 */
function handleContextMenuTrigger(text: string): void {
  const selection = window.getSelection();
  const rect = getSelectionRect(selection);
  const context = selection ? extractSurroundingContext(selection) : "";
  processSelection(text, rect, context);
}

/**
 * Processes the current selection when the user presses Alt+Shift+P.
 * The service worker sends COMMAND_TRIGGER without text, so we read
 * the selection from the page directly.
 * (IMPLEMENTATION_GUIDE.md Step 7a.4)
 */
function handleCommandTrigger(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text) return;

  const rect = getSelectionRect(selection);
  const context = extractSurroundingContext(selection);
  processSelection(text, rect, context);
}

/** Extracts a bounding rect from a Selection, or returns a centered fallback. */
function getSelectionRect(selection: Selection | null): DOMRect {
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    return selection.getRangeAt(0).getBoundingClientRect();
  }
  return new DOMRect(window.innerWidth / 2 - 100, window.innerHeight / 3, 200, 20);
}

// ─── OCR handlers ──────────────────────────────────────────────

async function handleOCRStartSelection(): Promise<void> {
  const rect = await startOCRSelection();
  if (!rect) return;

  pendingOCRRect = rect;
  chrome.runtime.sendMessage({
    type: "OCR_CAPTURE_REQUEST",
    rect,
  });
}

async function handleOCRCaptureResult(dataUrl: string): Promise<void> {
  const rect = pendingOCRRect;
  pendingOCRRect = null;
  if (!rect) return;

  const loading = document.createElement("div");
  loading.className = "hg-ocr-loading";
  loading.textContent = "Recognizing text\u2026";
  loading.style.left = `${rect.x + rect.width / 2 - 70}px`;
  loading.style.top = `${rect.y + rect.height / 2 - 14}px`;
  document.body.appendChild(loading);

  try {
    const croppedCanvas = await cropScreenshot(dataUrl, rect);
    const text = await runOCR(croppedCanvas);

    loading.remove();

    if (!text) {
      showBriefError("No Chinese text detected in selected area");
      return;
    }

    const selectionRect = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    processSelection(text, selectionRect, text);
  } catch (err) {
    loading.remove();
    showBriefError("OCR failed: " + (err instanceof Error ? err.message : String(err)));
  }
}

function cropScreenshot(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio;
      const cropX = rect.x * dpr;
      const cropY = rect.y * dpr;
      const cropW = rect.width * dpr;
      const cropH = rect.height * dpr;

      const canvas = document.createElement("canvas");
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas context"));
        return;
      }
      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error("Failed to load screenshot"));
    img.src = dataUrl;
  });
}

async function runOCR(canvas: HTMLCanvasElement): Promise<string | null> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("chi_sim");
  try {
    const result = await worker.recognize(canvas);
    let text = result.data.text.trim().replace(/\n+/g, " ");
    if (!containsChinese(text)) return null;
    return text;
  } finally {
    await worker.terminate();
  }
}

function showBriefError(message: string): void {
  const el = document.createElement("div");
  el.className = "hg-ocr-loading";
  el.textContent = message;
  el.style.left = "50%";
  el.style.top = "40%";
  el.style.transform = "translateX(-50%)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Dismiss handlers ──────────────────────────────────────────────

/**
 * Dismisses the overlay when the user clicks anywhere outside the
 * Shadow DOM host element. Clicks inside the overlay (e.g. on a
 * definition card or close button) are handled within the shadow root
 * and do not bubble to this handler.
 * (IMPLEMENTATION_GUIDE.md Step 7a.5)
 */
document.addEventListener("mousedown", (e: MouseEvent) => {
  const host = document.getElementById("hg-extension-root");
  if (!host) return;
  if (host.contains(e.target as Node)) return;
  dismissOverlay();
});

/** Dismisses the overlay when the user presses Escape. */
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    dismissOverlay();
  }
});

// ─── Vocab callback ────────────────────────────────────────────────

setVocabCallback((word) => {
  chrome.runtime.sendMessage({ type: "RECORD_WORD", word });
});

// ─── Theme caching ─────────────────────────────────────────────────

/**
 * Reads the theme once at init and keeps it in sync via
 * chrome.storage.onChanged, so each overlay render doesn't
 * need an async storage read.
 */
chrome.storage.sync.get(["theme", "ttsEnabled"], (result) => {
  if (result.theme) cachedTheme = result.theme as Theme;
  if (result.ttsEnabled !== undefined) cachedTtsEnabled = result.ttsEnabled as boolean;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.theme?.newValue) {
    cachedTheme = changes.theme.newValue as Theme;
  }
  if (changes.ttsEnabled?.newValue !== undefined) {
    cachedTtsEnabled = changes.ttsEnabled.newValue as boolean;
  }
});
