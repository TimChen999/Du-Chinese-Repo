/**
 * Content script entry point — injected into every page by manifest.json.
 *
 * Drives the click-flow popup (the new Zhongwen + Du-Chinese-style
 * lookup): hover to preview a word, click to commit, the popup shows
 * pinyin + gloss + sentence translation. The legacy selection-driven
 * overlay (mouseup → showOverlay → updateOverlay) was retired in
 * favor of the click flow; only OCR and the right-click menu / Alt+Shift+P
 * shortcut still feed external text into the popup, and they do it
 * by synthesising a click via the click-flow's public entry points.
 *
 * See: .claude/ARCHITECTURE_REDESIGN.md sections 4-15.
 */

import { containsChinese } from "../shared/chinese-detect";
import { DEFAULT_SETTINGS } from "../shared/constants";
import { handleVocabCapture } from "../shared/vocab-capture";
import {
  isTranslatorAvailable,
  prewarmTranslator,
} from "../shared/translate-example";
import type {
  ExtensionMessage,
  PinyinStyle,
  Theme,
} from "../shared/types";
import { startOCRSelection } from "./ocr-selection";
import { runPageDecode, dismissPageOverlay } from "./page-overlay";
import {
  initClickFlow,
  setClickFlowSettings,
  dismissClickFlow,
  triggerFromSelection,
  triggerFromTextNode,
} from "./click-flow";
import {
  setClickPopupVocabCallback,
  setClickPopupVocabSavedChecker,
} from "./click-popup";
import {
  initVocabSavedCache,
  isVocabSaved,
} from "../shared/vocab-saved-cache";

// ─── Settings cache (mirrored to click-flow) ──────────────────────

let cachedTheme: Theme = DEFAULT_SETTINGS.theme;
let cachedTtsEnabled = DEFAULT_SETTINGS.ttsEnabled;
let cachedLlmEnabled = DEFAULT_SETTINGS.llmEnabled;
let cachedOverlayEnabled = DEFAULT_SETTINGS.overlayEnabled;
let cachedFontSize: number = DEFAULT_SETTINGS.fontSize;

/** Viewport rect from the most recent OCR area selection. */
let pendingOCRRect:
  | { x: number; y: number; width: number; height: number }
  | null = null;

// ─── Click-flow init + vocab wiring ───────────────────────────────

// Wire the popup's saved-state predicate to the live cache and warm
// the cache from chrome.storage.local. handleVocabCapture itself
// flips the local cache before sending RECORD_WORD so the popup's
// next isVocabSaved() read sees the new state without waiting on the
// storage onChanged round-trip.
initVocabSavedCache();
setClickPopupVocabSavedChecker(isVocabSaved);
setClickPopupVocabCallback(handleVocabCapture);
initClickFlow();

// ─── Incoming message listener ────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  switch (message.type) {
    case "CONTEXT_MENU_TRIGGER":
      handleContextMenuTrigger();
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
    case "PAGE_DECODE_BEGIN":
      // Clear any prior overlay, then ask the service worker for a
      // fresh viewport screenshot. PAGE_DECODE_CAPTURE_RESULT lands
      // in this listener and feeds runPageDecode().
      dismissPageOverlay();
      chrome.runtime.sendMessage({ type: "PAGE_DECODE_CAPTURE_REQUEST" });
      break;
    case "PAGE_DECODE_CAPTURE_RESULT":
      if (message.dataUrl) {
        void runPageDecode(message.dataUrl);
      }
      break;
  }
});

// ─── Trigger handlers ─────────────────────────────────────────────

/**
 * Right-click → "Show Pinyin & Translation". Re-route to the click
 * flow: treat the start of the user's selection as a click target.
 * The click-flow's sentence-detect picks up the surrounding sentence.
 */
function handleContextMenuTrigger(): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  triggerFromSelection(selection);
}

/**
 * Alt+Shift+P → same handling as the right-click menu.
 */
function handleCommandTrigger(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  triggerFromSelection(selection);
}

// ─── OCR flow ─────────────────────────────────────────────────────

async function handleOCRStartSelection(): Promise<void> {
  const rect = await startOCRSelection();
  if (!rect) return;

  // Prewarm the on-device translator while OCR runs (Tesseract takes
  // seconds; by the time it finishes, the user's mouseup activation
  // has expired and a fresh Translator.create() would NotAllowedError).
  if (isTranslatorAvailable()) {
    void prewarmTranslator();
  }

  pendingOCRRect = rect;
  chrome.runtime.sendMessage({ type: "OCR_CAPTURE_REQUEST", rect });
}

