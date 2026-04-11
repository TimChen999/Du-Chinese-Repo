/**
 * Multi-provider LLM client with adapter pattern for request/response formats.
 *
 * Supports two API styles: OpenAI-compatible (OpenAI, Ollama, custom) and
 * Gemini (Google's distinct REST format). Provider-specific details are
 * isolated behind buildRequest() and parseResponse() adapters, so adding
 * a new OpenAI-compatible provider only requires a new PROVIDER_PRESETS
 * entry in constants.ts -- no code changes here.
 *
 * Uses only the Fetch API (no Chrome-specific APIs), making it testable
 * with standard fetch mocking.
 *
 * See: SPEC.md Section 6 "LLM Integration Design" for the adapter pattern,
 *      SPEC.md Section 6 "Multi-Provider Support" for provider details,
 *      IMPLEMENTATION_GUIDE.md Step 4 for implementation details.
 */

import type { LLMConfig, WordData, APIStyle } from "../shared/types";
import {
  LLM_TIMEOUT_MS,
  SYSTEM_PROMPT,
  PROVIDER_PRESETS,
} from "../shared/constants";

// ─── LLM Response Type ─────────────────────────────────────────────

/** Parsed LLM output: word-segmented pinyin with definitions + translation. */
export interface LLMResponse {
  words: Required<WordData>[];
  translation: string;
}

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

export type LLMResult =
  | { ok: true; data: LLMResponse }
  | { ok: false; error: LLMError };

// ─── Response Validation ────────────────────────────────────────────

/**
 * Type guard that validates the shape of parsed LLM JSON.
 * Ensures `words` is an array and `translation` is a string so
 * downstream consumers can trust the data without extra checks.
 */
export function validateLLMResponse(data: unknown): data is LLMResponse {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.words)) return false;
  if (typeof obj.translation !== "string") return false;
  return true;
}

// ─── Request Builder (Adapter) ──────────────────────────────────────

/**
 * Constructs the provider-specific fetch URL and RequestInit.
 *
 * OpenAI-compatible: POST /chat/completions with Bearer auth and
 *   response_format for reliable JSON output.
 * Gemini: POST /v1beta/models/{model}:generateContent with API key
 *   in the query string and responseMimeType for JSON.
 *
 * (SPEC.md Section 6 "API Styles")
 */
function buildRequest(
  text: string,
  context: string,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  const userContent = `Chinese text: "${text}"\nSurrounding context: "${context}"`;

  if (apiStyle === "gemini") {
    return {
      url: `${config.baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: SYSTEM_PROMPT + "\n\n" + userContent }] },
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

  // OpenAI-compatible (OpenAI, Ollama, custom)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      signal,
    },
  };
}

// ─── Response Parser (Adapter) ──────────────────────────────────────

/**
 * Extracts and JSON-parses the LLM's text output from the
 * provider-specific response envelope.
 *
 * OpenAI: data.choices[0].message.content
 * Gemini: data.candidates[0].content.parts[0].text
 */
function parseResponse(data: unknown, apiStyle: APIStyle): unknown {
  const obj = data as Record<string, unknown>;
  let raw: string | undefined;

  if (apiStyle === "gemini") {
    const candidates = obj.candidates as Array<Record<string, unknown>> | undefined;
    const text = (
      candidates?.[0]?.content as Record<string, unknown> | undefined
    )?.parts as Array<Record<string, unknown>> | undefined;
    raw = text?.[0]?.text as string | undefined;
  } else {
    // OpenAI-compatible
    const choices = obj.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    raw = message?.content as string | undefined;
  }

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[LLM-client] JSON.parse failed. Raw text (%d chars):", raw.length, raw.slice(0, 500));
    console.error("[LLM-client] Parse error:", err);
    return null;
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Sends Chinese text + context to the configured LLM and returns
 * structured word data with definitions and a sentence translation.
 *
 * Handles timeout (LLM_TIMEOUT_MS), one retry on 5xx server errors,
 * and graceful null return on any failure so the caller can fall
 * back to Phase 1 local pinyin.
 *
 * (SPEC.md Section 6 "Fallback Strategy")
 */
export async function queryLLM(
  text: string,
  context: string,
  config: LLMConfig,
): Promise<LLMResult> {
  const preset = PROVIDER_PRESETS[config.provider];
  const apiStyle = preset.apiStyle;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    return await attemptFetch(text, context, config, apiStyle, controller.signal);
  } catch (err) {
    if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
      return { ok: false, error: { code: "TIMEOUT", message: "Translation timed out. Try again." } };
    }
    console.error("[LLM-client] queryLLM caught error:", err);
    return { ok: false, error: { code: "NETWORK_ERROR", message: "Could not reach the LLM provider." } };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Executes a single fetch attempt and retries once on 5xx server errors.
 * The 1-second delay before retry gives transient server issues time
 * to resolve without hammering the endpoint.
 */
async function attemptFetch(
  text: string,
  context: string,
  config: LLMConfig,
  apiStyle: APIStyle,
  signal: AbortSignal,
): Promise<LLMResult> {
  const { url, init } = buildRequest(text, context, config, apiStyle, signal);

  console.log("[LLM-client] Fetching: %s", url);

  let response = await fetch(url, init);

  if (!response.ok && response.status >= 500) {
    console.warn("[LLM-client] Got %d, retrying in 1s…", response.status);
    await new Promise((r) => setTimeout(r, 1000));
    response = await fetch(url, init);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    console.error("[LLM-client] HTTP %d %s — body: %s", response.status, response.statusText, body.slice(0, 500));
    return { ok: false, error: classifyHttpError(response.status) };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." } };
  }

  const parsed = parseResponse(data, apiStyle);

  if (!validateLLMResponse(parsed)) {
    console.error("[LLM-client] Response failed validation. Raw parsed:", parsed);
    return { ok: false, error: { code: "INVALID_RESPONSE", message: "Received an invalid response from the LLM." } };
  }

  return { ok: true, data: parsed };
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
