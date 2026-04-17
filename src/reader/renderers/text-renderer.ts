/**
 * Plain text (.txt) renderer.
 *
 * Zero dependencies; reads the file as a UTF-8 string and dumps it
 * into a <pre>-styled div via textContent (so HTML inside the file is
 * displayed verbatim, never executed). Pinyin selection just rides
 * the generic mouseup handler in reader.ts since textContent
 * preserves a real DOM Text node, which getSelection() can range.
 *
 * No TOC (text files don't carry one) and no chapter navigation;
 * next/prev fall through to DomRendererBase's scroll-by-viewport
 * behavior, which is the natural expectation for a continuous
 * document.
 */

import { DomRendererBase } from "./_shared/dom-renderer-base";
import type { BookMetadata } from "../reader-types";

export class TextRenderer extends DomRendererBase {
  readonly formatName = "Plain Text";
  readonly extensions = [".txt"];

  private text = "";
  private title = "";

  async load(file: File): Promise<BookMetadata> {
    this.text = await file.text();
    this.title = file.name.replace(/\.txt$/i, "") || file.name;
    return {
      title: this.title,
      author: "Unknown",
      toc: [],
      totalChapters: 1,
      currentChapter: 0,
    };
  }

  protected contentClassName(): string {
    return "text-content";
  }

  protected async renderContent(target: HTMLElement): Promise<void> {
    target.style.whiteSpace = "pre-wrap";
    target.style.wordBreak = "break-word";
    target.textContent = this.text;
  }
}
