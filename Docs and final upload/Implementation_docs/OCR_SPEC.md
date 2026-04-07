# OCR Area Selection — Feature Specification

Adds an "select text from image" capability to the Pinyin Tool extension. The user clicks a button in the popup, drags a rectangle over any region of the page, and the extension runs local OCR to extract Chinese characters from that region. The recognized text is then fed into the existing pinyin/translation pipeline — same overlay, same two-phase rendering, same LLM enrichment.

This feature builds on the content script wiring described in [SPEC.md](SPEC.md) Section 5, the overlay rendering from [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) Step 6, and the service worker orchestration from [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) Step 3.

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Trigger Mechanism](#2-trigger-mechanism)
3. [Message Protocol](#3-message-protocol)
4. [Area Selection UI](#4-area-selection-ui)
5. [Screenshot Capture](#5-screenshot-capture)
6. [OCR Processing](#6-ocr-processing)
7. [Integration with Existing Pipeline](#7-integration-with-existing-pipeline)
8. [Manifest and Dependency Changes](#8-manifest-and-dependency-changes)
9. [UI and CSS Additions](#9-ui-and-css-additions)
10. [File Change Summary](#10-file-change-summary)

---

## 1. Feature Overview

### What It Does

The extension already handles text that the user can select with the mouse — DOM text on web pages. OCR area selection extends this to text the user **cannot** select: text baked into images, canvas elements, screenshots, video thumbnails, embedded PDFs rendered as images, or any other non-selectable visual content.

The interaction:

1. User clicks the extension icon to open the popup.
2. User clicks the "Select text from image" button.
3. The popup closes. A full-page selection mask appears.
4. User drags a rectangle over the region containing Chinese text.
5. The extension captures a screenshot, crops it to the selected rectangle, and runs OCR.
6. The recognized Chinese text feeds into the existing `processSelection()` flow.
7. The pinyin/translation overlay appears, exactly as if the user had selected the text normally.

### What It Does Not Do

- **No multi-page or cross-tab capture** — only the visible portion of the active tab is captured.
- **No PDF-aware OCR** — the extension captures rendered pixels, not PDF text layers.
- **No persistent image storage** — the cropped screenshot exists only in memory during OCR processing and is discarded afterward.
- **No traditional Chinese model by default** — the initial version ships with Simplified Chinese (`chi_sim`) only. Traditional Chinese support may be added later as a user setting.
- **No handwriting recognition** — the OCR model is optimized for printed/digital text.

### Who It's For

The same target users defined in [SPEC.md](SPEC.md) Section 1 "Target Users" — particularly learners who encounter Chinese text in images, infographics, memes, or embedded screenshots that cannot be highlighted with the mouse.

---

## 2. Trigger Mechanism

### Popup Button (Approach 2)

The OCR feature is triggered from a button in the popup, positioned between the `<h1>` title and the `.tab-bar` that holds the Settings/Vocab tabs. This placement makes it a top-level action — always visible, not buried inside a tab.

```
┌──────────────────────────────────────┐
│  Pinyin Tool Extension               │
├──────────────────────────────────────┤
│  [ Select text from image ]          │  ← NEW button
├──────────────────────────────────────┤
│  [ Settings ]   [ Vocab ]            │
├──────────────────────────────────────┤
│                                      │
│  (tab content)                       │
│                                      │
└──────────────────────────────────────┘
```

### HTML Structure

The button is added to `src/popup/popup.html` between the existing `<h1>` and `.tab-bar`:

```html
<h1>Pinyin Tool Extension</h1>

<button id="ocr-btn">Select text from image</button>

<div class="tab-bar">
  <button class="tab-btn active" data-tab="settings">Settings</button>
  <button class="tab-btn" data-tab="vocab">Vocab</button>
</div>
```

### Why the Popup Must Close

Chrome does not allow interaction with the underlying page while the popup is open. The popup blocks all page events. Therefore, the click handler in `src/popup/popup.ts` must:

1. Send a message to the service worker.
2. Immediately call `window.close()`.

The service worker then forwards the trigger to the content script, which can now receive it because the popup is gone and the page is interactive again.

### Why Not a Context Menu or Keyboard Shortcut?

Both are viable alternative triggers and could be added later, but the popup button is the right starting point because:

- **Discoverability** — new users will see the button the first time they open the popup. Context menu items are hidden until right-click; keyboard shortcuts require memorization.
- **No text dependency** — the existing context menu item (`contexts: ["selection"]`) requires a text selection to appear. OCR targets areas where there is no selectable text, so a selection-dependent trigger is contradictory.
- **Simpler first implementation** — a popup button requires no manifest changes beyond what already exists. A new keyboard shortcut would need a new `commands` entry.

---

## 3. Message Protocol

### New Message Types

Four new message types are added to the `ExtensionMessage` discriminated union in `src/shared/types.ts`:

```typescript
| { type: "OCR_START" }
| { type: "OCR_START_SELECTION" }
| { type: "OCR_CAPTURE_REQUEST"; rect: { x: number; y: number; width: number; height: number } }
| { type: "OCR_CAPTURE_RESULT"; dataUrl: string }
```

### Message Flow

```
Popup                    Service Worker              Content Script
  │                           │                           │
  │── OCR_START ─────────────►│                           │
  │   (then window.close())   │                           │
  │                           │── OCR_START_SELECTION ────►│
  │                           │                           │ (show selection mask)
  │                           │                           │ (user drags rectangle)
  │                           │◄── OCR_CAPTURE_REQUEST ───│
  │                           │    { rect }               │
  │                           │                           │
  │                           │ captureVisibleTab()       │
  │                           │                           │
  │                           │── OCR_CAPTURE_RESULT ────►│
  │                           │   { dataUrl }             │
  │                           │                           │ (crop, OCR, processSelection)
```

### Why Four Messages Instead of Fewer?

The split follows the same principle as the existing message protocol: each component only does what it has access to.

- The **popup** cannot talk directly to the content script — Chrome requires messages to route through `chrome.runtime`.
- The **content script** cannot call `captureVisibleTab()` — that API is only available in the service worker.
- The **service worker** cannot interact with the page DOM — it needs the content script to handle the selection UI and OCR rendering.

### Relationship to Existing Messages

These messages are independent of the existing `PINYIN_REQUEST` / `PINYIN_RESPONSE_*` flow. The OCR path only joins the existing pipeline at the very end, when the content script calls `processSelection()` with the recognized text — at which point a normal `PINYIN_REQUEST` is sent, and the standard two-phase rendering proceeds.

---

## 4. Area Selection UI

### New Module

The selection UI lives in a new file: `src/content/ocr-selection.ts`. It is kept separate from `src/content/overlay.ts` because the selection mask and the result overlay have different lifecycles — the selection mask is dismissed before the overlay appears.

### Visual Design

When OCR selection mode is activated:

1. A **full-viewport fixed overlay** covers the entire page with a semi-transparent dark background (`rgba(0, 0, 0, 0.4)`).
2. The cursor changes to a **crosshair**.
3. A brief instruction label appears near the top center: "Drag to select area" (fades out after 2 seconds or on first mousedown).
4. As the user drags, the **selected rectangle** is drawn with a clear/transparent interior and a visible border, creating a "cutout" effect against the dark mask.
5. On **mouseup**, the selection mask is removed and the selected rect is emitted.
6. Pressing **Escape** at any point cancels the selection and removes the mask.

### Coordinate System

All coordinates use the **viewport** (client) coordinate system (`clientX`, `clientY` from `MouseEvent`), matching what `getBoundingClientRect()` returns and what the overlay positioning logic in `overlay.ts` expects.

### Device Pixel Ratio

`captureVisibleTab()` captures at the display's native resolution. On HiDPI/Retina displays (`devicePixelRatio > 1`), the screenshot is larger than the CSS viewport. The content script must multiply the viewport coordinates by `window.devicePixelRatio` when cropping the captured image:

```typescript
const dpr = window.devicePixelRatio;
const cropX = rect.x * dpr;
const cropY = rect.y * dpr;
const cropW = rect.width * dpr;
const cropH = rect.height * dpr;
```

Without this adjustment, the crop will be offset and scaled incorrectly on HiDPI displays.

### Minimum Selection Size

Drags smaller than 10x10 CSS pixels are ignored to prevent accidental single-click triggers. The selection mask is removed without emitting a rect.

### API Surface

```typescript
export function startOCRSelection(): Promise<{ x: number; y: number; width: number; height: number } | null>;
```

Returns a `Promise` that resolves with the selected viewport rect, or `null` if the user cancels (Escape / too-small drag). The caller in `content.ts` awaits this, then sends `OCR_CAPTURE_REQUEST` to the service worker.

---

## 5. Screenshot Capture

### Service Worker Handler

On receiving `OCR_CAPTURE_REQUEST`, the service worker calls:

```typescript
chrome.tabs.captureVisibleTab(null, { format: "png" })
```

This returns a data URL (`data:image/png;base64,...`) of the entire visible tab at native display resolution.

The data URL is sent back to the content script via `OCR_CAPTURE_RESULT`.

### Permissions

No new permissions are needed. The `activeTab` permission already declared in `manifest.json` grants `captureVisibleTab` access when the extension is invoked via the popup click. The grant persists for the duration of the user gesture chain, which includes the forwarded messages.

### Error Handling

If `captureVisibleTab` fails (e.g., on `chrome://` pages or other restricted URLs), the service worker sends a `PINYIN_ERROR` message with `phase: "local"` and a descriptive message. The content script shows this via the existing `showOverlayError()` function.

---

## 6. OCR Processing

### Engine: tesseract.js (Local)

OCR runs entirely in the browser using `tesseract.js`. No image data is sent to external servers.

### Language Model

The initial version loads `chi_sim` (Simplified Chinese), using the optimized LSTM-only browser pack. Download size is approximately 6 MB on first use, cached by the browser afterward.

### Processing Steps

```
Screenshot data URL (full tab)
        │
        ▼
  Create <canvas>, draw Image from data URL
        │
        ▼
  Crop canvas to selected rect (adjusted for devicePixelRatio)
        │
        ▼
  Extract cropped ImageData
        │
        ▼
  tesseract.createWorker("chi_sim")
        │
        ▼
  worker.recognize(croppedCanvas)
        │
        ▼
  result.data.text
        │
        ▼
  Normalize: strip leading/trailing whitespace, collapse internal newlines
        │
        ▼
  Validate: containsChinese(text) → true?
        │
        ├── Yes → processSelection(text, rect, text)
        │
        └── No  → Show brief error: "No Chinese text detected in selected area"
```

### Worker Lifecycle

The tesseract worker is created on-demand when the user first triggers OCR, not at content script load time. After recognition completes, the worker is terminated to free memory. If the user triggers OCR again, a new worker is created.

This trades a small initialization cost (~1-2 seconds on first run) for zero ongoing memory overhead when the feature isn't in use.

### Loading Indicator

While OCR is running (between mouseup and text recognition), the content script shows a minimal loading indicator at the center of the selected region — a small floating element with "Recognizing text..." that disappears when results arrive. This reuses the same visual style as the existing `.hg-loading` class.

---

## 7. Integration with Existing Pipeline

### The Handoff

Once OCR produces recognized text, the content script calls the same `processSelection()` function used by mouseup, context menu, and keyboard shortcut triggers:

```typescript
processSelection(ocrText, selectionRect, ocrText);
```

Arguments:

- **`text`** — the OCR-recognized Chinese text
- **`rect`** — the viewport DOMRect of the area the user selected (used for overlay positioning)
- **`context`** — the OCR text itself, since there is no surrounding DOM text to extract

From this point forward, the existing two-phase pipeline takes over unchanged:

1. **Phase 1** — service worker runs `pinyin-pro` segmentation, content script shows overlay with local pinyin
2. **Phase 2** — service worker calls the LLM for contextual definitions and translation, content script updates the overlay

### No Changes to the Overlay

The overlay component (`src/content/overlay.ts`) receives `WordData[]` and a `DOMRect` — it has no knowledge of whether the text came from DOM selection or OCR. No changes are needed.

### No Changes to the Service Worker Pipeline

The service worker's `handlePinyinRequest()` and `handleLLMPath()` receive text and context strings — they have no knowledge of the text source. No changes are needed beyond handling the new OCR-specific messages (`OCR_START`, `OCR_CAPTURE_REQUEST`).

### Vocab Recording

Words from OCR-recognized text are recorded in the vocab store just like any other text, because recording happens inside `handleLLMPath()` which runs identically regardless of text source.

---

## 8. Manifest and Dependency Changes

### Manifest (`manifest.json`)

No new permissions are needed for the MVP:

| Permission | Already declared | Used for |
|---|---|---|
| `activeTab` | Yes | `captureVisibleTab()` after popup invocation |
| `storage` | Yes | tesseract.js may cache language data (uses IndexedDB by default) |

If tesseract.js worker scripts and trained data files are bundled with the extension rather than fetched from a CDN, they must be listed in `web_accessible_resources`:

```json
{
  "web_accessible_resources": [
    {
      "resources": ["assets/*", "tesseract/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

Whether to bundle or use the CDN is an implementation-time decision. Bundling adds ~6 MB to the extension package but ensures offline capability and avoids CSP issues on strict pages.

### Dependencies (`package.json`)

Add `tesseract.js` as a runtime dependency:

```json
{
  "dependencies": {
    "pinyin-pro": "^3",
    "tesseract.js": "^5"
  }
}
```

`tesseract.js` v5 defaults to LSTM-only models, which are smaller and faster than the legacy + LSTM combination in v4.

---

## 9. UI and CSS Additions

### Popup Button (`src/popup/popup.css`)

The OCR button is styled as a secondary action — an outlined button, visually distinct from the primary blue "Save Settings" button. It spans the full width of the popup and sits in the gap between the title and the tab bar.

```css
#ocr-btn {
  width: 100%;
  padding: 8px;
  margin-bottom: 12px;
  border: 1px solid #3b82f6;
  border-radius: 4px;
  background: transparent;
  color: #3b82f6;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

#ocr-btn:hover {
  background: rgba(59, 130, 246, 0.08);
}
```

Dark mode variant (inside existing `@media (prefers-color-scheme: dark)` block):

```css
#ocr-btn {
  border-color: #60a5fa;
  color: #60a5fa;
}

#ocr-btn:hover {
  background: rgba(96, 165, 250, 0.12);
}
```

### Selection Mask (`src/content/overlay.css`)

The selection overlay and drag rectangle are styled within the content script's Shadow DOM, alongside the existing overlay styles:

```css
.hg-ocr-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.4);
  cursor: crosshair;
  z-index: 2147483646;
}

.hg-ocr-instruction {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #ffffff;
  font-size: 14px;
  pointer-events: none;
  z-index: 2147483647;
  animation: hg-fade-in 150ms ease-out;
}

.hg-ocr-rect {
  position: fixed;
  border: 2px solid #3b82f6;
  background: rgba(59, 130, 246, 0.1);
  z-index: 2147483647;
  pointer-events: none;
}

.hg-ocr-loading {
  position: fixed;
  padding: 8px 16px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #ffffff;
  font-size: 13px;
  font-style: italic;
  z-index: 2147483647;
  pointer-events: none;
  animation: hg-fade-in 150ms ease-out;
}
```

These styles work in both light and dark mode because they use their own opaque/semi-transparent backgrounds rather than inheriting from the page or the `.hg-light` / `.hg-dark` theme classes.

---

## 10. File Change Summary

| Area | File | Change |
|---|---|---|
| Types | `src/shared/types.ts` | Add 4 OCR message types to `ExtensionMessage` union |
| Popup HTML | `src/popup/popup.html` | Add `#ocr-btn` button between `<h1>` and `.tab-bar` |
| Popup CSS | `src/popup/popup.css` | Style `#ocr-btn` in both light and dark mode |
| Popup TS | `src/popup/popup.ts` | Click handler: send `OCR_START` via `chrome.runtime.sendMessage`, call `window.close()` |
| Service Worker | `src/background/service-worker.ts` | Handle `OCR_START` (forward as `OCR_START_SELECTION` to active tab) and `OCR_CAPTURE_REQUEST` (call `captureVisibleTab`, respond with `OCR_CAPTURE_RESULT`) |
| Content Script | `src/content/content.ts` | Handle `OCR_START_SELECTION` (start selection UI) and `OCR_CAPTURE_RESULT` (crop, OCR, call `processSelection`) |
| New Module | `src/content/ocr-selection.ts` | Selection mask UI: dark overlay, crosshair cursor, drag rectangle, Escape cancel, coordinate math |
| Overlay CSS | `src/content/overlay.css` | Add `.hg-ocr-mask`, `.hg-ocr-instruction`, `.hg-ocr-rect`, `.hg-ocr-loading` styles |
| Manifest | `manifest.json` | Potentially extend `web_accessible_resources` to include tesseract worker/data files |
| Package | `package.json` | Add `tesseract.js` (`^5`) as a runtime dependency |

---

## Future Directions (Out of Scope)

- **Traditional Chinese model** — add `chi_tra` support as a user setting alongside or instead of `chi_sim`.
- **Remote vision-model OCR** — send the cropped image to the configured LLM provider's vision endpoint (GPT-4o, Gemini) for higher accuracy, especially on handwritten or low-quality text.
- **Context menu trigger** — add "OCR this area" as a right-click option (using `contexts: ["page", "image"]`).
- **Keyboard shortcut** — add a dedicated shortcut (e.g., `Alt+Shift+O`) to enter selection mode without opening the popup.
- **Multi-region selection** — let the user select multiple rectangles before running OCR, concatenating the results.
- **Language auto-detection** — detect whether the image contains Simplified or Traditional Chinese and load the appropriate model automatically.
