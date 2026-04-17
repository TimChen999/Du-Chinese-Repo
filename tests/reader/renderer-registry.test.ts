/**
 * Tests for the renderer registry.
 *
 * Verifies that file extensions map to the correct renderer classes,
 * unsupported formats return null, and the supported extensions list
 * is accurate.
 */

import { describe, it, expect } from "vitest";
import {
  getRendererForFile,
  getSupportedExtensions,
} from "../../src/reader/renderers/renderer-registry";
import { EpubRenderer } from "../../src/reader/renderers/epub-renderer";
import { TextRenderer } from "../../src/reader/renderers/text-renderer";
import { MarkdownRenderer } from "../../src/reader/renderers/markdown-renderer";
import { HtmlRenderer } from "../../src/reader/renderers/html-renderer";
import { DocxRenderer } from "../../src/reader/renderers/docx-renderer";
import { SubtitleRenderer } from "../../src/reader/renderers/subtitle-renderer";
import { PdfRenderer } from "../../src/reader/renderers/pdf-renderer";

describe("renderer-registry", () => {
  describe("getRendererForFile", () => {
    it("returns EpubRenderer for .epub files", () => {
      expect(getRendererForFile(createFile("book.epub"))).toBeInstanceOf(EpubRenderer);
    });

    it("returns PdfRenderer for .pdf files", () => {
      expect(getRendererForFile(createFile("doc.pdf"))).toBeInstanceOf(PdfRenderer);
    });

    it("returns TextRenderer for .txt files", () => {
      expect(getRendererForFile(createFile("notes.txt"))).toBeInstanceOf(TextRenderer);
    });

    it("returns MarkdownRenderer for .md and .markdown files", () => {
      expect(getRendererForFile(createFile("a.md"))).toBeInstanceOf(MarkdownRenderer);
      expect(getRendererForFile(createFile("a.markdown"))).toBeInstanceOf(MarkdownRenderer);
    });

    it("returns HtmlRenderer for .html and .htm files", () => {
      expect(getRendererForFile(createFile("a.html"))).toBeInstanceOf(HtmlRenderer);
      expect(getRendererForFile(createFile("a.htm"))).toBeInstanceOf(HtmlRenderer);
    });

    it("returns DocxRenderer for .docx files", () => {
      expect(getRendererForFile(createFile("a.docx"))).toBeInstanceOf(DocxRenderer);
    });

    it("returns SubtitleRenderer for srt/vtt/ass/ssa", () => {
      expect(getRendererForFile(createFile("a.srt"))).toBeInstanceOf(SubtitleRenderer);
      expect(getRendererForFile(createFile("a.vtt"))).toBeInstanceOf(SubtitleRenderer);
      expect(getRendererForFile(createFile("a.ass"))).toBeInstanceOf(SubtitleRenderer);
      expect(getRendererForFile(createFile("a.ssa"))).toBeInstanceOf(SubtitleRenderer);
    });

    it("handles uppercase extension", () => {
      expect(getRendererForFile(createFile("book.EPUB"))).toBeInstanceOf(EpubRenderer);
      expect(getRendererForFile(createFile("a.PDF"))).toBeInstanceOf(PdfRenderer);
    });

    it("handles mixed-case extension", () => {
      expect(getRendererForFile(createFile("book.Epub"))).toBeInstanceOf(EpubRenderer);
      expect(getRendererForFile(createFile("a.MarkDown"))).toBeInstanceOf(MarkdownRenderer);
    });

    it("returns null for unsupported formats", () => {
      expect(getRendererForFile(createFile("a.mobi"))).toBeNull();
      expect(getRendererForFile(createFile("a.fb2"))).toBeNull();
    });

    it("returns null for files with no extension", () => {
      expect(getRendererForFile(createFile("noextension"))).toBeNull();
    });

    it("returns a new instance on each call", () => {
      const r1 = getRendererForFile(createFile("a.epub"));
      const r2 = getRendererForFile(createFile("b.epub"));
      expect(r1).not.toBe(r2);
    });

    it("uses only the final extension, not embedded ones", () => {
      expect(getRendererForFile(createFile("book.epub.bak"))).toBeNull();
    });
  });

  describe("getSupportedExtensions", () => {
    it("contains all the registered extensions", () => {
      const exts = getSupportedExtensions();
      for (const ext of [
        ".epub", ".pdf", ".txt", ".md", ".markdown",
        ".html", ".htm", ".docx",
        ".srt", ".vtt", ".ass", ".ssa",
      ]) {
        expect(exts).toContain(ext);
      }
    });

    it("returns at least one extension", () => {
      expect(getSupportedExtensions().length).toBeGreaterThan(0);
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function createFile(name: string): File {
  return new File([""], name, { type: "application/octet-stream" });
}
