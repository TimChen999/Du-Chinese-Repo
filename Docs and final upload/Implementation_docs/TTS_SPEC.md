# Text-to-Speech Pronunciation — Feature Specification

Adds a speaker button to the pinyin overlay so users can hear the full selected Chinese text read aloud with natural pronunciation. The button sits at the end of the pinyin row and reads the entire selection as a sentence, preserving natural speech rhythm, tone sandhi, and prosody. The feature is gated by a `ttsEnabled` setting in the popup.

This feature builds on the overlay rendering described in [SPEC.md](SPEC.md) Section 7 and [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) Step 6. It requires no new message types, no new dependencies, and no new manifest permissions — all speech synthesis runs in the content script's page context, where `window.speechSynthesis` is available.

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Trigger Mechanism](#2-trigger-mechanism)
3. [Web Speech API Integration](#3-web-speech-api-integration)
4. [UI Design](#4-ui-design)
5. [Settings Integration](#5-settings-integration)
6. [Voice Availability and Fallback](#6-voice-availability-and-fallback)
7. [Integration with Existing Pipeline](#7-integration-with-existing-pipeline)
8. [CSS Additions](#8-css-additions)
9. [File Change Summary](#9-file-change-summary)

---

## 1. Feature Overview

### What It Does

The extension already displays Chinese words as clickable `<ruby>` elements inside a Shadow DOM overlay, with a translation below. This feature adds a small speaker button to the pinyin row that reads the **full selected text** aloud as a complete utterance — not word-by-word, but as a natural sentence.

The interaction:

1. User selects Chinese text (or uses OCR). The overlay appears with pinyin annotations.
2. A small speaker icon is visible at the end of the pinyin row.
3. User clicks the speaker icon.
4. The browser reads the full Chinese text aloud in Mandarin Chinese (`zh-CN`) with natural sentence-level prosody.
5. The icon pulses while audio is playing, then returns to its idle state.

### Why Sentence-Level, Not Per-Word

Sentence-level TTS is the right choice for language learners:

- **Natural rhythm and flow** — Chinese speech has a cadence that only exists in connected speech. Isolated single-word pronunciation misses this entirely.
- **Correct tone sandhi** — Mandarin has systematic tone changes in context (e.g., consecutive third tones: 你好 nǐ hǎo is actually pronounced ní hǎo). The speech engine applies these rules automatically when given a full sentence, but cannot apply them to an isolated word.
- **Realistic listening practice** — the user hears exactly how the text would sound when spoken by a native speaker, which is the point of pronunciation assistance.
- **Simpler implementation** — one button in a fixed location is simpler to implement and test than hover-revealed buttons on every word.

### What It Does Not Do

- **No per-word TTS** — the button reads the entire selection, not individual words. Per-word pronunciation may be added as a supplementary feature later.
- **No voice selection UI** — the browser's default `zh-CN` voice is used. Users who want a different voice can change it in their OS speech settings.
- **No audio recording or download** — speech is played ephemerally through the system audio output.
- **No external TTS API calls** — all synthesis is local via the Web Speech API. No data leaves the browser.
- **No auto-play** — the user must explicitly click the speaker icon. The overlay never speaks unprompted.

### Who It's For

The same target users defined in [SPEC.md](SPEC.md) Section 1 "Target Users" — Chinese language learners who want to hear the correct pronunciation of text they encounter while reading.

---

## 2. Trigger Mechanism

### Always-Visible Speaker Button

The speaker button is permanently visible in the overlay, positioned at the right end of the pinyin row. Unlike the definition cards (which require a click to reveal), the speaker button is always accessible as soon as the overlay appears.

```
┌───────────────────────────────────────────────┐
│  汉(hàn)  语(yǔ)  很(hěn)  好(hǎo)    [🔊]  │
│                                               │
│  Chinese is very good                         │
└───────────────────────────────────────────────┘
```

### Why Always Visible

- **Discoverability** — a permanently visible button is immediately obvious to the user. A hover-revealed button requires the user to discover the interaction by accident.
- **Single target** — there is one button for the whole selection, not one per word. There is no clutter concern.
- **Touch-friendly** — no hover state needed, so it works identically on touch devices.

### Click to Play

Clicking the speaker icon triggers speech synthesis for the full Chinese text that was selected. The text is reconstructed by joining the `chars` fields from the `WordData[]` array that the overlay already holds.

---

## 3. Web Speech API Integration

### API Choice: `window.speechSynthesis` vs `chrome.tts`

Two browser APIs can synthesize speech:

| API | Runs in | Permissions | Voices |
|---|---|---|---|
| `window.speechSynthesis` (Web Speech API) | Content script / page context | None | OS-installed voices |
| `chrome.tts` | Service worker only | `"tts"` permission | OS + extension-provided voices |

This feature uses `window.speechSynthesis` because:

- **No permissions needed** — no manifest changes required.
- **No message passing** — the overlay module (`src/content/overlay.ts`) is DOM-only by design (no Chrome extension APIs). Using `speechSynthesis` preserves this constraint. Using `chrome.tts` would require sending a message to the service worker and adding a new message type.
- **Sufficient for the use case** — the Web Speech API supports Chinese voices on all major platforms (Windows, macOS, Linux/ChromeOS).

### Usage Pattern

```typescript
function speakText(text: string): void {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 0.85;
  window.speechSynthesis.speak(utterance);
}
```

Key details:

- **`cancel()` before `speak()`** — stops any in-progress utterance before starting a new one. Prevents overlapping audio if the user clicks the button multiple times.
- **`lang = "zh-CN"`** — tells the engine to use a Mandarin Chinese voice. Without this, the engine may fall back to the browser's default language and mispronounce the characters.
- **`rate = 0.85`** — slightly slower than normal speed. Language learners benefit from hearing pronunciation at a reduced pace. Normal rate is `1.0`.
- **Full sentence input** — passing the complete text rather than individual words allows the engine to apply tone sandhi, natural pausing, and sentence-level intonation.

### Utterance Lifecycle

The `SpeechSynthesisUtterance` object supports event handlers that can drive UI feedback:

```typescript
utterance.onstart = () => { /* add visual feedback class */ };
utterance.onend = () => { /* remove visual feedback class */ };
utterance.onerror = () => { /* remove visual feedback class */ };
```

These are used to show a pulsing animation on the speaker button while the text is being spoken. See Section 4 for the visual design.

---

## 4. UI Design

### Speaker Button Placement

The speaker button is appended to the `.hg-pinyin-row` flex container, after all the `<ruby>` word elements. Because the pinyin row uses `display: flex` with `flex-wrap: wrap`, the button flows naturally at the end of the word sequence. It is vertically centered with the words using `align-self: center`.

```
┌─ .hg-pinyin-row (flex) ──────────────────────┐
│  <ruby>汉 hàn</ruby>                         │
│  <ruby>语 yǔ</ruby>                          │
│  <ruby>很 hěn</ruby>                          │
│  <ruby>好 hǎo</ruby>                          │
│  <button class="hg-tts-btn">🔊</button>      │
└───────────────────────────────────────────────┘
```

### HTML Structure

The button is created as a standalone element appended after the ruby content, not inside any `<ruby>` element:

```html
<div class="hg-pinyin-row">
  <ruby class="hg-word" data-chars="汉" data-definition="Chinese; Han">汉<rt>hàn</rt></ruby>
  <ruby class="hg-word" data-chars="语" data-definition="language">语<rt>yǔ</rt></ruby>
  <!-- ... more words ... -->
  <button class="hg-tts-btn" title="Play pronunciation" aria-label="Play pronunciation">
    <svg><!-- speaker icon --></svg>
  </button>
</div>
```

### Icon

The button uses an inline SVG speaker icon rather than a Unicode emoji. SVG renders consistently across platforms and can be styled with CSS (color, size). The icon is a simple speaker cone with a sound wave:

```html
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
</svg>
```

### Visual Feedback During Playback

While the utterance is playing (between `onstart` and `onend`/`onerror`), the button receives a `.hg-tts-speaking` class that applies a subtle pulsing animation:

```css
.hg-tts-btn.hg-tts-speaking {
  animation: hg-tts-pulse 0.8s ease-in-out infinite;
}

@keyframes hg-tts-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

This gives the user a clear signal that audio is playing without being distracting.

### Interaction with Definition Cards

The speaker button is a sibling of the `<ruby>` elements, not a child. It sits outside the word click handler's scope entirely. The existing `attachWordClickHandlers()` function only binds to `.hg-word` elements, so the `.hg-tts-btn` is unaffected. No `stopPropagation` is needed.

### Text Reconstruction

The button's click handler needs access to the full Chinese text. This is reconstructed from the `WordData[]` array by joining all `chars` fields:

```typescript
const fullText = words.map((w) => w.chars).join("");
```

The `words` array is already available in both `showOverlay()` (Phase 1) and `updateOverlay()` (Phase 2). The button is created with a `data-text` attribute holding the joined text, so the click handler is self-contained:

```typescript
ttsBtn.setAttribute("data-text", words.map((w) => w.chars).join(""));
ttsBtn.addEventListener("click", () => {
  const text = ttsBtn.getAttribute("data-text") ?? "";
  speakText(text);
});
```

When `updateOverlay()` re-renders the pinyin row with LLM-enhanced words, the button is re-created with the updated text.

---

## 5. Settings Integration

### New Setting: `ttsEnabled`

A new boolean field is added to `ExtensionSettings` in `src/shared/types.ts`:

```typescript
export interface ExtensionSettings {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  pinyinStyle: PinyinStyle;
  fontSize: number;
  theme: Theme;
  llmEnabled: boolean;
  ttsEnabled: boolean;    // ← NEW
}
```

### Default Value

In `src/shared/constants.ts`, the default is `true` — the feature is enabled out of the box since it has no cost (no API key, no network traffic) and is user-initiated (requires an explicit click):

```typescript
export const DEFAULT_SETTINGS: ExtensionSettings = {
  // ... existing fields ...
  llmEnabled: true,
  ttsEnabled: true,       // ← NEW
};
```

### Popup UI

A new checkbox is added to `src/popup/popup.html`, placed below the existing "Enable LLM-enhanced translations" checkbox so both feature toggles are grouped together:

```html
<!-- LLM Mode -->
<div class="form-group checkbox-group">
  <label class="checkbox-label">
    <input type="checkbox" id="llm-enabled" />
    Enable LLM-enhanced translations
  </label>
</div>

<!-- TTS Mode -->
<div class="form-group checkbox-group">
  <label class="checkbox-label">
    <input type="checkbox" id="tts-enabled" />
    Enable text-to-speech pronunciation
  </label>
</div>
```

### Popup Logic

In `src/popup/popup.ts`:

1. **`getElements()`** — add `ttsEnabled: document.getElementById("tts-enabled") as HTMLInputElement`.
2. **`initPopup()`** — populate from settings: `els.ttsEnabled.checked = settings.ttsEnabled`.
3. **`readFormValues()`** — include in the returned object: `ttsEnabled: els.ttsEnabled.checked`.

These follow the exact same pattern as the existing `llmEnabled` checkbox.

### Content Script Caching

In `src/content/content.ts`, the `ttsEnabled` value is cached alongside the existing `cachedTheme`, using the same storage read and `onChanged` listener pattern:

```typescript
let cachedTtsEnabled = true;

chrome.storage.sync.get("ttsEnabled", (result) => {
  if (result.ttsEnabled !== undefined) cachedTtsEnabled = result.ttsEnabled;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes.ttsEnabled?.newValue !== undefined) {
    cachedTtsEnabled = changes.ttsEnabled.newValue;
  }
});
```

The cached value is passed to `showOverlay()` and `updateOverlay()` so the overlay knows whether to render the speaker button.

---

## 6. Voice Availability and Fallback

### Platform Voice Support

The Web Speech API relies on voices installed at the OS level. Chinese voice availability by platform:

| Platform | Default Chinese voice | Notes |
|---|---|---|
| Windows 10/11 | Microsoft Huihui (zh-CN) | Pre-installed on most configurations |
| macOS | Ting-Ting (zh-CN) | Pre-installed |
| ChromeOS | Google 普通话 | Built into Chrome |
| Linux | Varies | May require `espeak-ng` or similar |

### Detection

At overlay render time, the extension checks whether a suitable voice is available:

```typescript
function hasChineseVoice(): boolean {
  const voices = window.speechSynthesis.getVoices();
  return voices.some((v) => v.lang.startsWith("zh"));
}
```

### Timing Caveat

`getVoices()` may return an empty array on the first call — voices load asynchronously. The `voiceschanged` event signals when voices are ready. The overlay should listen for this event on first use:

```typescript
function ensureVoicesLoaded(): Promise<void> {
  return new Promise((resolve) => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve();
      return;
    }
    window.speechSynthesis.addEventListener("voiceschanged", () => resolve(), { once: true });
  });
}
```

### Graceful Degradation

If no Chinese voice is available after voices have loaded:

- The `.hg-tts-btn` button is **not rendered** in the overlay.
- No error message is shown — the feature is silently absent. Users who never expected TTS will not see a confusing error.
- The `ttsEnabled` checkbox in the popup remains visible and functional — the user's preference is still stored, so if they later install a Chinese voice (or switch to a platform that has one), the button will appear automatically.

---

## 7. Integration with Existing Pipeline

### No New Messages

Unlike the OCR feature (which required four new message types), TTS requires zero new messages. All speech synthesis happens inside `src/content/overlay.ts`, which runs in the page context where `window.speechSynthesis` is directly available.

```
Content Script                     Service Worker
     │                                  │
     │  (no TTS-related messages)       │
     │                                  │
     │  overlay.ts calls                │
     │  speechSynthesis.speak()         │
     │  directly in page context        │
     │                                  │
```

### Overlay Module Changes

The overlay module (`src/content/overlay.ts`) is intentionally DOM-only — its module comment (line 8) states: "This module is DOM-only -- no Chrome extension APIs -- making it testable with jsdom." TTS does not break this constraint because `speechSynthesis` is a standard Web API, not a Chrome extension API.

The following functions in `overlay.ts` are modified:

**`showOverlay(words, rect, theme, ttsEnabled)`** — gains a `ttsEnabled` parameter. When true, a `.hg-tts-btn` button is appended to the pinyin row after the ruby elements. Its `data-text` attribute holds the joined `chars` from all words. When false, no button is rendered.

**`updateOverlay(words, translation, ttsEnabled)`** — gains a `ttsEnabled` parameter. When re-rendering the pinyin row with LLM-enhanced words, the button is re-created with the updated (potentially corrected) text.

A new internal function is added:

**`speakText(text)`** — cancels any active utterance and speaks the given text in `zh-CN` at `rate = 0.85`. Manages the `.hg-tts-speaking` class on the button via utterance lifecycle events.

### Signature Changes

```typescript
export function showOverlay(
  words: WordData[],
  rect: DOMRect,
  theme: Theme,
  ttsEnabled: boolean,   // ← NEW
): void { ... }

export function updateOverlay(
  words: Required<WordData>[],
  translation: string,
  ttsEnabled: boolean,   // ← NEW
): void { ... }
```

The content script (`content.ts`) passes `cachedTtsEnabled` to both calls.

### No Changes to the Service Worker

The service worker has no involvement in TTS. It continues to handle `PINYIN_REQUEST`, LLM queries, caching, and vocab recording exactly as before.

### No Changes to the Overlay's Testability

Because `speechSynthesis` is a standard DOM API, it can be mocked in jsdom-based tests:

```typescript
window.speechSynthesis = {
  cancel: vi.fn(),
  speak: vi.fn(),
  getVoices: () => [{ lang: "zh-CN", name: "Test Voice" }],
} as unknown as SpeechSynthesis;
```

Existing overlay tests continue to pass unchanged, since they call `showOverlay()` / `updateOverlay()` without the `ttsEnabled` flag (defaulting to `false`).

---

## 8. CSS Additions

### New Styles in `src/content/overlay.css`

All TTS-related styles are added to the existing overlay stylesheet, scoped inside the Shadow DOM.

#### Speaker Button Base

The button sits inside the `.hg-pinyin-row` flex container, vertically centered with the words:

```css
.hg-tts-btn {
  flex-shrink: 0;
  align-self: center;
  width: 28px;
  height: 28px;
  margin-left: 8px;
  padding: 4px;
  border: none;
  border-radius: 50%;
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 150ms ease;
}

.hg-tts-btn:hover {
  background: rgba(59, 130, 246, 0.25);
}
```

#### Dark Theme Variant

```css
.hg-overlay.hg-dark .hg-tts-btn {
  background: rgba(96, 165, 250, 0.15);
  color: #60a5fa;
}

.hg-overlay.hg-dark .hg-tts-btn:hover {
  background: rgba(96, 165, 250, 0.3);
}
```

#### Speaking Animation

```css
.hg-tts-btn.hg-tts-speaking {
  animation: hg-tts-pulse 0.8s ease-in-out infinite;
}

@keyframes hg-tts-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

### No Changes to Popup CSS

The `ttsEnabled` checkbox uses the same `.checkbox-group` / `.checkbox-label` classes as the existing `llmEnabled` checkbox. No new popup styles are needed.

---

## 9. File Change Summary

| Area | File | Change |
|---|---|---|
| Types | `src/shared/types.ts` | Add `ttsEnabled: boolean` to `ExtensionSettings` interface |
| Constants | `src/shared/constants.ts` | Add `ttsEnabled: true` to `DEFAULT_SETTINGS` |
| Popup HTML | `src/popup/popup.html` | Add `#tts-enabled` checkbox below the LLM toggle |
| Popup TS | `src/popup/popup.ts` | Add `ttsEnabled` to `getElements()`, `initPopup()`, and `readFormValues()` |
| Overlay TS | `src/content/overlay.ts` | Add `ttsEnabled` parameter to `showOverlay()` and `updateOverlay()`; add `speakText()` helper; create and append `.hg-tts-btn` to the pinyin row with `data-text` attribute; manage `.hg-tts-speaking` class via utterance events |
| Overlay CSS | `src/content/overlay.css` | Add `.hg-tts-btn` flex item styles, hover state, dark theme variant, and `.hg-tts-speaking` pulse animation |
| Content TS | `src/content/content.ts` | Cache `ttsEnabled` from `chrome.storage.sync` alongside `cachedTheme`; pass it to `showOverlay()` and `updateOverlay()` |

No changes to: `manifest.json`, `package.json`, `src/background/service-worker.ts`, `src/background/llm-client.ts`, `src/background/pinyin-service.ts`, `src/background/cache.ts`, `src/background/vocab-store.ts`, `src/content/ocr-selection.ts`.

---

## Future Directions (Out of Scope)

- **Per-word TTS** — add hover-revealed speaker buttons on individual `<ruby>` elements for drilling specific words.
- **Playback speed control** — expose `utterance.rate` as a user setting (e.g., a slider from 0.5x to 1.5x).
- **Voice picker** — let the user choose from available `zh-CN` voices in the popup settings, stored in `chrome.storage.sync`.
- **External TTS API** — integrate Google Cloud TTS or Azure Cognitive Services for higher-quality neural voices, behind an API key setting.
- **Vocab list pronunciation** — add speaker buttons to the vocab tab in the popup so users can review pronunciation of saved words.
