/**
 * Single source of truth for every configurable value in the extension.
 *
 * To adjust any behavior -- timeouts, cache duration, provider URLs,
 * default models, or the LLM system prompt -- edit only this file.
 * No other module hard-codes tunable values.
 *
 * See: SPEC.md Section 2.5 for settings overview,
 *      SPEC.md Section 6 for LLM provider presets and prompt design,
 *      IMPLEMENTATION_GUIDE.md Step 1j for the full constant listing.
 */

import type { ExtensionSettings, LLMProvider, ProviderPreset } from "./types";

// ─── Chinese Detection ─────────────────────────────────────────────
/** Matches a single CJK Unified Ideograph (basic + Extension A). Used by containsChinese(). */
export const CHINESE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
/** Global variant that matches runs of CJK characters. Used for extraction/splitting. */
export const CHINESE_REGEX_GLOBAL = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;

// ─── LLM Provider Presets ──────────────────────────────────────────
/**
 * Static presets for each supported LLM backend.
 * When the user selects a provider in the popup, its preset auto-fills
 * the base URL, model dropdown, and API key visibility.
 * Adding a new OpenAI-compatible provider only requires a new entry here.
 * (SPEC.md Section 6 "Multi-Provider Support")
 */
export const PROVIDER_PRESETS: Record<LLMProvider, ProviderPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    apiStyle: "openai",
    requiresApiKey: true,
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-nano"],
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-flash",
    apiStyle: "gemini",
    requiresApiKey: true,
    models: [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
    ],
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    apiStyle: "openai",
    requiresApiKey: false,
    models: ["qwen2.5:7b", "llama3:8b", "mistral:7b", "gemma2:9b"],
  },
  custom: {
    baseUrl: "",
    defaultModel: "",
    apiStyle: "openai",
    requiresApiKey: false,
    models: [],
  },
};

// ─── Default User Settings ─────────────────────────────────────────
/**
 * Initial settings for new installs. Merged with whatever the user
 * has stored in chrome.storage.sync so missing keys get sensible defaults.
 * (SPEC.md Section 2.5)
 */
export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: "openai",
  apiKey: "",
  baseUrl: PROVIDER_PRESETS.openai.baseUrl,
  model: PROVIDER_PRESETS.openai.defaultModel,
  pinyinStyle: "toneMarks",
  fontSize: 16,
  theme: "auto",
  llmEnabled: true,
};

// ─── Cache Configuration ───────────────────────────────────────────
// LLM responses are cached in chrome.storage.local keyed by SHA-256
// hash of the input text+context. (SPEC.md Section 6 "Caching")
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_CACHE_ENTRIES = 5000;

// ─── Vocab Store Configuration ────────────────────────────────────
/** Maximum number of words to store in the vocab list. Least-frequent entries are dropped first. */
export const MAX_VOCAB_ENTRIES = 10_000;

/**
 * Common function words excluded from vocab recording.
 * These appear in nearly every sentence and would inflate the list
 * with words the user certainly already knows.
 * (VOCAB_SPEC.md Section 6 "Stop-Word Filtering")
 */
export const VOCAB_STOP_WORDS = new Set([
  "的", "了", "是", "在", "不", "我", "你", "他", "她", "它",
  "们", "这", "那", "也", "都", "就", "和", "有", "很", "会",
  "能", "要", "把", "被", "让", "给", "到", "从", "对", "为",
  "吗", "呢", "吧", "啊", "嗯",
]);

// ─── LLM Request Configuration ────────────────────────────────────
/** Abort controller timeout for each LLM fetch call. (SPEC.md Section 6) */
export const LLM_TIMEOUT_MS = 10_000; // 10 seconds
export const LLM_MAX_TOKENS = 1024;
/** Zero temperature for deterministic, consistent pinyin output. */
export const LLM_TEMPERATURE = 0;

// ─── Selection Handling ────────────────────────────────────────────
/** Texts longer than this are truncated before sending to the LLM. (SPEC.md Section 10.2) */
export const MAX_SELECTION_LENGTH = 500;
/** Mouseup debounce to avoid firing during click-drag. (SPEC.md Section 10.4) */
export const DEBOUNCE_MS = 100;

// ─── LLM System Prompt ────────────────────────────────────────────
/**
 * The system instruction sent to every LLM provider. Defines the
 * expected JSON output format with word segmentation, pinyin,
 * definitions, and sentence translation.
 * Edit this to change output format, detail level, or target language.
 * (SPEC.md Section 6 "Prompt Engineering")
 */
export const SYSTEM_PROMPT = `You are a Chinese language assistant integrated into a browser extension.
Given Chinese text and its surrounding context, you must:
1. Segment the text into individual words (not characters).
2. Provide the correct pinyin for each word, using tone marks.
   For polyphonic characters, use the surrounding context to choose the correct reading.
3. Provide a concise English definition for each word as it is used in this context.
4. Provide a natural English translation of the full text.

Respond ONLY with valid JSON in this exact format:
{
  "words": [
    { "chars": "<characters>", "pinyin": "<pinyin with tone marks>", "definition": "<contextual English definition>" }
  ],
  "translation": "<full English translation>"
}`;
