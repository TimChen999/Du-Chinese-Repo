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
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string, content: string): File {
  return makeTextFile(name, content, "text/plain");
}
