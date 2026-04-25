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
import {
  DEBOUNCE_MS,
  DEFAULT_SETTINGS,
  KEEPALIVE_PORT_NAME,
  LLM_TIMEOUT_MS,
  MAX_SELECTION_LENGTH,
  RETRY_DELAYS_MS,
} from "../shared/constants";
import { handleVocabCapture } from "../shared/vocab-capture";
import {
  isTranslatorAvailable,
  prewarmTranslator,
  translateChineseToEnglish,
} from "../shared/translate-example";
import { runFallbackTranslation } from "../shared/fallback-translation";
import type {
  ExtensionMessage,
  PinyinResponseLocal,
  Theme,
} from "../shared/types";
import {
  showOverlay,
  updateOverlay,
  updateOverlayFallback,
  showOverlayError,
  showTruncationNotice,
  dismissOverlay,
  setVocabCallback,
  setOverlayContext,
} from "./overlay";
import { startOCRSelection } from "./ocr-selection";

// ─── Module state ──────────────────────────────────────────────────

/** Monotonic counter to discard responses from superseded requests. */
let currentRequestId = 0;

/** Increments when a final LLM translation renders, so previews can't overwrite it. */
let llmTranslationSequence = 0;

/** Cached theme setting so each overlay doesn't need a storage read. */
let cachedTheme: Theme = "auto";

/** Cached TTS toggle so each overlay doesn't need a storage read. */
let cachedTtsEnabled = true;

/**
 * Cached AI Translations toggle. Mirrored on the content side so the
 * Phase 1 overlay can omit the "Loading translation..." row when the
 * service worker won't be sending Phase 2 anyway.
 */
let cachedLlmEnabled = true;

/**
 * Cached "auto-show overlay on mouseup" toggle. When false, the
 * mouseup listener is a no-op so plain text selections do not pop
 * the overlay. The right-click menu item and Alt+Shift+P shortcut
 * remain active so the user can still trigger the overlay on demand.
 * Defaults to true to match DEFAULT_SETTINGS and preserve historical
 * behavior on first install.
 */
let cachedOverlayEnabled = true;

/**
 * Cached overlay font size (px). Mirrored on the content side so each
 * showOverlay() call avoids a chrome.storage.sync round-trip. The value
 * is forwarded to overlay.ts which sets it as a --hg-font-size CSS
 * custom property on the Shadow DOM host; overlay.css derives pinyin
 * and translation sizes from it via calc() multipliers.
 */
let cachedFontSize: number = DEFAULT_SETTINGS.fontSize;

/** Viewport rect from the most recent OCR area selection, awaiting capture result. */
let pendingOCRRect: { x: number; y: number; width: number; height: number } | null = null;

// ─── Service-worker keep-alive ─────────────────────────────────────

/**
 * One open chrome.runtime.Port per outstanding LLM request, indexed by
 * the request id. Holding the port open prevents the MV3 service worker
 * from being suspended mid-fetch (which used to surface as silently
 * dropped translations after ~30s of idle time).
 *
 * Each entry also owns a safety timer that disconnects the port if no
 * PINYIN_RESPONSE_LLM / PINYIN_ERROR(llm) ever comes back -- e.g. when
 * settings.llmEnabled is false on the SW side, no Phase-2 message is
 * ever emitted. The bound covers the worst-case retry budget:
 *   3 attempts × LLM_TIMEOUT_MS + sum(RETRY_DELAYS_MS) + slack
 */
const KEEPALIVE_SAFETY_MS =
  3 * LLM_TIMEOUT_MS + RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 5_000;

interface KeepalivePort {
  port: chrome.runtime.Port;
  safety: ReturnType<typeof setTimeout>;
}
const keepalivePorts = new Map<number, KeepalivePort>();

/**
 * Opens a port and registers it under the given request id. The port
 * carries no traffic; its mere existence keeps the SW awake. The
 * safety timer disconnects it after KEEPALIVE_SAFETY_MS as a leak
 * guard for the no-LLM-message edge case.
 */
function openKeepalivePort(requestId: number): void {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: KEEPALIVE_PORT_NAME });
  } catch {
    // Extension reload can transiently make connect throw.
    return;
  }
  const safety = setTimeout(() => closeKeepalivePort(requestId), KEEPALIVE_SAFETY_MS);
  keepalivePorts.set(requestId, { port, safety });
  port.onDisconnect.addListener(() => {
    const entry = keepalivePorts.get(requestId);
    if (!entry) return;
    clearTimeout(entry.safety);
    keepalivePorts.delete(requestId);
  });
}

