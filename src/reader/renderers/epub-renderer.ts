/**
 * EPUB format renderer backed by epub.js.
 *
 * Handles the full EPUB specification: OPF parsing, spine navigation,
 * NCX/nav table of contents, XHTML content rendering, CSS, images,
 * and embedded fonts. epub.js uses JSZip internally for archive extraction.
 *
 * See: READER_SPEC.md Section 4 "EPUB Renderer -- Detailed Design".
 */

import ePub from "epubjs";
import type { Book, Rendition, NavItem } from "epubjs";
import type {
  FormatRenderer,
  BookMetadata,
  TocEntry,
  ReaderSettings,
  BookmarkAnchor,
} from "../reader-types";
import { FONT_FAMILY_MAP, THEME_COLORS } from "./_shared/typography";
import { windowAroundAnchor } from "../../shared/chinese-detect";

export { FONT_FAMILY_MAP, THEME_COLORS };

const ANCHOR_CONTEXT_CHARS = 20;

export class EpubRenderer implements FormatRenderer {
  readonly formatName = "EPUB";
  readonly extensions = [".epub"];

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private container: HTMLElement | null = null;
  private currentFlow: "scrolled-doc" | "paginated" = "scrolled-doc";
  private relocatedCallback: ((spineIndex: number) => void) | null = null;
  private iframeRenderedCallback: ((doc: Document) => void) | null = null;
  private lastKnownCfi = "";
  private pendingAnchor: BookmarkAnchor | null = null;

  /**
   * Registers a callback fired with each rendered spine-page iframe's
   * Document. The reader uses this to install click-flow listeners on
   * the iframe's document AND inject its `::highlight()` CSS rules.
   *
   * Called once per render() — the same callback fires multiple times
   * as the user navigates spine pages, since epub.js destroys + recreates
   * iframes on chapter changes (paginated mode) or appends new ones
   * (scrolled-doc mode).
   */
  onIframeRendered(cb: (doc: Document) => void): void {
    this.iframeRenderedCallback = cb;
    if (this.rendition) this.attachIframeRenderedHook(this.rendition);
  }

  private attachIframeRenderedHook(rendition: Rendition): void {
    rendition.on("rendered", (_section: unknown, contents: unknown) => {
      if (!this.iframeRenderedCallback) return;
      const doc = (contents as { document?: Document })?.document;
      if (doc) this.iframeRenderedCallback(doc);
    });
  }

  async load(file: File): Promise<BookMetadata> {
    const arrayBuffer = await file.arrayBuffer();
    this.book = ePub(arrayBuffer as any);
    await this.book.ready;

    const metadata = await this.book.loaded.metadata;
    const navigation = await this.book.loaded.navigation;

    return {
      title: metadata.title || file.name,
      author: (metadata as any).creator || "Unknown",
      language: (metadata as any).language,
      coverUrl: await this.extractCoverUrl(),
      toc: this.convertToc(navigation.toc),
      totalChapters: this.book.spine ? this.getSpineLength() : 0,
      currentChapter: 0,
    };
  }

  setInitialFlow(flow: "scrolled-doc" | "paginated"): void {
    this.currentFlow = flow;
  }

  async renderTo(container: HTMLElement): Promise<void> {
    if (!this.book) throw new Error("No book loaded");

    this.container = container;
    this.updateContainerClass();

    this.rendition = this.book.renderTo(container, {
      width: "100%",
      height: "100%",
      spread: "none",
      flow: this.currentFlow,
      allowScriptedContent: false,
    });

    this.suppressHorizontalOverflow(this.rendition);

    this.rendition.on("relocated", (location: any) => {
      const cfi = location?.start?.cfi;
      if (cfi) this.lastKnownCfi = cfi;
      const index = location?.start?.index;
      if (typeof index === "number" && this.relocatedCallback) {
        this.relocatedCallback(index);
      }
    });

    // Bind the iframe-rendered hook so callers that registered before
    // renderTo() still receive each spine page's iframe document.
    this.attachIframeRenderedHook(this.rendition);

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

    const beforeIndex = (this.rendition.currentLocation() as any)?.start?.index;
    await this.rendition.prev();

    if (this.currentFlow === "scrolled-doc") {
      const afterIndex = (this.rendition.currentLocation() as any)?.start?.index;
      if (typeof beforeIndex === "number" && typeof afterIndex === "number" && afterIndex !== beforeIndex) {
        const scrollEl = this.container?.querySelector(".epub-container") as HTMLElement;
        if (scrollEl) scrollEl.scrollTop = 0;
      }
    }

    return true;
  }

  getCurrentLocation(): string {
    if (!this.rendition) return "";
    const location = this.rendition.currentLocation() as any;
    return location?.start?.cfi ?? "";
  }

