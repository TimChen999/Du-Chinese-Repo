/**
 * Background service worker -- the orchestration hub of the extension.
 *
 * Receives PINYIN_REQUEST messages from the content script and returns
 * a Phase 1 (local pinyin-pro) response immediately via sendResponse.
 * An async LLM path (Phase 2) is stubbed here and will be wired in
 * Step 4 to send back contextual definitions and translations via
 * chrome.tabs.sendMessage.
 *
 * Also registers the "Show Pinyin & Translation" context menu item
 * and handles the Alt+Shift+P keyboard shortcut, forwarding both
 * triggers to the content script for overlay rendering.
 *
 * See: SPEC.md Section 3 "Architecture" for the service worker's role,
 *      SPEC.md Section 5 "Data Flow" for the two-phase message flow,
 *      IMPLEMENTATION_GUIDE.md Step 3 for implementation details.
 */

import { convertToPinyin } from "./pinyin-service";
import { DEFAULT_SETTINGS, PROVIDER_PRESETS } from "../shared/constants";
import type {
  ExtensionSettings,
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

  // Phase 2 LLM path -- stubbed for Step 3, wired in Step 4
  handleLLMPath(request, tabId, settings);
}

/**
 * Async LLM path (Phase 2). Checks whether the provider is properly
 * configured before attempting the call. Currently a stub -- the
 * actual queryLLM() import and call will be added in Step 4.
 * (SPEC.md Section 6 "Fallback Strategy")
 */
async function handleLLMPath(
  _request: PinyinRequest,
  _tabId: number | undefined,
  settings: ExtensionSettings,
): Promise<void> {
  if (!settings.llmEnabled) return;

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey && !settings.apiKey) return;

  // Step 4 will: import queryLLM, call it, cache the result,
  // and send PINYIN_RESPONSE_LLM back via chrome.tabs.sendMessage.
}

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
