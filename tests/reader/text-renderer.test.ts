/**
 * Tests for the plain text (.txt) renderer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TextRenderer } from "../../src/reader/renderers/text-renderer";
import { DEFAULT_READER_SETTINGS } from "../../src/reader/reader-types";
import { makeTextFile, mountInScrollableHost } from "./_test-fixtures";

describe("TextRenderer", () => {
  let renderer: TextRenderer;

  beforeEach(() => {
    renderer = new TextRenderer();
  });

  describe("properties", () => {
    it("has formatName Plain Text", () => {
      expect(renderer.formatName).toBe("Plain Text");
    });

    it("handles only .txt", () => {
      expect(renderer.extensions).toEqual([".txt"]);
    });
  });

  describe("load()", () => {
    it("uses filename without extension as title", async () => {
      const meta = await renderer.load(makeFile("notes.txt", "hello"));
      expect(meta.title).toBe("notes");
    });

    it("returns Unknown author and empty TOC", async () => {
      const meta = await renderer.load(makeFile("a.txt", "x"));
      expect(meta.author).toBe("Unknown");
      expect(meta.toc).toEqual([]);
      expect(meta.totalChapters).toBe(1);
    });
  });

  describe("renderTo()", () => {
    it("writes the file text into the container", async () => {
      await renderer.load(makeFile("a.txt", "你好世界"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.textContent).toBe("你好世界");
    });

    it("uses textContent so HTML in the file is escaped", async () => {
      await renderer.load(makeFile("a.txt", "<script>alert(1)</script>"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain("<script>");
    });

    it("preserves whitespace and newlines", async () => {
      await renderer.load(makeFile("a.txt", "line1\n  indented"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      const inner = container.querySelector(".dom-renderer-content") as HTMLElement;
      expect(inner.style.whiteSpace).toBe("pre-wrap");
    });
  });

  describe("getCurrentLocation() / getVisibleText()", () => {
    it("returns scroll offset as a string", async () => {
      await renderer.load(makeFile("a.txt", "hello"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(renderer.getCurrentLocation()).toBe("0");
    });

    it("returns the rendered text via getVisibleText", async () => {
      await renderer.load(makeFile("a.txt", "我喜欢学中文"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(renderer.getVisibleText()).toContain("我喜欢学中文");
    });

    it("getVisibleText caps at 500 characters", async () => {
      const big = "A".repeat(2000);
      await renderer.load(makeFile("a.txt", big));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(renderer.getVisibleText().length).toBeLessThanOrEqual(500);
    });
  });

  describe("getSpineIndex()", () => {
    it("always returns -1", () => {
      expect(renderer.getSpineIndex("anything")).toBe(-1);
    });
  });

  describe("applySettings()", () => {
    it("writes inline font-size and line-height", async () => {
      await renderer.load(makeFile("a.txt", "x"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.applySettings({ ...DEFAULT_READER_SETTINGS, fontSize: 22, lineSpacing: 2.0 });
      const inner = container.querySelector(".dom-renderer-content") as HTMLElement;
      expect(inner.style.fontSize).toBe("22px");
      expect(inner.style.lineHeight).toBe("2");
    });

    it("does not throw when called before render", () => {
      expect(() => renderer.applySettings(DEFAULT_READER_SETTINGS)).not.toThrow();
    });
  });

  describe("destroy()", () => {
    it("clears the container", async () => {
      await renderer.load(makeFile("a.txt", "hi"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.destroy();
      expect(container.innerHTML).toBe("");
    });

    it("can be called when nothing is loaded", () => {
      expect(() => renderer.destroy()).not.toThrow();
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string, content: string): File {
  return makeTextFile(name, content, "text/plain");
}
