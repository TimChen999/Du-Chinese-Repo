/**
 * Background service worker — orchestrates the click-flow's per-sentence
 * LLM calls, vocab persistence, OCR screenshot capture, the right-click
 * context menu, and the Alt+Shift+P keyboard shortcut.
 *
 * The legacy two-phase PINYIN_REQUEST handler was retired with the
 * click-flow redesign; only SENTENCE_TRANSLATE_REQUEST is now the
 * LLM entry point.
 */

import { queryLLMSentence } from "./llm-client";
import {
  hashSentenceKey,
  getSentenceFromCache,
  saveSentenceToCache,
} from "./sentence-cache";
import {
  recordWords,
  removeWord,
  removeExample,
  setExampleTranslation,
  getAllVocab,
  bumpViewCount,
} from "./vocab-store";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
  KEEPALIVE_PORT_NAME,
} from "../shared/constants";
import type {
  ExtensionSettings,
  LLMConfig,
  SentenceTranslateRequest,
  VocabExample,
} from "../shared/types";

// ─── Settings Helper ───────────────────────────────────────────────

/**
 * Reads user settings from chrome.storage.sync and merges with
 * DEFAULT_SETTINGS so any missing keys fall back to sensible defaults.
 * Called on every PINYIN_REQUEST to pick up live setting changes
 * without requiring a service worker restart.
 */
export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Sentence-mode (click-flow) handler ───────────────────────────

/**
 * Handles SENTENCE_TRANSLATE_REQUEST from the click-flow content script.
 *
 *  1. Cache lookup (sentence + style + provider + model). On hit, send
 *     the cached payload immediately so the popup transitions to Hot
 *     without a network round-trip.
 *  2. If LLM is disabled or unconfigured, send an error -- the content
 *     script keeps the sentence in Bootstrap (Chrome translator) state.
 *  3. Otherwise call queryLLMSentence. On success, cache + send. On
 *     error, send an error message.
 */
