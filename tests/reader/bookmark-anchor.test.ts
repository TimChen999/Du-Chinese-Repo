/**
 * Tests for the word-precise bookmark anchor on DomRendererBase.
 *
 * Uses TextRenderer as a concrete subclass since the base class is
 * abstract. captureAnchor() now takes a wordRange hint produced by
 * the click-flow, so each test builds a Range over the relevant text
 * node and passes it explicitly.
 *
 * The capture/restore round-trip is the heart of the auto-bookmark
 * feature, so we cover: exact-offset round-trip, snippet-based
 * fallback when offsets drift, payload-kind mismatch rejection, and
 * out-of-content guards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TextRenderer } from "../../src/reader/renderers/text-renderer";
import type { BookmarkAnchor } from "../../src/reader/reader-types";
import {
  absoluteCharOffset,
  nodeAtOffset,
  snippetSearch,
} from "../../src/reader/renderers/_shared/dom-renderer-base";
import { makeTextFile, mountInScrollableHost } from "./_test-fixtures";

describe("DomRendererBase bookmark anchor", () => {
  let renderer: TextRenderer;
  let container: HTMLElement;

  beforeEach(async () => {
    renderer = new TextRenderer();
    container = mountInScrollableHost();
    await renderer.load(makeTextFile("a.txt", FIXTURE_TEXT));
    await renderer.renderTo(container);
  });

  describe("captureAnchor()", () => {
    it("returns null when wordRange is outside the content element", () => {
      const stray = document.createElement("div");
      stray.textContent = "elsewhere";
      document.body.appendChild(stray);
      const wordRange = rangeOver(stray.firstChild as Text, 0, 4);
      expect(renderer.captureAnchor({ wordRange })).toBeNull();
      stray.remove();
    });

    it("captures a dom anchor with the clicked word", () => {
      const node = firstTextNode(container);
      const offset = FIXTURE_TEXT.indexOf("你好");
      const wordRange = rangeOver(node, offset, offset + 2);

      const anchor = renderer.captureAnchor({ wordRange });
      expect(anchor).not.toBeNull();
      expect(anchor!.word).toBe("你好");
      expect(anchor!.payload.kind).toBe("dom");
      if (anchor!.payload.kind === "dom") {
        expect(anchor!.payload.charOffset).toBe(offset);
      }
    });

    it("captures surrounding context characters", () => {
      const node = firstTextNode(container);
      const offset = FIXTURE_TEXT.indexOf("世界");
      const wordRange = rangeOver(node, offset, offset + 2);

      const anchor = renderer.captureAnchor({ wordRange })!;
      expect(anchor.contextBefore.endsWith(",")).toBe(true);
      expect(anchor.contextAfter.startsWith("。")).toBe(true);
    });
  });

  describe("goToAnchor()", () => {
    it("returns false for a non-dom payload", async () => {
      const anchor: BookmarkAnchor = {
        word: "x",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "epub", cfi: "epubcfi(/6/4)" },
      };
      expect(await renderer.goToAnchor(anchor)).toBe(false);
    });

    it("round-trips an anchor on the same content", async () => {
      const node = firstTextNode(container);
      const offset = FIXTURE_TEXT.indexOf("世界");
      const wordRange = rangeOver(node, offset, offset + 2);
      const anchor = renderer.captureAnchor({ wordRange })!;

      const fresh = new TextRenderer();
      const freshContainer = mountInScrollableHost();
      await fresh.load(makeTextFile("a.txt", FIXTURE_TEXT));
      await fresh.renderTo(freshContainer);

      expect(await fresh.goToAnchor(anchor)).toBe(true);
    });

    it("falls back to snippet search when the saved offset drifts", async () => {
      const anchor: BookmarkAnchor = {
        word: "世界",
        contextBefore: ",",
        contextAfter: "。",
        payload: { kind: "dom", charOffset: 9999 },
      };
      const ok = await renderer.goToAnchor(anchor);
      expect(ok).toBe(true);
    });

    it("returns false when the word can't be found at all", async () => {
      const anchor: BookmarkAnchor = {
        word: "absent-word-xyz",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "dom", charOffset: 0 },
      };
      expect(await renderer.goToAnchor(anchor)).toBe(false);
    });
  });
});

describe("anchor helper functions", () => {
  describe("absoluteCharOffset()", () => {
    it("computes offset across multiple text nodes", () => {
      const root = document.createElement("div");
      root.innerHTML = "<span>abc</span><span>def</span>";
      const second = root.querySelectorAll("span")[1].firstChild!;
      expect(absoluteCharOffset(root, second, 1)).toBe(4);
    });

    it("clamps offset to node length", () => {
      const root = document.createElement("div");
      root.textContent = "hello";
      const node = root.firstChild!;
      expect(absoluteCharOffset(root, node, 99)).toBe(5);
    });

    it("returns -1 when targetNode is unrelated", () => {
      const root = document.createElement("div");
      root.textContent = "hi";
      const stranger = document.createTextNode("nope");
      expect(absoluteCharOffset(root, stranger, 0)).toBe(-1);
    });
  });

  describe("nodeAtOffset()", () => {
    it("locates the text node containing the target offset", () => {
      const root = document.createElement("div");
      root.innerHTML = "<span>abc</span><span>def</span>";
      const located = nodeAtOffset(root, 4);
      expect(located).not.toBeNull();
      expect(located!.node.nodeValue).toBe("def");
      expect(located!.offset).toBe(1);
    });

    it("clamps to the last node when offset overruns", () => {
      const root = document.createElement("div");
      root.textContent = "abc";
      const located = nodeAtOffset(root, 99);
      expect(located).not.toBeNull();
      expect(located!.offset).toBe(3);
    });

    it("returns null for negative offsets", () => {
      const root = document.createElement("div");
      root.textContent = "abc";
      expect(nodeAtOffset(root, -1)).toBeNull();
    });
  });

  describe("snippetSearch()", () => {
    const anchor: BookmarkAnchor = {
      word: "世界",
      contextBefore: "你好,",
      contextAfter: "。",
      payload: { kind: "dom", charOffset: 0 },
    };

    it("finds the word near the hint offset", () => {
      const text = "前文 你好,世界。后文";
      const idx = text.indexOf("世界");
      expect(snippetSearch(text, anchor, idx)).toBe(idx);
    });

    it("uses contextBefore to disambiguate when offset is far off", () => {
      const text = "noise 你好,世界。 你好,世界。";
      const wantIdx = text.indexOf("你好,世界") + "你好,".length;
      expect(snippetSearch(text, anchor, 9999)).toBe(wantIdx);
    });

    it("returns null when the word is missing", () => {
      expect(snippetSearch("nothing here", anchor, 0)).toBeNull();
    });

    it("returns null for empty word", () => {
      const empty: BookmarkAnchor = { ...anchor, word: "" };
      expect(snippetSearch("anything", empty, 0)).toBeNull();
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

const FIXTURE_TEXT = "前段文字。你好,世界。结尾段落到此结束。";

function firstTextNode(root: HTMLElement): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) throw new Error("no text node in container");
  return node as Text;
}

function rangeOver(node: Text, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}
