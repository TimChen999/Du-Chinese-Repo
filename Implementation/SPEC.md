# HanziGlow Chrome Extension — Specification

A Chrome extension inspired by Chinese reading apps like Du Chinese that lets users select Chinese text on **any webpage** and instantly see pinyin annotations, word-level definitions, and full sentence translations. Unlike app-based readers (locked to curated readings), HanziGlow operates freely across all browser tabs — news articles, social media, documentation, emails, etc. Complex tasks like word segmentation, polyphonic character disambiguation, and contextual translation are handled by LLM integration.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Core Features](#2-core-features)
3. [Architecture](#3-architecture)
4. [Manifest V3 Configuration](#4-manifest-v3-configuration)
5. [Data Flow](#5-data-flow)
6. [LLM Integration Design](#6-llm-integration-design)
7. [UI/UX Design](#7-uiux-design)
8. [File and Folder Structure](#8-file-and-folder-structure)
9. [Step-by-Step Implementation Guide](#9-step-by-step-implementation-guide)
10. [Chrome Web Store Publishing](#10-chrome-web-store-publishing)

---

## 1. Product Overview

### What It Does

The extension adds a Chinese reading assistant to every webpage. When a user selects Chinese text:

- A floating overlay appears near the selection
- Pinyin is displayed above each character/word using HTML ruby annotations
- Each word is clickable, revealing its definition and contextual meaning
- A full English translation of the selected passage is shown
- An LLM handles the hard parts: word segmentation, polyphonic disambiguation, and natural translation

### How It Differs from App-Based Readers

| Aspect | App-Based Readers (e.g. Du Chinese) | HanziGlow |
|---|---|---|
| Content source | Curated graded readings | Any webpage in the browser |
| Platform | Mobile app (iOS/Android) | Chrome browser extension |
| Pinyin trigger | Tap any word in a lesson | Select text on any page |
| Translation | Pre-written translations | LLM-generated, context-aware |
| Word segmentation | Pre-segmented by editors | Automatic via LLM + pinyin-pro |
| Offline support | Full offline library | Local pinyin (offline), LLM requires internet |

### Target Users

- Chinese language learners browsing Chinese websites
- Heritage speakers who can speak but struggle with reading
- Professionals who encounter Chinese text in their work
- Anyone who wants quick pinyin and translations without leaving their browser tab

---

## 2. Core Features

### 2.1 Selection-Based Pinyin Overlay

The primary interaction. User selects Chinese text on any page and a floating panel appears.

- **Detection**: The content script listens for `mouseup` events and checks whether the selected text contains Chinese characters (Unicode range `\u4e00-\u9fff`, plus extended CJK blocks)
- **Rendering**: Pinyin is displayed above characters using HTML `<ruby>` / `<rt>` tags, which browsers render natively as annotations above base text
- **Word segmentation**: Characters are grouped into words (e.g., `你好世界` becomes `你好 | 世界`) rather than annotated character-by-character. `pinyin-pro` handles basic segmentation; the LLM refines it with contextual awareness

### 2.2 Word-Level Definitions

Clicking any word in the overlay expands a definition card:

- **Dictionary definition**: Part of speech, common meanings
- **Contextual meaning**: LLM-generated explanation of what the word means *in this specific sentence* (critical for words with multiple meanings)
- **Example**: Clicking `行` in `银行` shows "háng — bank (financial institution)" rather than the generic "xíng — to walk / row / OK"

### 2.3 Sentence-Level Translation

Below the pinyin-annotated text, a full English translation of the selected passage is displayed:

- LLM-powered for natural, fluent translation
- Preserves sentence structure and nuance better than word-by-word lookup
- Falls back to a simpler concatenation of word definitions if the LLM is unavailable

### 2.4 Pinyin Display Modes

Users can choose their preferred pinyin format in settings:

| Mode | Example |
|---|---|
| Tone marks (default) | hàn yǔ pīn yīn |
| Tone numbers | han4 yu3 pin1 yin1 |
| No tones | han yu pin yin |

Both Simplified and Traditional Chinese characters are supported.

### 2.5 Settings and Configuration

Accessible via the extension popup (clicking the extension icon):

- **LLM provider**: Dropdown to select between OpenAI, Google Gemini, Ollama (local), or a custom OpenAI-compatible endpoint. Selecting a provider auto-fills the base URL and suggests a default model.
- **API key**: Input field for the selected provider's API key (not required for Ollama since it runs locally)
- **LLM model selection**: Choose between models offered by the selected provider (e.g., `gpt-4o-mini` for OpenAI, `gemini-2.0-flash` for Gemini, `qwen2.5:7b` for Ollama)
- **Pinyin style**: Tone marks, tone numbers, or no tones
- **Font size**: Adjustable overlay text size
- **Theme**: Light, dark, or auto (match system/page)
- **Mode toggle**: Local-only (fast, offline, no API needed) vs. LLM-enhanced (contextual, requires API key or local Ollama)

All configurable constants (cache TTL, timeouts, selection limits, provider presets, etc.) are centralized in a single file -- `src/shared/constants.ts` -- so they can be adjusted in one place without hunting through multiple modules.

### 2.6 Context Menu and Keyboard Shortcut

Alternative triggers beyond text selection:

- **Right-click context menu**: "Show Pinyin & Translation" option appears when text is selected
- **Keyboard shortcut**: Configurable hotkey (default: `Alt+Shift+P`) to process the current selection

---

## 3. Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                    Browser Tab                       │
│                                                      │
│  ┌──────────────┐         ┌──────────────────────┐  │
│  │ Content Script│────────▶│   Overlay UI          │  │
│  │              │         │ (Shadow DOM)           │  │
│  │ - mouseup    │         │ - ruby annotations     │  │
│  │ - selection  │         │ - definition cards     │  │
│  │ - messaging  │         │ - sentence translation │  │
│  └──────┬───────┘         └──────────────────────┘  │
│         │                                            │
└─────────┼────────────────────────────────────────────┘
          │ chrome.runtime.sendMessage
          ▼
┌─────────────────────────────────────────────────────┐
│              Service Worker (Background)              │
│                                                      │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ pinyin-pro    │  │ LLM Client  │  │ Cache Layer│ │
│  │ (local)       │  │ (multi-prov)│  │ (storage)  │ │
│  └──────────────┘  └──────┬──────┘  └────────────┘ │
│                           │                          │
└───────────────────────────┼──────────────────────────┘
                            │ HTTPS (or localhost)
                            ▼
              ┌──────────────────────────┐
              │  LLM Provider (one of):   │
              │  - OpenAI API             │
              │  - Google Gemini API      │
              │  - Ollama (local)         │
              │  - Any OpenAI-compatible  │
              └──────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                    Popup UI                           │
│  - API key input                                     │
│  - Display preferences                               │
│  - Mode toggle                                       │
│  - Reads/writes chrome.storage.sync                  │
└─────────────────────────────────────────────────────┘
```

### Component Breakdown

**Content Script** (`content.ts`)
- Injected into every page via `manifest.json` content_scripts declaration
- Listens for `mouseup` events on the document
- Extracts the selected text via `window.getSelection()`
- Validates that the selection contains Chinese characters
- Sends the selected text + surrounding context to the service worker via `chrome.runtime.sendMessage`
- Receives annotated results and delegates to the overlay component for rendering
- Handles overlay dismissal on click-outside or new selection

**Overlay Component** (`overlay.ts` + `overlay.css`)
- Creates a Shadow DOM container attached to a `<div>` injected into the page
- Shadow DOM provides full style isolation — the overlay's CSS never leaks into or is affected by the host page
- Renders ruby-annotated text: `<ruby>你好<rt>nǐ hǎo</rt></ruby>`
- Positions the overlay near the text selection using the selection's bounding rect
- Manages word click interactions for expanded definition cards
- Displays sentence translation in a section below the annotated text

**Service Worker** (`service-worker.ts`)
- Manifest V3 background script (replaces the old persistent background page)
- Receives messages from the content script
- Orchestrates two parallel processing paths:
  - **Fast path**: Runs `pinyin-pro` locally for immediate pinyin results
  - **LLM path**: Sends text to the configured LLM provider for contextual segmentation, disambiguation, definitions, and translation
- Sends the fast-path result immediately, then updates with the LLM result when it arrives
- Reads user settings from `chrome.storage.sync`
- Manages the response cache in `chrome.storage.local`

**LLM Client** (`llm-client.ts`)
- Provider-agnostic LLM wrapper that adapts requests to the selected provider's API format
- Supports two API styles: **OpenAI-compatible** (used by OpenAI, Ollama, Azure, and most third-party providers) and **Gemini** (Google's distinct REST format)
- Constructs structured prompts with the selected text and surrounding context
- Requests JSON-formatted responses for reliable parsing
- Handles errors, timeouts, and rate limiting gracefully
- Provider-specific details (URL patterns, auth headers, response parsing) are isolated behind a `buildRequest()` / `parseResponse()` adapter pattern

**Pinyin Service** (`pinyin-service.ts`)
- Wrapper around the `pinyin-pro` npm library
- Provides offline pinyin conversion with tone marks, tone numbers, or plain output
- Handles word segmentation at a basic level (pinyin-pro supports this)
- Used as the fast-path and fallback when the LLM is unavailable

**Popup UI** (`popup.html` + `popup.ts` + `popup.css`)
- Small settings panel that opens when clicking the extension icon
- Form fields for API key, model selection, pinyin style, font size, theme
- Persists all settings to `chrome.storage.sync` (synced across Chrome instances)
- Shows connection status (API key valid/invalid)

### Tech Stack

| Technology | Purpose |
|---|---|
| TypeScript | Type-safe source code for all components |
| Vite | Build tool and bundler |
| vite-plugin-web-extension (or @crxjs/vite-plugin) | Vite plugin for Chrome extension builds with Manifest V3 |
| pinyin-pro | Offline Chinese-to-pinyin conversion, word segmentation |
| OpenAI / Gemini / Ollama API | LLM-powered contextual translation, disambiguation (user picks provider) |
| Shadow DOM | Style-isolated overlay rendering |
| chrome.storage | Settings persistence (sync) and LLM cache (local) |

---

## 4. Manifest V3 Configuration

```json
{
  "manifest_version": 3,
  "name": "HanziGlow — Pinyin & Translation Assistant",
  "version": "1.0.0",
  "description": "Select Chinese text on any webpage to see pinyin, definitions, and translations.",
  "permissions": [
    "activeTab",
    "storage",
    "contextMenus"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "src/background/service-worker.ts"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/content.ts"],
      "css": ["src/content/overlay.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": {
      "16": "assets/icons/icon-16.png",
      "48": "assets/icons/icon-48.png",
      "128": "assets/icons/icon-128.png"
    }
  },
  "icons": {
    "16": "assets/icons/icon-16.png",
    "48": "assets/icons/icon-48.png",
    "128": "assets/icons/icon-128.png"
  },
  "commands": {
    "show-pinyin": {
      "suggested_key": {
        "default": "Alt+Shift+P"
      },
      "description": "Show pinyin for selected text"
    }
  },
  "web_accessible_resources": [
    {
      "resources": ["assets/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### Permissions Justification

| Permission | Why It's Needed |
|---|---|
| `activeTab` | Access the current tab's content when the user invokes the extension |
| `storage` | Persist user settings (API key, preferences) and cache LLM responses |
| `contextMenus` | Add "Show Pinyin" to the right-click menu |
| `<all_urls>` (host) | Content script must run on any page the user visits to detect Chinese text selection |

---

## 5. Data Flow

### Selection to Pinyin to Translation

```
User selects "他在银行工作" on a webpage
        │
        ▼
[1] Content Script: mouseup event fires
        │
        ▼
[2] Content Script: getSelection() → "他在银行工作"
    Regex test: /[\u4e00-\u9fff]/ → true (contains Chinese)
    Extract surrounding sentence context for LLM
        │
        ▼
[3] Content Script → Service Worker (chrome.runtime.sendMessage)
    Payload: { text: "他在银行工作", context: "...surrounding paragraph..." }
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
[4a] pinyin-pro (fast, local)       [4b] LLM Provider API (slower, contextual)
     "tā zài yín háng gōng zuò"          Request: structured JSON prompt
        │                                  │
        ▼                                  ▼
[5a] Service Worker → Content Script  [5b] Service Worker → Content Script
     (immediate result)                    (updated result when ready)
        │                                  │
        ▼                                  ▼
[6] Content Script: Render overlay    [7] Content Script: Update overlay
    with basic pinyin                     with contextual pinyin + definitions
                                          + sentence translation
```

### Two-Phase Rendering

The extension uses a two-phase approach to balance speed and quality:

1. **Phase 1 — Instant** (< 50ms): The service worker runs `pinyin-pro` locally and returns basic pinyin immediately. The overlay appears with pinyin annotations right away. No translation or definitions yet.

2. **Phase 2 — Enhanced** (~1-3s): The LLM response arrives with contextual word segmentation, disambiguated pinyin for polyphonic characters, word definitions, and a full sentence translation. The overlay updates in place with the richer data.

If the user is in local-only mode (no API key or toggled off), only Phase 1 runs.

### Message Protocol

Messages between content script and service worker use a typed protocol:

```typescript
type LLMProvider = "openai" | "gemini" | "ollama" | "custom";
type APIStyle = "openai" | "gemini";

// Content Script → Service Worker
interface PinyinRequest {
  type: "PINYIN_REQUEST";
  text: string;
  context: string;       // surrounding paragraph for LLM context
  selectionRect: DOMRect; // position for overlay placement
}

// Service Worker → Content Script (Phase 1)
interface PinyinResponseLocal {
  type: "PINYIN_RESPONSE_LOCAL";
  words: Array<{
    chars: string;
    pinyin: string;
  }>;
}

// Service Worker → Content Script (Phase 2)
interface PinyinResponseLLM {
  type: "PINYIN_RESPONSE_LLM";
  words: Array<{
    chars: string;
    pinyin: string;
    definition: string;
  }>;
  translation: string;
}

// Error
interface PinyinError {
  type: "PINYIN_ERROR";
  error: string;
  phase: "local" | "llm";
}

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}
```

---

## 6. LLM Integration Design

### Prompt Engineering

The LLM receives a structured system prompt and user prompt to return deterministic, parseable JSON:

**System prompt:**

```
You are a Chinese language assistant integrated into a browser extension.
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
}
```

**User prompt:**

```
Chinese text: "他在银行工作"
Surrounding context: "他毕业后在银行工作，每天早上八点上班。"
```

**Expected LLM response:**

```json
{
  "words": [
    { "chars": "他", "pinyin": "tā", "definition": "he; him" },
    { "chars": "在", "pinyin": "zài", "definition": "at; in (indicating location)" },
    { "chars": "银行", "pinyin": "yín háng", "definition": "bank (financial institution)" },
    { "chars": "工作", "pinyin": "gōng zuò", "definition": "to work; job" }
  ],
  "translation": "He works at a bank."
}
```

### Why LLM Disambiguation Matters

Polyphonic characters are one of the hardest problems in Chinese NLP. The same character has different pronunciations and meanings depending on context:

| Character | Context | Correct Reading | Meaning |
|---|---|---|---|
| 行 | 银**行** | háng | bank / row |
| 行 | **行**走 | xíng | to walk |
| 了 | 吃**了** | le | (completed action) |
| 了 | **了**解 | liǎo | to understand |
| 地 | 土**地** | dì | land / earth |
| 地 | 慢慢**地** | de | (adverb marker) |

`pinyin-pro` handles many common cases, but an LLM with sentence context handles edge cases and novel combinations more reliably.

### Multi-Provider Support

The extension supports multiple LLM providers out of the box. Each provider has a preset configuration, and users can also specify a fully custom endpoint.

#### Supported Providers

| Provider | API Style | Base URL | Default Model | Auth | Local? |
|---|---|---|---|---|---|
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` | `gpt-4o-mini` | Bearer token (API key) | No |
| Google Gemini | Gemini REST | `https://generativelanguage.googleapis.com` | `gemini-2.0-flash` | Query param (`?key=`) | No |
| Ollama | OpenAI-compatible | `http://localhost:11434/v1` | `qwen2.5:7b` | None (local) | Yes |
| Custom | OpenAI-compatible | User-specified | User-specified | Bearer token (optional) | Varies |

#### API Styles

There are two API request/response formats the LLM client must handle:

1. **OpenAI-compatible** -- Used by OpenAI, Ollama, Azure OpenAI, Together AI, Groq, and most third-party providers. Sends `POST /chat/completions` with `{ model, messages, temperature, response_format }`. Auth via `Authorization: Bearer <key>` header.

2. **Gemini** -- Used by Google's Generative Language API. Sends `POST /v1beta/models/{model}:generateContent?key=<key>` with `{ contents, generationConfig }`. Different request/response JSON structure.

#### API Configuration

```typescript
type LLMProvider = "openai" | "gemini" | "ollama" | "custom";
type APIStyle = "openai" | "gemini";

interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
  apiStyle: APIStyle;
  requiresApiKey: boolean;
  models: string[];  // suggested models for the dropdown
}

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}
```

#### Provider Presets (defined in `constants.ts`)

```typescript
const PROVIDER_PRESETS: Record<LLMProvider, ProviderPreset> = {
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
```

When the user selects a provider from the popup dropdown, the base URL, model, and other fields auto-populate from the preset. The user can still override any field.

### Fallback Strategy

```
Is LLM mode enabled AND provider properly configured?
(API key set for cloud providers, or Ollama running for local)
  ├── YES → Send request to the selected provider's API
  │         ├── Success → Use LLM result (Phase 2)
  │         └── Failure (timeout, rate limit, error)
  │                     → Log error, keep Phase 1 result
  │                     → Show subtle error indicator in overlay
  └── NO  → Use pinyin-pro only (Phase 1 only)
```

### Caching

LLM responses are cached in `chrome.storage.local` to avoid redundant API calls:

- **Cache key**: SHA-256 hash of the selected text + context
- **Cache TTL**: 7 days (configurable)
- **Cache size limit**: 5 MB (approximately 5,000 cached lookups)
- Before calling the LLM, the service worker checks the cache first

---

## 7. UI/UX Design

### Overlay Panel

The overlay is the primary UI element. It is a floating panel that appears near the user's text selection.

**Visual design:**
- Rounded corners (8px border-radius)
- Subtle drop shadow for depth
- Semi-transparent background with backdrop blur
- Max width of 500px, scrollable if content exceeds max height (400px)
- Close button (X) in the top-right corner
- Smooth fade-in animation (150ms)

**Layout:**
```
┌──────────────────────────────────────────────┐
│                                          [X] │
│  ┌────────────────────────────────────────┐  │
│  │    tā      zài    yín háng   gōng zuò │  │  ← pinyin (smaller, muted color)
│  │    他       在      银行       工作     │  │  ← characters (larger, bold)
│  └────────────────────────────────────────┘  │
│                                              │
│  He works at a bank.                         │  ← sentence translation
│                                              │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│  [Expanded definition card when word clicked]│
│  银行 (yín háng)                             │
│  noun — bank; financial institution          │
│                                              │
└──────────────────────────────────────────────┘
```

**Ruby annotation HTML structure:**

```html
<div class="hg-pinyin-row">
  <ruby>他<rt>tā</rt></ruby>
  <ruby>在<rt>zài</rt></ruby>
  <ruby>银行<rt>yín háng</rt></ruby>
  <ruby>工作<rt>gōng zuò</rt></ruby>
</div>
<div class="hg-translation">
  He works at a bank.
</div>
```

### Overlay Positioning

The overlay is positioned relative to the text selection's bounding rectangle:

- Default: Below the selection, horizontally centered on it
- If insufficient space below: Above the selection
- If near the right edge: Aligned to the right
- If near the left edge: Aligned to the left
- The overlay never extends beyond the viewport

### Interaction Patterns

| Action | Result |
|---|---|
| Select Chinese text | Overlay appears with pinyin (instant) then definitions + translation (when LLM responds) |
| Click a word in the overlay | Expanded definition card appears below the word |
| Click outside the overlay | Overlay dismisses |
| Press Escape | Overlay dismisses |
| Select new text | Previous overlay dismisses, new one appears |
| Right-click selected text → "Show Pinyin" | Same as selection trigger |
| Alt+Shift+P with text selected | Same as selection trigger |

### Loading States

- **Phase 1 loaded**: Pinyin shown, translation area shows a subtle loading indicator (pulsing dots)
- **Phase 2 loaded**: Loading indicator replaced with translation; definitions become available on word click
- **LLM error**: Translation area shows "Translation unavailable — using local pinyin only" with a muted style
- **No Chinese detected**: No overlay appears (no error shown — silent no-op)

### Themes

| Theme | Overlay Background | Text Color | Pinyin Color |
|---|---|---|---|
| Light | `#ffffff` at 95% opacity | `#1a1a1a` | `#6b7280` |
| Dark | `#1f2937` at 95% opacity | `#f3f4f6` | `#9ca3af` |
| Auto | Matches `prefers-color-scheme` | — | — |

### Popup (Settings Panel)

The popup opens when clicking the extension icon in the toolbar.

**Layout:**
```
┌─────────────────────────────────┐
│  HanziGlow Extension            │
│  ─────────────────────────────  │
│                                 │
│  LLM Provider                   │
│  ┌─────────────────────────┐    │
│  │ OpenAI             ▼   │    │
│  └─────────────────────────┘    │
│  (OpenAI, Gemini, Ollama,       │
│   Custom)                       │
│                                 │
│  API Key                        │
│  ┌─────────────────────────┐    │
│  │ sk-...                  │    │
│  └─────────────────────────┘    │
│                                 │
│  API Base URL                   │
│  ┌─────────────────────────┐    │
│  │ https://api.openai...   │    │
│  └─────────────────────────┘    │
│  (auto-filled from provider)    │
│                                 │
│  Model                          │
│  ┌─────────────────────────┐    │
│  │ gpt-4o-mini         ▼  │    │
│  └─────────────────────────┘    │
│                                 │
│  Pinyin Style                   │
│  (●) Tone marks  hàn yǔ        │
│  ( ) Tone numbers  han4 yu3    │
│  ( ) No tones  han yu           │
│                                 │
│  Font Size                      │
│  ◄━━━━━━━●━━━━━━►  16px        │
│                                 │
│  Theme                          │
│  ┌─────────────────────────┐    │
│  │ Auto (system)       ▼  │    │
│  └─────────────────────────┘    │
│                                 │
│  [✓] Enable LLM mode           │
│                                 │
│  ┌─────────────────────────┐    │
│  │      Save Settings      │    │
│  └─────────────────────────┘    │
│                                 │
└─────────────────────────────────┘
```

When the user selects a provider from the dropdown, the API Key, Base URL, and Model fields auto-populate from the provider preset defined in `constants.ts`. The user can still override any field. For Ollama, the API Key field is hidden since no key is needed.

---

## 8. File and Folder Structure

```
hanziglow-extension/
├── manifest.json                    # Chrome extension manifest (Manifest V3)
├── package.json                     # npm dependencies and scripts
├── tsconfig.json                    # TypeScript configuration
├── vite.config.ts                   # Vite build config with extension plugin
├── src/
│   ├── content/
│   │   ├── content.ts               # Selection detection, message passing, overlay lifecycle
│   │   ├── overlay.ts               # Shadow DOM overlay component (create, update, dismiss)
│   │   └── overlay.css              # Overlay styles (injected into Shadow DOM)
│   ├── background/
│   │   ├── service-worker.ts        # Message handler, orchestrates pinyin + LLM
│   │   ├── llm-client.ts            # Multi-provider LLM wrapper (OpenAI, Gemini, Ollama adapters)
│   │   └── pinyin-service.ts        # pinyin-pro wrapper, format conversion, basic segmentation
│   ├── popup/
│   │   ├── popup.html               # Settings panel markup
│   │   ├── popup.ts                 # Settings form logic, chrome.storage read/write
│   │   └── popup.css                # Popup styles
│   └── shared/
│       ├── types.ts                 # Shared TypeScript interfaces (messages, settings, word data)
│       ├── constants.ts             # ALL configurable values in one place: provider presets, defaults, cache TTL, regex, timeouts
│       └── chinese-detect.ts        # Chinese character detection regex utilities
├── assets/
│   └── icons/
│       ├── icon-16.png              # Toolbar icon (16x16)
│       ├── icon-48.png              # Extensions page icon (48x48)
│       └── icon-128.png             # Chrome Web Store icon (128x128)
└── README.md
```

### File Responsibilities

| File | Responsibility |
|---|---|
| `content.ts` | Entry point injected into web pages. Attaches `mouseup` listener, extracts selections, manages overlay lifecycle (create/update/destroy), relays messages to/from the service worker. |
| `overlay.ts` | Exports functions to create the Shadow DOM container, render ruby-annotated HTML, display translation text, show/hide definition cards, and position the overlay relative to the selection rect. |
| `overlay.css` | All styles for the overlay panel, ruby text, definition cards, loading states, and theme variants. Scoped inside Shadow DOM so they never conflict with host page styles. |
| `service-worker.ts` | Listens for `chrome.runtime.onMessage`. On receiving a `PINYIN_REQUEST`: (1) immediately returns local pinyin via pinyin-service, (2) checks cache, (3) calls LLM if cache miss, (4) caches result, (5) sends `PINYIN_RESPONSE_LLM` back via `chrome.tabs.sendMessage`. Also registers the context menu item and handles the keyboard shortcut command. |
| `llm-client.ts` | Exports an async `queryLLM` function that adapts to the selected provider's API format (OpenAI-compatible or Gemini). Uses the Fetch API. Handles JSON parsing, validation, retries (1 retry on 5xx), and timeout. Provider-specific request building and response parsing are isolated into internal `buildRequest()` and `parseResponse()` helpers. |
| `pinyin-service.ts` | Wraps `pinyin-pro`'s `pinyin()` function. Exports conversion functions that accept a pinyin style parameter (tone marks, tone numbers, none) and return an array of `{ chars, pinyin }` objects. |
| `popup.html/ts/css` | Settings UI. On load, reads current settings from `chrome.storage.sync` and populates the form. On save, validates the API key format and writes settings back. |
| `types.ts` | TypeScript interfaces and type aliases shared across all components: `PinyinRequest`, `PinyinResponseLocal`, `PinyinResponseLLM`, `PinyinError`, `ExtensionSettings`, `WordData`, `LLMConfig`, `LLMProvider`, `APIStyle`, `ProviderPreset`. |
| `constants.ts` | **The single source of truth for all configurable values.** Contains: `PROVIDER_PRESETS` (base URLs, default models, API styles for each provider), `DEFAULT_SETTINGS`, `CACHE_TTL_MS`, `MAX_CACHE_ENTRIES`, `LLM_TIMEOUT_MS`, `MAX_SELECTION_LENGTH`, `DEBOUNCE_MS`, `CHINESE_REGEX`, and `SYSTEM_PROMPT`. Every tunable value in the extension lives here. |
| `chinese-detect.ts` | Utility functions: `containsChinese(text: string): boolean`, `extractSurroundingContext(selection: Selection): string` (grabs the parent paragraph or nearby text for LLM context). |

---

## 9. Step-by-Step Implementation Guide

### Phase 1: Project Setup

#### Step 1.1 — Initialize the Project

```bash
mkdir hanziglow-extension
cd hanziglow-extension
npm init -y
```

#### Step 1.2 — Install Dependencies

```bash
# Build tools
npm install -D typescript vite vite-plugin-web-extension

# Pinyin library
npm install pinyin-pro

# Type definitions for Chrome extension APIs
npm install -D @types/chrome
```

#### Step 1.3 — Configure TypeScript

Create `tsconfig.json`:

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
    "rootDir": "src",
    "types": ["chrome"]
  },
  "include": ["src/**/*.ts"]
}
```

#### Step 1.4 — Configure Vite

Create `vite.config.ts`:

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

#### Step 1.5 — Add npm Scripts

In `package.json`, add:

```json
{
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

---

### Phase 2: Manifest and Core Infrastructure

#### Step 2.1 — Create manifest.json

Write the manifest as specified in [Section 4](#4-manifest-v3-configuration). The Vite plugin will process the paths during build.

#### Step 2.2 — Create Shared Types (`src/shared/types.ts`)

Define all TypeScript interfaces for message passing, settings, and data structures. This file is imported by both the content script and service worker builds.

Key types to define:
- `PinyinRequest`, `PinyinResponseLocal`, `PinyinResponseLLM`, `PinyinError` (message protocol)
- `WordData` — `{ chars: string; pinyin: string; definition?: string }`
- `ExtensionSettings` — all user-configurable options (includes `provider` field)
- `LLMConfig` — provider, API key, base URL, model, temperature
- `LLMProvider` — `"openai" | "gemini" | "ollama" | "custom"`
- `APIStyle` — `"openai" | "gemini"`
- `ProviderPreset` — `{ baseUrl, defaultModel, apiStyle, requiresApiKey, models }`
- `PinyinStyle` — `"toneMarks" | "toneNumbers" | "none"`

#### Step 2.3 — Create Constants (`src/shared/constants.ts`)

This is the **single file where all configurable values live**. Any value that might need tuning is defined here, never scattered across modules.

Define:
- `PROVIDER_PRESETS: Record<LLMProvider, ProviderPreset>` — base URLs, default models, API styles, and suggested model lists for OpenAI, Gemini, Ollama, and custom
- `DEFAULT_SETTINGS: ExtensionSettings` with sensible defaults (provider: `"openai"`, model: `"gpt-4o-mini"`, etc.)
- `CHINESE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/`
- `CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000` (7 days)
- `MAX_CACHE_ENTRIES = 5000`
- `LLM_TIMEOUT_MS = 10_000` (10 seconds)
- `MAX_SELECTION_LENGTH = 500`
- `DEBOUNCE_MS = 100`
- `SYSTEM_PROMPT` — the full LLM system prompt (moved here so it's tunable in one place)

#### Step 2.4 — Create Chinese Detection Utility (`src/shared/chinese-detect.ts`)

Implement:
- `containsChinese(text: string): boolean` — returns true if the string contains at least one Chinese character
- `extractSurroundingContext(selection: Selection): string` — walks up the DOM from the selection's anchor node to find the containing paragraph or block element, returns its text content (capped at ~500 chars)

---

### Phase 3: Content Script and Selection Detection

#### Step 3.1 — Create Content Script (`src/content/content.ts`)

Implement the `mouseup` event listener:

```typescript
document.addEventListener("mouseup", async (event) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text || !containsChinese(text)) return;

  const context = extractSurroundingContext(selection);
  const rect = selection.getRangeAt(0).getBoundingClientRect();

  // Send to service worker
  const localResponse = await chrome.runtime.sendMessage({
    type: "PINYIN_REQUEST",
    text,
    context,
    selectionRect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height },
  });

  // Show overlay with local pinyin immediately
  showOverlay(localResponse.words, rect);
});
```

Also add:
- `mousedown` listener to dismiss the overlay (unless click is inside the overlay)
- `keydown` listener for Escape to dismiss
- Listener for `chrome.runtime.onMessage` to receive the Phase 2 LLM response and update the overlay

#### Step 3.2 — Register keyboard shortcut handler

Listen for the `chrome.commands.onCommand` event in the service worker, and for the content script, use a message-based approach to trigger the same flow as `mouseup`.

---

### Phase 4: Pinyin Service (Local)

#### Step 4.1 — Create Pinyin Service (`src/background/pinyin-service.ts`)

```typescript
import { pinyin } from "pinyin-pro";

export function convertToPinyin(text: string, style: PinyinStyle): WordData[] {
  const result = pinyin(text, {
    type: "array",
    toneType: style === "toneNumbers" ? "num" : style === "none" ? "none" : "symbol",
    mode: "normal",
  });

  // pinyin-pro returns pinyin per character; group multi-char words
  // Use pinyin-pro's segment option for word-level grouping
  const segmented = pinyin(text, {
    type: "array",
    toneType: style === "toneNumbers" ? "num" : style === "none" ? "none" : "symbol",
    mode: "normal",
  });

  // Build WordData array
  return segmented.map((py, i) => ({
    chars: text[i],  // simplified; actual implementation groups multi-char words
    pinyin: py,
  }));
}
```

The actual implementation will use `pinyin-pro`'s segmentation features to group characters into words properly.

---

### Phase 5: Service Worker

#### Step 5.1 — Create Service Worker (`src/background/service-worker.ts`)

```typescript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PINYIN_REQUEST") {
    handlePinyinRequest(message, sender.tab?.id);
    // Return local result synchronously
    const settings = await getSettings();
    const localWords = convertToPinyin(message.text, settings.pinyinStyle);
    sendResponse({ type: "PINYIN_RESPONSE_LOCAL", words: localWords });
    return true; // keep message channel open for async
  }
});

async function handlePinyinRequest(request: PinyinRequest, tabId?: number) {
  const settings = await getSettings();
  const preset = PROVIDER_PRESETS[settings.provider];
  const needsKey = preset.requiresApiKey && !settings.apiKey;
  if (!settings.llmEnabled || needsKey) return;

  // Check cache
  const cacheKey = await hashText(request.text + request.context);
  const cached = await getFromCache(cacheKey);
  if (cached) {
    chrome.tabs.sendMessage(tabId!, { type: "PINYIN_RESPONSE_LLM", ...cached });
    return;
  }

  // Call LLM
  const llmResult = await queryLLM(request.text, request.context, settings);
  if (llmResult) {
    await saveToCache(cacheKey, llmResult);
    chrome.tabs.sendMessage(tabId!, { type: "PINYIN_RESPONSE_LLM", ...llmResult });
  }
}
```

#### Step 5.2 — Register Context Menu

```typescript
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "show-pinyin",
    title: "Show Pinyin & Translation",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "show-pinyin" && info.selectionText) {
    chrome.tabs.sendMessage(tab!.id!, {
      type: "CONTEXT_MENU_TRIGGER",
      text: info.selectionText,
    });
  }
});
```

---

### Phase 6: LLM Client

#### Step 6.1 — Create LLM Client (`src/background/llm-client.ts`)

The LLM client adapts to the selected provider's API format. It uses an internal adapter pattern with `buildRequest()` and `parseResponse()` helpers that switch on the provider's `apiStyle` (from `PROVIDER_PRESETS`).

```typescript
import { PROVIDER_PRESETS, SYSTEM_PROMPT, LLM_TIMEOUT_MS } from "../shared/constants";

export async function queryLLM(
  text: string,
  context: string,
  config: LLMConfig
): Promise<LLMResponse | null> {
  const preset = PROVIDER_PRESETS[config.provider];
  const apiStyle = preset.apiStyle;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const { url, init } = buildRequest(text, context, config, apiStyle);
    const response = await fetch(url, { ...init, signal: controller.signal });

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    const parsed = parseResponse(data, apiStyle);

    if (!validateLLMResponse(parsed)) {
      throw new Error("Invalid LLM response structure");
    }

    return parsed;
  } catch (error) {
    console.error("[HanziGlow] LLM error:", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Adapter: build the fetch request per API style ---

function buildRequest(text: string, context: string, config: LLMConfig, apiStyle: APIStyle) {
  const userContent = `Chinese text: "${text}"\nSurrounding context: "${context}"`;

  if (apiStyle === "gemini") {
    return {
      url: `${config.baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n" + userContent }] }],
          generationConfig: { temperature: config.temperature, responseMimeType: "application/json" },
        }),
      },
    };
  }

  // OpenAI-compatible (OpenAI, Ollama, custom)
  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    },
  };
}

// --- Adapter: parse the response per API style ---

function parseResponse(data: any, apiStyle: APIStyle): unknown {
  if (apiStyle === "gemini") {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? JSON.parse(text) : null;
  }

  // OpenAI-compatible
  const content = data.choices?.[0]?.message?.content;
  return content ? JSON.parse(content) : null;
}
```

This design means adding a new provider in the future only requires adding a preset to `PROVIDER_PRESETS` in `constants.ts`. If the new provider uses the OpenAI-compatible format (most do), no code changes to `llm-client.ts` are needed at all.

---

### Phase 7: Overlay UI

#### Step 7.1 — Create Overlay Component (`src/content/overlay.ts`)

Key implementation details:

1. **Create Shadow DOM container**: Inject a `<div id="hg-extension-root">` into the page body. Attach a Shadow DOM to it. All overlay content lives inside the shadow root.

2. **Render ruby annotations**: Convert the `WordData[]` array into `<ruby>` elements:

```typescript
function renderRubyText(words: WordData[]): string {
  return words.map(w =>
    `<ruby class="hg-word" data-chars="${w.chars}">${w.chars}<rt>${w.pinyin}</rt></ruby>`
  ).join("");
}
```

3. **Position the overlay**: Use the selection's `DOMRect` to place the overlay below (or above) the selected text. Account for scroll position (`window.scrollX`, `window.scrollY`).

4. **Word click handler**: Attach click listeners to `.hg-word` elements. On click, show an expanded definition card with the word's definition (from the LLM response).

5. **Dismiss logic**: Click outside the shadow root or press Escape to remove the overlay.

#### Step 7.2 — Style the Overlay (`src/content/overlay.css`)

The CSS lives inside the Shadow DOM, so it's fully isolated. Key styles:

```css
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.hg-overlay {
  position: fixed;
  z-index: 2147483647;
  max-width: 500px;
  max-height: 400px;
  overflow-y: auto;
  padding: 16px;
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  animation: hg-fade-in 150ms ease-out;
}

/* Light theme */
.hg-overlay.hg-light {
  background: rgba(255, 255, 255, 0.95);
  color: #1a1a1a;
  backdrop-filter: blur(8px);
}

/* Dark theme */
.hg-overlay.hg-dark {
  background: rgba(31, 41, 55, 0.95);
  color: #f3f4f6;
  backdrop-filter: blur(8px);
}

.hg-pinyin-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}

ruby {
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 18px;
  transition: background-color 150ms;
}

ruby:hover {
  background: rgba(59, 130, 246, 0.1);
}

rt {
  font-size: 12px;
  color: #6b7280;
  font-weight: normal;
}

.hg-translation {
  padding-top: 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
  font-size: 14px;
  line-height: 1.5;
  color: #374151;
}

.hg-definition-card {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.05);
  border-left: 3px solid #3b82f6;
  font-size: 14px;
}

.hg-close-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  color: #9ca3af;
  padding: 4px;
  border-radius: 4px;
}

.hg-close-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #374151;
}

.hg-loading {
  color: #9ca3af;
  font-style: italic;
}

@keyframes hg-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

---

### Phase 8: Settings Popup

#### Step 8.1 — Create Popup HTML (`src/popup/popup.html`)

Build a settings form with fields for:
- LLM Provider (dropdown: OpenAI, Gemini, Ollama, Custom) -- selecting a provider auto-fills base URL and model from `PROVIDER_PRESETS`
- API key (password input with show/hide toggle; hidden when provider is Ollama)
- API Base URL (text input, auto-filled from provider preset, editable for overrides)
- Model selection (dropdown populated from the selected provider's `models` list, plus a "custom" option with text input)
- Pinyin style (radio buttons)
- Font size (range slider)
- Theme (dropdown: Light, Dark, Auto)
- LLM mode toggle (checkbox)
- Save button

#### Step 8.2 — Create Popup Logic (`src/popup/popup.ts`)

On popup open:
1. Read current settings from `chrome.storage.sync`
2. Populate all form fields with current values

On save:
1. Read all form values
2. Validate API key: if the selected provider requires one (`requiresApiKey` from preset), ensure it's at least 10 characters (don't enforce `sk-` prefix since Gemini keys use a different format)
3. Validate base URL: must start with `http://` or `https://`
4. Write to `chrome.storage.sync`
5. Show success/error feedback

#### Step 8.3 — Style the Popup (`src/popup/popup.css`)

Style the popup with a clean, modern look. Fixed width of 320px. Use consistent spacing, appropriate input sizing, and a prominent save button.

---

### Phase 9: Caching Layer

#### Step 9.1 — Implement Cache in Service Worker

Add caching functions to the service worker:

```typescript
async function hashText(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getFromCache(key: string): Promise<LLMResponse | null> {
  const result = await chrome.storage.local.get(key);
  if (!result[key]) return null;

  const { data, timestamp } = result[key];
  if (Date.now() - timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return data;
}

async function saveToCache(key: string, data: LLMResponse): Promise<void> {
  await chrome.storage.local.set({
    [key]: { data, timestamp: Date.now() },
  });
}
```

#### Step 9.2 — Cache Eviction

Periodically (on extension install and every 24 hours via `chrome.alarms`), run a cleanup that removes entries older than the TTL and trims the cache to `MAX_CACHE_ENTRIES` by removing the oldest entries first.

---

### Phase 10: Polish and Edge Cases

#### Step 10.1 — Mixed Text Handling

When the selection contains both Chinese and non-Chinese text (e.g., "我love你"), preserve non-Chinese segments as-is in the overlay without pinyin annotations.

#### Step 10.2 — Long Selection Handling

If the selected text exceeds 500 characters:
- Truncate the LLM request to the first 500 characters
- Show a notice in the overlay: "Showing results for the first 500 characters"
- Local pinyin still processes the full text

#### Step 10.3 — Error States

- **No API key configured**: Overlay shows pinyin only with a subtle note "Set up an API key for translations"
- **API key invalid / rate limited**: Overlay shows pinyin with "Translation unavailable"
- **Network error**: Same as above, with "Check your internet connection"
- **Malformed LLM response**: Fall back to local pinyin, log the error

#### Step 10.4 — Performance

- Debounce `mouseup` handler (100ms) to avoid processing during click-drag
- Cancel in-flight LLM requests if user makes a new selection before the previous one completes
- Limit overlay rendering to one instance at a time

---

### Phase 11: Testing

#### Step 11.1 — Load the Extension Locally

1. Run `npm run build` to generate the `dist/` folder
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked" and select the `dist/` folder
5. The extension icon should appear in the toolbar

#### Step 11.2 — Test Scenarios

| Scenario | Expected Result |
|---|---|
| Select Chinese text on a Chinese news site | Overlay appears with pinyin + translation |
| Select mixed Chinese/English text | Chinese parts annotated, English parts preserved |
| Select text with polyphonic characters (e.g., 银行 vs 行走) | Correct pinyin for each context |
| Click a word in the overlay | Definition card expands |
| Click outside the overlay | Overlay dismisses |
| Press Escape | Overlay dismisses |
| Right-click selected text → "Show Pinyin" | Overlay appears |
| Use Alt+Shift+P shortcut | Overlay appears |
| No API key set | Pinyin appears, translation shows setup prompt |
| Invalid API key | Pinyin appears, translation shows error |
| Very long selection (> 500 chars) | Truncation notice shown |
| Select non-Chinese text | No overlay appears |
| Select on a page with complex CSS | Overlay renders correctly (Shadow DOM isolation) |

#### Step 11.3 — Recommended Test Sites

- https://www.bbc.com/zhongwen/simp (BBC Chinese)
- https://cn.nytimes.com (NYT Chinese)
- https://zh.wikipedia.org (Chinese Wikipedia)
- https://weibo.com (Weibo — tests complex dynamic content)
- https://www.zhihu.com (Zhihu — mixed Chinese/English)

---

### Phase 12: Packaging and Publishing

#### Step 12.1 — Production Build

```bash
npm run build
```

This generates a production-optimized `dist/` folder.

#### Step 12.2 — Create Extension Package

```bash
cd dist
zip -r ../hanziglow-extension.zip .
```

#### Step 12.3 — Chrome Web Store Developer Account

1. Go to https://chrome.google.com/webstore/devconsole
2. Pay the one-time $5 registration fee
3. Complete developer identity verification

#### Step 12.4 — Prepare Store Listing

Prepare the following assets:
- **Extension name**: "HanziGlow — Pinyin & Translation Assistant"
- **Short description** (132 chars max): "Select Chinese text on any webpage to instantly see pinyin, definitions, and translations powered by AI."
- **Detailed description**: Feature overview, usage instructions, privacy note about API keys
- **Screenshots**: At least 1280x800 screenshots showing the overlay in action
- **Icons**: 128x128 store icon
- **Category**: Education
- **Language**: English

#### Step 12.5 — Submit for Review

1. Upload the `.zip` file in the developer dashboard
2. Fill in the store listing details
3. In the Privacy tab:
   - Declare that no user data is collected by the extension itself
   - Note that selected text is sent to the user's own configured LLM API
   - The extension does not use remote code
4. Set distribution to Public
5. Submit for review (typically 1-3 business days)

---

## 10. Chrome Web Store Publishing

### Checklist

- [ ] Production build passes with no errors
- [ ] Extension loads correctly via "Load unpacked"
- [ ] All features tested manually
- [ ] Icons created at 16px, 48px, 128px
- [ ] Store listing description written
- [ ] At least 2 screenshots captured (1280x800)
- [ ] Privacy practices declared
- [ ] Developer account registered ($5 fee paid)
- [ ] ZIP file uploaded and submitted for review