async function handleSentenceTranslateRequest(
  request: SentenceTranslateRequest,
  tabId: number | undefined,
): Promise<void> {
  if (!tabId) return;

  const settings = await getSettings();

  const cacheKey = await hashSentenceKey(
    request.sentence,
    request.pinyinStyle,
    settings.provider,
    settings.model,
  );

  const cached = await getSentenceFromCache(cacheKey);
  if (cached) {
    chrome.tabs.sendMessage(tabId, {
      type: "SENTENCE_TRANSLATE_RESPONSE_LLM",
      sentence: request.sentence,
      requestId: request.requestId,
      translation: cached.translation,
      words: cached.words,
    });
    return;
  }

  if (!settings.llmEnabled) {
    chrome.tabs.sendMessage(tabId, {
      type: "SENTENCE_TRANSLATE_ERROR",
      sentence: request.sentence,
      requestId: request.requestId,
      error: "AI Translations are disabled in settings.",
      code: "DISABLED",
    });
    return;
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) {
    chrome.tabs.sendMessage(tabId, {
      type: "SENTENCE_TRANSLATE_ERROR",
      sentence: request.sentence,
      requestId: request.requestId,
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

  const result = await queryLLMSentence(
    request.sentence,
    request.pinyinStyle,
    config,
  );

  if (result.ok) {
    await saveSentenceToCache(cacheKey, result.data);
    chrome.tabs.sendMessage(tabId, {
      type: "SENTENCE_TRANSLATE_RESPONSE_LLM",
      sentence: request.sentence,
      requestId: request.requestId,
      translation: result.data.translation,
      words: result.data.words,
    });
  } else {
    chrome.tabs.sendMessage(tabId, {
      type: "SENTENCE_TRANSLATE_ERROR",
      sentence: request.sentence,
      requestId: request.requestId,
      error: result.error.message,
      code: result.error.code,
    });
  }
}

// ─── Vocab Recording + Example Sentences ──────────────────────────

/**
 * RECORD_WORD handler. The content script has already run the
 * example-quality gate, trimmed the sentence at clause boundaries,
 * and (when the on-device Translator API resolved synchronously)
 * attached the English translation to the same message. The service
 * worker just persists what it's given -- the gate / trim / translate
 * pipeline moved to the content script so the Translator API runs in
 * a context with user activation (see src/shared/translate-example.ts).
 */
async function handleRecordWord(
  word: { chars: string; pinyin: string; definition: string },
  example: { sentence: string; translation?: string } | undefined,
): Promise<void> {
  const stored: VocabExample | undefined = example
    ? {
        sentence: example.sentence,
        capturedAt: Date.now(),
        ...(example.translation ? { translation: example.translation } : {}),
      }
    : undefined;
  await recordWords([{ ...word }], stored);
}

/**
 * SET_EXAMPLE_TRANSLATION handler. Used by the content script's async
 * follow-up after the +Vocab click: when the on-device Translator API
 * resolves later (e.g. the model had to download on first call), the
 * content script ships the result in a separate message so the stored
 * example can be patched without blocking the initial save.
 *
 * The example is looked up by sentence rather than index because the
 * persist may have landed in either slot (slot 0 vs slot 1) depending
 * on which slots were already occupied. No-op when the word or the
 * matching sentence is no longer present (e.g. user removed it
 * between RECORD_WORD and SET_EXAMPLE_TRANSLATION).
 */
async function handleSetExampleTranslation(
  chars: string,
  sentence: string,
  translation: string,
): Promise<void> {
  const all = await getAllVocab();
  const entry = all.find((e) => e.chars === chars);
  const idx = entry?.examples?.findIndex((e) => e.sentence === sentence) ?? -1;
  if (idx < 0) return;
  await setExampleTranslation(chars, idx, translation);
}

// ─── OCR Message Handling ──────────────────────────────────────────

/**
 * Handles OCR_START (from popup) and OCR_CAPTURE_REQUEST (from content
 * script). These are separate from the PINYIN_REQUEST listener because
 * they follow a different async pattern and don't use sendResponse.
 */
chrome.runtime.onMessage.addListener(
  (
    message: { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === "SENTENCE_TRANSLATE_REQUEST") {
      const req = message as unknown as SentenceTranslateRequest;
      handleSentenceTranslateRequest(req, sender.tab?.id);
      return;
    }

    if (message.type === "RECORD_WORD") {
      const word = message.word as { chars: string; pinyin: string; definition: string };
      const example = message.example as
        | { sentence: string; translation?: string }
        | undefined;
      handleRecordWord(word, example);
      return;
    }

    if (message.type === "BUMP_VIEW_COUNT") {
      bumpViewCount(message.chars as string);
      return;
    }

    if (message.type === "REMOVE_WORD") {
      removeWord(message.chars as string);
      return;
    }

    if (message.type === "REMOVE_EXAMPLE") {
      const chars = message.chars as string;
      const index = message.index as number;
      removeExample(chars, index);
      return;
    }

    if (message.type === "SET_EXAMPLE_TRANSLATION") {
      const chars = message.chars as string;
      const sentence = message.sentence as string;
      const translation = message.translation as string;
      handleSetExampleTranslation(chars, sentence, translation);
      return;
    }

    if (message.type === "OCR_START") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "OCR_START_SELECTION" });
        }
      });
      return;
    }

    if (message.type === "OCR_CAPTURE_REQUEST") {
      const tabId = sender.tab?.id;
      if (!tabId) return;

      chrome.tabs.captureVisibleTab(
        null as unknown as number,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            // Surface the error inline via the click-flow's sentence
            // error path; the OCR result strip won't render at all on
            // failure so this is mostly diagnostic.
            chrome.tabs.sendMessage(tabId, {
              type: "SENTENCE_TRANSLATE_ERROR",
              sentence: "",
              requestId: 0,
              error: chrome.runtime.lastError?.message
                ?? "Failed to capture screenshot",
              code: "OCR_CAPTURE_FAILED",
            });
            return;
          }
          chrome.tabs.sendMessage(tabId, {
            type: "OCR_CAPTURE_RESULT",
            dataUrl,
          });
        },
      );
      return;
    }

    if (message.type === "PAGE_DECODE_START") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: "PAGE_DECODE_BEGIN" });
        }
      });
      return;
    }

    if (message.type === "PAGE_DECODE_CAPTURE_REQUEST") {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      chrome.tabs.captureVisibleTab(
        null as unknown as number,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            chrome.tabs.sendMessage(tabId, {
              type: "PAGE_DECODE_CAPTURE_RESULT",
              dataUrl: "",
            });
            return;
          }
          chrome.tabs.sendMessage(tabId, {
            type: "PAGE_DECODE_CAPTURE_RESULT",
            dataUrl,
          });
        },
      );
      return;
    }
  },
);

// ─── MV3 Keep-Alive Port ──────────────────────────────────────────

/**
 * Accepts (and silently holds) chrome.runtime.Port connections opened
 * by content scripts for the duration of long-running LLM requests.
 * Chrome keeps the MV3 service worker alive as long as at least one
 * port remains connected, so a 30+ second LLM generation no longer
 * risks suspension mid-fetch (which used to manifest as silent
 * dropped responses). chrome.runtime tracks the port lifetime
 * internally; we just need a listener to be registered, otherwise
 * incoming connections close immediately.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;
  // No-op: holding the listener registration is sufficient. The port
  // disconnects when the content script calls port.disconnect() or
  // when the originating tab navigates / closes.
});

// ─── Context Menu ──────────────────────────────────────────────────

/**
 * Creates the right-click "Show Pinyin & Translation" menu item
 * on first install and on extension updates. Only appears when
 * the user has text selected. (SPEC.md Section 2.6)
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "show-pinyin",
    title: "Show Pinyin & Translation",
    contexts: ["selection"],
  });
});

/**
 * Forwards the right-clicked selection text to the content script
 * so it can run the same pinyin/overlay flow as a mouseup selection.
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "show-pinyin" && info.selectionText && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: "CONTEXT_MENU_TRIGGER",
      text: info.selectionText,
    });
  }
});

// ─── Keyboard Command ──────────────────────────────────────────────

/**
 * Handles the Alt+Shift+P shortcut defined in manifest.json.
 * Sends COMMAND_TRIGGER to the active tab so the content script
 * can process the current selection. (SPEC.md Section 2.6)
 */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "show-pinyin" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "COMMAND_TRIGGER" });
  }
});