  getVisibleText(anchor?: string): string {
    if (!this.rendition) return "";
    const contents = this.rendition.getContents() as any;
    if (!contents) return "";
    const doc = Array.isArray(contents) ? contents[0] : contents;
    if (!doc?.document) return "";
    const fullText = doc.document.body?.textContent ?? "";
    return windowAroundAnchor(fullText, anchor ?? "");
  }

  destroy(): void {
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
    this.pendingAnchor = null;
  }

  getRendition(): Rendition | null {
    return this.rendition;
  }

  /**
   * Read the raw scroll offset of the `.epub-container` element in
   * scrolled-doc mode. Returns null if not in scroll mode or the
   * element isn't mounted yet. Used by the reader shell to snapshot
   * exact pixel position before a tab switch -- epub.js's CFI-based
   * restore can land on the spine-item start instead of the user's
   * actual scroll position when its internal resize handler fires.
   */
  getScrollContainerTop(): number | null {
    if (this.currentFlow !== "scrolled-doc") return null;
    const scrollEl = this.container?.querySelector(".epub-container") as HTMLElement | null;
    return scrollEl ? scrollEl.scrollTop : null;
  }

  /**
   * Force the `.epub-container` scroll offset directly, bypassing
   * epub.js's location/CFI logic. Paired with getScrollContainerTop()
   * for tab-switch restoration. No-op outside scrolled-doc mode.
   */
  setScrollContainerTop(top: number): void {
    if (this.currentFlow !== "scrolled-doc") return;
    const scrollEl = this.container?.querySelector(".epub-container") as HTMLElement | null;
    if (scrollEl) scrollEl.scrollTop = top;
  }

  /**
   * Stash the most recent CFI range from epub.js's `selected` event so
   * captureAnchor() can return a word-precise anchor on demand. The
   * reader's selection wiring calls this from inside the same handler
   * that already extracts the selection text + rect for the overlay.
   *
   * `selectedText` is what the user actually highlighted (passed
   * separately because reading the iframe Selection again here can
   * race with overlay activation).
   */
  recordSelectedAnchor(cfiRange: string, selectedText: string, contents?: any): void {
    if (!cfiRange || !selectedText) {
      return;
    }
    const word = selectedText.trim();
    if (!word) return;

    let contextBefore = "";
    let contextAfter = "";
    try {
      const doc = contents?.document as Document | undefined;
      const win = contents?.window as Window | undefined;
      const sel = win?.getSelection?.();
      if (sel && sel.rangeCount > 0 && doc?.body) {
        const range = sel.getRangeAt(0);
        const bodyText = doc.body.textContent ?? "";
        const idx = bodyText.indexOf(word);
        if (idx >= 0) {
          contextBefore = bodyText.slice(
            Math.max(0, idx - ANCHOR_CONTEXT_CHARS),
            idx,
          );
          contextAfter = bodyText.slice(
            idx + word.length,
            idx + word.length + ANCHOR_CONTEXT_CHARS,
          );
        }
        void range;
      }
    } catch {
      // Context extraction is best-effort; the CFI itself is the
      // authoritative anchor and works without surrounding snippets.
    }

    this.pendingAnchor = {
      word,
      contextBefore,
      contextAfter,
      payload: { kind: "epub", cfi: cfiRange },
    };
  }

  captureAnchor(hint?: { wordRange: Range }): BookmarkAnchor | null {
    // Click-flow path: derive a CFI from the clicked word's range so a
    // single click is enough to move the bookmark anchor. Without this
    // the user has to drag-select to update the anchor (only the
    // "selected" event fed pendingAnchor before).
    if (hint?.wordRange) {
      const fromClick = this.anchorFromWordRange(hint.wordRange);
      if (fromClick) return fromClick;
    }
    // Fallback: the drag-select path (epub.js "selected" event ->
    // recordSelectedAnchor) is still the source of truth when no click
    // hint is available, e.g. the right-click context-menu flow.
    return this.pendingAnchor;
  }

  /**
   * Build a CFI-backed anchor from a word Range that lives inside one
   * of the rendered spine iframes. We locate the `contents` whose
   * iframe document contains the range, ask epub.js for the CFI of the
   * range, and pull surrounding context out of that document's body
   * text. Returns null if no spine iframe owns the range or if epub.js
   * refuses the range (defensive — cfiFromRange can throw on detached
   * nodes after a quick spine swap).
   */
  private anchorFromWordRange(range: Range): BookmarkAnchor | null {
    if (!this.rendition) return null;
    const ownerDoc = range.startContainer.ownerDocument;
    if (!ownerDoc) return null;

    const contentsList = this.rendition.getContents() as any;
    const list = Array.isArray(contentsList) ? contentsList : [contentsList];
    const owner = list.find(
      (c: any) => c?.document === ownerDoc,
    );
    if (!owner) return null;

    let cfi = "";
    try {
      cfi = owner.cfiFromRange(range);
    } catch {
      return null;
    }
    if (!cfi) return null;

    const word = range.toString().trim();
    if (!word) return null;

    let contextBefore = "";
    let contextAfter = "";
    try {
      const bodyText = ownerDoc.body?.textContent ?? "";
      const idx = bodyText.indexOf(word);
      if (idx >= 0) {
        contextBefore = bodyText.slice(
          Math.max(0, idx - ANCHOR_CONTEXT_CHARS),
          idx,
        );
        contextAfter = bodyText.slice(
          idx + word.length,
          idx + word.length + ANCHOR_CONTEXT_CHARS,
        );
      }
    } catch {
      // Best-effort context; the CFI alone is enough to restore.
    }

    return {
      word,
      contextBefore,
      contextAfter,
      payload: { kind: "epub", cfi },
    };
  }

