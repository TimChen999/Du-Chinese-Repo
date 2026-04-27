/**
 * Subtitle (.srt, .vtt, .ass, .ssa) renderer.
 *
 * Subtitles are an unusual "ebook" format: they're discrete cues
 * with timestamps, not continuous prose. We render each cue as a
 * stacked block (timestamp on top, text below), which gives the
 * user a scannable transcript and matches how learners typically
 * use subtitle files for study (line-by-line review of dialogue).
 *
 * No TOC -- subtitle files don't have logical sections; the
 * timestamp + index columns serve as the navigation aids. Pinyin
 * selection works through the generic mouseup handler in reader.ts
 * since each cue's text is a normal text node.
 *
 * Parsing is delegated to _shared/subtitle-parser, which handles
 * SRT, WebVTT, and a subset of ASS/SSA Dialogue lines.
 */

import {
  DomRendererBase,
  absoluteCharOffset,
  nodeAtOffset,
  snippetSearch,
} from "./_shared/dom-renderer-base";
import {
  parseSubtitles,
  detectSubtitleFormat,
  type SubtitleCue,
} from "./_shared/subtitle-parser";
import type { BookMetadata, BookmarkAnchor } from "../reader-types";

const ANCHOR_CONTEXT_CHARS = 20;

export class SubtitleRenderer extends DomRendererBase {
  readonly formatName = "Subtitles";
  readonly extensions = [".srt", ".vtt", ".ass", ".ssa"];

  private cues: SubtitleCue[] = [];
  private title = "";

  async load(file: File): Promise<BookMetadata> {
    const raw = await file.text();
    const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
    const format = detectSubtitleFormat(ext);
    this.cues = parseSubtitles(raw, format);
    this.title = file.name.replace(/\.(srt|vtt|ass|ssa)$/i, "") || file.name;

    return {
      title: this.title,
      author: "",
      toc: [],
      totalChapters: 1,
      currentChapter: 0,
    };
  }

  protected contentClassName(): string {
    return "subtitle-content";
  }

  protected async renderContent(target: HTMLElement): Promise<void> {
    if (this.cues.length === 0) {
      const empty = document.createElement("p");
      empty.className = "subtitle-empty";
      empty.textContent = "No subtitle cues could be parsed from this file.";
      target.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const cue of this.cues) {
      const block = document.createElement("div");
      block.className = "subtitle-cue";
      block.dataset.cueIndex = String(cue.index);

      const time = document.createElement("span");
      time.className = "subtitle-time";
      time.textContent = `#${cue.index} \u00B7 ${cue.time}`;

      const text = document.createElement("p");
      text.className = "subtitle-text";
      text.textContent = cue.text;

      block.append(time, text);
      fragment.appendChild(block);
    }
    target.appendChild(fragment);
  }

  /**
   * Anchor on `cueIndex + offset within cue` rather than a transcript-
   * wide offset. The cue list can shrink/expand if the parser changes
   * (we already had one such change between SRT and ASS support), but
   * cue indices are stable per file and offsets within a cue are tiny.
   */
  override captureAnchor(hint: { wordRange: Range }): BookmarkAnchor | null {
    if (!this.contentEl) return null;
    const range = hint.wordRange;
    if (!this.contentEl.contains(range.startContainer)) return null;

    const cueEl = closestCueElement(range.startContainer);
    if (!cueEl) return null;
    const cueIndex = parseInt(cueEl.dataset.cueIndex ?? "", 10);
    if (!Number.isFinite(cueIndex)) return null;

    const textEl = cueEl.querySelector<HTMLElement>(".subtitle-text");
    if (!textEl || !textEl.contains(range.startContainer)) return null;

    const charOffset = absoluteCharOffset(
      textEl,
      range.startContainer,
      range.startOffset,
    );
    if (charOffset < 0) return null;

    const word = range.toString().trim();
    if (!word) return null;

    const cueText = textEl.textContent ?? "";
    const contextBefore = cueText.slice(
      Math.max(0, charOffset - ANCHOR_CONTEXT_CHARS),
      charOffset,
    );
    const contextAfter = cueText.slice(
      charOffset + word.length,
      charOffset + word.length + ANCHOR_CONTEXT_CHARS,
    );

    return {
      word,
      contextBefore,
      contextAfter,
      payload: { kind: "subtitle", cueIndex, charOffset },
    };
  }

  override async goToAnchor(anchor: BookmarkAnchor): Promise<boolean> {
    if (!this.contentEl) return false;
    if (anchor.payload.kind !== "subtitle") return false;

    const { cueIndex, charOffset } = anchor.payload;
    const cueEl = this.contentEl.querySelector<HTMLElement>(
      `.subtitle-cue[data-cue-index="${cssNumber(cueIndex)}"]`,
    );
    if (!cueEl) return false;
    const textEl = cueEl.querySelector<HTMLElement>(".subtitle-text");
    if (!textEl) return false;

    const cueText = textEl.textContent ?? "";
    let resolved = charOffset;
    if (
      charOffset < 0 ||
      charOffset + anchor.word.length > cueText.length ||
      cueText.slice(charOffset, charOffset + anchor.word.length) !== anchor.word
    ) {
      const fallback = snippetSearch(cueText, anchor, charOffset);
      if (fallback == null) {
        cueEl.scrollIntoView({ block: "center" });
        return true;
      }
      resolved = fallback;
    }

    const located = nodeAtOffset(textEl, resolved);
    const target =
      located?.node.parentElement ??
      (located?.node.nodeType === Node.ELEMENT_NODE
        ? (located.node as HTMLElement)
        : null) ??
      cueEl;
    target.scrollIntoView({ block: "center" });
    return true;
  }
}

function closestCueElement(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      if (el.classList?.contains("subtitle-cue")) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

function cssNumber(n: number): string {
  return String(Math.trunc(n));
}
