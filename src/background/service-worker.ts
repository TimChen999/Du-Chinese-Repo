/**
 * Background service worker -- the orchestration hub of the extension.
 *
 * Receives PINYIN_REQUEST messages from the content script and returns
 * a Phase 1 (local pinyin-pro) response immediately via sendResponse.
 * Phase 2 calls the LLM client asynchronously, sending contextual
 * definitions and translations back via chrome.tabs.sendMessage.
 *
 * Also registers the "Show Pinyin & Translation" context menu item
 * and handles the Alt+Shift+P keyboard shortcut, forwarding both
 * triggers to the content script for overlay rendering.
 *
 * See: SPEC.md Section 3 "Architecture" for the service worker's role,
 *      SPEC.md Section 5 "Data Flow" for the two-phase message flow,
 *      IMPLEMENTATION_GUIDE.md Steps 3-5 for implementation details.
 */

import { convertToPinyin } from "./pinyin-service";
import { queryLLM } from "./llm-client";
import { hashText, getFromCache, saveToCache, evictExpiredEntries } from "./cache";
import { recordWords, removeWord } from "./vocab-store";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  LLM_MAX_TOKENS,
  LLM_TEMPERATURE,
} from "../shared/constants";
import type {
  ExtensionSettings,
  LLMConfig,
  PinyinRequest,
  PinyinResponseLocal,
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

// ─── Message Handling ──────────────────────────────────────────────

/**
 * Phase 1 fast-path: on PINYIN_REQUEST, immediately run pinyin-pro
 * and return the result via sendResponse. The content script shows
 * the overlay with basic pinyin while the LLM path runs in the
 * background. (SPEC.md Section 5 "Two-Phase Rendering")
 *
 * Returns true to keep the message channel open for the async
 * getSettings() call inside the handler.
 */
chrome.runtime.onMessage.addListener(
  (
    message: { type: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: PinyinResponseLocal) => void,
  ) => {
    if (message.type !== "PINYIN_REQUEST") return;

    const request = message as PinyinRequest;

    handlePinyinRequest(request, sender.tab?.id, sendResponse);

    return true;
  },
);

async function handlePinyinRequest(
  request: PinyinRequest,
  tabId: number | undefined,
  sendResponse: (response: PinyinResponseLocal) => void,
): Promise<void> {
  const settings = await getSettings();
  const words = convertToPinyin(request.text, settings.pinyinStyle);

  sendResponse({ type: "PINYIN_RESPONSE_LOCAL", words });

  // Phase 2: async LLM call for contextual definitions + translation
  handleLLMPath(request, tabId, settings);
}

/**
 * Async LLM path (Phase 2). Checks the chrome.storage.local cache
 * before calling queryLLM to avoid redundant API calls for text the
 * user has already looked up.  On cache miss, calls the LLM and
 * stores the result for next time.
 *
 * Skips silently if LLM is disabled or the provider isn't configured.
 * (SPEC.md Section 6 "Fallback Strategy", "Caching")
 */
async function handleLLMPath(
  request: PinyinRequest,
  tabId: number | undefined,
  settings: ExtensionSettings,
): Promise<void> {
  if (!settings.llmEnabled || !tabId) {
    console.log("[LLM] Skipped: llmEnabled=%s, tabId=%s", settings.llmEnabled, tabId);
    return;
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) {
    console.warn("[LLM] No API key set for provider '%s'", settings.provider);
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_ERROR",
      error: "Set up an API key in extension settings for translations.",
      phase: "llm",
    });
    return;
  }

  console.log("[LLM] Starting request: provider=%s, model=%s, baseUrl=%s, text='%s'",
    settings.provider, settings.model, settings.baseUrl, request.text.slice(0, 50));

  // Cache lookup keyed on text+context so identical selections in
  // different paragraphs get separate, contextually correct entries.
  const cacheKey = await hashText(request.text + request.context);
  const cached = await getFromCache(cacheKey);

  if (cached) {
    console.log("[LLM] Cache hit for key=%s", cacheKey.slice(0, 12));
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_RESPONSE_LLM",
      words: cached.words,
      translation: cached.translation,
    });
    return;
  }

  console.log("[LLM] Cache miss, calling queryLLM…");

  const config: LLMConfig = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    maxTokens: LLM_MAX_TOKENS,
    temperature: LLM_TEMPERATURE,
  };

  const result = await queryLLM(request.text, request.context, config);

  if (result) {
    console.log("[LLM] Success: %d words, translation='%s'",
      result.words.length, result.translation.slice(0, 80));
    await saveToCache(cacheKey, result);
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_RESPONSE_LLM",
      words: result.words,
      translation: result.translation,
    });
  } else {
    console.error("[LLM] queryLLM returned null — request failed");
    chrome.tabs.sendMessage(tabId, {
      type: "PINYIN_ERROR",
      error: "LLM request failed",
      phase: "llm",
    });
  }
}

// ─── OCR Message Handling ──────────────────────────────────────────

/**
 * Handles OCR_START (from popup) and OCR_CAPTURE_REQUEST (from content
 * script). These are separate from the PINYIN_REQUEST listener because
 * they follow a different async pattern and don't use sendResponse.
 */
chrome.runtime.onMessage.addListener(
  (message: { type: string; [key: string]: unknown }, sender: chrome.runtime.MessageSender) => {
    if (message.type === "RECORD_WORD") {
      const word = message.word as { chars: string; pinyin: string; definition: string };
      recordWords([word]);
      return;
    }

    if (message.type === "REMOVE_WORD") {
      removeWord(message.chars as string);
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
            chrome.tabs.sendMessage(tabId, {
              type: "PINYIN_ERROR",
              error: chrome.runtime.lastError?.message
                ?? "Failed to capture screenshot",
              phase: "local",
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
  },
);

// ─── Context Menu ──────────────────────────────────────────────────

/**
 * Creates the right-click "Show Pinyin & Translation" menu item
 * on first install and on extension updates. Only appears when
 * the user has text selected. (SPEC.md Section 2.6)
 *
 * Also runs cache eviction to clean up expired / over-limit entries
 * that may have accumulated since the last install or update.
 * (SPEC.md Section 6 "Caching", IMPLEMENTATION_GUIDE.md Step 5b)
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "show-pinyin",
    title: "Show Pinyin & Translation",
    contexts: ["selection"],
  });

  evictExpiredEntries();
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
