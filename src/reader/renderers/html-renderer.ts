/**
 * HTML / XHTML (.html, .htm) renderer.
 *
 * Reads the file as text and parses with DOMParser, then injects
 * the sanitized <body> into the reader. We deliberately do NOT use
 * an iframe -- the reader runs as an extension page so any script
 * surviving the sanitizer would inherit chrome.* privileges. Going
 * through the sanitize.ts profile (which forbids script/iframe/
 * object/embed/on*) keeps the threat surface tight while letting
 * the user select Chinese text directly with the standard Selection
 * API.
 *
 * Title/author come from <title> and <meta name="author"> when
 * present; otherwise fall back to the filename.
 */

import { DomRendererBase, buildHeadingToc } from "./_shared/dom-renderer-base";
import { sanitizeHtml } from "./_shared/sanitize";
import type { BookMetadata, TocEntry } from "../reader-types";

export class HtmlRenderer extends DomRendererBase {
  readonly formatName = "HTML";
  readonly extensions = [".html", ".htm"];

  private html = "";
  private title = "";
  private author = "";
  private pendingToc: TocEntry[] = [];

  async load(file: File): Promise<BookMetadata> {
    const raw = await file.text();
    const parsed = new DOMParser().parseFromString(raw, "text/html");

    this.title = (parsed.title || "").trim() || file.name.replace(/\.x?html?$/i, "");
    this.author =
      parsed.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() ||
      "Unknown";

    const bodyHtml = parsed.body?.innerHTML ?? "";
    this.html = sanitizeHtml(bodyHtml);

    const probe = document.createElement("div");
    probe.innerHTML = this.html;
    this.pendingToc = buildHeadingToc(probe);
    this.html = probe.innerHTML;

    return {
      title: this.title,
      author: this.author,
      toc: this.pendingToc,
      totalChapters: 1,
      currentChapter: 0,
    };
  }

  protected contentClassName(): string {
    return "html-content";
  }

  protected async renderContent(target: HTMLElement): Promise<void> {
    target.innerHTML = this.html;
  }
}
