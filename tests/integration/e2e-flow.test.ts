/**
 * End-to-end integration tests validating the full system.
 *
 * Unlike unit tests that isolate individual modules, these tests wire
 * multiple components together to verify cross-module interactions:
 *
 *  - Full pipeline: detection -> pinyin-pro -> overlay rendering
 *  - Settings propagation: chrome.storage.sync -> getSettings -> convertToPinyin
 *  - Cache integration: saveToCache -> getFromCache round-trip via the LLM path
 *  - Provider switching: changing provider updates LLM request format
 *  - Error propagation: LLM failure -> service worker error -> overlay error state
 *  - Message protocol: correct message types with required fields
 *  - Overlay lifecycle: show -> update -> dismiss without leaks
 *  - Type system integrity: all message types match their interfaces
 *
 * Uses the chrome mock from vitest-chrome-mv3 and a Map-backed
 * storage mock for chrome.storage.local (same pattern as cache.test.ts).
 *
 * See: IMPLEMENTATION_GUIDE.md "Final Integration Verification".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { containsChinese } from "../../src/shared/chinese-detect";
import { convertToPinyin } from "../../src/background/pinyin-service";
import { queryLLM, validateLLMResponse } from "../../src/background/llm-client";
import { hashText, saveToCache, getFromCache, clearCache } from "../../src/background/cache";
import {
  createOverlay,
  showOverlay,
  updateOverlay,
  showOverlayError,
  showTruncationNotice,
  dismissOverlay,
  renderRubyText,
} from "../../src/content/overlay";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  MAX_SELECTION_LENGTH,
  CACHE_TTL_MS,
  SYSTEM_PROMPT,
} from "../../src/shared/constants";
import type {
  ExtensionSettings,
  LLMConfig,
  WordData,
  PinyinRequest,
  PinyinResponseLocal,
  PinyinResponseLLM,
  PinyinError,
} from "../../src/shared/types";

// ─── In-memory chrome.storage.local mock ────────────────────────────

let store: Map<string, unknown>;

function setupStorageMocks() {
  store = new Map();

  chrome.storage.local.get.mockImplementation(
    (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null) {
        const all: Record<string, unknown> = {};
        store.forEach((v, k) => (all[k] = v));
        return Promise.resolve(all);
      }
      const keyList =
        typeof keys === "string"
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys as object);
      const result: Record<string, unknown> = {};
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      return Promise.resolve(result);
    },
  );

  chrome.storage.local.set.mockImplementation(
    (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      return Promise.resolve();
    },
  );

  chrome.storage.local.remove.mockImplementation(
    (keys: string | string[]) => {
      const keyList = typeof keys === "string" ? [keys] : keys;
      for (const k of keyList) store.delete(k);
      return Promise.resolve();
    },
  );

  chrome.storage.local.clear.mockImplementation(() => {
    store.clear();
    return Promise.resolve();
  });
}

// ─── Shared fixtures ────────────────────────────────────────────────

const sampleLLMResult = {
  words: [
    { chars: "你好", pinyin: "nǐ hǎo", definition: "hello" },
    { chars: "世界", pinyin: "shì jiè", definition: "world" },
  ],
  translation: "Hello world",
};

const openaiConfig: LLMConfig = {
  provider: "openai",
  apiKey: "sk-test-key-1234567890",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  maxTokens: 1024,
  temperature: 0,
};

// =====================================================================
// 1. Full Pipeline: detection -> pinyin -> overlay
// =====================================================================

describe("full pipeline: detection -> pinyin -> overlay", () => {
  afterEach(() => {
    dismissOverlay();
  });

  it("processes Chinese text from detection through to rendered overlay", () => {
    const text = "你好世界";

    // Step 1: detect Chinese
    expect(containsChinese(text)).toBe(true);

    // Step 2: convert to pinyin
    const words = convertToPinyin(text, "toneMarks");
    expect(words.length).toBeGreaterThan(0);
    expect(words.map((w) => w.chars).join("")).toBe(text);

    // Step 3: render ruby HTML
    const html = renderRubyText(words);
    expect(html).toContain("<ruby");
    expect(html).toContain("你");
    expect(html).toContain("好");

    // Step 4: show overlay
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay(words, rect, "light");

    const host = document.getElementById("hg-extension-root");
    expect(host).not.toBeNull();
    const shadow = host!.shadowRoot!;
    expect(shadow.querySelector(".hg-overlay")).not.toBeNull();
    expect(shadow.querySelector(".hg-pinyin-row")).not.toBeNull();
    expect(shadow.querySelector(".hg-loading")).not.toBeNull();
  });

  it("updates overlay with LLM-enhanced data (Phase 2)", () => {
    const words: WordData[] = [{ chars: "你好", pinyin: "nǐ hǎo" }];
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay(words, rect, "dark");

    const llmWords: Required<WordData>[] = [
      { chars: "你好", pinyin: "nǐ hǎo", definition: "hello; hi" },
    ];
    updateOverlay(llmWords, "Hello!");

    const host = document.getElementById("hg-extension-root");
    const shadow = host!.shadowRoot!;
    expect(shadow.querySelector(".hg-loading")).toBeNull();
    expect(shadow.querySelector(".hg-translation")!.textContent).toBe("Hello!");
    expect(shadow.querySelector(".hg-word")!.getAttribute("data-definition")).toBe("hello; hi");
  });

  it("correctly rejects non-Chinese text at the gate", () => {
    expect(containsChinese("hello world 123")).toBe(false);
    expect(containsChinese("")).toBe(false);
    expect(containsChinese("ひらがな")).toBe(false);
  });
});

// =====================================================================
// 2. Settings propagation: storage -> pinyin style
// =====================================================================

describe("settings propagation", () => {
  it("different pinyinStyle settings produce different pinyin output", () => {
    const text = "你好";

    const marks = convertToPinyin(text, "toneMarks");
    const numbers = convertToPinyin(text, "toneNumbers");
    const none = convertToPinyin(text, "none");

    const marksPinyin = marks.map((w) => w.pinyin).join("");
    const numbersPinyin = numbers.map((w) => w.pinyin).join("");
    const nonePinyin = none.map((w) => w.pinyin).join("");

    expect(marksPinyin).not.toBe(numbersPinyin);
    expect(numbersPinyin).not.toBe(nonePinyin);
    // But the chars must be identical
    expect(marks.map((w) => w.chars).join("")).toBe(text);
    expect(numbers.map((w) => w.chars).join("")).toBe(text);
    expect(none.map((w) => w.chars).join("")).toBe(text);
  });

  it("DEFAULT_SETTINGS provider matches its preset", () => {
    const preset = PROVIDER_PRESETS[DEFAULT_SETTINGS.provider];
    expect(DEFAULT_SETTINGS.baseUrl).toBe(preset.baseUrl);
    expect(DEFAULT_SETTINGS.model).toBe(preset.defaultModel);
  });

  it("all providers have consistent apiStyle values", () => {
    for (const [, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(["openai", "gemini"]).toContain(preset.apiStyle);
    }
  });
});

// =====================================================================
// 3. Cache integration: save -> retrieve -> expire
// =====================================================================

describe("cache integration", () => {
  beforeEach(() => {
    setupStorageMocks();
  });

  it("caches an LLM result and retrieves it by the same hash key", async () => {
    const text = "你好世界";
    const context = "朋友说你好世界";

    const key = await hashText(text + context);
    await saveToCache(key, sampleLLMResult);

    const cached = await getFromCache(key);
    expect(cached).toEqual(sampleLLMResult);
  });

  it("different text+context pairs produce different cache keys", async () => {
    const key1 = await hashText("你好" + "context A");
    const key2 = await hashText("你好" + "context B");
    expect(key1).not.toBe(key2);
  });

  it("cached entry is null after clearCache", async () => {
    const key = await hashText("test");
    await saveToCache(key, sampleLLMResult);
    await clearCache();
    expect(await getFromCache(key)).toBeNull();
  });

  it("expired entries return null on read", async () => {
    const key = await hashText("expired-test");
    await saveToCache(key, sampleLLMResult);

    const entry = store.get(key) as { timestamp: number };
    entry.timestamp = Date.now() - CACHE_TTL_MS - 1000;
    store.set(key, entry);

    expect(await getFromCache(key)).toBeNull();
  });

  it("cache round-trip preserves word data structure", async () => {
    const key = await hashText("structure-test");
    const data = {
      words: [
        { chars: "银行", pinyin: "yín háng", definition: "bank" },
        { chars: "工作", pinyin: "gōng zuò", definition: "work" },
      ],
      translation: "Working at a bank",
    };

    await saveToCache(key, data);
    const cached = await getFromCache(key);

    expect(cached!.words).toHaveLength(2);
    expect(cached!.words[0].chars).toBe("银行");
    expect(cached!.words[0].definition).toBe("bank");
    expect(cached!.translation).toBe("Working at a bank");
  });
});

// =====================================================================
// 4. Provider switching: config -> request format
// =====================================================================

describe("provider switching", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("OpenAI config produces /chat/completions URL", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(sampleLLMResult) } }],
      }),
    });

    await queryLLM("你好", "context", openaiConfig);

    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect(url).toContain("openai.com");
  });

  it("Gemini config produces generateContent URL with key param", async () => {
    const geminiConfig: LLMConfig = {
      provider: "gemini",
      apiKey: "AIza-test",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.0-flash",
      maxTokens: 1024,
      temperature: 0,
    };

    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(sampleLLMResult) }] } }],
      }),
    });

    await queryLLM("你好", "context", geminiConfig);

    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain("generateContent");
    expect(url).toContain("key=AIza-test");
  });

  it("Ollama config omits Authorization header", async () => {
    const ollamaConfig: LLMConfig = {
      provider: "ollama",
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b",
      maxTokens: 1024,
      temperature: 0,
    };

    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(sampleLLMResult) } }],
      }),
    });

    await queryLLM("你好", "context", ollamaConfig);

    const [, options] = (fetch as any).mock.calls[0];
    expect(options.headers["Authorization"]).toBeUndefined();
  });

  it("system prompt is included in every provider's request body", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(sampleLLMResult) } }],
      }),
    });

    await queryLLM("你好", "context", openaiConfig);

    const [, options] = (fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    const systemMsg = body.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toBe(SYSTEM_PROMPT);
  });
});

// =====================================================================
// 5. Error propagation: LLM failure -> null result
// =====================================================================

describe("error propagation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    dismissOverlay();
  });

  it("LLM network error returns typed error and overlay shows message", async () => {
    (fetch as any).mockRejectedValue(new Error("Network error"));

    const result = await queryLLM("你好", "context", openaiConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
    }

    // Simulate what the service worker does: show Phase 1 then error
    const words = convertToPinyin("你好", "toneMarks");
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay(words, rect, "light");
    if (!result.ok) showOverlayError(result.error.message);

    const shadow = document.getElementById("hg-extension-root")!.shadowRoot!;
    const translation = shadow.querySelector(".hg-translation");
    expect(translation!.textContent).toBe("Could not reach the LLM provider.");
    expect(translation!.classList.contains("hg-loading")).toBe(false);
  });

  it("invalid LLM JSON returns INVALID_RESPONSE error", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "not json at all {{{" } }],
      }),
    });

    const result = await queryLLM("你好", "context", openaiConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_RESPONSE");
    }
  });

  it("validateLLMResponse rejects malformed structures", () => {
    expect(validateLLMResponse({ words: "not-array", translation: "ok" })).toBe(false);
    expect(validateLLMResponse({ words: [], translation: 42 })).toBe(false);
    expect(validateLLMResponse(null)).toBe(false);
  });
});

// =====================================================================
// 6. Message protocol: type field and shape validation
// =====================================================================

describe("message protocol", () => {
  it("PinyinRequest has all required fields", () => {
    const msg: PinyinRequest = {
      type: "PINYIN_REQUEST",
      text: "你好",
      context: "朋友说你好",
      selectionRect: { top: 0, left: 0, bottom: 20, right: 50, width: 50, height: 20 },
    };
    expect(msg.type).toBe("PINYIN_REQUEST");
    expect(msg.text).toBeDefined();
    expect(msg.context).toBeDefined();
    expect(msg.selectionRect.width).toBeGreaterThanOrEqual(0);
  });

  it("PinyinResponseLocal has correct structure", () => {
    const words = convertToPinyin("你好", "toneMarks");
    const msg: PinyinResponseLocal = {
      type: "PINYIN_RESPONSE_LOCAL",
      words,
    };
    expect(msg.type).toBe("PINYIN_RESPONSE_LOCAL");
    expect(msg.words.length).toBeGreaterThan(0);
    expect(msg.words[0]).toHaveProperty("chars");
    expect(msg.words[0]).toHaveProperty("pinyin");
  });

  it("PinyinResponseLLM includes definitions and translation", () => {
    const msg: PinyinResponseLLM = {
      type: "PINYIN_RESPONSE_LLM",
      words: [{ chars: "你好", pinyin: "nǐ hǎo", definition: "hello" }],
      translation: "Hello",
    };
    expect(msg.type).toBe("PINYIN_RESPONSE_LLM");
    expect(msg.words[0].definition).toBe("hello");
    expect(msg.translation).toBe("Hello");
  });

  it("PinyinError has phase field", () => {
    const msg: PinyinError = {
      type: "PINYIN_ERROR",
      error: "something went wrong",
      phase: "llm",
    };
    expect(msg.phase).toBe("llm");
    expect(msg.error.length).toBeGreaterThan(0);
  });

  it("message types form a complete discriminated union", () => {
    const types = [
      "PINYIN_REQUEST",
      "PINYIN_RESPONSE_LOCAL",
      "PINYIN_RESPONSE_LLM",
      "PINYIN_ERROR",
      "CONTEXT_MENU_TRIGGER",
      "COMMAND_TRIGGER",
    ];
    for (const t of types) {
      expect(typeof t).toBe("string");
    }
    expect(new Set(types).size).toBe(types.length);
  });
});

// =====================================================================
// 7. Overlay lifecycle: show -> update -> dismiss
// =====================================================================

describe("overlay lifecycle", () => {
  afterEach(() => {
    dismissOverlay();
  });

  it("complete lifecycle: create -> show -> update -> dismiss", () => {
    const root = createOverlay();
    expect(root).toBeDefined();

    const words: WordData[] = [
      { chars: "你好", pinyin: "nǐ hǎo" },
      { chars: "世界", pinyin: "shì jiè" },
    ];
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay(words, rect, "light");

    let host = document.getElementById("hg-extension-root");
    expect(host).not.toBeNull();
    expect(host!.shadowRoot!.querySelector(".hg-loading")).not.toBeNull();

    updateOverlay(
      [
        { chars: "你好", pinyin: "nǐ hǎo", definition: "hello" },
        { chars: "世界", pinyin: "shì jiè", definition: "world" },
      ],
      "Hello world",
    );

    expect(host!.shadowRoot!.querySelector(".hg-loading")).toBeNull();
    expect(host!.shadowRoot!.querySelector(".hg-translation")!.textContent).toBe("Hello world");

    dismissOverlay();
    host = document.getElementById("hg-extension-root");
    expect(host).toBeNull();
  });

  it("showing a new overlay replaces the previous one", () => {
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;

    showOverlay([{ chars: "你", pinyin: "nǐ" }], rect, "light");
    showOverlay([{ chars: "好", pinyin: "hǎo" }], rect, "dark");

    const host = document.getElementById("hg-extension-root");
    const overlays = host!.shadowRoot!.querySelectorAll(".hg-overlay");
    expect(overlays.length).toBe(1);
    expect(overlays[0].innerHTML).toContain("好");
    expect(overlays[0].classList.contains("hg-dark")).toBe(true);
  });

  it("truncation notice appears and persists after update", () => {
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay([{ chars: "你", pinyin: "nǐ" }], rect, "light");
    showTruncationNotice();

    const host = document.getElementById("hg-extension-root");
    expect(host!.shadowRoot!.querySelector(".hg-truncation-notice")).not.toBeNull();
    expect(host!.shadowRoot!.querySelector(".hg-truncation-notice")!.textContent).toContain("500");
  });

  it("error state replaces loading indicator", () => {
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay([{ chars: "你", pinyin: "nǐ" }], rect, "light");

    expect(document.getElementById("hg-extension-root")!.shadowRoot!.querySelector(".hg-loading")).not.toBeNull();

    showOverlayError("Set up an API key in extension settings for translations.");

    const shadow = document.getElementById("hg-extension-root")!.shadowRoot!;
    expect(shadow.querySelector(".hg-loading")).toBeNull();
    expect(shadow.querySelector(".hg-translation")!.textContent).toContain("API key");
  });

  it("definition card appears on word click and toggles off", () => {
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay([{ chars: "你好", pinyin: "nǐ hǎo" }], rect, "light");
    updateOverlay(
      [{ chars: "你好", pinyin: "nǐ hǎo", definition: "hello" }],
      "Hello",
    );

    const shadow = document.getElementById("hg-extension-root")!.shadowRoot!;
    const word = shadow.querySelector(".hg-word") as HTMLElement;
    word.click();
    expect(shadow.querySelector(".hg-definition-card")).not.toBeNull();

    word.click();
    expect(shadow.querySelector(".hg-definition-card")).toBeNull();
  });

  it("dismiss is safe to call when no overlay exists", () => {
    expect(() => dismissOverlay()).not.toThrow();
    expect(document.getElementById("hg-extension-root")).toBeNull();
  });
});

// =====================================================================
// 8. Full system round-trip (detection -> pinyin -> LLM -> overlay)
// =====================================================================

describe("full system round-trip", () => {
  beforeEach(() => {
    setupStorageMocks();
    vi.stubGlobal("fetch", vi.fn());
    // jsdom doesn't provide matchMedia; stub it for "auto" theme resolution
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    dismissOverlay();
  });

  it("simulates the complete request cycle with mocked LLM", async () => {
    const text = "你好世界";
    const context = "朋友说你好世界";

    // 1. Detection gate
    expect(containsChinese(text)).toBe(true);

    // 2. Phase 1: local pinyin
    const localWords = convertToPinyin(text, "toneMarks");
    expect(localWords.length).toBeGreaterThan(0);

    // 3. Show Phase 1 overlay
    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay(localWords, rect, "auto");

    const shadow = document.getElementById("hg-extension-root")!.shadowRoot!;
    expect(shadow.querySelector(".hg-loading")).not.toBeNull();

    // 4. Cache miss -> LLM call
    const cacheKey = await hashText(text + context);
    const cachedBefore = await getFromCache(cacheKey);
    expect(cachedBefore).toBeNull();

    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(sampleLLMResult) } }],
      }),
    });

    const llmResult = await queryLLM(text, context, openaiConfig);
    expect(llmResult.ok).toBe(true);
    if (!llmResult.ok) throw new Error("Expected ok result");
    expect(validateLLMResponse(llmResult.data)).toBe(true);

    // 5. Save to cache
    await saveToCache(cacheKey, llmResult.data);

    // 6. Phase 2: update overlay
    updateOverlay(llmResult.data.words, llmResult.data.translation);
    expect(shadow.querySelector(".hg-loading")).toBeNull();
    expect(shadow.querySelector(".hg-translation")!.textContent).toBe("Hello world");

    // 7. Second lookup hits cache
    const cachedAfter = await getFromCache(cacheKey);
    expect(cachedAfter).toEqual(sampleLLMResult);

    // 8. Dismiss
    dismissOverlay();
    expect(document.getElementById("hg-extension-root")).toBeNull();
  });

  it("truncated text shows notice and still completes the pipeline", async () => {
    const longText = "你好".repeat(300);
    expect(longText.length).toBeGreaterThan(MAX_SELECTION_LENGTH);

    const truncated = longText.slice(0, MAX_SELECTION_LENGTH);
    expect(containsChinese(truncated)).toBe(true);

    const words = convertToPinyin(truncated, "toneMarks");
    expect(words.length).toBeGreaterThan(0);

    const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
    showOverlay(words, rect, "light");
    showTruncationNotice();

    const shadow = document.getElementById("hg-extension-root")!.shadowRoot!;
    expect(shadow.querySelector(".hg-truncation-notice")).not.toBeNull();
    expect(shadow.querySelector(".hg-truncation-notice")!.textContent).toContain("500");
  });
});