async function handleOCRCaptureResult(dataUrl: string): Promise<void> {
  const rect = pendingOCRRect;
  pendingOCRRect = null;
  if (!rect) return;

  const loading = document.createElement("div");
  loading.className = "hg-ocr-loading";
  loading.textContent = "Recognizing text…";
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
    showOcrResultStrip(text, rect);
  } catch (err) {
    loading.remove();
    showBriefError(
      "OCR failed: " + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Renders the OCR'd text as a clickable in-page strip near the OCR
 * region. The text inside the strip is real DOM, so the click-flow's
 * mousemove/click listeners catch interactions the same as on regular
 * page text. We synthesise a click on the first Chinese character so
 * the popup opens immediately without an extra aim.
 */
function showOcrResultStrip(
  text: string,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const prior = document.getElementById("pt-ocr-strip");
  if (prior) prior.remove();

  const strip = document.createElement("div");
  strip.id = "pt-ocr-strip";
  strip.className = "pt-ocr-strip";
  const top = Math.min(window.innerHeight - 48, rect.y + rect.height + 8);
  strip.style.top = `${top}px`;
  strip.style.left = `${Math.max(8, rect.x)}px`;
  strip.style.maxWidth = `${Math.max(220, rect.width)}px`;

  const textNode = document.createTextNode(text);
  strip.appendChild(textNode);

  const closeBtn = document.createElement("button");
  closeBtn.className = "pt-ocr-strip-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close OCR result");
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    strip.remove();
    dismissClickFlow();
  });
  strip.appendChild(closeBtn);

  document.body.appendChild(strip);
  triggerFromTextNode(textNode);
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
    const text = result.data.text.trim().replace(/\n+/g, " ");
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

// ─── Settings sync ────────────────────────────────────────────────

chrome.storage.sync.get(
  ["theme", "ttsEnabled", "overlayEnabled", "llmEnabled", "fontSize", "pinyinStyle"],
  (result) => {
    if (result.theme) cachedTheme = result.theme as Theme;
    if (result.ttsEnabled !== undefined) cachedTtsEnabled = result.ttsEnabled as boolean;
    if (result.overlayEnabled !== undefined) cachedOverlayEnabled = result.overlayEnabled as boolean;
    if (result.llmEnabled !== undefined) cachedLlmEnabled = result.llmEnabled as boolean;
    if (typeof result.fontSize === "number") cachedFontSize = result.fontSize;
    setClickFlowSettings({
      theme: cachedTheme,
      fontSize: cachedFontSize,
      llmEnabled: cachedLlmEnabled,
      ttsEnabled: cachedTtsEnabled,
      // The same toggle that used to gate the legacy auto-mouseup
      // overlay now gates the entire click-flow. Both off => the
      // extension is silent until OCR / right-click / Alt+Shift+P.
      clickFlowEnabled: cachedOverlayEnabled,
      pinyinStyle: (result.pinyinStyle as PinyinStyle) ?? "toneMarks",
    });
  },
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.theme?.newValue) {
    cachedTheme = changes.theme.newValue as Theme;
    setClickFlowSettings({ theme: cachedTheme });
  }
  if (changes.ttsEnabled?.newValue !== undefined) {
    cachedTtsEnabled = changes.ttsEnabled.newValue as boolean;
    setClickFlowSettings({ ttsEnabled: cachedTtsEnabled });
  }
  if (changes.overlayEnabled?.newValue !== undefined) {
    cachedOverlayEnabled = changes.overlayEnabled.newValue as boolean;
    setClickFlowSettings({ clickFlowEnabled: cachedOverlayEnabled });
    if (!cachedOverlayEnabled) dismissClickFlow();
  }
  if (changes.llmEnabled?.newValue !== undefined) {
    cachedLlmEnabled = changes.llmEnabled.newValue as boolean;
    setClickFlowSettings({ llmEnabled: cachedLlmEnabled });
  }
  if (typeof changes.fontSize?.newValue === "number") {
    cachedFontSize = changes.fontSize.newValue;
    setClickFlowSettings({ fontSize: cachedFontSize });
  }
  if (changes.pinyinStyle?.newValue !== undefined) {
    setClickFlowSettings({
      pinyinStyle: changes.pinyinStyle.newValue as PinyinStyle,
    });
  }
});
