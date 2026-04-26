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
 * A captured example sentence for a vocab word. Sentences are pulled
 * from the surrounding page context at "+ Vocab" time and only kept
 * when they pass the quality gate in shared/example-quality.ts.
 * `translation` is filled either at capture time (when AI Translations
 * is on) or later via the on-demand "Translate" button in the vocab
 * card / flashcard flip view.
 */
export interface VocabExample {
  sentence: string;
  translation?: string;
  capturedAt: number;
}

/**
 * A word recorded by the vocab tracker. Extends the core WordData fields
 * with frequency and timestamp metadata.
 * (VOCAB_SPEC.md Section 2 "Data Model")
 *
 * `examples` holds up to MAX_VOCAB_EXAMPLES (2) captured sentences.
 * Slots are append-only on capture; the user explicitly clears a slot
 * with the X button before a future capture can refill it.
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
  /**
   * Current spaced-repetition interval in days. Zero means the card
   * is due immediately (either never reviewed or last answer wrong);
   * a successful review doubles the interval up to SRS_MAX_INTERVAL_DAYS.
   */
  intervalDays: number;
  /**
   * Epoch ms when this card next becomes due. Defaults to 0 for
   * entries that have never been reviewed -- they're treated as due
   * immediately so they surface in the very next session.
   */
  nextDueAt: number;
  examples?: VocabExample[];
}

/**
 * Runtime configuration passed to the LLM client's queryLLMSentence().
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
 * One segmented word in the LLM's sentence response (click-flow path).
 * `text` is the raw Chinese substring (or punctuation) the LLM produced
 * for this slot. The contract is that `words.map(w => w.text).join("")`
 * must equal the original sentence exactly — see SYSTEM_PROMPT_SENTENCE.
 */
export interface LLMSentenceWord {
  text: string;
  pinyin: string;
  gloss: string;
}

/**
 * Click-flow content -> service worker. Asks the SW for a per-sentence
 * LLM enrichment (translation + per-word boundaries / contextual pinyin
 * / contextual gloss). Cache key is derived from `sentence` + style +
 * provider/model (see sentence-cache.ts).
 */
export interface SentenceTranslateRequest {
  type: "SENTENCE_TRANSLATE_REQUEST";
  sentence: string;
  pinyinStyle: PinyinStyle;
  /** Monotonic per-tab id; the content script discards stale responses. */
  requestId: number;
}

/**
 * Click-flow service worker -> content. Successful LLM response with
 * the validated per-word breakdown. The content script must verify
 * concat(words[].text) === sentence before applying.
 */
export interface SentenceTranslateResponseLLM {
  type: "SENTENCE_TRANSLATE_RESPONSE_LLM";
  sentence: string;
  requestId: number;
  translation: string;
  words: LLMSentenceWord[];
}

/**
 * Click-flow service worker -> content. The LLM call failed or the
 * provider was unconfigured. The content script keeps the sentence in
 * Bootstrap state (Chrome on-device translator + CC-CEDICT) and shows
 * an inline error indicator.
 */
export interface SentenceTranslateError {
  type: "SENTENCE_TRANSLATE_ERROR";
  sentence: string;
  requestId: number;
  error: string;
  /** Non-typed string here so we don't import the LLM client's enum into shared. */
  code: string;
}

/**
 * Discriminated union of every message that can travel between
 * content script <-> service worker. The `type` field acts as the discriminant.
 * Includes the two trigger messages for context menu and keyboard shortcut.
 * (SPEC.md Section 2.6, Section 5 "Message Protocol")
 */
export type ExtensionMessage =
  | SentenceTranslateRequest
  | SentenceTranslateResponseLLM
  | SentenceTranslateError
  | { type: "CONTEXT_MENU_TRIGGER"; text: string }
  | { type: "COMMAND_TRIGGER" }
  | {
      /**
       * Content script -> Service worker. Persists a single recorded
       * word, optionally with a captured example sentence already
       * trimmed and (when the on-device Translator API succeeded
       * synchronously) translated by the content script. The service
       * worker no longer runs the example-quality gate, the trim, or
       * the translation -- those move to the content script so the
       * Translator API runs in a context that has user activation.
       */
      type: "RECORD_WORD";
      word: { chars: string; pinyin: string; definition: string };
      example?: { sentence: string; translation?: string };
    }
  | {
      /**
       * Content script -> Service worker. Sent after RECORD_WORD when
       * the Translator API completed asynchronously (e.g. on the very
       * first call where the model had to download). The service
       * worker looks up the matching example by sentence and patches
       * its `translation` field via setExampleTranslation.
       */
      type: "SET_EXAMPLE_TRANSLATION";
      chars: string;
      sentence: string;
      translation: string;
    }
  | { type: "OCR_START" }
  | { type: "OCR_START_SELECTION" }
  | { type: "REMOVE_WORD"; chars: string }
  | { type: "REMOVE_EXAMPLE"; chars: string; index: number }
  | { type: "OCR_CAPTURE_REQUEST"; rect: { x: number; y: number; width: number; height: number } }
  | { type: "OCR_CAPTURE_RESULT"; dataUrl: string };
