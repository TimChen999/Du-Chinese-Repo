/**
 * PDF (.pdf) renderer powered by pdf.js.
 *
 * PDF is the only non-EPUB format that does NOT extend
 * DomRendererBase: pages are fixed-size canvas + text-layer pairs
 * (so text doesn't reflow), navigation is per-page, and "font size"
 * really means "render scale". Sharing the base class would force
 * shoehorning all of that through scroll-based location semantics,
 * which would make zoom and outline TOCs awkward.
 *
 * Architecture:
 *   load()       parses the document, pulls metadata + outline TOC.
 *   renderTo()   renders every page eagerly as <canvas> + invisible
 *                positioned text layer. Selection works on the text
 *                layer via the standard Selection API.
 *   navigation:  next/prev/goTo move the relevant page into view via
 *                scrollIntoView. An IntersectionObserver tracks which
 *                page is currently visible for getCurrentLocation()
 *                and the relocated callback.
 *   settings:    fontSize maps to a render scale (fontSize / 18 *
 *                BASE_SCALE), triggering a re-render of all pages.
 *                Dark theme applies CSS filter inversion to the
 *                container so canvas content matches the surrounding
 *                page chrome.
 *
 * Worker: pdf.js requires a separate worker script. We resolve its
 * URL via Vite's `?url` import (which produces a hashed asset path
 * at build time). In tests pdfjs-dist is mocked entirely, so the
 * worker resolution path never runs.
 *
 * Eager render is intentional v1. Large PDFs (>200 pages) may benefit
 * from IntersectionObserver-based lazy rendering later; the per-page
 * scaffold (`<div class="pdf-page">`) was chosen with that future
 * refactor in mind.
 */

import type {
  FormatRenderer,
  BookMetadata,
  TocEntry,
  ReaderSettings,
  BookmarkAnchor,
} from "../reader-types";
import { windowAroundAnchor } from "../../shared/chinese-detect";

const BASE_SCALE = 1.5;
const DEFAULT_FONT_SIZE = 18;
const ANCHOR_CONTEXT_CHARS = 20;

interface PdfTextItemRecord {
  str: string;
  startCharOffset: number;
}

interface PdfRenderedPage {
  pageNum: number;
  wrap: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayerEl: HTMLElement;
  items: PdfTextItemRecord[];
  pageText: string;
}

export class PdfRenderer implements FormatRenderer {
  readonly formatName = "PDF";
  readonly extensions = [".pdf"];

  private pdf: any = null;
  private container: HTMLElement | null = null;
  private numPages = 0;
  private currentPage = 1;
  private scale = BASE_SCALE;
  private theme: ReaderSettings["theme"] = "auto";
  private renderedPages: PdfRenderedPage[] = [];
  private relocatedCallback: ((index: number) => void) | null = null;
  private pageObserver: IntersectionObserver | null = null;
  private title = "";
  private author = "";

  async load(file: File): Promise<BookMetadata> {
    const pdfjsLib = await loadPdfjs();
    const arrayBuffer = await file.arrayBuffer();
    this.pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    this.numPages = this.pdf.numPages;

    this.title = file.name.replace(/\.pdf$/i, "") || file.name;
    this.author = "Unknown";
    try {
      const meta = await this.pdf.getMetadata();
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      const t = typeof info.Title === "string" ? info.Title.trim() : "";
      const a = typeof info.Author === "string" ? info.Author.trim() : "";
      if (t) this.title = t;
      if (a) this.author = a;
    } catch {
      // Metadata is optional; many PDFs lack it. Fall back to defaults.
    }

    let toc: TocEntry[] = [];
    try {
      const outline = await this.pdf.getOutline();
      if (Array.isArray(outline) && outline.length > 0) {
        toc = await this.convertOutline(outline);
      }
    } catch {
      // Outline is also optional.
    }

    return {
      title: this.title,
      author: this.author,
      toc,
      totalChapters: this.numPages,
      currentChapter: 0,
    };
  }

