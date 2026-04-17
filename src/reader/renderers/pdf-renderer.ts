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
} from "../reader-types";

const BASE_SCALE = 1.5;
const DEFAULT_FONT_SIZE = 18;

interface PdfRenderedPage {
  pageNum: number;
  wrap: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayerEl: HTMLElement;
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
    const target = this.renderedPages.find((p) => p.pageNum === pageNum);
    if (target) {
      target.wrap.scrollIntoView({ block: "start" });
      this.currentPage = pageNum;
    }
  }

  async next(): Promise<boolean> {
    if (this.currentPage >= this.numPages) return false;
    await this.goTo(this.currentPage + 1);
    return true;
  }

  async prev(): Promise<boolean> {
    if (this.currentPage <= 1) return false;
    await this.goTo(this.currentPage - 1);
    return true;
  }

  getCurrentLocation(): string {
    return String(this.currentPage);
  }

  getVisibleText(): string {
    const target = this.renderedPages.find((p) => p.pageNum === this.currentPage);
    if (!target) return "";
    const text = target.textLayerEl.textContent ?? "";
    return text.length > 500 ? text.slice(0, 500) : text;
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

    try {
      const textContent = await page.getTextContent();
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

    return { pageNum, wrap, canvas, textLayerEl };
  }

  private async rerenderAllPages(): Promise<void> {
    if (!this.container) return;
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

  private async resolveDestinationPage(dest: any): Promise<number> {
    if (!this.pdf || dest == null) return 0;
    try {
      let resolved = dest;
      if (typeof dest === "string") {
        resolved = await this.pdf.getDestination(dest);
      }
      if (!Array.isArray(resolved) || resolved.length === 0) return 0;
      const ref = resolved[0];
      const idx = await this.pdf.getPageIndex(ref);
      return typeof idx === "number" ? idx + 1 : 0;
    } catch {
      return 0;
    }
  }
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