  async goToAnchor(anchor: BookmarkAnchor): Promise<boolean> {
    if (!this.rendition) return false;
    if (anchor.payload.kind !== "epub") return false;
    try {
      await this.rendition.display(anchor.payload.cfi);
      return true;
    } catch {
      return false;
    }
  }

  getSpineIndex(href: string): number {
    if (!this.book) return -1;
    const baseHref = href.split("#")[0];
    let found = -1;
    this.book.spine.each((item: any, index: number) => {
      if (found === -1 && (item.href === baseHref || item.href === href)) {
        found = index;
      }
    });
    return found;
  }

  onRelocated(callback: (spineIndex: number) => void): void {
    this.relocatedCallback = callback;
  }

  applySettings(settings: ReaderSettings): void {
    if (!this.rendition) return;

    this.rendition.themes.override("font-size", `${settings.fontSize}px`);
    this.rendition.themes.override(
      "font-family",
      FONT_FAMILY_MAP[settings.fontFamily] ?? FONT_FAMILY_MAP["system"],
    );
    this.rendition.themes.override("line-height", String(settings.lineSpacing));

    const resolvedTheme =
      settings.theme === "auto"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : settings.theme;
    const colors = THEME_COLORS[resolvedTheme] ?? THEME_COLORS["light"];
    this.rendition.themes.override("color", colors.text);
    this.rendition.themes.override("background-color", colors.bg);
  }

  async applyReadingMode(mode: "scroll" | "paginated", settings: ReaderSettings): Promise<void> {
    const newFlow = mode === "paginated" ? "paginated" : "scrolled-doc";
    if (newFlow === this.currentFlow || !this.book || !this.container) return;

    const savedLocation = this.getCurrentLocation() || this.lastKnownCfi;
    this.currentFlow = newFlow;
    this.updateContainerClass();

    this.rendition?.destroy();
    this.container.innerHTML = "";

    this.rendition = this.book.renderTo(this.container, {
      width: "100%",
      height: "100%",
      spread: "none",
      flow: this.currentFlow,
      allowScriptedContent: false,
    });

    this.suppressHorizontalOverflow(this.rendition);

    this.rendition.on("relocated", (location: any) => {
      const cfi = location?.start?.cfi;
      if (cfi) this.lastKnownCfi = cfi;
      const index = location?.start?.index;
      if (typeof index === "number" && this.relocatedCallback) {
        this.relocatedCallback(index);
      }
    });

    this.applySettings(settings);

    if (savedLocation) {
      await this.rendition.display(savedLocation);
    } else {
      await this.rendition.display();
    }
  }

  private updateContainerClass(): void {
    if (!this.container) return;
    this.container.classList.toggle("paginated", this.currentFlow === "paginated");
  }

  private suppressHorizontalOverflow(rendition: Rendition): void {
    rendition.themes.default({
      "img": { "max-width": "100% !important", "height": "auto !important" },
      "pre, code": { "white-space": "pre-wrap !important", "word-break": "break-all" },
      "table": { "max-width": "100% !important" },
    });

    const patchContainer = () => {
      if (!this.container) return;
      const epubContainer = this.container.querySelector(".epub-container") as HTMLElement;
      if (epubContainer) {
        epubContainer.style.overflowX = "hidden";
      }
      this.container.querySelectorAll<HTMLElement>(".epub-view").forEach((v) => {
        v.style.overflowX = "hidden";
      });
    };

    patchContainer();
    rendition.on("rendered", patchContainer);
  }

  private async extractCoverUrl(): Promise<string | undefined> {
    if (!this.book) return undefined;
    try {
      const coverUrl = await this.book.coverUrl();
      return coverUrl ?? undefined;
    } catch {
      return undefined;
    }
  }

  convertToc(items: NavItem[]): TocEntry[] {
    return items.map((item) => ({
      label: item.label.trim(),
      href: item.href,
      level: 0,
      children: item.subitems ? this.convertToc(item.subitems) : undefined,
    }));
  }

  private getSpineLength(): number {
    let count = 0;
    this.book!.spine.each(() => { count++; });
    return count;
  }
}
