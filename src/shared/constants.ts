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
  displayScript: "simplified",
  fontSize: 16,
  theme: "auto",
  llmEnabled: true,
  ttsEnabled: true,
  overlayEnabled: true,
};

// ─── Cache Configuration ───────────────────────────────────────────
// LLM responses are cached in chrome.storage.local keyed by SHA-256
// hash of the input text+context. (SPEC.md Section 6 "Caching")
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_CACHE_ENTRIES = 5000;

// ─── Vocab Store Configuration ────────────────────────────────────
/**
 * chrome.storage.local key under which the vocab Record<chars, VocabEntry>
 * is persisted. Shared between the authoritative store
 * (background/vocab-store.ts) and the synchronous saved-state cache
 * (shared/vocab-saved-cache.ts) so the two can never silently drift
 * apart and start watching different keys.
 */
export const VOCAB_STORAGE_KEY = "vocabStore";

/** Maximum number of words to store in the vocab list. Least-frequent entries are dropped first. */
export const MAX_VOCAB_ENTRIES = 10_000;

/**
 * Maximum number of captured example sentences stored per vocab entry.
 * Two slots is the sweet spot: rich enough to give the user real-world
 * context, small enough that the vocab card and flashcard flip stay
 * uncluttered. Slots fill on capture and clear only via the X button;
 * when both are full a new capture is silently dropped.
 */
export const MAX_VOCAB_EXAMPLES = 2;

/**
 * Threshold used by isUsableExample(). Captured context only becomes
 * a stored example when scoreSentence() meets or exceeds this value.
 * Tune lower to be more permissive (more sentences kept, more noise),
 * higher to be stricter. See shared/example-quality.ts for the rubric.
 */
export const MIN_SENTENCE_QUALITY_SCORE = 60;

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
/**
 * Abort controller timeout applied per-attempt (not per-call).
 * Bumped from 10s -> 45s because the previous value frequently aborted
 * still-streaming responses on cold-start hosted models. With smarter
 * retries (RETRY_DELAYS_MS) the worst-case end-to-end budget is
 * 3 * LLM_TIMEOUT_MS + sum(RETRY_DELAYS_MS) ≈ 138s. (SPEC.md Section 6)
 */
export const LLM_TIMEOUT_MS = 45_000;
/**
 * Output-token cap. Bumped from 2048 -> 4096 so longer paragraphs with
 * per-word definitions + a translation no longer truncate mid-JSON
 * (which used to surface as INVALID_RESPONSE / "spits nothing").
 */
export const LLM_MAX_TOKENS = 4096;
/** Zero temperature for deterministic, consistent pinyin output. */
export const LLM_TEMPERATURE = 0;

/**
 * Backoff delays (ms) between LLM retry attempts.
 * Length determines retry count: N delays => N+1 total attempts.
 * Each delay is multiplied by a small jitter factor at call time.
 */
export const RETRY_DELAYS_MS = [800, 2_400];

/**
 * Per-error-code TTL for the negative cache. Only entries listed here
 * are persisted on failure; every other error code is *not* cached, so
 * the next identical request immediately re-attempts.
 * Rate-limit replies are cached briefly to avoid hammering the provider
 * while the user re-clicks.
 */
export const NEGATIVE_CACHE_TTL_MS: Partial<Record<string, number>> = {
  RATE_LIMITED: 30_000,
};

/**
 * Name used for the chrome.runtime.connect port that keeps the MV3
 * service worker alive for the duration of a long LLM request.
 * The port carries no traffic; its mere existence prevents suspension.
 */
export const KEEPALIVE_PORT_NAME = "llm-keepalive";

// ─── Selection Handling ────────────────────────────────────────────
/** Texts longer than this are truncated before sending to the LLM. (SPEC.md Section 10.2) */
export const MAX_SELECTION_LENGTH = 500;
/**
 * Hard cap on the number of unique Chinese segments translated per
 * selection in the on-device fallback path (used when the user has
 * AI Translations turned off). The full-sentence translation is
 * always done; per-segment glosses cap out here so a long passage
 * doesn't queue hundreds of Translator.translate() calls. Sized to
 * comfortably cover a typical 500-char (MAX_SELECTION_LENGTH)
 * selection while still being a clear upper bound.
 */
export const MAX_FALLBACK_SEGMENTS = 50;
/**
 * Hard cap on the surrounding-context string sent to the LLM.
 * Used by sentenceContextAround() as the absolute upper bound after
 * sentence-boundary trimming, keeping prefill latency predictable.
 */
export const MAX_CONTEXT_LENGTH = 400;
/** Mouseup debounce to avoid firing during click-drag. (SPEC.md Section 10.4) */
export const DEBOUNCE_MS = 100;

// ─── CC-CEDICT (offline dictionary) ───────────────────────────────
/**
 * Web-accessible path to the bundled CC-CEDICT data file. The file is
 * downloaded by scripts/download-cedict.mjs into public/dict/ at install
 * time and copied to dist/dict/ by Vite. Resolved via
 * chrome.runtime.getURL() in the content script.
 */
export const CEDICT_DICT_PATH = "dict/cedict_ts.u8";

