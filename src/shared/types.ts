/**
 * Shared TypeScript types for the Pinyin Tool Chrome extension.
 *
 * Every component (content script, service worker, popup, overlay) imports
 * from this file. The types define the message protocol between content
 * script and service worker, user-facing settings, LLM provider config,
 * and the core word data structure used throughout rendering.
 *
 * See: SPEC.md Section 5 "Data Flow" for the message protocol,
 *      SPEC.md Section 6 "LLM Integration Design" for provider/config types,
 *      IMPLEMENTATION_GUIDE.md Step 1i for the full type listing.
 */

/** User's choice of pinyin annotation format. (SPEC.md Section 2.4) */
export type PinyinStyle = "toneMarks" | "toneNumbers" | "none";

/**
 * Color scheme shared by the popup, in-page overlay, library shell,
 * hub, and reader. "auto" follows prefers-color-scheme; "sepia" is
 * the e-reader-style cream/brown palette.
 *
 * Sepia used to be reader-only (it's the classic long-reading
 * palette) but it's now exposed everywhere so a single shared theme
 * value drives every surface consistently. (SPEC.md Section 7)
 */
export type Theme = "light" | "dark" | "sepia" | "auto";

/** Supported LLM backends. Each maps to a ProviderPreset in constants.ts. (SPEC.md Section 6) */
export type LLMProvider = "openai" | "gemini" | "ollama" | "custom";

/** The two request/response wire formats the LLM client adapts between. (SPEC.md Section 6) */
export type APIStyle = "openai" | "gemini";

/**
 * Static configuration for an LLM provider. Stored in PROVIDER_PRESETS
 * in constants.ts. When the user picks a provider in the popup, these
 * values auto-fill the base URL, model dropdown, and API key visibility.
 * (SPEC.md Section 6 "Provider Presets")
 */
export interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
  apiStyle: APIStyle;
  requiresApiKey: boolean;
  models: string[];
}

/**
 * A single segmented word with its pinyin (and optional definition).
 * Phase 1 (local pinyin-pro) produces WordData without definitions;
 * Phase 2 (LLM) fills in the definition field.
 * (SPEC.md Section 5 "Two-Phase Rendering")
 */
export interface WordData {
  chars: string;
  pinyin: string;
  definition?: string;
}

/**
 * A word recorded by the vocab tracker. Extends the core WordData fields
 * with frequency and timestamp metadata.
 * (VOCAB_SPEC.md Section 2 "Data Model")
 */
export interface VocabEntry {
  chars: string;
  pinyin: string;
  definition: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  wrongStreak: number;
  totalReviews: number;
  totalCorrect: number;
}

/**
 * Content script -> Service worker message.
 * Sent on mouseup when the user selects Chinese text.
 * Carries the selected text, surrounding paragraph context for the LLM,
 * and the selection's bounding rect for overlay positioning.
 * (SPEC.md Section 5 "Message Protocol")
 */
export interface PinyinRequest {
  type: "PINYIN_REQUEST";
  text: string;
  context: string;
  selectionRect: {
    top: number;
    left: number;
    bottom: number;
    right: number;
    width: number;
    height: number;
  };
}

/**
 * Service worker -> Content script (Phase 1).
 * The instant local-only response from pinyin-pro, returned via sendResponse.
 * Contains basic pinyin without definitions or translation.
 * (SPEC.md Section 5 "Two-Phase Rendering", Phase 1)
 */
export interface PinyinResponseLocal {
  type: "PINYIN_RESPONSE_LOCAL";
  words: WordData[];
}

/**
 * Service worker -> Content script (Phase 2).
 * The slower LLM-enhanced response, sent via chrome.tabs.sendMessage.
 * Contains contextually-disambiguated pinyin, per-word definitions,
 * and a full sentence translation.
 * (SPEC.md Section 5 "Two-Phase Rendering", Phase 2)
 */
export interface PinyinResponseLLM {
  type: "PINYIN_RESPONSE_LLM";
  words: Required<WordData>[];
  translation: string;
}

/**
 * Error message for either processing phase.
 * phase="local" means pinyin-pro failed; phase="llm" means the API call failed.
 * (SPEC.md Section 5 "Message Protocol")
 */
export interface PinyinError {
  type: "PINYIN_ERROR";
  error: string;
  phase: "local" | "llm";
}

/**
 * Runtime configuration passed to the LLM client's queryLLM() function.
 * Derived from ExtensionSettings by the service worker before each call.
 * (SPEC.md Section 6 "API Configuration")
 */
export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

/**
 * User-facing settings persisted in chrome.storage.sync.
 * The popup reads/writes these; the service worker and overlay consume them.
 * (SPEC.md Section 2.5 "Settings and Configuration")
 */
export interface ExtensionSettings {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  pinyinStyle: PinyinStyle;
  fontSize: number;
  theme: Theme;
  llmEnabled: boolean;
  ttsEnabled: boolean;
  /**
   * When false, the content script ignores plain mouseup-driven text
   * selections (the "auto" path). The right-click "Show Pinyin &
   * Translation" menu item and the Alt+Shift+P keyboard shortcut
   * remain functional so the user can still trigger the overlay
   * on demand. Defaults to true.
   */
  overlayEnabled: boolean;
}

/**
 * Discriminated union of every message that can travel between
 * content script <-> service worker. The `type` field acts as the discriminant.
 * Includes the two trigger messages for context menu and keyboard shortcut.
 * (SPEC.md Section 2.6, Section 5 "Message Protocol")
 */
export type ExtensionMessage =
  | PinyinRequest
  | PinyinResponseLocal
  | PinyinResponseLLM
  | PinyinError
  | { type: "CONTEXT_MENU_TRIGGER"; text: string }
  | { type: "COMMAND_TRIGGER" }
  | { type: "RECORD_WORD"; word: { chars: string; pinyin: string; definition: string } }
  | { type: "OCR_START" }
  | { type: "OCR_START_SELECTION" }
  | { type: "REMOVE_WORD"; chars: string }
  | { type: "OCR_CAPTURE_REQUEST"; rect: { x: number; y: number; width: number; height: number } }
  | { type: "OCR_CAPTURE_RESULT"; dataUrl: string };
