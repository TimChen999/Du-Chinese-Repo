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
import type { FormatRenderer, BookMetadata, TocEntry } from "../reader-types";

export class EpubRenderer implements FormatRenderer {
  readonly formatName = "EPUB";
  readonly extensions = [".epub"];

  private book: Book | null = null;
  private rendition: Rendition | null = null;

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
    if (!this.rendition) return;
    this.rendition.on("relocated", (location: any) => {
      const index = location?.start?.index;
      if (typeof index === "number") {
        callback(index);
      }
    });
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
