/**
 * Multi-provider LLM client for the click-flow's per-sentence
 * translation calls. Supports two API styles: OpenAI-compatible
 * (OpenAI, Ollama, custom) and Gemini (Google's REST format).
 * Provider-specific details are isolated behind buildSentenceRequest()
 * and extractRawText().
 *
 * The legacy queryLLM (selection-flow with partial-JSON salvage) was
 * retired with the click-flow redesign; queryLLMSentence is the only
 * entry point.
 */

import type {
  LLMConfig,
  LLMSentenceWord,
  APIStyle,
  PinyinStyle,
} from "../shared/types";
import {
  LLM_TIMEOUT_MS,
  SYSTEM_PROMPT_SENTENCE,
  PROVIDER_PRESETS,
  RETRY_DELAYS_MS,
} from "../shared/constants";

export type LLMErrorCode =
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "UNKNOWN";

export interface LLMError {
  code: LLMErrorCode;
  message: string;
}

// ─── Response Parser (Adapter) ──────────────────────────────────────

/**
 * Pulls the model's raw text payload out of the provider-specific
 * envelope without attempting any JSON parsing.
 *
 * OpenAI: data.choices[0].message.content
 * Gemini: data.candidates[0].content.parts[0].text
 */
function extractRawText(data: unknown, apiStyle: APIStyle): string | null {
  const obj = data as Record<string, unknown>;

  if (apiStyle === "gemini") {
    const candidates = obj.candidates as Array<Record<string, unknown>> | undefined;
    const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    const text = parts?.[0]?.text;
    return typeof text === "string" ? text : null;
  }

  // OpenAI-compatible
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : null;
}

// ─── Logging Helpers ────────────────────────────────────────────────

/**
 * Single-line JSON telemetry record emitted at the end of every
 * attempt (success or failure). No PII, no API key. Designed to be
 * grep-able from chrome://extensions devtools logs.
 */
interface TelemetryRecord {
  provider: string;
  model: string;
  attempt: number;
  status: string;
  latencyMs: number;
  partial: boolean;
  textLen: number;
  contextLen: number;
}
function logTelemetry(rec: TelemetryRecord): void {
  console.log("[LLM-telemetry]", JSON.stringify(rec));
}

// ─── Sentence-mode (click-flow) ───────────────────────────────────

/** Error codes that a transient failure can recover from on retry. */
const RETRYABLE_CODES: ReadonlySet<LLMErrorCode> = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_ERROR",
]);

/**
 * Sentence-mode response. Returned by queryLLMSentence(). Distinct from
 * LLMResponse (selection-flow): the per-word unit here is
 * { text, pinyin, gloss }, not WordData with optional definition. The
 * shape matches LLMSentenceWord in shared/types.
 */
export interface LLMSentenceResponse {
  translation: string;
  words: LLMSentenceWord[];
}

export type LLMSentenceResult =
  | { ok: true; data: LLMSentenceResponse }
  | { ok: false; error: LLMError };

/**
 * Validates that the LLM's per-word array, when concatenated, equals the
 * input sentence. Returns true if valid. Required by the click-flow
 * contract: any segmentation that doesn't reconstruct the original
 * sentence is discarded so the user never sees boundaries that don't
 * line up with what's painted on the page.
 */
export function validateSentenceConcat(
  sentence: string,
  words: LLMSentenceWord[],
): boolean {
  return words.map((w) => w.text).join("") === sentence;
}

function validateSentenceResponse(
  data: unknown,
  sentence: string,
): data is LLMSentenceResponse {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.translation !== "string") return false;
  if (!Array.isArray(obj.words)) return false;
  for (const w of obj.words) {
    if (!w || typeof w !== "object") return false;
    const wo = w as Record<string, unknown>;
    if (typeof wo.text !== "string") return false;
    // pinyin / gloss may be missing on punctuation slots; we permit
    // them as missing here and normalize in normalizeSentenceWords.
  }
  return validateSentenceConcat(sentence, obj.words as LLMSentenceWord[]);
}

function normalizeSentenceWords(words: LLMSentenceWord[]): LLMSentenceWord[] {
  return words.map((w) => ({
    text: w.text,
    pinyin: typeof w.pinyin === "string" ? w.pinyin : "",
    gloss: typeof w.gloss === "string" ? w.gloss : "",
  }));
}

