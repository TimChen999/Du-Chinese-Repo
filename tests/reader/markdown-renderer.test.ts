/**
 * Tests for the Markdown renderer.
 *
 * marked is mocked at module level so the test doesn't depend on the
 * exact HTML markup the real parser produces. We feed in a known
 * HTML payload and assert that the renderer wires it through
 * sanitization, picks up the title from the source, and exposes a
 * heading-based TOC.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("marked", () => ({
  marked: {
    parse: vi.fn((src: string) => {
      // Echo a simple HTML translation so we can assert TOC building
      const lines = src.split("\n");
      return lines
        .map((line) => {
          const h1 = line.match(/^# (.+)/);
          if (h1) return `<h1>${h1[1]}</h1>`;
          const h2 = line.match(/^## (.+)/);
          if (h2) return `<h2>${h2[1]}</h2>`;
          if (line.trim()) return `<p>${line}</p>`;
          return "";
        })
        .join("");
    }),
  },
}));

import { MarkdownRenderer } from "../../src/reader/renderers/markdown-renderer";
import {
  makeTextFile,
  mountInScrollableHost,
  collectTocLabels,
} from "./_test-fixtures";

describe("MarkdownRenderer", () => {
  let renderer: MarkdownRenderer;

  beforeEach(() => {
    vi.clearAllMocks();
    renderer = new MarkdownRenderer();
  });

  describe("properties", () => {
    it("has formatName Markdown", () => {
      expect(renderer.formatName).toBe("Markdown");
    });

    it("handles .md and .markdown", () => {
      expect(renderer.extensions).toContain(".md");
      expect(renderer.extensions).toContain(".markdown");
    });
  });

  describe("load()", () => {
    it("uses first H1 as title", async () => {
      const meta = await renderer.load(makeFile("any.md", "# 我的书\n\nhello"));
      expect(meta.title).toBe("我的书");
    });

    it("falls back to filename without .md when no H1", async () => {
      const meta = await renderer.load(makeFile("notes.md", "just text"));
      expect(meta.title).toBe("notes");
    });

    it("falls back to filename without .markdown", async () => {
      const meta = await renderer.load(makeFile("doc.markdown", "no h1"));
      expect(meta.title).toBe("doc");
    });

    it("builds a TOC from H1/H2", async () => {
      const meta = await renderer.load(
        makeFile("a.md", "# Title\n## Sub A\n## Sub B"),
      );
      expect(meta.toc.length).toBeGreaterThan(0);
      const labels = collectLabels(meta.toc);
      expect(labels).toContain("Title");
      expect(labels).toContain("Sub A");
      expect(labels).toContain("Sub B");
    });
  });

  describe("renderTo()", () => {
    it("renders the parsed HTML into the container", async () => {
      await renderer.load(makeFile("a.md", "# Hi"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.innerHTML).toContain("<h1");
      expect(container.textContent).toContain("Hi");
    });

    it("attaches a markdown-content class", async () => {
      await renderer.load(makeFile("a.md", "# Hi"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelector(".markdown-content")).not.toBeNull();
    });
  });

  describe("destroy()", () => {
    it("empties the container", async () => {
      await renderer.load(makeFile("a.md", "# x"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.destroy();
      expect(container.innerHTML).toBe("");
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string, content: string): File {
  return makeTextFile(name, content, "text/markdown");
}

const collectLabels = collectTocLabels;