function closeKeepalivePort(requestId: number): void {
  const entry = keepalivePorts.get(requestId);
  if (!entry) return;
  clearTimeout(entry.safety);
  try { entry.port.disconnect(); } catch { /* already gone */ }
  keepalivePorts.delete(requestId);
}

/**
 * Closes the oldest open keep-alive port. PINYIN_RESPONSE_LLM /
 * PINYIN_ERROR messages don't carry a request id, so we use FIFO
 * order: the SW processes per-tab requests in order, so the oldest
 * open port corresponds to the earliest still-pending Phase-2 reply.
 */
function closeOldestKeepalivePort(): void {
  const next = keepalivePorts.keys().next();
  if (!next.done) closeKeepalivePort(next.value);
}

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

  // The on-device fallback runs only when the LLM-backed Phase-2 path
  // is disabled AND Chrome's Translator API is present. Computed once
  // up front so the overlay's loading-row decision and the post-render
  // dispatch agree on the same answer.
  const willUseFallback = !cachedLlmEnabled && isTranslatorAvailable();
  // Reserve the translation row whenever something will fill it -- the
  // LLM path or the fallback. Without this the fallback would have to
  // inject a row after the fact (it does, defensively, but we'd rather
  // pay the layout cost up front so the user doesn't see a jump).
  const expectTranslation = cachedLlmEnabled || willUseFallback;

  // Open the keep-alive port *before* sending so the SW can't go idle
  // between sendMessage and the start of its async LLM path. Skipped
  // when the LLM path is disabled: the fallback runs entirely in the
  // content script's main world (Chrome's Translator API is page-side)
  // so the SW has nothing long-running to keep alive in that case.
  if (cachedLlmEnabled) {
    openKeepalivePort(requestId);
  }

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
      // Stash the captured context so the "+ Vocab" click handler in
      // the overlay can ship it to the service worker for the
      // example-quality gate. Must precede showOverlay so the very
      // first card the user sees already has the right context wired.
      setOverlayContext(context);
      showOverlay(
        response.words,
        rect,
        cachedTheme,
        cachedTtsEnabled,
        expectTranslation,
        cachedFontSize,
      );
      if (wasTruncated) showTruncationNotice();

      // Non-LLM fallback: ship the same selection through Chrome's
      // built-in Translator API for both a full-sentence translation
      // and per-segment glosses. The service worker won't send any
      // PINYIN_RESPONSE_LLM in this branch (handleLLMPath bails on
      // !llmEnabled), so this is the only Phase-2 source. The shared
      // helper handles dedup, the two-phase paint, and the requestId
      // staleness check; we just supply the overlay-side callbacks.
      if (willUseFallback) {
        void runFallbackTranslation(truncated, response.words, {
          isStale: () => requestId !== currentRequestId,
          onPaint: (enriched, translation) => {
            updateOverlayFallback(enriched, translation, cachedTtsEnabled);
          },
          onError: (msg) => showOverlayError(msg),
        });
      } else if (cachedLlmEnabled && isTranslatorAvailable()) {
        void runQuickTranslationPreview(
          truncated,
          response.words,
          requestId,
          llmTranslationSequence,
        );
      }
    },
  );
}

/**
 * LLM-mode quick preview: translate only the full selected text with
 * Chrome's on-device Translator while the real LLM request is still
 * running. No per-segment glosses here -- the LLM response remains the
 * source of contextual word grouping/definitions and overwrites this
 * preview when it arrives.
 */
async function runQuickTranslationPreview(
  text: string,
  words: PinyinResponseLocal["words"],
  requestId: number,
  llmSeqAtStart: number,
): Promise<void> {
  const result = await translateChineseToEnglish(text);
  if (!result.ok) return;
  if (requestId !== currentRequestId) return;
  if (llmTranslationSequence !== llmSeqAtStart) return;

  updateOverlayFallback(
    words.map((w) => ({
      chars: w.chars,
      pinyin: w.pinyin,
      definition: w.definition ?? "",
    })),
    result.translation,
    cachedTtsEnabled,
  );
}

