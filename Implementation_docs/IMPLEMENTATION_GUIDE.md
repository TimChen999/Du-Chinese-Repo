# Pinyin Tool Chrome Extension -- Implementation Guide

This document breaks the full [SPEC.md](SPEC.md) into **8 discrete implementation steps**, each designed to be completed in a single LLM coding session. Every step includes its own unit tests in a dedicated `tests/` directory. Steps are ordered by dependency -- each step builds only on files produced by prior steps.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Test Infrastructure](#test-infrastructure)
- [Dependency Graph](#dependency-graph)
- [Step 1: Project Scaffolding + Shared Types](#step-1-project-scaffolding--shared-types)
- [Step 2: Pinyin Service (Local)](#step-2-pinyin-service-local)
- [Step 3: Service Worker + Message Handling](#step-3-service-worker--message-handling)
- [Step 4: LLM Client](#step-4-llm-client)
- [Step 5: Caching Layer](#step-5-caching-layer)
- [Step 6: Overlay UI Component](#step-6-overlay-ui-component)
- [Step 7: Content Script (Selection Wiring)](#step-7-content-script-selection-wiring)
- [Step 8: Popup Settings UI + Polish + Edge Cases](#step-8-popup-settings-ui--polish--edge-cases)
- [Final Integration Verification](#final-integration-verification)

---

## Prerequisites

Before starting any step, ensure the following are installed on your machine:

- **Node.js** >= 18.x (LTS)
- **npm** >= 9.x
- **Google Chrome** (for manual testing via `chrome://extensions`)
- A text editor or IDE with TypeScript support

---

## Test Infrastructure

All steps share a common test setup. Step 1 creates the configuration; subsequent steps only add test files.

### Test runner: Vitest

Vitest is the test framework. It integrates natively with Vite (the project's bundler) and supports TypeScript out of the box.

### Chrome API mocking: vitest-chrome-mv3

The `vitest-chrome-mv3` package provides a complete mock of Chrome extension APIs (`chrome.runtime`, `chrome.storage`, `chrome.tabs`, `chrome.contextMenus`, etc.) that behaves like the real API -- promises resolve, events fire, and storage persists within each test.

### DOM environment: jsdom

Tests that touch the DOM (overlay component, content script, popup) run in Vitest's built-in `jsdom` environment, giving them `document`, `window`, and `HTMLElement` without a real browser.

### Test directory structure

Tests mirror the `src/` layout:

```
tests/
├── setup.ts                          # Global test setup (chrome mock, jsdom)
├── shared/
│   ├── chinese-detect.test.ts        # Step 1
│   └── constants.test.ts             # Step 1
├── background/
│   ├── pinyin-service.test.ts        # Step 2
│   ├── service-worker.test.ts        # Step 3
│   ├── llm-client.test.ts           # Step 4
│   └── cache.test.ts                # Step 5
├── content/
│   ├── overlay.test.ts              # Step 6
│   └── content.test.ts             # Step 7
├── popup/
│   └── popup.test.ts               # Step 8
└── integration/
    └── edge-cases.test.ts           # Step 8
```

### Running tests

```bash
# Run all tests
npm test

# Run tests for a specific step
npx vitest run tests/shared/
npx vitest run tests/background/pinyin-service.test.ts

# Run in watch mode during development
npx vitest --watch
```

---

## Dependency Graph

Each step depends only on the steps above it. Steps at the same level could theoretically be parallelized, but the order below is the recommended linear path.

```
Step 1: Scaffolding + Shared Types
  │
  ├──► Step 2: Pinyin Service
  │       │
  │       ├──► Step 3: Service Worker
  │       │       │
  │       │       ├──► Step 4: LLM Client
  │       │       │
  │       │       └──► Step 5: Caching Layer
  │       │
  │       └──► Step 6: Overlay UI
  │               │
  │               └──► Step 7: Content Script
  │
  └──► Step 8: Popup + Polish + Edge Cases
```

Summary of dependencies:

| Step | Depends on |
|------|-----------|
| 1 | Nothing (bootstraps the project) |
| 2 | Step 1 (`types.ts`, `constants.ts`) |
| 3 | Steps 1, 2 (`pinyin-service.ts`, `types.ts`) |
| 4 | Steps 1, 3 (`types.ts`, `constants.ts`, called by service worker) |
| 5 | Steps 1, 3 (`types.ts`, `constants.ts`, integrated into service worker) |
| 6 | Step 1 (`types.ts`, `constants.ts`) |
| 7 | Steps 1, 6 (`overlay.ts`, `chinese-detect.ts`, `types.ts`) |
| 8 | Steps 1-7 (settings drive all other components) |

---

## Step 1: Project Scaffolding + Shared Types

### Scope

Bootstrap the entire project from scratch -- configuration files, build pipeline, extension manifest, shared TypeScript types, constants, Chinese detection utilities, and the test infrastructure itself.

### Files to create

| File | Purpose |
|------|---------|
| `package.json` | npm project with dependencies and scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `vite.config.ts` | Vite build config with web extension plugin |
| `vitest.config.ts` | Vitest test runner configuration |
| `manifest.json` | Chrome Manifest V3 extension manifest |
| `src/shared/types.ts` | All shared TypeScript interfaces |
| `src/shared/constants.ts` | Default settings, regex patterns, config values |
| `src/shared/chinese-detect.ts` | `containsChinese()` and `extractSurroundingContext()` |
| `tests/setup.ts` | Global test setup (chrome mock initialization) |
| `tests/shared/chinese-detect.test.ts` | Tests for Chinese detection utilities |
| `tests/shared/constants.test.ts` | Tests for constant values and default settings |

### Detailed instructions

#### 1a. Initialize the project

```bash
mkdir pinyin-tool-extension && cd pinyin-tool-extension
npm init -y
```

#### 1b. Install all dependencies

```bash
npm install pinyin-pro

npm install -D typescript vite vite-plugin-web-extension \
  @types/chrome vitest vitest-chrome-mv3 jsdom
```

#### 1c. Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["chrome"],
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

#### 1d. Create `vite.config.ts`

```typescript
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
    }),
  ],
  build: {
    outDir: "dist",
    emptyDirFirst: true,
  },
});
```

#### 1e. Create `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
  },
});
```

#### 1f. Add scripts to `package.json`

```json
{
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest --watch"
  }
}
```

#### 1g. Create `tests/setup.ts`

This file initializes the Chrome API mock before every test:

```typescript
import { chrome } from "vitest-chrome-mv3";

Object.assign(globalThis, { chrome });

beforeEach(() => {
  chrome.reset();
});
```

#### 1h. Create `manifest.json`

Write the full manifest as specified in SPEC.md Section 4, including:
- `manifest_version: 3`
- `permissions`: `["activeTab", "storage", "contextMenus"]`
- `host_permissions`: `["<all_urls>"]`
- `content_scripts` matching `<all_urls>` with `content.ts` and `overlay.css`
- `background.service_worker` pointing to `service-worker.ts`
- `action.default_popup` pointing to `popup.html`
- `commands` with `show-pinyin` keyboard shortcut (`Alt+Shift+P`)
- `web_accessible_resources` for `assets/*`

#### 1i. Create `src/shared/types.ts`

Define all shared interfaces. At minimum:

```typescript
export type PinyinStyle = "toneMarks" | "toneNumbers" | "none";
export type Theme = "light" | "dark" | "auto";
export type LLMProvider = "openai" | "gemini" | "ollama" | "custom";
export type APIStyle = "openai" | "gemini";

export interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
  apiStyle: APIStyle;
  requiresApiKey: boolean;
  models: string[];
}

export interface WordData {
  chars: string;
  pinyin: string;
  definition?: string;
}

export interface PinyinRequest {
  type: "PINYIN_REQUEST";
  text: string;
  context: string;
  selectionRect: { top: number; left: number; bottom: number; right: number; width: number; height: number };
}

export interface PinyinResponseLocal {
  type: "PINYIN_RESPONSE_LOCAL";
  words: WordData[];
}

export interface PinyinResponseLLM {
  type: "PINYIN_RESPONSE_LLM";
  words: Required<WordData>[];
  translation: string;
}

export interface PinyinError {
  type: "PINYIN_ERROR";
  error: string;
  phase: "local" | "llm";
}

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface ExtensionSettings {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  pinyinStyle: PinyinStyle;
  fontSize: number;
  theme: Theme;
  llmEnabled: boolean;
}

export type ExtensionMessage =
  | PinyinRequest
  | PinyinResponseLocal
  | PinyinResponseLLM
  | PinyinError
  | { type: "CONTEXT_MENU_TRIGGER"; text: string }
  | { type: "COMMAND_TRIGGER" };
```

#### 1j. Create `src/shared/constants.ts`

This is the **single source of truth for every configurable value** in the extension. To adjust any behavior -- timeouts, cache duration, provider URLs, default models, or the LLM system prompt -- edit only this file.

```typescript
import type { ExtensionSettings, LLMProvider, ProviderPreset } from "./types";

// ─── Chinese Detection ─────────────────────────────────────────────
export const CHINESE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
export const CHINESE_REGEX_GLOBAL = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;

// ─── LLM Provider Presets ──────────────────────────────────────────
// Add new providers here. If they use the OpenAI-compatible /chat/completions
// format, set apiStyle to "openai" and no code changes are needed elsewhere.
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
    defaultModel: "gemini-2.0-flash",
    apiStyle: "gemini",
    requiresApiKey: true,
    models: ["gemini-2.0-flash", "gemini-2.5-flash-preview-05-20", "gemini-2.5-pro-preview-05-06"],
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
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_CACHE_ENTRIES = 5000;

// ─── LLM Request Configuration ────────────────────────────────────
export const LLM_TIMEOUT_MS = 10_000; // 10 seconds
export const LLM_MAX_TOKENS = 1024;
export const LLM_TEMPERATURE = 0; // deterministic for consistent pinyin

// ─── Selection Handling ────────────────────────────────────────────
export const MAX_SELECTION_LENGTH = 500;
export const DEBOUNCE_MS = 100;

// ─── LLM System Prompt ────────────────────────────────────────────
// The instruction sent to every LLM provider. Edit this to change
// the output format, detail level, or target translation language.
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
```

#### 1k. Create `src/shared/chinese-detect.ts`

```typescript
import { CHINESE_REGEX } from "./constants";

export function containsChinese(text: string): boolean {
  return CHINESE_REGEX.test(text);
}

export function extractSurroundingContext(selection: Selection): string {
  if (!selection.anchorNode) return "";

  let node: Node | null = selection.anchorNode;
  // Walk up to find the nearest block-level parent
  while (node && node.nodeName !== "P" && node.nodeName !== "DIV"
    && node.nodeName !== "ARTICLE" && node.nodeName !== "SECTION"
    && node.nodeName !== "BODY" && node.parentNode) {
    node = node.parentNode;
  }

  const text = node?.textContent ?? "";
  // Cap at 500 characters to keep LLM context reasonable
  return text.length > 500 ? text.slice(0, 500) : text;
}
```

### Test file: `tests/shared/chinese-detect.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { containsChinese } from "../../src/shared/chinese-detect";

describe("containsChinese", () => {
  it("returns true for pure Chinese text", () => {
    expect(containsChinese("你好世界")).toBe(true);
  });

  it("returns true for mixed Chinese/English text", () => {
    expect(containsChinese("hello你好world")).toBe(true);
  });

  it("returns false for pure English text", () => {
    expect(containsChinese("hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsChinese("")).toBe(false);
  });

  it("returns false for numbers and punctuation only", () => {
    expect(containsChinese("12345!@#")).toBe(false);
  });

  it("returns true for CJK Extension B characters", () => {
    // U+3400-U+4DBF range (CJK Unified Ideographs Extension A)
    expect(containsChinese("\u3400")).toBe(true);
    expect(containsChinese("\u4DBF")).toBe(true);
  });

  it("returns true for a single Chinese character", () => {
    expect(containsChinese("中")).toBe(true);
  });

  it("returns false for Japanese hiragana only", () => {
    expect(containsChinese("ひらがな")).toBe(false);
  });

  it("returns true for Japanese text containing kanji", () => {
    expect(containsChinese("漢字とひらがな")).toBe(true);
  });
});
```

### Test file: `tests/shared/constants.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  CHINESE_REGEX,
  DEFAULT_SETTINGS,
  CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  LLM_TIMEOUT_MS,
  MAX_SELECTION_LENGTH,
  DEBOUNCE_MS,
  PROVIDER_PRESETS,
  SYSTEM_PROMPT,
} from "../../src/shared/constants";

describe("constants", () => {
  it("CHINESE_REGEX matches Chinese characters", () => {
    expect(CHINESE_REGEX.test("你")).toBe(true);
    expect(CHINESE_REGEX.test("a")).toBe(false);
  });

  it("DEFAULT_SETTINGS has correct shape and sensible defaults", () => {
    expect(DEFAULT_SETTINGS.provider).toBe("openai");
    expect(DEFAULT_SETTINGS.apiKey).toBe("");
    expect(DEFAULT_SETTINGS.baseUrl).toBe("https://api.openai.com/v1");
    expect(DEFAULT_SETTINGS.model).toBe("gpt-4o-mini");
    expect(DEFAULT_SETTINGS.pinyinStyle).toBe("toneMarks");
    expect(DEFAULT_SETTINGS.fontSize).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.theme).toBe("auto");
    expect(DEFAULT_SETTINGS.llmEnabled).toBe(true);
  });

  it("CACHE_TTL_MS equals 7 days in milliseconds", () => {
    expect(CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("MAX_CACHE_ENTRIES is a positive number", () => {
    expect(MAX_CACHE_ENTRIES).toBeGreaterThan(0);
  });

  it("LLM_TIMEOUT_MS is 10 seconds", () => {
    expect(LLM_TIMEOUT_MS).toBe(10_000);
  });

  it("MAX_SELECTION_LENGTH is 500", () => {
    expect(MAX_SELECTION_LENGTH).toBe(500);
  });

  it("DEBOUNCE_MS is 100", () => {
    expect(DEBOUNCE_MS).toBe(100);
  });
});

describe("PROVIDER_PRESETS", () => {
  it("defines presets for all four providers", () => {
    expect(PROVIDER_PRESETS).toHaveProperty("openai");
    expect(PROVIDER_PRESETS).toHaveProperty("gemini");
    expect(PROVIDER_PRESETS).toHaveProperty("ollama");
    expect(PROVIDER_PRESETS).toHaveProperty("custom");
  });

  it("each preset has the required fields", () => {
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset).toHaveProperty("baseUrl");
      expect(preset).toHaveProperty("defaultModel");
      expect(preset).toHaveProperty("apiStyle");
      expect(preset).toHaveProperty("requiresApiKey");
      expect(preset).toHaveProperty("models");
      expect(["openai", "gemini"]).toContain(preset.apiStyle);
    }
  });

  it("openai preset uses openai apiStyle", () => {
    expect(PROVIDER_PRESETS.openai.apiStyle).toBe("openai");
    expect(PROVIDER_PRESETS.openai.requiresApiKey).toBe(true);
    expect(PROVIDER_PRESETS.openai.baseUrl).toContain("openai.com");
  });

  it("gemini preset uses gemini apiStyle", () => {
    expect(PROVIDER_PRESETS.gemini.apiStyle).toBe("gemini");
    expect(PROVIDER_PRESETS.gemini.requiresApiKey).toBe(true);
    expect(PROVIDER_PRESETS.gemini.baseUrl).toContain("googleapis.com");
  });

  it("ollama preset uses openai apiStyle and requires no API key", () => {
    expect(PROVIDER_PRESETS.ollama.apiStyle).toBe("openai");
    expect(PROVIDER_PRESETS.ollama.requiresApiKey).toBe(false);
    expect(PROVIDER_PRESETS.ollama.baseUrl).toContain("localhost");
  });

  it("custom preset has empty baseUrl and models", () => {
    expect(PROVIDER_PRESETS.custom.baseUrl).toBe("");
    expect(PROVIDER_PRESETS.custom.models).toEqual([]);
  });

  it("DEFAULT_SETTINGS.baseUrl matches the default provider preset", () => {
    const defaultPreset = PROVIDER_PRESETS[DEFAULT_SETTINGS.provider];
    expect(DEFAULT_SETTINGS.baseUrl).toBe(defaultPreset.baseUrl);
    expect(DEFAULT_SETTINGS.model).toBe(defaultPreset.defaultModel);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(50);
  });

  it("instructs the LLM to return JSON", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("json");
  });

  it("mentions pinyin", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("pinyin");
  });
});
```

### Verification

```bash
npx vitest run tests/shared/
```

All tests should pass. Confirm the project builds without errors:

```bash
npm run build
```

(The build will warn about missing source files for content/background/popup -- that is expected at this stage.)

---

## Step 2: Pinyin Service (Local)

### Scope

Create the pinyin conversion wrapper around `pinyin-pro`. This is a pure utility module with no Chrome API dependencies, making it straightforward to test.

### Files to create

| File | Purpose |
|------|---------|
| `src/background/pinyin-service.ts` | Wraps `pinyin-pro`, converts text to `WordData[]` with configurable style |
| `tests/background/pinyin-service.test.ts` | Unit tests for all conversion modes and edge cases |

### Depends on

- `src/shared/types.ts` (`WordData`, `PinyinStyle`)

### Detailed instructions

#### 2a. Create `src/background/pinyin-service.ts`

This module must:

1. Import `pinyin` and `segment` from `pinyin-pro`.
2. Export a `convertToPinyin(text: string, style: PinyinStyle): WordData[]` function.
3. Use `pinyin-pro`'s segmentation to group characters into words (not character-by-character).
4. Map the `style` parameter:
   - `"toneMarks"` -> `toneType: "symbol"` (default: hàn yǔ)
   - `"toneNumbers"` -> `toneType: "num"` (han4 yu3)
   - `"none"` -> `toneType: "none"` (han yu)
5. Handle mixed Chinese/non-Chinese text: non-Chinese segments should be passed through as `WordData` with their original text as both `chars` and `pinyin` (no annotation).
6. Handle empty string input by returning an empty array.

Key implementation detail -- `pinyin-pro` supports segmentation via its `segment` function or via the `mode` option. Use whichever groups multi-character words correctly (e.g., "银行" as one word, not "银" + "行").

### Test file: `tests/background/pinyin-service.test.ts`

Test cases to implement:

```typescript
import { describe, it, expect } from "vitest";
import { convertToPinyin } from "../../src/background/pinyin-service";

describe("convertToPinyin", () => {
  describe("tone marks mode", () => {
    it("converts simple Chinese text to pinyin with tone marks", () => {
      const result = convertToPinyin("你好", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
      expect(result.some(w => w.chars === "你好" || w.chars === "你")).toBe(true);
      // Pinyin should contain tone marks (diacritics)
      const allPinyin = result.map(w => w.pinyin).join(" ");
      expect(allPinyin).toMatch(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/);
    });

    it("segments multi-character words", () => {
      const result = convertToPinyin("你好世界", "toneMarks");
      // "你好" and "世界" should be grouped as words, not 4 separate characters
      expect(result.length).toBeLessThanOrEqual(4);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("tone numbers mode", () => {
    it("returns pinyin with tone numbers", () => {
      const result = convertToPinyin("你好", "toneNumbers");
      const allPinyin = result.map(w => w.pinyin).join(" ");
      expect(allPinyin).toMatch(/[1-4]/);
    });
  });

  describe("no tones mode", () => {
    it("returns pinyin without any tone indicators", () => {
      const result = convertToPinyin("你好", "none");
      const allPinyin = result.map(w => w.pinyin).join(" ");
      expect(allPinyin).not.toMatch(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/);
      expect(allPinyin).not.toMatch(/[1-4]/);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty string", () => {
      expect(convertToPinyin("", "toneMarks")).toEqual([]);
    });

    it("handles mixed Chinese/English text", () => {
      const result = convertToPinyin("我love你", "toneMarks");
      expect(result.length).toBeGreaterThanOrEqual(3);
      const chars = result.map(w => w.chars);
      expect(chars.join("")).toContain("love");
    });

    it("handles pure English text gracefully", () => {
      const result = convertToPinyin("hello world", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles numbers and punctuation", () => {
      const result = convertToPinyin("你好123", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("every WordData has non-empty chars and pinyin", () => {
      const result = convertToPinyin("银行工作很开心", "toneMarks");
      for (const word of result) {
        expect(word.chars.length).toBeGreaterThan(0);
        expect(word.pinyin.length).toBeGreaterThan(0);
      }
    });

    it("reconstructed chars match the original text", () => {
      const input = "他在银行工作";
      const result = convertToPinyin(input, "toneMarks");
      const reconstructed = result.map(w => w.chars).join("");
      expect(reconstructed).toBe(input);
    });
  });
});
```

### Verification

```bash
npx vitest run tests/background/pinyin-service.test.ts
```

All tests should pass. Particularly important: the "reconstructed chars match the original text" test ensures word segmentation preserves every character.

---

## Step 3: Service Worker + Message Handling

### Scope

Create the background service worker that orchestrates everything: receives messages from the content script, calls the pinyin service for the fast-path response, delegates to the LLM client (stubbed at this step), registers the context menu, and handles the keyboard command.

### Files to create

| File | Purpose |
|------|---------|
| `src/background/service-worker.ts` | Main background script: message listener, context menu, command handler, settings reader |
| `tests/background/service-worker.test.ts` | Tests with mocked Chrome APIs |

### Depends on

- `src/shared/types.ts`
- `src/shared/constants.ts`
- `src/background/pinyin-service.ts` (from Step 2)

### Detailed instructions

#### 3a. Create `src/background/service-worker.ts`

This module must:

1. **Listen for `chrome.runtime.onMessage`**: When a `PINYIN_REQUEST` arrives, immediately call `convertToPinyin()` with the text and the user's configured `pinyinStyle`, and return the result via `sendResponse` as a `PinyinResponseLocal`.

2. **Async LLM path**: After sending the local response, kick off an async function that:
   - Reads settings from `chrome.storage.sync`
   - Checks if LLM is enabled and provider is properly configured (API key set for providers that require one per `PROVIDER_PRESETS[provider].requiresApiKey`, or any provider like Ollama that doesn't need a key)
   - If yes, calls the LLM client (imported from `llm-client.ts` -- stub it as a no-op for now, will be implemented in Step 4)
   - Sends the LLM result back via `chrome.tabs.sendMessage` as `PINYIN_RESPONSE_LLM`

3. **Register context menu on install**: Use `chrome.runtime.onInstalled` to create a `"show-pinyin"` context menu item with `contexts: ["selection"]`.

4. **Handle context menu click**: Listen on `chrome.contextMenus.onClicked` and forward the selected text to the content script via `chrome.tabs.sendMessage` with type `CONTEXT_MENU_TRIGGER`.

5. **Handle keyboard command**: Listen on `chrome.commands.onCommand` for `"show-pinyin"` and send a `COMMAND_TRIGGER` message to the active tab.

6. **Settings helper**: Export a `getSettings()` function that reads from `chrome.storage.sync` and merges with `DEFAULT_SETTINGS`.

Important: The `onMessage` listener must `return true` to keep the message channel open for async `sendResponse`.

### Test file: `tests/background/service-worker.test.ts`

Test cases to implement:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("service-worker", () => {
  describe("message handling", () => {
    it("responds to PINYIN_REQUEST with PINYIN_RESPONSE_LOCAL", async () => {
      // Send a PINYIN_REQUEST message via the chrome mock
      // Verify sendResponse is called with type "PINYIN_RESPONSE_LOCAL"
      // Verify the response contains a non-empty words array
    });

    it("ignores messages with unknown type", () => {
      // Send a message with type "UNKNOWN"
      // Verify sendResponse is not called
    });

    it("returns words with correct pinyin style from settings", async () => {
      // Set pinyinStyle to "toneNumbers" in chrome.storage.sync
      // Send a PINYIN_REQUEST
      // Verify response pinyin contains tone numbers
    });
  });

  describe("context menu", () => {
    it("creates context menu item on install", () => {
      // Trigger chrome.runtime.onInstalled
      // Verify chrome.contextMenus.create was called with id "show-pinyin"
    });

    it("sends CONTEXT_MENU_TRIGGER when context menu is clicked", () => {
      // Simulate chrome.contextMenus.onClicked with selectionText
      // Verify chrome.tabs.sendMessage was called with type "CONTEXT_MENU_TRIGGER"
    });
  });

  describe("keyboard command", () => {
    it("sends COMMAND_TRIGGER on show-pinyin command", () => {
      // Simulate chrome.commands.onCommand with "show-pinyin"
      // Verify chrome.tabs.sendMessage was called with type "COMMAND_TRIGGER"
    });
  });

  describe("getSettings", () => {
    it("returns DEFAULT_SETTINGS when storage is empty", async () => {
      // Verify getSettings() returns DEFAULT_SETTINGS
    });

    it("merges stored settings with defaults", async () => {
      // Set partial settings in chrome.storage.sync
      // Verify getSettings() returns merged result
    });
  });
});
```

### Verification

```bash
npx vitest run tests/background/service-worker.test.ts
```

All tests should pass. The LLM path is stubbed, so only the local pinyin response and Chrome API interactions are tested.

---

## Step 4: LLM Client

### Scope

Build a multi-provider LLM client that adapts to the selected provider's API format. The module uses only the Fetch API (no Chrome-specific APIs), making it testable with standard `fetch` mocking. It supports two API styles: **OpenAI-compatible** (used by OpenAI, Ollama, and most third-party providers) and **Gemini** (Google's distinct REST format).

### Files to create

| File | Purpose |
|------|---------|
| `src/background/llm-client.ts` | Multi-provider LLM wrapper with adapter pattern, retry, timeout |
| `tests/background/llm-client.test.ts` | Tests with mocked `fetch` for each provider |

### Depends on

- `src/shared/types.ts` (`LLMConfig`, `WordData`, `APIStyle`, `LLMProvider`)
- `src/shared/constants.ts` (`LLM_TIMEOUT_MS`, `SYSTEM_PROMPT`, `PROVIDER_PRESETS`)

### Detailed instructions

#### 4a. Create `src/background/llm-client.ts`

This module must export:

1. **`queryLLM(text: string, context: string, config: LLMConfig): Promise<LLMResponse | null>`**:
   - Look up the provider's `apiStyle` from `PROVIDER_PRESETS[config.provider]`.
   - Create an `AbortController` with a timeout of `LLM_TIMEOUT_MS`.
   - Call `buildRequest()` to construct the provider-specific URL and fetch options.
   - On success: call `parseResponse()` to extract the result from the provider-specific response format.
   - Validate the parsed result with `validateLLMResponse()`.
   - On 5xx error: retry once after 1 second.
   - On any error (network, timeout, parse failure): log the error and return `null`.
   - Always clear the timeout in a `finally` block.

2. **`buildRequest(text, context, config, apiStyle)`** (internal):
   - For `apiStyle === "openai"`: POST to `${config.baseUrl}/chat/completions` with `Authorization: Bearer` header (omitted if no API key, e.g., Ollama), `messages` array, `response_format: { type: "json_object" }`.
   - For `apiStyle === "gemini"`: POST to `${config.baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}` with `contents` array and `generationConfig` including `responseMimeType: "application/json"`.
   - Both styles use `SYSTEM_PROMPT` from `constants.ts`.

3. **`parseResponse(data, apiStyle)`** (internal):
   - For `"openai"`: extract `data.choices[0].message.content`, JSON-parse it.
   - For `"gemini"`: extract `data.candidates[0].content.parts[0].text`, JSON-parse it.

4. **`LLMResponse` type** (or export from types.ts): `{ words: Required<WordData>[]; translation: string }`.

5. **`validateLLMResponse(data: unknown): data is LLMResponse`**: Type guard that checks the shape of the parsed JSON -- `words` must be an array, `translation` must be a string.

#### 4b. Wire into service worker

Update `src/background/service-worker.ts` to import and call `queryLLM` in the async LLM path (replacing the stub from Step 3). Derive the `LLMConfig` from `ExtensionSettings`, including the `provider` field. Before calling `queryLLM`, check whether the provider requires an API key (`PROVIDER_PRESETS[settings.provider].requiresApiKey`) -- if it does and no key is set, skip the LLM call.

### Test file: `tests/background/llm-client.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { queryLLM, validateLLMResponse } from "../../src/background/llm-client";
import type { LLMConfig } from "../../src/shared/types";

const openaiConfig: LLMConfig = {
  provider: "openai",
  apiKey: "sk-test-key",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  maxTokens: 1024,
  temperature: 0,
};

const geminiConfig: LLMConfig = {
  provider: "gemini",
  apiKey: "AIza-test-key",
  baseUrl: "https://generativelanguage.googleapis.com",
  model: "gemini-2.0-flash",
  maxTokens: 1024,
  temperature: 0,
};

const ollamaConfig: LLMConfig = {
  provider: "ollama",
  apiKey: "",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5:7b",
  maxTokens: 1024,
  temperature: 0,
};

const sampleLLMData = {
  words: [
    { chars: "你好", pinyin: "nǐ hǎo", definition: "hello" },
  ],
  translation: "Hello",
};

describe("queryLLM", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("OpenAI-compatible provider (OpenAI)", () => {
    it("sends correct request to /chat/completions", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(sampleLLMData) } }] }),
      });

      await queryLLM("你好", "context here", openaiConfig);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = (fetch as any).mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(options.method).toBe("POST");
      expect(options.headers["Authorization"]).toBe("Bearer sk-test-key");

      const body = JSON.parse(options.body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].content).toContain("你好");
    });

    it("returns parsed response on success", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(sampleLLMData) } }] }),
      });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toEqual(sampleLLMData);
    });
  });

  describe("OpenAI-compatible provider (Ollama)", () => {
    it("sends request without Authorization header", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(sampleLLMData) } }] }),
      });

      await queryLLM("你好", "context", ollamaConfig);

      const [url, options] = (fetch as any).mock.calls[0];
      expect(url).toBe("http://localhost:11434/v1/chat/completions");
      expect(options.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("Gemini provider", () => {
    it("sends correct request to Gemini generateContent endpoint", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify(sampleLLMData) }] } }],
        }),
      });

      await queryLLM("你好", "context", geminiConfig);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = (fetch as any).mock.calls[0];
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("gemini-2.0-flash");
      expect(url).toContain("generateContent");
      expect(url).toContain("key=AIza-test-key");
      expect(options.headers["Authorization"]).toBeUndefined();

      const body = JSON.parse(options.body);
      expect(body.contents).toBeDefined();
      expect(body.generationConfig).toBeDefined();
    });

    it("parses Gemini response format correctly", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify(sampleLLMData) }] } }],
        }),
      });
      const result = await queryLLM("你好", "context", geminiConfig);
      expect(result).toEqual(sampleLLMData);
    });
  });

  describe("error handling (all providers)", () => {
    it("returns null on network error", async () => {
      (fetch as any).mockRejectedValue(new Error("Network error"));
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });

    it("returns null on non-ok response (4xx)", async () => {
      (fetch as any).mockResolvedValue({ ok: false, status: 401 });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });

    it("retries once on 5xx error then succeeds", async () => {
      (fetch as any)
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(sampleLLMData) } }] }),
        });

      const result = await queryLLM("你好", "context", openaiConfig);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual(sampleLLMData);
    });

    it("returns null when response has invalid structure", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ invalid: true }) } }] }),
      });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });

    it("returns null when response is not valid JSON", async () => {
      (fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "not json" } }] }),
      });
      const result = await queryLLM("你好", "context", openaiConfig);
      expect(result).toBeNull();
    });
  });
});

describe("validateLLMResponse", () => {
  it("returns true for valid response", () => {
    expect(validateLLMResponse({
      words: [{ chars: "你", pinyin: "nǐ", definition: "you" }],
      translation: "You",
    })).toBe(true);
  });

  it("returns false when words is missing", () => {
    expect(validateLLMResponse({ translation: "Hello" })).toBe(false);
  });

  it("returns false when translation is missing", () => {
    expect(validateLLMResponse({ words: [] })).toBe(false);
  });

  it("returns false when words is not an array", () => {
    expect(validateLLMResponse({ words: "not array", translation: "Hello" })).toBe(false);
  });

  it("returns false for null input", () => {
    expect(validateLLMResponse(null)).toBe(false);
  });
});
```

Note: The `SYSTEM_PROMPT` tests have moved to `tests/shared/constants.test.ts` since the prompt is now defined in `constants.ts`.

### Verification

```bash
npx vitest run tests/background/llm-client.test.ts
```

All tests should pass. The `fetch` mock ensures no real API calls are made.

---

## Step 5: Caching Layer

### Scope

Build the cache module that sits between the service worker and the LLM client. It stores LLM responses in `chrome.storage.local` with TTL-based expiration and size-based eviction.

### Files to create

| File | Purpose |
|------|---------|
| `src/background/cache.ts` | Cache get/set/evict functions using `chrome.storage.local` |
| `tests/background/cache.test.ts` | Tests using `vitest-chrome-mv3` storage mock |

### Depends on

- `src/shared/types.ts`
- `src/shared/constants.ts` (`CACHE_TTL_MS`, `MAX_CACHE_ENTRIES`)

### Detailed instructions

#### 5a. Create `src/background/cache.ts`

Export the following functions:

1. **`hashText(text: string): Promise<string>`**: Uses `crypto.subtle.digest("SHA-256", ...)` to create a hex hash of the input text. This produces the cache key.

2. **`getFromCache(key: string): Promise<LLMResponse | null>`**: Reads from `chrome.storage.local`. If the entry exists and its timestamp is within `CACHE_TTL_MS`, return the data. If expired, remove the entry and return `null`. If not found, return `null`.

3. **`saveToCache(key: string, data: LLMResponse): Promise<void>`**: Writes to `chrome.storage.local` with the structure `{ data, timestamp: Date.now() }`.

4. **`evictExpiredEntries(): Promise<void>`**: Reads all entries from `chrome.storage.local`, removes those older than `CACHE_TTL_MS`, and if the remaining count exceeds `MAX_CACHE_ENTRIES`, removes the oldest entries until the count is within the limit.

5. **`clearCache(): Promise<void>`**: Clears all cache entries (useful for settings/debugging).

#### 5b. Wire into service worker

Update `src/background/service-worker.ts` to:
- Import and call `getFromCache` before calling `queryLLM`.
- Call `saveToCache` after a successful LLM response.
- Call `evictExpiredEntries` on `chrome.runtime.onInstalled`.

### Test file: `tests/background/cache.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashText, getFromCache, saveToCache, evictExpiredEntries, clearCache } from "../../src/background/cache";
import { CACHE_TTL_MS } from "../../src/shared/constants";

describe("cache", () => {
  describe("hashText", () => {
    it("returns a hex string", async () => {
      const hash = await hashText("test input");
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it("returns consistent hash for same input", async () => {
      const hash1 = await hashText("你好");
      const hash2 = await hashText("你好");
      expect(hash1).toBe(hash2);
    });

    it("returns different hashes for different inputs", async () => {
      const hash1 = await hashText("你好");
      const hash2 = await hashText("世界");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("saveToCache / getFromCache", () => {
    it("stores and retrieves data", async () => {
      const data = {
        words: [{ chars: "你", pinyin: "nǐ", definition: "you" }],
        translation: "You",
      };
      await saveToCache("test-key", data);
      const result = await getFromCache("test-key");
      expect(result).toEqual(data);
    });

    it("returns null for non-existent key", async () => {
      const result = await getFromCache("non-existent-key");
      expect(result).toBeNull();
    });

    it("returns null for expired entry", async () => {
      const data = {
        words: [{ chars: "你", pinyin: "nǐ", definition: "you" }],
        translation: "You",
      };
      await saveToCache("expired-key", data);

      // Manually set the timestamp to be older than TTL
      const stored = await chrome.storage.local.get("expired-key");
      stored["expired-key"].timestamp = Date.now() - CACHE_TTL_MS - 1000;
      await chrome.storage.local.set(stored);

      const result = await getFromCache("expired-key");
      expect(result).toBeNull();
    });
  });

  describe("evictExpiredEntries", () => {
    it("removes expired entries", async () => {
      // Save an entry with an old timestamp
      await chrome.storage.local.set({
        "old-entry": {
          data: { words: [], translation: "" },
          timestamp: Date.now() - CACHE_TTL_MS - 1000,
        },
      });
      await chrome.storage.local.set({
        "fresh-entry": {
          data: { words: [], translation: "Fresh" },
          timestamp: Date.now(),
        },
      });

      await evictExpiredEntries();

      const old = await chrome.storage.local.get("old-entry");
      const fresh = await chrome.storage.local.get("fresh-entry");
      expect(old["old-entry"]).toBeUndefined();
      expect(fresh["fresh-entry"]).toBeDefined();
    });
  });

  describe("clearCache", () => {
    it("removes all cache entries", async () => {
      await saveToCache("key1", { words: [], translation: "A" });
      await saveToCache("key2", { words: [], translation: "B" });

      await clearCache();

      expect(await getFromCache("key1")).toBeNull();
      expect(await getFromCache("key2")).toBeNull();
    });
  });
});
```

### Verification

```bash
npx vitest run tests/background/cache.test.ts
```

All tests should pass. The `vitest-chrome-mv3` mock makes `chrome.storage.local` behave like a real in-memory store within each test.

---

## Step 6: Overlay UI Component

### Scope

Build the floating overlay that renders pinyin annotations, translation text, and definition cards. This is a DOM-only module (no Chrome APIs) that creates a Shadow DOM element.

### Files to create

| File | Purpose |
|------|---------|
| `src/content/overlay.ts` | Shadow DOM overlay: create, render, update, position, dismiss |
| `src/content/overlay.css` | Overlay styles (light/dark themes, ruby, animations) |
| `tests/content/overlay.test.ts` | DOM tests using jsdom |

### Depends on

- `src/shared/types.ts` (`WordData`, `Theme`)

### Detailed instructions

#### 6a. Create `src/content/overlay.ts`

Export the following functions:

1. **`createOverlay(): ShadowRoot`**: Creates a `<div id="hg-extension-root">` in the document body, attaches an open Shadow DOM, injects the CSS (from `overlay.css`), and returns the shadow root. If the root already exists, reuses it.

2. **`showOverlay(words: WordData[], rect: DOMRect, theme: Theme): void`**: Clears the shadow root content and renders:
   - A close button (X) in the top-right corner.
   - A `.hg-pinyin-row` div containing `<ruby>` elements for each word.
   - A `.hg-translation` div that initially shows a loading indicator.
   - Positions the overlay near `rect` (below the selection by default, above if insufficient space, never exceeding viewport bounds).

3. **`updateOverlay(words: Required<WordData>[], translation: string): void`**: Updates the overlay with LLM-enhanced data: replaces the ruby elements with clickable words and replaces the loading indicator with the translation text.

4. **`dismissOverlay(): void`**: Removes the overlay from the DOM.

5. **`renderRubyText(words: WordData[]): string`**: Converts `WordData[]` to HTML string with `<ruby>` / `<rt>` tags. Each ruby element has `class="hg-word"` and `data-chars` / `data-definition` attributes.

6. **`calculatePosition(rect: DOMRect, overlayWidth: number, overlayHeight: number): { top: number; left: number }`**: Pure function that computes overlay position given the selection rect and viewport dimensions.

7. Internal word click handler that toggles a `.hg-definition-card` element below the clicked word.

#### 6b. Create `src/content/overlay.css`

Use the full CSS from SPEC.md Section 7 (Step 7.2). Include:
- `:host { all: initial; }` to reset styles within Shadow DOM.
- `.hg-overlay` with fixed positioning, max-width 500px, max-height 400px, rounded corners, shadow, backdrop blur.
- Light (`.hg-light`) and dark (`.hg-dark`) theme classes.
- `ruby`, `rt` styling.
- `.hg-translation`, `.hg-definition-card`, `.hg-close-btn`, `.hg-loading` classes.
- `hg-fade-in` animation.

### Test file: `tests/content/overlay.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createOverlay,
  showOverlay,
  updateOverlay,
  dismissOverlay,
  renderRubyText,
  calculatePosition,
} from "../../src/content/overlay";
import type { WordData } from "../../src/shared/types";

describe("overlay", () => {
  afterEach(() => {
    dismissOverlay();
  });

  describe("createOverlay", () => {
    it("creates a shadow DOM root in the document body", () => {
      const shadowRoot = createOverlay();
      expect(shadowRoot).toBeDefined();
      const host = document.getElementById("hg-extension-root");
      expect(host).not.toBeNull();
      expect(host!.shadowRoot).toBe(shadowRoot);
    });

    it("reuses existing root on second call", () => {
      const root1 = createOverlay();
      const root2 = createOverlay();
      expect(root1).toBe(root2);
    });
  });

  describe("renderRubyText", () => {
    it("renders ruby elements for each word", () => {
      const words: WordData[] = [
        { chars: "你好", pinyin: "nǐ hǎo" },
        { chars: "世界", pinyin: "shì jiè" },
      ];
      const html = renderRubyText(words);
      expect(html).toContain("<ruby");
      expect(html).toContain("<rt>nǐ hǎo</rt>");
      expect(html).toContain("<rt>shì jiè</rt>");
      expect(html).toContain("你好");
      expect(html).toContain("世界");
    });

    it("adds hg-word class and data-chars attribute", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const html = renderRubyText(words);
      expect(html).toContain('class="hg-word"');
      expect(html).toContain('data-chars="好"');
    });

    it("returns empty string for empty array", () => {
      expect(renderRubyText([])).toBe("");
    });
  });

  describe("calculatePosition", () => {
    it("places overlay below the selection by default", () => {
      const rect = { top: 100, left: 200, bottom: 120, right: 400, width: 200, height: 20 } as DOMRect;
      const pos = calculatePosition(rect, 300, 200);
      expect(pos.top).toBeGreaterThan(rect.bottom);
    });

    it("places overlay above the selection when insufficient space below", () => {
      // Simulate selection near the bottom of viewport
      const rect = { top: 700, left: 200, bottom: 720, right: 400, width: 200, height: 20 } as DOMRect;
      const pos = calculatePosition(rect, 300, 200);
      expect(pos.top).toBeLessThan(rect.top);
    });

    it("never returns negative left position", () => {
      const rect = { top: 100, left: 5, bottom: 120, right: 50, width: 45, height: 20 } as DOMRect;
      const pos = calculatePosition(rect, 500, 200);
      expect(pos.left).toBeGreaterThanOrEqual(0);
    });
  });

  describe("showOverlay / dismissOverlay", () => {
    it("renders overlay with pinyin content", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const rect = { top: 100, left: 200, bottom: 120, right: 300, width: 100, height: 20 } as DOMRect;
      showOverlay(words, rect, "light");

      const host = document.getElementById("hg-extension-root");
      expect(host).not.toBeNull();
      const shadow = host!.shadowRoot!;
      expect(shadow.innerHTML).toContain("好");
      expect(shadow.innerHTML).toContain("hǎo");
    });

    it("dismissOverlay removes the overlay from DOM", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const rect = { top: 100, left: 200, bottom: 120, right: 300, width: 100, height: 20 } as DOMRect;
      showOverlay(words, rect, "light");
      dismissOverlay();

      const host = document.getElementById("hg-extension-root");
      expect(host).toBeNull();
    });
  });

  describe("updateOverlay", () => {
    it("replaces loading indicator with translation text", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const rect = { top: 100, left: 200, bottom: 120, right: 300, width: 100, height: 20 } as DOMRect;
      showOverlay(words, rect, "light");

      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good."
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      expect(shadow.innerHTML).toContain("Good.");
      expect(shadow.querySelector(".hg-loading")).toBeNull();
    });
  });
});
```

### Verification

```bash
npx vitest run tests/content/overlay.test.ts
```

All tests should pass. Note: jsdom has limited Shadow DOM support, so some tests may need to query the shadow root directly rather than using `document.querySelector`.

---

## Step 7: Content Script (Selection Wiring)

### Scope

Build the content script that ties everything together on the page: listens for text selection, communicates with the service worker, and manages the overlay lifecycle.

### Files to create

| File | Purpose |
|------|---------|
| `src/content/content.ts` | mouseup listener, selection handling, message dispatch, overlay lifecycle |
| `tests/content/content.test.ts` | DOM + Chrome mock tests |

### Depends on

- `src/shared/types.ts`
- `src/shared/constants.ts` (`DEBOUNCE_MS`, `MAX_SELECTION_LENGTH`)
- `src/shared/chinese-detect.ts` (`containsChinese`, `extractSurroundingContext`)
- `src/content/overlay.ts` (from Step 6)

### Detailed instructions

#### 7a. Create `src/content/content.ts`

This module is the entry point injected into every page. It must:

1. **Debounced mouseup handler** (100ms debounce):
   - Get the current selection via `window.getSelection()`.
   - If selection is collapsed or empty, do nothing.
   - Extract the text via `selection.toString().trim()`.
   - If text is empty or does not contain Chinese characters (`containsChinese()`), do nothing.
   - Truncate text to `MAX_SELECTION_LENGTH` characters if necessary.
   - Get the surrounding context via `extractSurroundingContext()`.
   - Get the selection's bounding rect.
   - Send a `PINYIN_REQUEST` to the service worker via `chrome.runtime.sendMessage`.
   - On receiving the `PinyinResponseLocal`, call `showOverlay()`.

2. **LLM response listener**: Listen for `chrome.runtime.onMessage` in the content script. When a `PINYIN_RESPONSE_LLM` arrives, call `updateOverlay()`. When a `PINYIN_ERROR` arrives with phase `"llm"`, show the error state in the overlay.

3. **Context menu trigger listener**: When a `CONTEXT_MENU_TRIGGER` message arrives, treat the `text` field the same as a mouseup selection -- run it through the same pinyin request flow.

4. **Command trigger listener**: When a `COMMAND_TRIGGER` message arrives, get the current selection (if any) and process it.

5. **Dismiss handlers**:
   - `mousedown` on the document: if the click target is outside the overlay's Shadow DOM host, call `dismissOverlay()`.
   - `keydown` for Escape: call `dismissOverlay()`.

6. **AbortController for in-flight requests**: When a new selection is made before the previous LLM response arrives, abort the previous request cycle by tracking a request ID or abort controller.

7. **Debounce utility**: Implement a simple debounce function (or inline closure) to prevent rapid-fire processing during text highlighting.

### Test file: `tests/content/content.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("content script", () => {
  describe("mouseup handler", () => {
    it("does nothing when selection is collapsed", () => {
      // Mock window.getSelection to return collapsed selection
      // Dispatch mouseup event
      // Verify chrome.runtime.sendMessage was NOT called
    });

    it("does nothing when selected text has no Chinese characters", () => {
      // Mock window.getSelection to return "hello world"
      // Dispatch mouseup event
      // Verify chrome.runtime.sendMessage was NOT called
    });

    it("sends PINYIN_REQUEST when Chinese text is selected", () => {
      // Mock window.getSelection to return "你好世界"
      // Dispatch mouseup event after debounce
      // Verify chrome.runtime.sendMessage was called with type "PINYIN_REQUEST"
    });

    it("truncates text longer than MAX_SELECTION_LENGTH", () => {
      // Mock a very long Chinese text selection (> 500 chars)
      // Verify the sent text is truncated
    });

    it("debounces rapid mouseup events", () => {
      // Dispatch 5 mouseup events rapidly
      // After debounce period, verify sendMessage was called only once
    });
  });

  describe("overlay lifecycle", () => {
    it("shows overlay after receiving local pinyin response", () => {
      // Mock sendMessage to return PinyinResponseLocal
      // Verify showOverlay was called
    });

    it("updates overlay when LLM response arrives", () => {
      // Simulate receiving PINYIN_RESPONSE_LLM via onMessage
      // Verify updateOverlay was called with words and translation
    });

    it("shows error state when LLM error arrives", () => {
      // Simulate receiving PINYIN_ERROR via onMessage
      // Verify overlay shows error message
    });
  });

  describe("dismiss behavior", () => {
    it("dismisses overlay on Escape key", () => {
      // Show overlay, then dispatch keydown with key "Escape"
      // Verify dismissOverlay was called
    });

    it("dismisses overlay on click outside", () => {
      // Show overlay, then dispatch mousedown on document body
      // Verify dismissOverlay was called
    });

    it("does NOT dismiss overlay when clicking inside it", () => {
      // Show overlay, then dispatch mousedown on the overlay host element
      // Verify dismissOverlay was NOT called
    });
  });

  describe("context menu and command triggers", () => {
    it("processes text from CONTEXT_MENU_TRIGGER message", () => {
      // Simulate chrome.runtime.onMessage with CONTEXT_MENU_TRIGGER
      // Verify it processes the text through the pinyin pipeline
    });

    it("processes current selection on COMMAND_TRIGGER message", () => {
      // Set a selection, then simulate COMMAND_TRIGGER
      // Verify it processes the current selection
    });
  });
});
```

### Verification

```bash
npx vitest run tests/content/content.test.ts
```

All tests should pass. Some tests will need to mock `window.getSelection()` to return a fake `Selection` object with the required methods.

---

## Step 8: Popup Settings UI + Polish + Edge Cases

### Scope

Build the settings popup UI, implement all polishing touches (mixed text handling, long selection notices, error states), and write integration-level edge case tests.

### Files to create

| File | Purpose |
|------|---------|
| `src/popup/popup.html` | Settings form HTML |
| `src/popup/popup.ts` | Settings load/save logic |
| `src/popup/popup.css` | Popup styling |
| `tests/popup/popup.test.ts` | Settings UI tests |
| `tests/integration/edge-cases.test.ts` | Cross-cutting edge case tests |

### Depends on

- `src/shared/types.ts` (`ExtensionSettings`, `PinyinStyle`, `Theme`)
- `src/shared/constants.ts` (`DEFAULT_SETTINGS`)

### Detailed instructions

#### 8a. Create `src/popup/popup.html`

Build a settings form with:

- Title: "Pinyin Tool Extension"
- **LLM Provider**: `<select id="provider">` with options: OpenAI, Google Gemini, Ollama (local), Custom. When the user selects a provider, JavaScript auto-fills the Base URL and Model fields from `PROVIDER_PRESETS` in `constants.ts`, and shows/hides the API Key field based on `requiresApiKey`.
- **API Key**: `<input type="password" id="api-key">` with a show/hide toggle button. Hidden when the selected provider is Ollama (since it runs locally without auth).
- **API Base URL**: `<input type="text" id="base-url">` with placeholder auto-filled from the selected provider preset. Editable for overrides.
- **Model**: `<select id="model">` populated from the selected provider's `models` array, plus a "Custom..." option that shows a text input for a custom model name.
- **Pinyin Style**: Three `<input type="radio" name="pinyin-style">` buttons for tone marks, tone numbers, no tones. Show an example next to each (e.g., "hàn yǔ", "han4 yu3", "han yu").
- **Font Size**: `<input type="range" id="font-size" min="12" max="24" step="1">` with a label showing the current value.
- **Theme**: `<select id="theme">` with options: Auto, Light, Dark.
- **LLM Mode**: `<input type="checkbox" id="llm-enabled">` with label "Enable LLM-enhanced translations".
- **Save button**: `<button id="save-btn">Save Settings</button>`.
- **Status message**: `<div id="status">` for showing save success/error feedback.

Link `popup.css` and `popup.ts`.

#### 8b. Create `src/popup/popup.ts`

1. **On DOMContentLoaded**:
   - Import `PROVIDER_PRESETS` and `DEFAULT_SETTINGS` from `constants.ts`.
   - Read settings from `chrome.storage.sync` via the `getSettings()` pattern (merge with `DEFAULT_SETTINGS`).
   - Populate all form fields with current values.
   - Populate the model dropdown from `PROVIDER_PRESETS[settings.provider].models`.

2. **On provider dropdown change**:
   - Look up the new provider's preset from `PROVIDER_PRESETS`.
   - Auto-fill the base URL field with `preset.baseUrl`.
   - Repopulate the model dropdown with `preset.models`, selecting `preset.defaultModel`.
   - Show/hide the API Key field based on `preset.requiresApiKey`.
   - This ensures switching providers is a single-click experience.

3. **On Save button click**:
   - Read all form field values.
   - Validate API key: if the selected provider requires one (`PROVIDER_PRESETS[provider].requiresApiKey`), ensure it's at least 10 characters.
   - Validate base URL: must start with `http://` or `https://`.
   - Build an `ExtensionSettings` object (including the `provider` field).
   - Write to `chrome.storage.sync`.
   - Show success message for 2 seconds, or an error message if validation fails.

4. **Show/hide toggle for API key**: Toggle the input type between `password` and `text`.

5. **Font size slider**: Update the label in real time as the user drags the slider.

#### 8c. Create `src/popup/popup.css`

Style the popup with:
- Fixed width of 320px, clean white background.
- Consistent 12px spacing between form groups.
- Styled inputs, selects, and buttons (border, border-radius, focus states).
- A prominent blue save button.
- Status message styling (green for success, red for error).
- Dark mode support via `@media (prefers-color-scheme: dark)`.

#### 8d. Polish existing modules

Update the following for edge case handling:

1. **`src/background/pinyin-service.ts`**: Ensure mixed Chinese/non-Chinese text (e.g., "我love你") produces correct `WordData[]` where non-Chinese segments have their original text as `pinyin`.

2. **`src/content/content.ts`**: When text exceeds `MAX_SELECTION_LENGTH`:
   - Truncate the text sent in the `PinyinRequest` to 500 characters.
   - After the overlay renders, append a notice: "Showing results for the first 500 characters."

3. **`src/content/overlay.ts`**: Add error state rendering:
   - When the LLM is unavailable and no API key is set: "Set up an API key in extension settings for translations."
   - When the LLM returns an error: "Translation unavailable -- using local pinyin only."
   - These appear in the `.hg-translation` area with the `.hg-loading` class replaced by a muted error message.

4. **`src/content/content.ts`**: Add `AbortController` logic to cancel in-flight LLM requests when a new selection is made.

### Test file: `tests/popup/popup.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDER_PRESETS } from "../../src/shared/constants";

describe("popup settings", () => {
  describe("loading settings", () => {
    it("populates form fields from chrome.storage.sync", async () => {
      // Set settings in chrome.storage.sync
      // Load the popup module
      // Verify form fields have the stored values
    });

    it("uses DEFAULT_SETTINGS when storage is empty", async () => {
      // Load the popup module with empty storage
      // Verify form fields have default values
      // Verify provider dropdown is set to "openai"
    });
  });

  describe("provider switching", () => {
    it("auto-fills base URL when provider changes to Gemini", () => {
      // Change provider dropdown to "gemini"
      // Verify base URL field is updated to Gemini's preset URL
      // Verify model dropdown is repopulated with Gemini models
    });

    it("auto-fills base URL when provider changes to Ollama", () => {
      // Change provider dropdown to "ollama"
      // Verify base URL field is "http://localhost:11434/v1"
      // Verify model dropdown contains Ollama models
    });

    it("hides API key field when provider is Ollama", () => {
      // Change provider to "ollama"
      // Verify API key input is hidden (PROVIDER_PRESETS.ollama.requiresApiKey === false)
    });

    it("shows API key field when provider is OpenAI", () => {
      // Change provider to "openai"
      // Verify API key input is visible
    });

    it("shows empty fields when provider is Custom", () => {
      // Change provider to "custom"
      // Verify base URL is empty and model dropdown shows text input
    });
  });

  describe("saving settings", () => {
    it("writes form values including provider to chrome.storage.sync", async () => {
      // Fill in form fields with provider "gemini"
      // Click save button
      // Verify chrome.storage.sync.set was called with provider: "gemini"
    });

    it("shows success message after save", async () => {
      // Click save button
      // Verify status element shows success message
    });

    it("validates API key when provider requires it", async () => {
      // Set provider to "openai", API key to "abc" (too short)
      // Click save
      // Verify error message is shown
    });

    it("skips API key validation when provider does not require it", async () => {
      // Set provider to "ollama", leave API key empty
      // Click save
      // Verify no error (Ollama doesn't need a key)
    });

    it("validates base URL format", async () => {
      // Set base URL to "not-a-url"
      // Click save
      // Verify error message is shown
    });

    it("accepts valid base URL with http", async () => {
      // Set base URL to "http://localhost:11434/v1"
      // Click save
      // Verify no error
    });
  });

  describe("UI interactions", () => {
    it("toggles API key visibility", () => {
      // Click the show/hide button
      // Verify input type toggles between "password" and "text"
    });

    it("updates font size label when slider changes", () => {
      // Move the range slider
      // Verify the label text updates
    });
  });
});
```

### Test file: `tests/integration/edge-cases.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { containsChinese } from "../../src/shared/chinese-detect";
import { convertToPinyin } from "../../src/background/pinyin-service";
import { MAX_SELECTION_LENGTH } from "../../src/shared/constants";

describe("edge cases", () => {
  describe("mixed text handling", () => {
    it("containsChinese returns true for mixed Chinese/English", () => {
      expect(containsChinese("I love 中国")).toBe(true);
    });

    it("pinyin service handles mixed text without crashing", () => {
      const result = convertToPinyin("Hello你好World世界", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
      const allChars = result.map(w => w.chars).join("");
      expect(allChars).toContain("Hello");
      expect(allChars).toContain("你好");
      expect(allChars).toContain("World");
      expect(allChars).toContain("世界");
    });

    it("pinyin service handles pure punctuation text", () => {
      const result = convertToPinyin("，。！？", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("long selection handling", () => {
    it("MAX_SELECTION_LENGTH is defined and positive", () => {
      expect(MAX_SELECTION_LENGTH).toBeGreaterThan(0);
    });

    it("pinyin service handles text at the max length", () => {
      const longText = "你".repeat(MAX_SELECTION_LENGTH);
      const result = convertToPinyin(longText, "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("pinyin service handles text exceeding max length", () => {
      const longText = "好".repeat(MAX_SELECTION_LENGTH + 100);
      const result = convertToPinyin(longText, "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("special character handling", () => {
    it("handles Chinese text with numbers", () => {
      const result = convertToPinyin("我有3个朋友", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
      const allChars = result.map(w => w.chars).join("");
      expect(allChars).toContain("3");
    });

    it("handles Chinese text with English abbreviations", () => {
      const result = convertToPinyin("我在IBM工作", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles newlines in text", () => {
      const result = convertToPinyin("你好\n世界", "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles whitespace-only input", () => {
      const result = convertToPinyin("   ", "toneMarks");
      // Should not crash; may return whitespace words or empty array
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("all pinyin styles produce valid output for the same input", () => {
    const input = "银行工作";

    it("toneMarks produces output", () => {
      const result = convertToPinyin(input, "toneMarks");
      expect(result.length).toBeGreaterThan(0);
    });

    it("toneNumbers produces output", () => {
      const result = convertToPinyin(input, "toneNumbers");
      expect(result.length).toBeGreaterThan(0);
    });

    it("none produces output", () => {
      const result = convertToPinyin(input, "none");
      expect(result.length).toBeGreaterThan(0);
    });

    it("all styles produce the same number of words", () => {
      const marks = convertToPinyin(input, "toneMarks");
      const numbers = convertToPinyin(input, "toneNumbers");
      const none = convertToPinyin(input, "none");
      expect(marks.length).toBe(numbers.length);
      expect(numbers.length).toBe(none.length);
    });

    it("all styles reconstruct the same original chars", () => {
      const marks = convertToPinyin(input, "toneMarks").map(w => w.chars).join("");
      const numbers = convertToPinyin(input, "toneNumbers").map(w => w.chars).join("");
      const none = convertToPinyin(input, "none").map(w => w.chars).join("");
      expect(marks).toBe(input);
      expect(numbers).toBe(input);
      expect(none).toBe(input);
    });
  });
});
```

### Verification

```bash
npx vitest run tests/popup/popup.test.ts
npx vitest run tests/integration/edge-cases.test.ts
```

All tests should pass. Then run the full suite to confirm no regressions:

```bash
npm test
```

---

## Final Integration Verification

After completing all 8 steps, perform these final checks:

### 1. Full test suite

```bash
npm test
```

All tests across all `tests/` subdirectories should pass.

### 2. Production build

```bash
npm run build
```

The `dist/` folder should be generated without errors.

### 3. Load in Chrome

1. Open `chrome://extensions/` in Google Chrome.
2. Enable "Developer mode" (toggle in top-right).
3. Click "Load unpacked" and select the `dist/` folder.
4. The extension icon should appear in the toolbar.

### 4. Manual smoke test

| Test | Expected |
|------|----------|
| Select Chinese text on https://zh.wikipedia.org | Overlay appears with pinyin |
| Click a word in the overlay | Definition card expands (if LLM is configured) |
| Click outside overlay | Overlay dismisses |
| Press Escape | Overlay dismisses |
| Right-click selected Chinese text -> "Show Pinyin & Translation" | Overlay appears |
| Press Alt+Shift+P with Chinese text selected | Overlay appears |
| Click extension icon | Settings popup opens with provider dropdown |
| Switch provider to Gemini | Base URL and model auto-fill from preset |
| Switch provider to Ollama | API Key field is hidden; base URL shows localhost |
| Enter API key and save | Settings persist across popup close/reopen |
| Select text on a page with complex CSS (e.g., Twitter/X) | Overlay renders correctly (Shadow DOM isolation) |
| Select non-Chinese text | No overlay appears |

### 5. Package for distribution

```bash
cd dist && zip -r ../pinyin-tool-extension.zip . && cd ..
```

The resulting `pinyin-tool-extension.zip` is ready for Chrome Web Store upload. See SPEC.md Section 10 for the full publishing checklist.
