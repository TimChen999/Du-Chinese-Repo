/**
 * Markdown (.md, .markdown) renderer.
 *
 * Lazy-imports `marked` so users who only ever open EPUBs don't
 * pay the parse cost. The pipeline is straightforward:
 *
 *   raw text -> marked.parse -> sanitize -> innerHTML
 *
 * After render we walk the resulting DOM for h1/h2/h3 headings and
 * build a TOC of #fragment links; DomRendererBase.goTo("#slug")
 * scrolls them into view.
 *
 * Title heuristic: first H1 in the source -> file basename.
 */

import { DomRendererBase, buildHeadingToc } from "./_shared/dom-renderer-base";
import { sanitizeHtml } from "./_shared/sanitize";
import type { BookMetadata, TocEntry } from "../reader-types";

export class MarkdownRenderer extends DomRendererBase {
  readonly formatName = "Markdown";
  readonly extensions = [".md", ".markdown"];

  private html = "";
  private title = "";
  private pendingToc: TocEntry[] = [];

  async load(file: File): Promise<BookMetadata> {
    const { marked } = await import("marked");
    const raw = await file.text();

    const titleMatch = raw.match(/^#\s+(.+?)\s*$/m);
    this.title = titleMatch?.[1].trim() || file.name.replace(/\.(md|markdown)$/i, "");

    const parsed = await Promise.resolve(marked.parse(raw, { async: false }));
    this.html = sanitizeHtml(typeof parsed === "string" ? parsed : "");

    // TOC requires real DOM nodes (we mutate ids onto headings as we
    // walk them). Build it against a detached div so it's ready
    // before renderTo() is called.
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
    return "markdown-content";
  }

  protected async renderContent(target: HTMLElement): Promise<void> {
    target.innerHTML = this.html;
  }
}