  async renderTo(container: HTMLElement): Promise<void> {
    if (!this.pdf) throw new Error("No PDF loaded");
    this.container = container;
    container.innerHTML = "";
    container.classList.add("pdf-container");
    this.applyThemeClass();

    this.renderedPages = [];
    for (let i = 1; i <= this.numPages; i++) {
      const page = await this.renderPage(i);
      container.appendChild(page.wrap);
      this.renderedPages.push(page);
    }

    this.attachPageObserver();
  }

  async goTo(location: string | number): Promise<void> {
    if (!this.container) return;
    const pageNum = typeof location === "number" ? location : parseInt(location, 10);
    if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > this.numPages) return;
    this.scrollToPage(pageNum, true);
  }

  async next(): Promise<boolean> {
    if (this.currentPage >= this.numPages) return false;
    this.scrollToPage(this.currentPage + 1, false);
    return true;
  }

  async prev(): Promise<boolean> {
    if (this.currentPage <= 1) return false;
    this.scrollToPage(this.currentPage - 1, false);
    return true;
  }

  getCurrentLocation(): string {
    return String(this.currentPage);
  }

  getVisibleText(anchor?: string): string {
    const target = this.renderedPages.find((p) => p.pageNum === this.currentPage);
    if (!target) return "";
    const text = target.textLayerEl.textContent ?? "";
    return windowAroundAnchor(text, anchor ?? "");
  }

  /**
   * PDFs don't have an EPUB-style spine. Outline entries always
   * resolve to numeric page indexes which goTo(number) handles
   * directly, so the reader never asks for a spine index lookup.
   */
  getSpineIndex(_href: string): number {
    return -1;
  }

  onRelocated(callback: (spineIndex: number) => void): void {
    this.relocatedCallback = callback;
  }

  /**
   * Anchor on (page, item index, offset within item.str). The text
   * layer DOM is rebuilt on every zoom (rerenderAllPages clears all
   * containers), so we anchor on data the rebuild reproduces, not on
   * DOM identity. Item indices match the order pdf.js returns from
   * getTextContent(), which is stable for the same PDF + version.
   */
  captureAnchor(hint?: { wordRange: Range }): BookmarkAnchor | null {
    if (typeof window === "undefined") return null;
    const range = hint?.wordRange ?? (() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      return sel.getRangeAt(0);
    })();
    if (!range) return null;
    const layerEl = closestPdfTextLayer(range.startContainer);
    if (!layerEl) return null;

    const page = this.renderedPages.find((p) => p.textLayerEl === layerEl);
    if (!page) return null;

    const word = range.toString().trim();
    if (!word) return null;

    const anchorElement = closestPdfSpan(range.startContainer, layerEl);
    let itemIndex = 0;
    let charOffset = 0;
    if (anchorElement) {
      const spans = Array.from(layerEl.querySelectorAll<HTMLElement>("span"));
      const idx = spans.indexOf(anchorElement);
      if (idx >= 0 && idx < page.items.length) {
        itemIndex = idx;
        charOffset = clampOffset(range.startOffset, page.items[idx].str.length);
      } else {
        const found = locateInItems(page.items, word);
        if (found) {
          itemIndex = found.itemIndex;
          charOffset = found.charOffset;
        }
      }
    } else {
      const found = locateInItems(page.items, word);
      if (found) {
        itemIndex = found.itemIndex;
        charOffset = found.charOffset;
      }
    }

    const absoluteOffset =
      (page.items[itemIndex]?.startCharOffset ?? 0) + charOffset;
    const contextBefore = page.pageText.slice(
      Math.max(0, absoluteOffset - ANCHOR_CONTEXT_CHARS),
      absoluteOffset,
    );
    const contextAfter = page.pageText.slice(
      absoluteOffset + word.length,
      absoluteOffset + word.length + ANCHOR_CONTEXT_CHARS,
    );

    return {
      word,
      contextBefore,
      contextAfter,
      payload: {
        kind: "pdf",
        page: page.pageNum,
        itemIndex,
        charOffset,
      },
    };
  }

  async goToAnchor(anchor: BookmarkAnchor): Promise<boolean> {
    if (anchor.payload.kind !== "pdf") return false;
    const { page: pageNum, itemIndex, charOffset } = anchor.payload;
    if (pageNum < 1 || pageNum > this.numPages) return false;

    await this.goTo(pageNum);

    const page = this.renderedPages.find((p) => p.pageNum === pageNum);
    if (!page) return true; // page-level jump succeeded

    let resolvedIndex = itemIndex;
    let resolvedOffset = charOffset;
    const expected = page.items[itemIndex]?.str ?? "";
    if (
      itemIndex < 0 ||
      itemIndex >= page.items.length ||
      charOffset + anchor.word.length > expected.length ||
      expected.slice(charOffset, charOffset + anchor.word.length) !==
        anchor.word
    ) {
      const fallback = locateInItems(page.items, anchor.word, anchor.contextBefore);
      if (fallback) {
        resolvedIndex = fallback.itemIndex;
        resolvedOffset = fallback.charOffset;
      }
    }

    const spans = Array.from(
      page.textLayerEl.querySelectorAll<HTMLElement>("span"),
    );
    const targetSpan = spans[resolvedIndex];
    if (targetSpan) {
      targetSpan.scrollIntoView({ block: "center" });
    }
    void resolvedOffset;
    return true;
  }

  applySettings(settings: ReaderSettings): void {
    if (!this.pdf || !this.container) return;
    const newScale = (settings.fontSize / DEFAULT_FONT_SIZE) * BASE_SCALE;
    const themeChanged = settings.theme !== this.theme;
    this.theme = settings.theme;

    if (Math.abs(newScale - this.scale) > 0.01) {
      this.scale = newScale;
      this.rerenderAllPages();
    }
    if (themeChanged) {
      this.applyThemeClass();
    }
  }

  destroy(): void {
    this.pageObserver?.disconnect();
    this.pageObserver = null;
    if (this.container) {
      this.container.innerHTML = "";
      this.container.classList.remove("pdf-container", "pdf-dark");
    }
    if (this.pdf && typeof this.pdf.destroy === "function") {
      this.pdf.destroy();
    }
    this.pdf = null;
    this.container = null;
    this.renderedPages = [];
    this.relocatedCallback = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Scroll the rendered wrapper for `pageNum` into view, update the
   * current-page state, and (when `fireRelocated` is true) notify the
   * reader's relocated callback.
   *
   * Why the explicit notification: assigning `this.currentPage` here
   * preempts the IntersectionObserver path. The observer is gated on
   * `bestPage !== this.currentPage`, so by the time post-scroll
   * entries arrive that gate is already false and the callback never
   * fires. Without this, programmatic jumps (TOC click, bookmark
   * jump, restored reading state) would scroll the content but leave
   * the reader's metadata.currentChapter -- and therefore the footer
   * page indicator -- pinned to whatever the user was on before.
   *
   * Why next()/prev() pass false: the reader's prev/next button
   * handlers already increment/decrement metadata.currentChapter
   * after the awaited call returns. Firing the callback here too
   * would step the indicator twice, skipping pages in the footer
   * even though the content scrolled by exactly one.
   */
  private scrollToPage(pageNum: number, fireRelocated: boolean): void {
    const target = this.renderedPages.find((p) => p.pageNum === pageNum);
    if (!target) return;
    target.wrap.scrollIntoView({ block: "start" });
    if (pageNum !== this.currentPage) {
      this.currentPage = pageNum;
      if (fireRelocated) this.relocatedCallback?.(pageNum - 1);
    }
  }

  private async renderPage(pageNum: number): Promise<PdfRenderedPage> {
    const pdfjsLib = await loadPdfjs();
    const page = await this.pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.scale });

    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.dataset.pageNum = String(pageNum);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = "pdf-canvas";
    wrap.appendChild(canvas);

    const textLayerEl = document.createElement("div");
    textLayerEl.className = "pdf-text-layer";
    textLayerEl.style.setProperty("--scale-factor", String(this.scale));
    textLayerEl.style.width = `${viewport.width}px`;
    textLayerEl.style.height = `${viewport.height}px`;
    wrap.appendChild(textLayerEl);

    const ctx = canvas.getContext("2d");
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    }

    let items: PdfTextItemRecord[] = [];
    let pageText = "";
    try {
      const textContent = await page.getTextContent();
      const rawItems: any[] = Array.isArray(textContent?.items)
        ? textContent.items
        : [];
      let cursor = 0;
      items = rawItems.map((it) => {
        const str = typeof it?.str === "string" ? it.str : "";
        const record: PdfTextItemRecord = { str, startCharOffset: cursor };
        cursor += str.length;
        return record;
      });
      pageText = items.map((it) => it.str).join("");

      const TextLayerCtor: any = (pdfjsLib as any).TextLayer;
      if (TextLayerCtor) {
        const textLayer = new TextLayerCtor({
          textContentSource: textContent,
          container: textLayerEl,
          viewport,
        });
        await textLayer.render();
      }
    } catch {
      // Text layer is best-effort. Without it the page is still
      // readable visually; only selection-based pinyin is impacted.
    }

    return { pageNum, wrap, canvas, textLayerEl, items, pageText };
  }

  private async rerenderAllPages(): Promise<void> {
    if (!this.container) return;
    // Capture the page the user was reading; the rebuild below clears
    // the container and otherwise lands the viewport at the top of the
    // PDF (page 1), which is the most user-visible regression from a
    // font-size / zoom change.
    const restorePage = this.currentPage;
    const previous = this.renderedPages;
    const newRendered: PdfRenderedPage[] = [];
    this.container.innerHTML = "";
    for (let i = 1; i <= this.numPages; i++) {
      const page = await this.renderPage(i);
      this.container.appendChild(page.wrap);
      newRendered.push(page);
    }
    this.renderedPages = newRendered;
    void previous;
    this.attachPageObserver();
    if (restorePage > 1 && restorePage <= this.numPages) {
      await this.goTo(restorePage);
    }
  }

  private applyThemeClass(): void {
    if (!this.container) return;
    const isDark =
      this.theme === "dark" ||
      (this.theme === "auto" &&
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    this.container.classList.toggle("pdf-dark", isDark);
  }

  private attachPageObserver(): void {
    this.pageObserver?.disconnect();
    if (typeof IntersectionObserver === "undefined" || !this.container) return;

    this.pageObserver = new IntersectionObserver(
      (entries) => {
        let bestPage = this.currentPage;
        let bestRatio = 0;
        for (const entry of entries) {
          const pageNum = parseInt(
            (entry.target as HTMLElement).dataset.pageNum ?? "0",
            10,
          );
          if (entry.intersectionRatio > bestRatio && pageNum > 0) {
            bestRatio = entry.intersectionRatio;
            bestPage = pageNum;
          }
        }
        if (bestPage !== this.currentPage && bestRatio > 0) {
          this.currentPage = bestPage;
          this.relocatedCallback?.(bestPage - 1);
        }
      },
      { threshold: [0.1, 0.5, 0.9] },
    );

    for (const page of this.renderedPages) {
      this.pageObserver.observe(page.wrap);
    }
  }

  private async convertOutline(outline: any[]): Promise<TocEntry[]> {
    const out: TocEntry[] = [];
    for (const node of outline) {
      const label = (node.title ?? "").trim();
      if (!label) continue;
      const pageNum = await this.resolveDestinationPage(node.dest);
      const entry: TocEntry = {
        label,
        href: pageNum > 0 ? String(pageNum) : "",
        level: 0,
        children: undefined,
      };
      if (Array.isArray(node.items) && node.items.length > 0) {
        entry.children = await this.convertOutline(node.items);
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Resolve a pdf.js outline destination to a 1-based page number.
   *
   * A destination's first element ("destRef") can be either:
   *   - A page reference object {num, gen}, which must be looked up
   *     via pdf.getPageIndex() (only valid input shape; passing
   *     anything else throws "Invalid pageIndex request.").
   *   - An explicit integer page index (0-based), already the answer.
   *
   * Many PDFs (especially those generated by ebook conversion tools)
   * store outline destinations as integer indices, so handling only
   * the Ref case silently breaks every TOC entry in those documents:
   * getPageIndex() throws -> caught -> returns 0 -> href is "" -> the
   * reader's goTo("") parseInt's to NaN and bails. Mirrors the dual
   * dispatch in pdf.js's own PDFLinkService.goToDestination.
   */
  private async resolveDestinationPage(dest: any): Promise<number> {
    if (!this.pdf || dest == null) return 0;
    try {
      let resolved = dest;
      if (typeof dest === "string") {
        resolved = await this.pdf.getDestination(dest);
      }
      if (!Array.isArray(resolved) || resolved.length === 0) return 0;
      const destRef = resolved[0];

      if (Number.isInteger(destRef)) {
        return (destRef as number) + 1;
      }
      if (destRef && typeof destRef === "object") {
        const idx = await this.pdf.getPageIndex(destRef);
        return typeof idx === "number" ? idx + 1 : 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }
}

// ─── Bookmark-anchor helpers ───────────────────────────────────────

function closestPdfTextLayer(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      if (el.classList?.contains("pdf-text-layer")) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

function closestPdfSpan(
  node: Node,
  layer: HTMLElement,
): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== layer) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      if (el.tagName === "SPAN" && el.parentElement === layer) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

function clampOffset(offset: number, max: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(offset, max);
}

/**
 * Find `word` in a page's text-content items array. Used both as a
 * primary fallback when DOM-span lookup fails and as the goToAnchor
 * fallback when the saved (item, offset) doesn't land on `word` (e.g.
 * the same PDF was re-extracted by a newer pdfjs-dist version).
 */
function locateInItems(
  items: PdfTextItemRecord[],
  word: string,
  contextBefore?: string,
): { itemIndex: number; charOffset: number } | null {
  if (!word || items.length === 0) return null;

  const probe = contextBefore ? contextBefore + word : word;
  const probeOffset = contextBefore ? contextBefore.length : 0;

  for (let i = 0; i < items.length; i++) {
    const idx = items[i].str.indexOf(probe);
    if (idx >= 0) {
      return { itemIndex: i, charOffset: idx + probeOffset };
    }
  }
  if (probe !== word) {
    for (let i = 0; i < items.length; i++) {
      const idx = items[i].str.indexOf(word);
      if (idx >= 0) {
        return { itemIndex: i, charOffset: idx };
      }
    }
  }
  return null;
}

// ─── pdf.js loader ─────────────────────────────────────────────────

let pdfjsModulePromise: Promise<any> | null = null;

async function loadPdfjs(): Promise<any> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = (async () => {
      const lib = await import("pdfjs-dist");
      try {
        if (!lib.GlobalWorkerOptions.workerSrc) {
          // Vite resolves `?url` to the bundled worker file's hashed
          // public path. Without a worker pdf.js falls back to the
          // main thread, which works but is dramatically slower.
          const workerMod: any = await import(
            "pdfjs-dist/build/pdf.worker.min.mjs?url"
          );
          lib.GlobalWorkerOptions.workerSrc = workerMod.default ?? workerMod;
        }
      } catch {
        // Tests mock pdfjs-dist entirely; production builds always
        // resolve the worker via Vite. No-op fallback keeps load()
        // unblocked even if the worker URL can't be resolved.
      }
      return lib;
    })();
  }
  return pdfjsModulePromise;
}