// ─── Mouseup handler ───────────────────────────────────────────────

/**
 * Debounced mouseup listener. On each mouseup, checks the current
 * text selection for Chinese content and kicks off the pinyin flow.
 * Debouncing at DEBOUNCE_MS prevents firing during click-drag.
 *
 * Gated by cachedOverlayEnabled: when the user has disabled the
 * auto-show setting, plain mouseup selections are ignored. The
 * context-menu and keyboard-shortcut paths bypass this gate so the
 * user can still trigger lookups on demand.
 *
 * (IMPLEMENTATION_GUIDE.md Step 7a.1)
 */
const debouncedSelectionScan = debounce(() => {
  if (!cachedOverlayEnabled) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const context = extractSurroundingContext(selection);

  processSelection(text, rect, context);
}, DEBOUNCE_MS);

// Skip mouseups that originate inside our overlay host. Without this
// gate, clicking the overlay's close button (or any control inside it)
// fires a mouseup that bubbles to document; the page selection from
// the original lookup is still alive (Shadow DOM clicks don't clear
// it), so processSelection would re-fire and the popup would pop
// right back up. Mirrors the host-contains check used by the
// click-outside dismisser below.
document.addEventListener("mouseup", (e: MouseEvent) => {
  const host = document.getElementById("hg-extension-root");
  if (host?.contains(e.target as Node)) return;
  debouncedSelectionScan();
});

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
        llmTranslationSequence += 1;
        updateOverlay(message.words, message.translation, cachedTtsEnabled);
        closeOldestKeepalivePort();
        break;

      case "PINYIN_ERROR":
        if (message.phase === "llm") {
          showOverlayError(message.error);
          closeOldestKeepalivePort();
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

  // Prewarm the on-device Translator while OCR is running. Tesseract
  // recognition typically takes seconds, by which time the user's
  // drag-mouseup-acquired transient activation has expired and a
  // fresh Translator.create() would throw NotAllowedError. Calling
  // prewarmTranslator() here -- still inside the synchronous tail of
  // the user's mouseup -- captures the activation and stashes the
  // resulting instance in the module cache, so the eventual fallback
  // translate() call in processSelection() reuses it without paying
  // the activation cost again. Fire-and-forget on purpose: the real
  // failure (if any) is surfaced by translateChineseToEnglish later.
  if (!cachedLlmEnabled && isTranslatorAvailable()) {
    void prewarmTranslator();
  }

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

// "+ Vocab" handler -- shared with the in-extension reader so both
// surfaces stay on one wire format. See src/shared/vocab-capture.ts
// for the full pipeline (gate -> trim -> RECORD_WORD -> async
// translate -> SET_EXAMPLE_TRANSLATION).
setVocabCallback(handleVocabCapture);

// ─── Theme caching ─────────────────────────────────────────────────

/**
 * Reads the theme once at init and keeps it in sync via
 * chrome.storage.onChanged, so each overlay render doesn't
 * need an async storage read.
 */
chrome.storage.sync.get(
  ["theme", "ttsEnabled", "overlayEnabled", "llmEnabled", "fontSize"],
  (result) => {
    if (result.theme) cachedTheme = result.theme as Theme;
    if (result.ttsEnabled !== undefined) cachedTtsEnabled = result.ttsEnabled as boolean;
    if (result.overlayEnabled !== undefined) cachedOverlayEnabled = result.overlayEnabled as boolean;
    if (result.llmEnabled !== undefined) cachedLlmEnabled = result.llmEnabled as boolean;
    if (typeof result.fontSize === "number") cachedFontSize = result.fontSize;
  },
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.theme?.newValue) {
    cachedTheme = changes.theme.newValue as Theme;
  }
  if (changes.ttsEnabled?.newValue !== undefined) {
    cachedTtsEnabled = changes.ttsEnabled.newValue as boolean;
  }
  if (changes.overlayEnabled?.newValue !== undefined) {
    cachedOverlayEnabled = changes.overlayEnabled.newValue as boolean;
  }
  if (changes.llmEnabled?.newValue !== undefined) {
    cachedLlmEnabled = changes.llmEnabled.newValue as boolean;
  }
  if (typeof changes.fontSize?.newValue === "number") {
    cachedFontSize = changes.fontSize.newValue;
  }
});
