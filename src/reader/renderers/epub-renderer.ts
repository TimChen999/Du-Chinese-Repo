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
import type { FormatRenderer, BookMetadata, TocEntry, ReaderSettings } from "../reader-types";

export const FONT_FAMILY_MAP: Record<string, string> = {
  "system": 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  "serif": 'Georgia, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  "sans-serif": 'system-ui, -apple-system, "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  "noto-sans": '"Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif',
  "noto-serif": '"Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif',
};

export const THEME_COLORS: Record<string, { bg: string; text: string }> = {
  light: { bg: "#ffffff", text: "#1a1a1a" },
  dark: { bg: "#1a1a2e", text: "#e2e8f0" },
  sepia: { bg: "#f4ecd8", text: "#5c4b37" },
};

export class EpubRenderer implements FormatRenderer {
  readonly formatName = "EPUB";
  readonly extensions = [".epub"];

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private container: HTMLElement | null = null;
  private currentFlow: "scrolled-doc" | "paginated" = "scrolled-doc";
  private relocatedCallback: ((spineIndex: number) => void) | null = null;
  private lastKnownCfi = "";

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
    const location = this.rendition.currentLocation() as any;
    return location?.start?.cfi ?? "";
  }

  getVisibleText(): string {
    if (!this.rendition) return "";
    const contents = this.rendition.getContents() as any;
    if (!contents) return "";
    const doc = Array.isArray(contents) ? contents[0] : contents;
    if (!doc?.document) return "";
    return doc.document.body?.textContent?.slice(0, 500) ?? "";
  }

  destroy(): void {
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
  }

  getRendition(): Rendition | null {
    return this.rendition;
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
