# File Reader Feature — Specification

A built-in file reader for the Pinyin Tool extension that lets users open EPUB ebooks (and eventually other formats) directly inside the extension and get the same pinyin annotations, word definitions, and translations they get on web pages. Because the reader runs on the extension's own page, it bypasses the `chrome-extension://` URL restrictions that prevent content scripts from working inside other extensions' EPUB readers.

---

## Table of Contents

1. [Product Overview and Motivation](#1-product-overview-and-motivation)
2. [Supported Formats](#2-supported-formats)
3. [Architecture](#3-architecture)
4. [EPUB Renderer — Detailed Design](#4-epub-renderer--detailed-design)
5. [Reader UI/UX Design](#5-reader-uiux-design)
6. [Pinyin Integration](#6-pinyin-integration)
7. [Manifest Changes](#7-manifest-changes)
8. [File and Folder Structure](#8-file-and-folder-structure)
9. [Data Flow](#9-data-flow)
10. [Reading State Persistence](#10-reading-state-persistence)
11. [Implementation Phases](#11-implementation-phases)
12. [Future Format Implementation Notes](#12-future-format-implementation-notes)

---

## 1. Product Overview and Motivation

### Why the Reader Exists

The Pinyin Tool extension injects a content script into every web page via `manifest.json` with `"matches": ["<all_urls>"]`. This works on any `http://` or `https://` page. However, Chrome enforces a hard security boundary: **content scripts cannot be injected into `chrome-extension://` pages**. This means the extension's pinyin overlay does not work inside other extensions that render content on their own pages — most critically, EPUB reader extensions like EPUBReader.

EPUB readers render book content at URLs like `chrome-extension://jhhclmfgfllimlhabjkgkeebkbiadflb/reader.html`. The Pinyin Tool content script is never injected there. Even if it were, most EPUB readers render chapter text inside **sandboxed iframes** (`sandbox="allow-same-origin"` without `allow-scripts`), which blocks script execution and isolates `window.getSelection()` across frame boundaries.

The solution: ship a reader inside the Pinyin Tool extension itself. Because the reader page is part of the extension, there is no content-script injection problem. The pinyin pipeline can be imported directly as ES modules — no message passing, no frame boundaries, no isolation barriers.

### Complementing the Content Script

The file reader does not replace the content-script approach. Both coexist:

| Surface | Mechanism | Use case |
|---|---|---|
| **Open web** (news, forums, social media) | Content script injected into every page | Browsing Chinese websites normally |
| **Files** (EPUB, PDF, text, subtitles) | Built-in reader page | Reading ebooks, study materials, subtitle files |

Users who browse Chinese websites continue to get pinyin overlays exactly as before. Users who want to read an EPUB or other file open the reader page via the popup or a dedicated tab.

### Target User Workflows

- **Language learners** reading graded readers or native Chinese novels in EPUB format
- **Students** studying Chinese textbooks distributed as PDF or EPUB
- **Drama/movie fans** reviewing Chinese subtitle files (SRT/VTT) to study dialogue
- **Researchers** reading Chinese academic papers or articles saved as HTML or text
- **Heritage speakers** reading family documents, letters, or exported chat logs

---

## 2. Supported Formats

### Tier 1 — Implement First

| Format | Extension(s) | Library | Rationale |
|---|---|---|---|
| **EPUB** | `.epub` | epub.js | The original motivation. Most common ebook format. epub.js handles the full EPUB spec (OPF, spine, NCX/nav, XHTML content, CSS, images, fonts). Mature, well-maintained, actively used. |

### Tier 2 — High Value, Implement Next

| Format | Extension(s) | Library | Rationale |
|---|---|---|---|
| **Plain text** | `.txt` | None | Zero-dependency. Render in a styled `<div>`. Many graded readers distribute text files. Users can paste or type Chinese text directly. |
| **PDF** | `.pdf` | pdf.js (Mozilla) | Extremely common for textbooks, academic papers, and scanned materials. pdf.js is the same renderer Firefox uses natively. Chinese PDF text extraction can be messy with mixed vertical/horizontal layouts — expect edge cases. |
| **Subtitles** | `.srt`, `.vtt`, `.ass` | Custom parser | SRT and VTT are trivially simple formats (timestamp + text). ASS/SSA is more complex but parseable. Huge value for learners watching Chinese shows who want to study dialogue line by line. |

### Tier 3 — Nice to Have

| Format | Extension(s) | Library | Rationale |
|---|---|---|---|
| **HTML** | `.html`, `.htm`, `.mhtml` | Native DOM | Saved web pages. Render inside an iframe or shadow DOM container. Minimal effort since the browser handles HTML natively. |
| **Markdown** | `.md` | marked / markdown-it | Study notes, exported content, README files. Lightweight library converts to HTML, then render like HTML. |
| **DOCX** | `.docx` | mammoth.js | Microsoft Word documents. mammoth.js converts DOCX to clean HTML. Niche use case — most users can export to PDF. |

### Tier 4 — Complex, Investigate Later

| Format | Extension(s) | Library | Rationale |
|---|---|---|---|
| **MOBI / AZW** | `.mobi`, `.azw`, `.azw3` | mobi.js or conversion layer | Amazon Kindle formats. Would need a JavaScript MOBI parser or a conversion step to EPUB. DRM-protected files cannot be read. Complex for marginal gain since most users can convert to EPUB. |
| **FB2** | `.fb2` | Custom XML parser | FictionBook format popular in Russian and Chinese ebook communities. XML-based, so parseable, but niche audience. |
| **CBZ / CBR** | `.cbz`, `.cbr` | JSZip + image rendering | Comic book archives (zipped images). Relevant for Chinese manga/manhua. Would need OCR integration (already partially built via Tesseract) to extract text from images. |

---

## 3. Architecture

### How the Reader Fits Into the Existing Extension

The reader is a new **extension page** — an HTML file declared in `manifest.json` that runs in the extension's own origin (`chrome-extension://<id>/`). Unlike content scripts, extension pages have full access to all Chrome APIs and can import any module from the extension's bundle directly.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Existing Architecture                         │
│                                                                 │
│  ┌──────────────────┐    messages    ┌───────────────────────┐  │
│  │ Content Script    │──────────────▶│ Service Worker         │  │
│  │ (web pages)       │◀──────────────│ (pinyin, LLM, cache)  │  │
│  └──────────────────┘               └───────────────────────┘  │
│                                                                 │
│  ┌──────────────────┐                                           │
│  │ Popup UI          │                                          │
│  │ (settings, vocab) │                                          │
│  └──────────────────┘                                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  NEW: Reader Page                         │   │
│  │                                                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │   │
│  │  │ File Loader   │  │ Format       │  │ Pinyin        │  │   │
│  │  │ (drag & drop, │  │ Renderers    │  │ Integration   │  │   │
│  │  │  file picker) │  │ (EPUB, PDF,  │  │ (direct       │  │   │
│  │  │              │  │  TXT, SRT)   │  │  imports)     │  │   │
│  │  └──────────────┘  └──────────────┘  └───────────────┘  │   │
│  │                                                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │   │
│  │  │ Reader Chrome │  │ TOC / Nav    │  │ Reading State │  │   │
│  │  │ (theme, font, │  │ (sidebar,    │  │ (bookmarks,   │  │   │
│  │  │  settings)    │  │  progress)   │  │  position)    │  │   │
│  │  └──────────────┘  └──────────────┘  └───────────────┘  │   │
│  │                                                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Shared Infrastructure                     │   │
│  │  chrome.storage.sync  (settings)                          │   │
│  │  chrome.storage.local (cache, vocab, reading state)       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Direct Imports vs Message Passing

On web pages, the content script and service worker run in separate processes and communicate via `chrome.runtime.sendMessage`. The reader page eliminates this boundary:

| Capability | Content Script (web pages) | Reader Page |
|---|---|---|
| `convertToPinyin()` | Via service worker message | Direct import from `pinyin-service.ts` |
| `queryLLM()` | Via service worker message | Direct import from `llm-client.ts` |
| Cache read/write | Via service worker (storage.local) | Direct import from `cache.ts` |
| Vocab recording | Via service worker | Direct import from `vocab-store.ts` |
| Overlay rendering | Shadow DOM in page | Shadow DOM in reader page |
| Settings | Cached from storage.onChanged | Direct `chrome.storage.sync.get()` |

This eliminates message-passing latency and simplifies the code path. Phase 1 pinyin and Phase 2 LLM calls happen directly in the reader page's context.

### Format Adapter Pattern

Each file format gets a renderer that implements a common `FormatRenderer` interface. This mirrors the LLM client's adapter pattern (`buildRequest()` / `parseResponse()` per API style) — format-specific details are isolated behind a uniform API, so the reader shell doesn't care what format is loaded.

```typescript
interface FormatRenderer {
  /** Human-readable format name for UI display. */
  readonly formatName: string;

  /** File extensions this renderer handles (e.g. [".epub"]). */
  readonly extensions: string[];

  /**
   * Parse a file and prepare it for rendering.
   * Called once when the user opens a file.
   * Returns metadata for the reader shell (title, author, TOC, etc.).
   */
  load(file: File): Promise<BookMetadata>;

  /**
   * Render the current chapter/section into the given container element.
   * The reader shell provides the container; the renderer fills it.
   */
  renderTo(container: HTMLElement): Promise<void>;

  /**
   * Navigate to a specific location (chapter index, page number,
   * or format-specific location identifier).
   */
  goTo(location: string | number): Promise<void>;

  /** Navigate to the next chapter/section. Returns false if at the end. */
  next(): Promise<boolean>;

  /** Navigate to the previous chapter/section. Returns false if at the start. */
  prev(): Promise<boolean>;

  /** Returns the current location for persistence (opaque string). */
  getCurrentLocation(): string;

  /** Returns the text content of the current view for context extraction. */
  getVisibleText(): string;

  /** Clean up resources (e.g. epub.js Book instance). */
  destroy(): void;
}

interface BookMetadata {
  title: string;
  author: string;
  language?: string;
  coverUrl?: string;
  toc: TocEntry[];
  totalChapters: number;
  currentChapter: number;
}

interface TocEntry {
  label: string;
  href: string;
  level: number;
  children?: TocEntry[];
}
```

Adding a new format means implementing this interface — the reader shell, pinyin integration, state persistence, and UI all work automatically.

---

## 4. EPUB Renderer — Detailed Design

### Why epub.js

epub.js is the standard JavaScript EPUB rendering library. It handles the full complexity of the EPUB specification so the reader doesn't need to:

| EPUB concern | epub.js handles it |
|---|---|
| ZIP archive parsing | Uses JSZip internally to unpack `.epub` files |
| OPF package document | Parses metadata, manifest, and spine (reading order) |
| NCX / Navigation Document | Generates table of contents from either legacy NCX or EPUB 3 nav |
| XHTML content documents | Renders chapter HTML with correct styling |
| CSS stylesheets | Applies publisher CSS within the content frame |
| Embedded images | Resolves `<img>` references within the EPUB archive |
| Embedded fonts | Loads `@font-face` declarations from the EPUB package |
| Spine navigation | Handles prev/next chapter traversal in reading order |
| CFI (Canonical Fragment Identifier) | Provides persistent location references for bookmarking |

### EPUB Structure Primer

An EPUB file is a ZIP archive with a defined structure:

```
my-book.epub (ZIP archive)
├── mimetype                        # Must be "application/epub+zip" (uncompressed)
├── META-INF/
│   └── container.xml               # Points to the OPF package document
├── OEBPS/                          # Content directory (name varies)
│   ├── content.opf                 # Package document: metadata + manifest + spine
│   ├── toc.ncx                     # Table of contents (EPUB 2) or nav.xhtml (EPUB 3)
│   ├── chapter1.xhtml              # Content documents (the actual book text)
│   ├── chapter2.xhtml
│   ├── styles/
│   │   └── book.css                # Publisher stylesheets
│   ├── images/
│   │   ├── cover.jpg               # Cover image
│   │   └── figure1.png             # Inline images
│   └── fonts/
│       └── custom-font.woff2       # Embedded fonts
```

Key components for the renderer:

- **Spine**: ordered list of content documents defining the reading sequence
- **Manifest**: list of all files in the EPUB with media types
- **Metadata**: title, author, language, publisher, cover reference
- **TOC**: hierarchical table of contents linking to content document locations

### epub.js Integration

```typescript
import ePub from "epubjs";
import type { Book, Rendition, NavItem } from "epubjs";

class EpubRenderer implements FormatRenderer {
  readonly formatName = "EPUB";
  readonly extensions = [".epub"];

  private book: Book | null = null;
  private rendition: Rendition | null = null;

  async load(file: File): Promise<BookMetadata> {
    const arrayBuffer = await file.arrayBuffer();
    this.book = ePub(arrayBuffer);
    await this.book.ready;

    const metadata = await this.book.loaded.metadata;
    const navigation = await this.book.loaded.navigation;

    return {
      title: metadata.title || file.name,
      author: metadata.creator || "Unknown",
      language: metadata.language,
      coverUrl: await this.extractCoverUrl(),
      toc: this.convertToc(navigation.toc),
      totalChapters: this.book.spine.length,
      currentChapter: 0,
    };
  }

  async renderTo(container: HTMLElement): Promise<void> {
    if (!this.book) throw new Error("No book loaded");

    this.rendition = this.book.renderTo(container, {
      width: "100%",
      height: "100%",
      spread: "none",
      flow: "scrolled-doc",
      allowScriptedContent: false,
    });

    await this.rendition.display();
  }

  async goTo(location: string | number): Promise<void> {
    if (!this.rendition) return;
    if (typeof location === "number") {
      const spine = this.book!.spine.get(location);
      if (spine) await this.rendition.display(spine.href);
    } else {
      await this.rendition.display(location);
    }
  }

  async next(): Promise<boolean> {
    if (!this.rendition) return false;
    await this.rendition.next();
    return true;
  }

  async prev(): Promise<boolean> {
    if (!this.rendition) return false;
    await this.rendition.prev();
    return true;
  }

  getCurrentLocation(): string {
    if (!this.rendition) return "";
    const location = this.rendition.currentLocation();
    return location?.start?.cfi ?? "";
  }

  getVisibleText(): string {
    if (!this.rendition) return "";
    const iframe = this.rendition.getContents()?.[0];
    if (!iframe?.document) return "";
    return iframe.document.body?.textContent?.slice(0, 500) ?? "";
  }

  destroy(): void {
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
  }

  // --- Internal helpers ---

  private async extractCoverUrl(): Promise<string | undefined> {
    if (!this.book) return undefined;
    try {
      const coverUrl = await this.book.coverUrl();
      return coverUrl ?? undefined;
    } catch {
      return undefined;
    }
  }

  private convertToc(items: NavItem[]): TocEntry[] {
    return items.map((item) => ({
      label: item.label.trim(),
      href: item.href,
      level: 0,
      children: item.subitems
        ? this.convertToc(item.subitems)
        : undefined,
    }));
  }
}
```

### Rendering Modes

epub.js supports two rendering flows. The reader should support both, with continuous scroll as the default for reading-focused use:

| Mode | epub.js `flow` | Behavior | Best for |
|---|---|---|---|
| **Continuous scroll** | `"scrolled-doc"` | Full chapter rendered as a scrollable document | Reading long passages, studying text |
| **Paginated** | `"paginated"` | Fixed page dimensions, left/right page turns | Book-like reading experience |

### Content Rendering Considerations

**Text**: epub.js renders XHTML content documents inside an iframe. The reader needs to attach event listeners to the iframe's document for text selection (see Section 6).

**Images**: Resolved automatically by epub.js from the EPUB archive. Displayed inline where the publisher placed them. The reader should ensure images are responsive (`max-width: 100%`).

**CSS**: Publisher CSS is applied inside the epub.js iframe. The reader injects additional CSS to override font size, line height, and theme colors based on user preferences. This uses epub.js's `rendition.themes.override()` API.

**Embedded fonts**: Loaded by epub.js from the EPUB archive. Some Chinese EPUBs include custom fonts for rare characters — these should be preserved.

---

## 5. Reader UI/UX Design

### Opening the Reader

The reader opens as a full browser tab at `chrome-extension://<id>/src/reader/reader.html`. Users reach it via:

- A "Open Reader" button in the extension popup
- A context menu item "Open in Pinyin Reader" (future — when the extension detects an EPUB download)
- Directly navigating to the extension page

### Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ┌──────────┐                                         ┌─────────────┐  │
│  │ ☰ TOC    │          Book Title — Author            │  ⚙ Settings │  │
│  └──────────┘                                         └─────────────┘  │
├──────────────┬──────────────────────────────────────────────────────────┤
│              │                                                          │
│  Table of    │                                                          │
│  Contents    │           Chapter Title                                  │
│              │                                                          │
│  ┌────────┐  │           zhè shì yī gè lì zi                          │
│  │Ch 1    │  │           这 是  一 个 例 子                              │
│  │Ch 2  ● │  │                                                          │
│  │  2.1   │  │           Content continues here with full               │
│  │  2.2   │  │           chapter text rendered by epub.js...            │
│  │Ch 3    │  │                                                          │
│  │Ch 4    │  │           ┌────────────────────────────────┐             │
│  │...     │  │           │  [Embedded image from EPUB]    │             │
│  │        │  │           └────────────────────────────────┘             │
│  │        │  │                                                          │
│  │        │  │           More text content follows...                   │
│  │        │  │                                                          │
│  │        │  │                                                          │
│  │        │  │                                                          │
│  └────────┘  │                                                          │
│              │                                                          │
├──────────────┴──────────────────────────────────────────────────────────┤
│  ◀ Prev    ━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━  Next ▶  │
│                           Chapter 2 of 15                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Landing State (No File Loaded)

When no file is loaded, the content area shows a clean loading interface:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│                          Pinyin Tool Reader                              │
│                                                                         │
│                  ┌─────────────────────────────────┐                    │
│                  │                                 │                    │
│                  │     Drag & drop an EPUB file    │                    │
│                  │     here to start reading       │                    │
│                  │                                 │                    │
│                  │     ─ ─ ─ ─  or  ─ ─ ─ ─       │                    │
│                  │                                 │                    │
│                  │     [ Choose File ]              │                    │
│                  │                                 │                    │
│                  └─────────────────────────────────┘                    │
│                                                                         │
│                  Supported formats: .epub                               │
│                  (PDF, TXT, SRT coming soon)                            │
│                                                                         │
│                  ┌─────────────────────────────────┐                    │
│                  │  Recent Files                    │                    │
│                  │                                 │                    │
│                  │  📖 三体 — 刘慈欣          Ch 5  │                    │
│                  │  📖 活着 — 余华            Ch 12 │                    │
│                  │  📖 红楼梦 — 曹雪芹        Ch 3  │                    │
│                  │                                 │                    │
│                  └─────────────────────────────────┘                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### File Loading

Two input methods:

1. **Drag and drop**: A full-page drop zone listens for `dragover` / `drop` events. On drop, the file is read via `FileReader.readAsArrayBuffer()` and passed to the appropriate format renderer based on file extension.

2. **File picker**: An `<input type="file">` element with `accept=".epub"` (expanded as more formats are added). Styled as a button.

The file is processed entirely client-side. No upload to any server. The raw `File` object is passed to the format renderer's `load()` method.

### Reader Chrome (Controls)

| Control | Type | Values | Persisted? |
|---|---|---|---|
| Font size | Range slider | 14–28px (default: 18) | Yes (chrome.storage.sync) |
| Theme | Dropdown | Light, Dark, Sepia, Auto | Yes |
| Font family | Dropdown | System default, Serif, Sans-serif, Noto Sans SC, Noto Serif SC | Yes |
| Line spacing | Range slider | 1.4–2.2 (default: 1.8) | Yes |
| Reading mode | Toggle | Scroll / Paginated | Yes |
| Pinyin overlay | Toggle | Enabled / Disabled (for those who want just a reader) | Yes |
| LLM translations | Toggle | Enabled / Disabled | Shared with main extension settings |

These are separate from the main extension settings (stored under a `readerSettings` key) except for LLM-related settings which are shared.

### TOC Sidebar

- Collapsible via the hamburger menu button in the top-left
- Renders the `TocEntry[]` tree from `BookMetadata`
- Highlights the currently active chapter
- Clicking an entry calls `renderer.goTo(entry.href)`
- Supports nested entries (subchapters) with indentation
- Keyboard navigable (arrow keys, Enter to select)

### Bottom Bar

- **Prev / Next buttons**: call `renderer.prev()` / `renderer.next()`
- **Progress bar**: visual indicator of position within the book
- **Chapter indicator**: "Chapter 2 of 15" text label
- Keyboard shortcuts: Left arrow = prev, Right arrow = next

### Themes

| Theme | Background | Text | Pinyin | Accent |
|---|---|---|---|---|
| Light | `#ffffff` | `#1a1a1a` | `#6b7280` | `#3b82f6` |
| Dark | `#1a1a2e` | `#e2e8f0` | `#94a3b8` | `#60a5fa` |
| Sepia | `#f4ecd8` | `#5c4b37` | `#8b7355` | `#b8860b` |
| Auto | Follows OS `prefers-color-scheme` | — | — | — |

The sepia theme is a reader-specific addition not present in the main extension overlay — it's the classic e-reader color scheme that reduces eye strain during long reading sessions.

### Responsive Behavior

The reader is designed for full-tab use on desktop. The layout adapts:

| Viewport width | TOC sidebar | Content area |
|---|---|---|
| > 900px | Visible, 240px wide | Fills remaining space, max-width 720px centered |
| 600–900px | Collapsed by default, overlay on toggle | Full width, padded |
| < 600px | Hidden, toggle reveals full-screen overlay | Full width, minimal padding |

---

## 6. Pinyin Integration

### Direct Import Path

The reader page is an extension page, so it can import modules directly without message passing:

```typescript
// reader.ts — direct imports, no chrome.runtime.sendMessage
import { convertToPinyin } from "../background/pinyin-service";
import { queryLLM } from "../background/llm-client";
import { hashText, getFromCache, saveToCache } from "../background/cache";
import { recordWords } from "../background/vocab-store";
import { containsChinese, extractSurroundingContext } from "../shared/chinese-detect";
import { showOverlay, updateOverlay, dismissOverlay } from "../content/overlay";
```

The overlay module (`overlay.ts`) is DOM-only with no Chrome API dependencies, so it works in the reader page without modification. The pinyin service and LLM client use only `fetch` and `chrome.storage` — both available on extension pages.

### Selection Handling in the Reader

epub.js renders content inside an iframe. Text selection events must be captured from the iframe's document, not the reader page's document:

```typescript
rendition.on("selected", (cfiRange: string, contents: Contents) => {
  const selection = contents.window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text || !containsChinese(text)) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  // Adjust rect to reader page coordinates (iframe offset)
  const iframeRect = contents.document.defaultView!
    .frameElement!.getBoundingClientRect();
  const adjustedRect = new DOMRect(
    rect.left + iframeRect.left,
    rect.top + iframeRect.top,
    rect.width,
    rect.height,
  );

  processSelection(text, adjustedRect, contents);
});
```

epub.js provides a `"selected"` event on the rendition that fires with the CFI range and the `Contents` object (which gives access to the iframe's `window` and `document`). This avoids the cross-frame `getSelection()` problem entirely.

### Two-Phase Flow (Reader Version)

The same two-phase pattern as the content script, but with direct function calls:

```typescript
async function processSelection(
  text: string,
  rect: DOMRect,
  contents: Contents,
): void {
  const requestId = ++currentRequestId;

  // Phase 1: instant local pinyin
  const settings = await getSettings();
  const words = convertToPinyin(truncated, settings.pinyinStyle);
  if (requestId !== currentRequestId) return;
  showOverlay(words, rect, settings.theme, settings.ttsEnabled);

  // Phase 2: LLM enrichment (if enabled)
  if (!settings.llmEnabled) return;

  const context = getChapterContext(contents);
  const cacheKey = await hashText(truncated + context);
  const cached = await getFromCache(cacheKey);

  if (cached) {
    if (requestId !== currentRequestId) return;
    updateOverlay(cached.words, cached.translation, settings.ttsEnabled);
    recordWords(cached.words);
    return;
  }

  const config = buildLLMConfig(settings);
  const result = await queryLLM(truncated, context, config);

  if (result && requestId === currentRequestId) {
    await saveToCache(cacheKey, result);
    updateOverlay(result.words, result.translation, settings.ttsEnabled);
    recordWords(result.words);
  }
}
```

### Reader-Specific Context Extraction

On web pages, `extractSurroundingContext()` walks up the DOM to the nearest block-level parent. In the reader, the context source is the current chapter's text — typically richer and more coherent than a random web page paragraph:

```typescript
function getChapterContext(contents: Contents): string {
  const body = contents.document.body;
  if (!body) return "";
  const text = body.textContent ?? "";
  return text.length > 500 ? text.slice(0, 500) : text;
}
```

Using the chapter text as context gives the LLM better disambiguation material, since book text is typically more coherent than web page fragments.

### Overlay Positioning

The overlay module's `calculatePosition()` function works without changes — it takes a `DOMRect` and viewport dimensions, both of which are available in the reader page. The only adjustment is translating the iframe-local selection rect to reader-page coordinates (shown in the selection handler above).

### Dismiss Behavior

Same as the content script:
- Click outside the overlay: dismiss
- Press Escape: dismiss
- New selection: dismiss previous, show new

The reader page attaches the same `mousedown` and `keydown` listeners as `content.ts`.

---

## 7. Manifest Changes

### New Page Declaration

The reader page must be accessible as a full tab. Add it to `manifest.json`:

```json
{
  "chrome_url_overrides": {},
  "web_accessible_resources": [
    {
      "resources": ["assets/*", "tesseract/*", "src/reader/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

The reader page is opened programmatically via:

```typescript
chrome.tabs.create({
  url: chrome.runtime.getURL("src/reader/reader.html"),
});
```

### Vite Build Integration

The reader page is an HTML entry point. `vite-plugin-web-extension` discovers it automatically because it's referenced in the manifest or in `web_accessible_resources`. If not auto-discovered, it can be added as an explicit Vite entry point:

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      additionalInputs: ["src/reader/reader.html"],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

### No New Permissions Required

The reader uses only APIs the extension already has permission for:

| API | Permission | Already declared |
|---|---|---|
| `chrome.storage.sync` | `storage` | Yes |
| `chrome.storage.local` | `storage` | Yes |
| `chrome.tabs.create` | None (own extension pages) | N/A |
| `fetch` (LLM calls) | `host_permissions: <all_urls>` | Yes |

---

## 8. File and Folder Structure

### New Files

```
src/
├── reader/
│   ├── reader.html               # Reader page markup (full-tab layout)
│   ├── reader.ts                 # Reader entry point: file loading, renderer lifecycle,
│   │                             #   pinyin integration, settings, state persistence
│   ├── reader.css                # Reader styles: layout, themes, sidebar, toolbar,
│   │                             #   drop zone, responsive breakpoints
│   ├── reader-types.ts           # Reader-specific types: ReaderSettings, BookMetadata,
│   │                             #   TocEntry, FormatRenderer interface, ReadingState
│   └── renderers/
│       ├── epub-renderer.ts      # epub.js-based EPUB renderer (FormatRenderer impl)
│       ├── text-renderer.ts      # Plain text renderer (future, FormatRenderer impl)
│       └── renderer-registry.ts  # Maps file extensions to renderer constructors;
│                                 #   getRendererForFile(file: File): FormatRenderer
tests/
├── reader/
│   ├── reader.test.ts            # File loading, renderer selection, pinyin flow
│   ├── epub-renderer.test.ts     # EPUB parsing, navigation, text extraction
│   └── renderer-registry.test.ts # Extension matching, unknown format handling
```

### Renderer Registry

A simple lookup table that maps file extensions to renderer constructors:

```typescript
// renderer-registry.ts

import { EpubRenderer } from "./epub-renderer";
import type { FormatRenderer } from "../reader-types";

type RendererConstructor = new () => FormatRenderer;

const RENDERERS: Map<string, RendererConstructor> = new Map([
  [".epub", EpubRenderer],
  // [".txt", TextRenderer],     // future
  // [".pdf", PdfRenderer],      // future
  // [".srt", SubtitleRenderer],  // future
]);

export function getRendererForFile(file: File): FormatRenderer | null {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  const Ctor = RENDERERS.get(ext);
  return Ctor ? new Ctor() : null;
}

export function getSupportedExtensions(): string[] {
  return Array.from(RENDERERS.keys());
}
```

### New Dependency

```bash
npm install epubjs
npm install -D @types/epubjs  # if type definitions are separate
```

epub.js bundles JSZip internally for EPUB archive extraction.

---

## 9. Data Flow

### File Open to Rendered Content

```
User drops/selects a file
        │
        ▼
[1] reader.ts: determine format from extension
        │
        ▼
[2] renderer-registry.ts: getRendererForFile(file)
        │ returns FormatRenderer (e.g. EpubRenderer)
        ▼
[3] renderer.load(file)
        │ parses file, returns BookMetadata
        ▼
[4] reader.ts: update UI with metadata
        │ - set title bar
        │ - populate TOC sidebar
        │ - show cover image (if present)
        │ - restore reading position (if previously opened)
        ▼
[5] renderer.renderTo(contentContainer)
        │ renders first chapter (or restored position) into the DOM
        ▼
[6] reader.ts: attach selection listeners to rendered content
        │ - epub.js "selected" event
        │ - mouseup fallback for non-EPUB renderers
        ▼
[7] User selects Chinese text within rendered content
        │
        ├──────────────────────────────────┐
        ▼                                  ▼
[8a] convertToPinyin() (instant)    [8b] queryLLM() (async, if enabled)
     direct import, < 50ms                direct import, 1-3s
        │                                  │
        ▼                                  ▼
[9a] showOverlay()                  [9b] updateOverlay()
     Phase 1: local pinyin               Phase 2: definitions + translation
                                           │
                                           ▼
                                    [10] saveToCache() + recordWords()
                                         side effects: cache + vocab
```

### Navigation Flow

```
User clicks TOC entry / Next / Prev
        │
        ▼
[1] renderer.goTo(href) / renderer.next() / renderer.prev()
        │
        ▼
[2] epub.js loads and renders new chapter content
        │
        ▼
[3] reader.ts: save reading position to chrome.storage.local
        │
        ▼
[4] reader.ts: update progress bar and chapter indicator
        │
        ▼
[5] reader.ts: re-attach selection listeners to new content
```

---

## 10. Reading State Persistence

### What Gets Persisted

| Data | Storage area | Key format | Updated when |
|---|---|---|---|
| Current reading position (CFI) | `chrome.storage.local` | `reader_state_{fileHash}` | Chapter navigation, scroll, page unload |
| Recently opened files | `chrome.storage.local` | `reader_recent` | File opened |
| Reader display preferences | `chrome.storage.sync` | `readerSettings` | User changes settings |

### Reading State Shape

```typescript
interface ReadingState {
  fileHash: string;
  fileName: string;
  title: string;
  author: string;
  location: string;       // CFI string or chapter index
  currentChapter: number;
  totalChapters: number;
  lastOpened: number;      // Date.now()
  coverDataUrl?: string;   // small thumbnail for recent files list
}

interface ReaderSettings {
  fontSize: number;        // 14-28, default 18
  fontFamily: string;      // "system" | "serif" | "sans-serif" | "noto-sans" | "noto-serif"
  lineSpacing: number;     // 1.4-2.2, default 1.8
  theme: "light" | "dark" | "sepia" | "auto";
  readingMode: "scroll" | "paginated";
}
```

### File Identification

Files are identified by a hash of their name and size (not content — hashing a full EPUB for identification would be too slow):

```typescript
async function getFileHash(file: File): Promise<string> {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  const encoded = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
```

### Recent Files List

Stored as an array of `ReadingState` objects under the `reader_recent` key. Capped at 20 entries. On file open, the entry is added or moved to the front. On the landing page, recent files are displayed with title, author, last chapter, and a small cover thumbnail.

### Auto-Save

Reading position is saved on:
- Chapter navigation (next/prev/TOC click)
- `beforeunload` event (tab close)
- Periodic interval (every 30 seconds while the reader is active)

On re-opening the same file, the reader restores position via `renderer.goTo(savedState.location)`.

---

## 11. Implementation Phases

### Phase 1 — Reader Shell + EPUB + Pinyin (MVP)

**Goal**: A functional EPUB reader with full pinyin integration.

| Task | Files | Depends on |
|---|---|---|
| Create reader page scaffolding | `reader.html`, `reader.ts`, `reader.css` | — |
| Implement `FormatRenderer` interface and types | `reader-types.ts` | — |
| Build `EpubRenderer` with epub.js | `renderers/epub-renderer.ts` | FormatRenderer interface |
| Build renderer registry | `renderers/renderer-registry.ts` | EpubRenderer |
| File loading (drag-and-drop + file picker) | `reader.ts` | Renderer registry |
| TOC sidebar and navigation (prev/next) | `reader.ts`, `reader.css` | EpubRenderer |
| Selection handling within epub.js iframe | `reader.ts` | EpubRenderer |
| Direct pinyin integration (two-phase) | `reader.ts` | Overlay module, pinyin-service, llm-client |
| Reader theme support (light/dark/sepia) | `reader.css`, `reader.ts` | — |
| Reader settings (font size, line spacing, etc.) | `reader.ts` | — |
| Manifest changes and Vite config update | `manifest.json`, `vite.config.ts` | — |
| Popup "Open Reader" button | `popup.html`, `popup.ts` | Reader page |
| Basic tests | `tests/reader/` | All above |

**Estimated effort**: 3-5 days.

### Phase 2 — Reading State and Polish

**Goal**: Persistent reading state and polished reading experience.

| Task | Files | Depends on |
|---|---|---|
| Reading state persistence (position, bookmarks) | `reader.ts` | Phase 1 |
| Recent files list on landing page | `reader.ts`, `reader.css` | Reading state |
| Auto-save on navigation and tab close | `reader.ts` | Reading state |
| Paginated reading mode | `reader.ts`, `reader.css` | Phase 1 |
| Keyboard shortcuts (arrow keys, Escape) | `reader.ts` | Phase 1 |
| Progress bar with chapter indicator | `reader.css`, `reader.ts` | Phase 1 |

**Estimated effort**: 2-3 days.

### Phase 3 — Additional Format Renderers

**Goal**: Support for plain text, PDF, and subtitles.

| Task | Files | Depends on |
|---|---|---|
| `TextRenderer` (plain text / paste input) | `renderers/text-renderer.ts` | FormatRenderer interface |
| `PdfRenderer` (pdf.js integration) | `renderers/pdf-renderer.ts` | FormatRenderer interface |
| `SubtitleRenderer` (SRT/VTT parser) | `renderers/subtitle-renderer.ts` | FormatRenderer interface |
| Update file picker accept list | `reader.ts` | New renderers |
| Update renderer registry | `renderers/renderer-registry.ts` | New renderers |
| Per-format tests | `tests/reader/` | New renderers |

**Estimated effort**: 3-5 days (PDF is the bulk).

### Phase 4 — Advanced Features

**Goal**: Power-user features for serious study.

| Task | Description |
|---|---|
| Full-text search within the loaded file | epub.js has a search API; implement UI for it |
| Text highlighting and annotations | Save highlighted passages to chrome.storage.local |
| Export vocab from reading session | Filter vocab list by "words encountered in this book" |
| Reading statistics | Time spent, characters read, words looked up per session |
| Batch pinyin mode | Toggle to show pinyin above all visible Chinese text, not just selected |
| Custom CSS injection | Let users apply their own CSS to the rendered content |

---

## 12. Future Format Implementation Notes

### Plain Text (`.txt`)

**Complexity**: Trivial.

```typescript
class TextRenderer implements FormatRenderer {
  readonly formatName = "Plain Text";
  readonly extensions = [".txt"];

  private text = "";
  private container: HTMLElement | null = null;

  async load(file: File): Promise<BookMetadata> {
    this.text = await file.text();
    return {
      title: file.name.replace(/\.txt$/i, ""),
      author: "Unknown",
      toc: [],
      totalChapters: 1,
      currentChapter: 0,
    };
  }

  async renderTo(container: HTMLElement): Promise<void> {
    this.container = container;
    const pre = document.createElement("div");
    pre.className = "reader-text-content";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = this.text;
    container.innerHTML = "";
    container.appendChild(pre);
  }

  async goTo(): Promise<void> { /* single page, no-op */ }
  async next(): Promise<boolean> { return false; }
  async prev(): Promise<boolean> { return false; }
  getCurrentLocation(): string { return "0"; }

  getVisibleText(): string {
    return this.text.slice(0, 500);
  }

  destroy(): void {
    this.text = "";
    this.container = null;
  }
}
```

No external dependencies. Selection handling uses the standard `mouseup` listener on the container element. A paste/type variant can reuse this renderer with text from a `<textarea>` instead of a file.

### PDF (`.pdf`)

**Complexity**: Medium-high.

**Library**: pdf.js (`pdfjs-dist` npm package) — the same renderer Firefox uses to display PDFs natively. Mature, actively maintained by Mozilla.

**Key challenges for Chinese text**:
- PDF stores text as positioned glyphs, not semantic characters. Text extraction relies on pdf.js's `getTextContent()` API, which reconstructs reading order from glyph positions. This works well for horizontal Chinese text but can struggle with vertical layouts or complex multi-column designs.
- Some Chinese PDFs are scanned images with no text layer. These would need the OCR path (Tesseract, already partially integrated in the extension).
- Font embedding varies — some PDFs subset fonts aggressively, which can cause display issues. pdf.js handles most cases.

**Rendering approach**: pdf.js renders each page to a `<canvas>` element for visual fidelity, with an invisible text layer (`<div>` overlay with positioned `<span>` elements) for selection. This text layer is where `getSelection()` operates, and where the pinyin overlay would attach.

```typescript
class PdfRenderer implements FormatRenderer {
  // Uses pdfjs-dist:
  //   import * as pdfjsLib from "pdfjs-dist";
  //   import "pdfjs-dist/web/pdf_viewer.css";
  //
  // Renders pages to canvas + text layer overlay.
  // Navigation is by page number rather than chapter.
  // TOC extracted from PDF outline (if present).
}
```

### SRT / VTT Subtitles (`.srt`, `.vtt`)

**Complexity**: Low.

SRT is a dead-simple format:

```
1
00:01:05,000 --> 00:01:08,000
你好，欢迎来到我们的节目

2
00:01:09,000 --> 00:01:12,500
今天我们要讨论一个有趣的话题
```

A custom parser (no external dependency) reads timestamp + text pairs. The renderer displays them as a scrollable list of subtitle blocks, each with its timestamp visible. Clicking a block selects its text for pinyin annotation.

VTT is nearly identical to SRT with a header line and slightly different timestamp format. ASS/SSA is more complex (has styling directives) but the text content is extractable with a regex.

**Rendering approach**: A styled list where each subtitle entry is a `<div>` with the timestamp and text. The entire subtitle file is rendered at once (no pagination needed — subtitle files are small).

### HTML (`.html`, `.htm`)

**Complexity**: Low.

Render the HTML inside a sandboxed `<iframe>` with `sandbox="allow-same-origin"` (no `allow-scripts` — we don't want arbitrary JavaScript from saved pages to run). Selection handling attaches to the iframe's document via `iframe.contentDocument`.

Alternatively, use `DOMParser` to parse the HTML and inject sanitized content into a `<div>`, stripping `<script>` tags and `on*` event handlers. This avoids iframe complexity but requires sanitization.

### Markdown (`.md`)

**Complexity**: Low.

**Library**: `marked` (lightweight, widely used) or `markdown-it` (more extensible, plugin ecosystem). Converts Markdown to HTML, then renders like an HTML file.

```typescript
import { marked } from "marked";

class MarkdownRenderer implements FormatRenderer {
  async renderTo(container: HTMLElement): Promise<void> {
    container.innerHTML = marked.parse(this.rawText);
  }
}
```

### DOCX (`.docx`)

**Complexity**: Medium.

**Library**: mammoth.js converts DOCX to clean, semantic HTML. The output is minimal (no complex Office styling preserved) but readable. After conversion, render the HTML in the content area and attach selection handlers.

### MOBI / AZW (`.mobi`, `.azw`, `.azw3`)

**Complexity**: High.

Amazon's Kindle formats are proprietary. Options:
1. **mobi.js** — JavaScript MOBI parser (limited maintenance, may not handle all variants)
2. **Convert to EPUB** — use a WASM build of Calibre's conversion engine (complex, large binary)
3. **Recommend conversion** — inform the user to convert to EPUB using Calibre before loading

DRM-protected files (the majority of purchased Kindle books) cannot be read regardless of approach. Given the complexity and DRM limitations, this format is lowest priority.

### FB2 (`.fb2`)

**Complexity**: Medium-low.

FB2 (FictionBook) is an XML format with a well-defined schema. A custom XML parser using `DOMParser` can extract the text content, metadata, and images. The format is popular in Russian and Chinese ebook communities (particularly for public domain and fan-translated works).

```xml
<FictionBook>
  <description>
    <title-info>
      <book-title>三体</book-title>
      <author><first-name>刘</first-name><last-name>慈欣</last-name></author>
    </title-info>
  </description>
  <body>
    <section><title><p>第一章</p></title>
      <p>中国，1967年。</p>
      <p>...</p>
    </section>
  </body>
</FictionBook>
```

No external library needed — standard `DOMParser` handles the XML. The renderer would walk the `<section>` / `<p>` tree and render as HTML.

### Common Renderer Checklist

When implementing any new `FormatRenderer`, ensure:

- [ ] `load()` extracts metadata and TOC (or empty TOC for flat formats)
- [ ] `renderTo()` produces selectable text in the container
- [ ] `getVisibleText()` returns text suitable for LLM context extraction
- [ ] Selection events fire correctly for Chinese text
- [ ] `getCurrentLocation()` returns a value that `goTo()` can restore
- [ ] `destroy()` cleans up all resources and event listeners
- [ ] Add the renderer to `renderer-registry.ts`
- [ ] Update the file picker's `accept` attribute
- [ ] Add basic tests in `tests/reader/`
