/**
 * Tests for the subtitle renderer (SRT/VTT/ASS).
 *
 * Subtitle parsing is unit-tested in subtitle-parser.test.ts; here
 * we focus on the renderer side: the cue-block DOM, the empty-file
 * fallback, and the title heuristic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SubtitleRenderer } from "../../src/reader/renderers/subtitle-renderer";
import { makeTextFile, mountInScrollableHost } from "./_test-fixtures";

describe("SubtitleRenderer", () => {
  let renderer: SubtitleRenderer;

  beforeEach(() => {
    renderer = new SubtitleRenderer();
  });

  describe("properties", () => {
    it("has formatName Subtitles", () => {
      expect(renderer.formatName).toBe("Subtitles");
    });

    it("handles srt/vtt/ass/ssa", () => {
      expect(renderer.extensions).toEqual([".srt", ".vtt", ".ass", ".ssa"]);
    });
  });

  describe("load()", () => {
    it("strips subtitle extension from title", async () => {
      const meta = await renderer.load(makeFile("episode01.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi"));
      expect(meta.title).toBe("episode01");
    });

    it("returns empty TOC and single chapter", async () => {
      const meta = await renderer.load(makeFile("a.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi"));
      expect(meta.toc).toEqual([]);
      expect(meta.totalChapters).toBe(1);
    });
  });

  describe("renderTo()", () => {
    it("renders one .subtitle-cue block per cue", async () => {
      const raw = [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "first",
        "",
        "2",
        "00:00:03,000 --> 00:00:04,000",
        "second",
      ].join("\n");
      await renderer.load(makeFile("a.srt", raw));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelectorAll(".subtitle-cue")).toHaveLength(2);
    });

    it("renders timestamp and text inside each cue", async () => {
      const raw = "1\n00:00:01,000 --> 00:00:02,000\n你好";
      await renderer.load(makeFile("a.srt", raw));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      const cue = container.querySelector(".subtitle-cue") as HTMLElement;
      expect(cue.querySelector(".subtitle-time")).not.toBeNull();
      expect(cue.querySelector(".subtitle-text")?.textContent).toBe("你好");
    });

    it("renders an empty-state message when no cues parse", async () => {
      await renderer.load(makeFile("a.srt", "garbage"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelector(".subtitle-empty")).not.toBeNull();
      expect(container.querySelectorAll(".subtitle-cue")).toHaveLength(0);
    });
  });

  describe("destroy()", () => {
    it("empties the container", async () => {
      await renderer.load(makeFile("a.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.destroy();
      expect(container.innerHTML).toBe("");
    });
  });

  describe("captureAnchor() / goToAnchor()", () => {
    async function setupTwoCues(): Promise<HTMLElement> {
      const raw = [
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "你好世界",
        "",
        "2",
        "00:00:03,000 --> 00:00:04,000",
        "再见朋友",
      ].join("\n");
      await renderer.load(makeFile("a.srt", raw));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      return container;
    }

    it("returns a subtitle anchor when wordRange points inside a cue", async () => {
      const container = await setupTwoCues();
      const cues = container.querySelectorAll(".subtitle-cue");
      const text = cues[1].querySelector(".subtitle-text")!.firstChild as Text;

      const wordRange = document.createRange();
      wordRange.setStart(text, 0);
      wordRange.setEnd(text, 2);

      const anchor = renderer.captureAnchor({ wordRange });
      expect(anchor).not.toBeNull();
      expect(anchor!.word).toBe("再见");
      expect(anchor!.payload.kind).toBe("subtitle");
      if (anchor!.payload.kind === "subtitle") {
        expect(anchor!.payload.cueIndex).toBe(2);
        expect(anchor!.payload.charOffset).toBe(0);
      }
    });

    it("returns null when wordRange is outside the renderer content", async () => {
      await setupTwoCues();
      const stray = document.createElement("div");
      stray.textContent = "stray";
      document.body.appendChild(stray);
      const wordRange = document.createRange();
      wordRange.setStart(stray.firstChild as Text, 0);
      wordRange.setEnd(stray.firstChild as Text, 5);
      expect(renderer.captureAnchor({ wordRange })).toBeNull();
      stray.remove();
    });

    it("goToAnchor returns true and locates the right cue", async () => {
      const container = await setupTwoCues();
      const result = await renderer.goToAnchor({
        word: "再见",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "subtitle", cueIndex: 2, charOffset: 0 },
      });
      expect(result).toBe(true);
      expect(container.querySelector('[data-cue-index="2"]')).not.toBeNull();
    });

    it("goToAnchor returns false for non-subtitle payload", async () => {
      await setupTwoCues();
      const result = await renderer.goToAnchor({
        word: "x",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "epub", cfi: "epubcfi(/6/4)" },
      });
      expect(result).toBe(false);
    });

    it("goToAnchor returns false when cueIndex is missing", async () => {
      await setupTwoCues();
      const result = await renderer.goToAnchor({
        word: "x",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "subtitle", cueIndex: 999, charOffset: 0 },
      });
      expect(result).toBe(false);
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string, content: string): File {
  return makeTextFile(name, content, "text/plain");
}
