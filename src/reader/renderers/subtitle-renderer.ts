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

import { DomRendererBase } from "./_shared/dom-renderer-base";
import {
  parseSubtitles,
  detectSubtitleFormat,
  type SubtitleCue,
} from "./_shared/subtitle-parser";
import type { BookMetadata } from "../reader-types";

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
}