function buildSentenceRequest(
  sentence: string,
  pinyinStyle: PinyinStyle,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  const styleHint =
    pinyinStyle === "toneMarks"
      ? "Format pinyin with tone marks (e.g. yínháng)."
      : pinyinStyle === "toneNumbers"
        ? "Format pinyin with tone numbers (e.g. yin2hang2)."
        : "Format pinyin without tone marks or numbers (e.g. yinhang).";

  const userContent = `Sentence: "${sentence}"\n${styleHint}`;

  if (apiStyle === "gemini") {
    return {
      url: `${config.baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: SYSTEM_PROMPT_SENTENCE + "\n\n" + userContent },
              ],
            },
          ],
          generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            responseMimeType: "application/json",
          },
        }),
        signal,
      },
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT_SENTENCE },
          { role: "user", content: userContent },
        ],
      }),
      signal,
    },
  };
}

/**
 * Sentence-mode LLM entry point. Mirrors queryLLM's resilience layering
 * (per-attempt timeout, retry on transient codes, telemetry) but without
 * partial-JSON salvage — for the click flow we'd rather discard a bad
 * response and let the user see the Bootstrap data than apply
 * possibly-misaligned boundaries from a salvaged shape.
 */
export async function queryLLMSentence(
  sentence: string,
  pinyinStyle: PinyinStyle,
  config: LLMConfig,
): Promise<LLMSentenceResult> {
  const apiStyle = PROVIDER_PRESETS[config.provider].apiStyle;
  const totalAttempts = RETRY_DELAYS_MS.length + 1;
  let last: LLMSentenceResult = {
    ok: false,
    error: { code: "UNKNOWN", message: "LLM sentence request failed." },
  };

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (attempt > 1) {
      const baseDelay = RETRY_DELAYS_MS[attempt - 2];
      const jittered = baseDelay * (1 + Math.random() * 0.25);
      await new Promise((r) => setTimeout(r, jittered));
    }

    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    let result: LLMSentenceResult;
    let status: string;

    try {
      result = await singleSentenceAttempt(
        sentence,
        pinyinStyle,
        config,
        apiStyle,
        controller.signal,
      );
      status = result.ok ? "ok" : result.error.code;
    } catch (err) {
      const isAbort =
        err && typeof err === "object" &&
        (err as { name?: string }).name === "AbortError";
      result = isAbort
        ? { ok: false, error: { code: "TIMEOUT", message: "Translation timed out. Try again." } }
        : { ok: false, error: { code: "NETWORK_ERROR", message: "Could not reach the LLM provider." } };
      status = result.error ? result.error.code : "UNKNOWN";
    } finally {
      clearTimeout(timer);
    }

    logTelemetry({
      provider: config.provider,
      model: config.model,
      attempt,
      status,
      latencyMs: Date.now() - t0,
      partial: false,
      textLen: sentence.length,
      contextLen: 0,
    });

    last = result;
    if (result.ok) return result;
    if (!RETRYABLE_CODES.has(result.error.code)) return result;
  }

  return last;
}

async function singleSentenceAttempt(
  sentence: string,
  pinyinStyle: PinyinStyle,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): Promise<LLMSentenceResult> {
  const { url, init } = buildSentenceRequest(sentence, pinyinStyle, config, apiStyle, signal);

  const response = await fetch(url, init);
  if (!response.ok) {
    return { ok: false, error: classifyHttpError(response.status) };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." },
    };
  }

  const raw = extractRawText(data, apiStyle);
  if (!raw) {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", message: "Received malformed JSON from the LLM." },
    };
  }

  if (!validateSentenceResponse(parsed, sentence)) {
    return {
      ok: false,
      error: {
        code: "INVALID_RESPONSE",
        message:
          "LLM segmentation didn't reconstruct the sentence; ignoring.",
      },
    };
  }

  return {
    ok: true,
    data: {
      translation: parsed.translation,
      words: normalizeSentenceWords(parsed.words),
    },
  };
}

function classifyHttpError(status: number): LLMError {
  if (status === 401 || status === 403) {
    return { code: "AUTH_FAILED", message: "API key is invalid or expired." };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." };
  }
  if (status >= 500) {
    return { code: "SERVER_ERROR", message: "LLM server error. Try again later." };
  }
  return { code: "UNKNOWN", message: `LLM request failed (HTTP ${status}).` };
}