// ─── Make Me a Hanzi (character decomposition) ────────────────────
/**
 * Stripped-down character-decomposition file derived from
 * skishore/makemeahanzi at build time by scripts/download-makemeahanzi.mjs.
 * TSV with one entry per line:
 *   <char>\t<decomposition>\t<radical>\t<etymologyHint>
 * Bundled into dist/dict/ via Vite's public/ pass-through and resolved
 * at runtime via chrome.runtime.getURL().
 */
export const COMPONENTS_DICT_PATH = "dict/components.tsv";

// ─── Phonetic component index (build-time derived) ────────────────
/**
 * JSON file produced by scripts/build-phonetics.mjs. Each key is a
 * Han component (e.g. "青") and the value lists the characters where
 * that component plays the phonetic role, grouped by sound-similarity
 * bucket. Used by the Hub's "Families" tab. See shared/phonetics-lookup.ts
 * for the consumer shape.
 */
export const PHONETICS_DICT_PATH = "dict/phonetics.json";

/**
 * Maximum number of characters from the caret position passed to
 * findLongest(). Mirrors Zhongwen's 30-char cap. Larger means the
 * lookup walks more iterations before giving up; smaller risks
 * missing very long fixed expressions (most Chinese words are 2-4
 * characters; almost no dictionary entry exceeds 8).
 */
export const CEDICT_DEFAULT_LOOKUP_CHARS = 12;

// ─── Sentence detection (click flow) ──────────────────────────────
/**
 * Single-character sentence terminators recognised by the click-flow
 * sentence detector. Matched on text-node walks both backward (start
 * of sentence is just past one of these) and forward (end of sentence
 * is at one of these, inclusive).
 */
export const SENTENCE_DELIMS = new Set([
  "。", // 。
  "！", // ！
  "？", // ？
  "；", // ；
  ".",
  "!",
  "?",
  ";",
  "\n",
]);

/** Hard cap on a detected sentence. Anything longer is hard-truncated. */
export const SENTENCE_MAX_CHARS = 500;

/**
 * Soft length budget for the click-flow sentence detector. When the
 * primary delimiter walk produces a sentence longer than this, the
 * detector silently re-walks with the secondary (clause-level)
 * delimiter set. Most Chinese sentences are 10-40 chars; 80 buys
 * comfortable headroom while preventing 200+ char run-ons from
 * landing in the popup. (.claude/ARCHITECTURE_REDESIGN.md §9)
 */
export const SENTENCE_SOFT_LIMIT_CHARS = 80;

/**
 * Secondary (clause-level) delimiters used by the soft-limit fallback.
 * Activated when Tier-1 (sentence-level) walk produced too long a chunk.
 * Includes Chinese commas, enumeration commas, and ASCII commas.
 */
export const SENTENCE_CLAUSE_DELIMS = new Set([
  "，", // 全角逗号
  "、", // 顿号
  ",",
]);

// ─── LLM System Prompt ────────────────────────────────────────────
/**
 * The system instruction sent to every LLM provider. Defines the
 * expected JSON output format with word segmentation, definitions,
 * and sentence translation.
 *
 * Pinyin is intentionally omitted from the requested schema: the local
 * pinyin-pro pipeline already produces accurate, polyphone-aware pinyin
 * for the LLM-segmented words, so asking the model to repeat that work
 * roughly doubles output tokens and end-to-end latency for no quality
 * win. The llm-client backfills pinyin per word after parsing.
 *
 * (SPEC.md Section 6 "Prompt Engineering")
 */
export const SYSTEM_PROMPT = `You are a Chinese language assistant integrated into a browser extension.
Given Chinese text and its surrounding context, you must:
1. Segment the text into individual words (not characters).
2. Provide a concise English definition for each word as it is used in this context.
3. Provide a natural English translation of the full text.

Respond ONLY with valid JSON in this exact format:
{
  "words": [
    { "chars": "<characters>", "definition": "<contextual English definition>" }
  ],
  "translation": "<full English translation>"
}`;

/**
 * System prompt for the click-flow sentence-mode LLM call. Returns a
 * full per-word breakdown so the popup can upgrade Bootstrap (CC-CEDICT)
 * data to LLM-contextual data once the response arrives, and so the
 * sentence's word boundaries become LLM-driven for subsequent clicks
 * within the same sentence.
 *
 * The "MUST concatenate" constraint is load-bearing: the content script
 * validates concat(words[].text) === sentence on receipt and discards
 * the response if violated, keeping the sentence in Bootstrap state.
 */
export const SYSTEM_PROMPT_SENTENCE = `You are a Chinese language assistant.
Given one Chinese sentence or clause, you must return:
1. A natural English translation.
2. The same sentence segmented into words and punctuation. The "text"
   fields, when concatenated in order with no extra characters, MUST
   equal the input sentence exactly.
3. For each word: contextual pinyin and a concise contextual English gloss.
   For punctuation entries, leave gloss as "" and pinyin as "".

Respond ONLY with valid JSON in this exact format:
{
  "translation": "<English translation>",
  "words": [
    { "text": "<chars>", "pinyin": "<pinyin>", "gloss": "<English>" }
  ]
}`;

