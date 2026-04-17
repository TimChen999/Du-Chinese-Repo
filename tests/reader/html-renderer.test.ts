/**
 * Tests for the HTML / .htm renderer.
 *
 * Uses jsdom's DOMParser directly (no module mocks needed). Verifies
 * <title> and meta[name=author] extraction, the body-only injection
 * pattern, and the integration with the shared sanitizer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HtmlRenderer } from "../../src/reader/renderers/html-renderer";
import {
  makeTextFile,
  mountInScrollableHost,
  collectTocLabels,
} from "./_test-fixtures";

describe("HtmlRenderer", () => {
  let renderer: HtmlRenderer;

  beforeEach(() => {
    renderer = new HtmlRenderer();
  });

  describe("properties", () => {
    it("has formatName HTML", () => {
      expect(renderer.formatName).toBe("HTML");
    });

    it("handles .html and .htm", () => {
      expect(renderer.extensions).toContain(".html");
      expect(renderer.extensions).toContain(".htm");
    });
  });

  describe("load()", () => {
    it("extracts <title> when present", async () => {
      const meta = await renderer.load(
        makeFile("a.html", "<html><head><title>My Title</title></head><body><p>x</p></body></html>"),
      );
      expect(meta.title).toBe("My Title");
    });

    it("falls back to filename without extension", async () => {
      const meta = await renderer.load(makeFile("notes.html", "<p>no title</p>"));
      expect(meta.title).toBe("notes");
    });

    it("strips .htm extension in fallback title", async () => {
      const meta = await renderer.load(makeFile("page.htm", "<p>no title</p>"));
      expect(meta.title).toBe("page");
    });

    it("extracts meta[name=author]", async () => {
      const meta = await renderer.load(
        makeFile(
          "a.html",
          '<html><head><meta name="author" content="鲁迅"></head><body></body></html>',
        ),
      );
      expect(meta.author).toBe("鲁迅");
    });

    it("returns Unknown author when not present", async () => {
      const meta = await renderer.load(makeFile("a.html", "<p>x</p>"));
      expect(meta.author).toBe("Unknown");
    });

    it("builds a TOC from headings in the body", async () => {
      const meta = await renderer.load(
        makeFile("a.html", "<h1>Big</h1><h2>Sub</h2><p>x</p>"),
      );
      const labels = collectLabels(meta.toc);
      expect(labels).toContain("Big");
      expect(labels).toContain("Sub");
    });
  });

  describe("renderTo()", () => {
    it("injects the sanitized body HTML", async () => {
      await renderer.load(makeFile("a.html", "<h1>hi</h1><p>你好</p>"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.textContent).toContain("hi");
      expect(container.textContent).toContain("你好");
    });

    it("strips <script> tags via sanitizer", async () => {
      await renderer.load(
        makeFile("a.html", '<p>hi</p><script>alert(1)</script>'),
      );
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelector("script")).toBeNull();
    });

    it("strips inline event handlers", async () => {
      await renderer.load(
        makeFile("a.html", '<button onclick="alert(1)">x</button>'),
      );
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      const btn = container.querySelector("button") as HTMLButtonElement | null;
      expect(btn?.getAttribute("onclick")).toBeNull();
    });
  });

  describe("destroy()", () => {
    it("empties the container", async () => {
      await renderer.load(makeFile("a.html", "<p>x</p>"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.destroy();
      expect(container.innerHTML).toBe("");
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string, content: string): File {
  return makeTextFile(name, content, "text/html");
}

const collectLabels = collectTocLabels;
