/**
 * DOCX (.docx) renderer.
 *
 * Lazy-loads mammoth.js (~700KB) on demand so EPUB-only sessions
 * don't pay the cost. mammoth converts DOCX -> clean semantic HTML;
 * we sanitize the result and route it through DomRendererBase like
 * the HTML / Markdown renderers.
 *
 * Tradeoffs: Word formatting (custom styles, complex tables,
 * footnotes) is reduced to plain HTML elements. That's intentional
 * for a reader -- we want selectable Chinese text first, faithful
 * Word rendering second. Users who care about layout fidelity should
 * export to PDF instead.
 */

import { DomRendererBase, buildHeadingToc } from "./_shared/dom-renderer-base";
import { sanitizeHtml } from "./_shared/sanitize";
import type { BookMetadata, TocEntry } from "../reader-types";

export class DocxRenderer extends DomRendererBase {
  readonly formatName = "Word Document";
  readonly extensions = [".docx"];

  private html = "";
  private title = "";
  private pendingToc: TocEntry[] = [];

  async load(file: File): Promise<BookMetadata> {
    const mammoth = (await import("mammoth")).default;
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });

    this.html = sanitizeHtml(result.value || "");
    this.title = file.name.replace(/\.docx$/i, "") || file.name;

    const probe = document.createElement("div");
    probe.innerHTML = this.html;
    this.pendingToc = buildHeadingToc(probe);
    this.html = probe.innerHTML;

    return {
      title: this.title,
      author: "Unknown",
      toc: this.pendingToc,
      totalChapters: 1,
      currentChapter: 0,
    };
  }

  protected contentClassName(): string {
    return "docx-content";
  }

  protected async renderContent(target: HTMLElement): Promise<void> {
    target.innerHTML = this.html;
  }
}
