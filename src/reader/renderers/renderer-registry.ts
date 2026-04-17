/**
 * Maps file extensions to FormatRenderer constructors.
 *
 * The reader calls getRendererForFile() with the dropped/selected File
 * and receives an instance of the appropriate renderer, or null for
 * unsupported formats.
 *
 * Adding a new format means: implement FormatRenderer in
 * renderers/<name>-renderer.ts, then register the extension(s) here.
 * The reader shell discovers everything else through the interface.
 *
 * See: READER_SPEC.md Section 8 "Renderer Registry".
 */

import { EpubRenderer } from "./epub-renderer";
import { TextRenderer } from "./text-renderer";
import { MarkdownRenderer } from "./markdown-renderer";
import { HtmlRenderer } from "./html-renderer";
import { DocxRenderer } from "./docx-renderer";
import { SubtitleRenderer } from "./subtitle-renderer";
import { PdfRenderer } from "./pdf-renderer";
import type { FormatRenderer } from "../reader-types";

type RendererConstructor = new () => FormatRenderer;

// Annotated as a tuple array so TypeScript doesn't infer the union of
// every concrete constructor type as the Map's value parameter (which
// would force every renderer to be assignable to EpubRenderer).
const RENDERER_ENTRIES: Array<[string, RendererConstructor]> = [
  [".epub", EpubRenderer],
  [".txt", TextRenderer],
  [".md", MarkdownRenderer],
  [".markdown", MarkdownRenderer],
  [".html", HtmlRenderer],
  [".htm", HtmlRenderer],
  [".docx", DocxRenderer],
  [".srt", SubtitleRenderer],
  [".vtt", SubtitleRenderer],
  [".ass", SubtitleRenderer],
  [".ssa", SubtitleRenderer],
  [".pdf", PdfRenderer],
];

const RENDERERS: Map<string, RendererConstructor> = new Map(RENDERER_ENTRIES);

export function getRendererForFile(file: File): FormatRenderer | null {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  const Ctor = RENDERERS.get(ext);
  return Ctor ? new Ctor() : null;
}

export function getSupportedExtensions(): string[] {
  return Array.from(RENDERERS.keys());
}
