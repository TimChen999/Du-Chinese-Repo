/**
 * Tests for the DOCX renderer.
 *
 * mammoth is mocked at module level so the test doesn't need a real
 * .docx file. We feed in a fake convertToHtml result and assert that
 * the rendered DOM matches, sanitizer strips dangerous nodes, and
 * the heading TOC is built.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConvertToHtml = vi.fn();

vi.mock("mammoth", () => ({
  default: {
    convertToHtml: mockConvertToHtml,
  },
}));

import { DocxRenderer } from "../../src/reader/renderers/docx-renderer";
import {
  makeBinaryFile,
  mountInScrollableHost,
  collectTocLabels,
} from "./_test-fixtures";

describe("DocxRenderer", () => {
  let renderer: DocxRenderer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConvertToHtml.mockReset();
    renderer = new DocxRenderer();
  });

  describe("properties", () => {
    it("has formatName Word Document", () => {
      expect(renderer.formatName).toBe("Word Document");
    });

    it("handles only .docx", () => {
      expect(renderer.extensions).toEqual([".docx"]);
    });
  });

  describe("load()", () => {
    it("returns filename without extension as title", async () => {
      mockConvertToHtml.mockResolvedValueOnce({ value: "<p>hi</p>", messages: [] });
      const meta = await renderer.load(makeFile("manuscript.docx"));
      expect(meta.title).toBe("manuscript");
    });

    it("calls mammoth.convertToHtml with arrayBuffer", async () => {
      mockConvertToHtml.mockResolvedValueOnce({ value: "<p>x</p>", messages: [] });
      await renderer.load(makeFile("a.docx"));
      expect(mockConvertToHtml).toHaveBeenCalledWith(
        expect.objectContaining({ arrayBuffer: expect.any(ArrayBuffer) }),
      );
    });

    it("builds a TOC from headings in mammoth's output", async () => {
      mockConvertToHtml.mockResolvedValueOnce({
        value: "<h1>第一章</h1><p>x</p><h2>1.1</h2>",
        messages: [],
      });
      const meta = await renderer.load(makeFile("a.docx"));
      const labels = collectLabels(meta.toc);
      expect(labels).toContain("第一章");
      expect(labels).toContain("1.1");
    });
  });

  describe("renderTo()", () => {
    it("injects the converted HTML", async () => {
      mockConvertToHtml.mockResolvedValueOnce({
        value: "<p>你好世界</p>",
        messages: [],
      });
      await renderer.load(makeFile("a.docx"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.textContent).toContain("你好世界");
    });

    it("sanitizes scripts in mammoth output", async () => {
      mockConvertToHtml.mockResolvedValueOnce({
        value: "<p>hi</p><script>alert(1)</script>",
        messages: [],
      });
      await renderer.load(makeFile("a.docx"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelector("script")).toBeNull();
    });

    it("attaches a docx-content class", async () => {
      mockConvertToHtml.mockResolvedValueOnce({ value: "<p>x</p>", messages: [] });
      await renderer.load(makeFile("a.docx"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelector(".docx-content")).not.toBeNull();
    });
  });

  describe("destroy()", () => {
    it("empties the container", async () => {
      mockConvertToHtml.mockResolvedValueOnce({ value: "<p>x</p>", messages: [] });
      await renderer.load(makeFile("a.docx"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.destroy();
      expect(container.innerHTML).toBe("");
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string): File {
  return makeBinaryFile(
    name,
    [0x50, 0x4b, 0x03, 0x04],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
}

const collectLabels = collectTocLabels;
