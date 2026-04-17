/**
 * Tests for the SRT/VTT/ASS subtitle parser. Pure function tests --
 * the renderer that consumes these cues is tested separately.
 */

import { describe, it, expect } from "vitest";
import {
  parseSubtitles,
  detectSubtitleFormat,
} from "../../src/reader/renderers/_shared/subtitle-parser";

describe("detectSubtitleFormat", () => {
  it("detects vtt", () => {
    expect(detectSubtitleFormat(".vtt")).toBe("vtt");
    expect(detectSubtitleFormat("vtt")).toBe("vtt");
    expect(detectSubtitleFormat(".VTT")).toBe("vtt");
  });

  it("detects ass and ssa as ass", () => {
    expect(detectSubtitleFormat(".ass")).toBe("ass");
    expect(detectSubtitleFormat(".ssa")).toBe("ass");
  });

  it("falls back to srt for unknown extensions", () => {
    expect(detectSubtitleFormat(".srt")).toBe("srt");
    expect(detectSubtitleFormat(".unknown")).toBe("srt");
  });
});

describe("parseSubtitles - SRT", () => {
  it("parses a single cue", () => {
    const raw = "1\n00:00:01,000 --> 00:00:02,000\n你好";
    const cues = parseSubtitles(raw, "srt");
    expect(cues).toHaveLength(1);
    expect(cues[0].index).toBe(1);
    expect(cues[0].text).toBe("你好");
    expect(cues[0].time).toContain("00:00:01,000");
  });

  it("parses multiple cues", () => {
    const raw = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "first",
      "",
      "2",
      "00:00:03,000 --> 00:00:04,000",
      "second",
    ].join("\n");
    const cues = parseSubtitles(raw, "srt");
    expect(cues).toHaveLength(2);
    expect(cues[1].text).toBe("second");
  });

  it("strips formatting tags", () => {
    const raw = "1\n00:00:01,000 --> 00:00:02,000\n<i>italic</i>";
    const cues = parseSubtitles(raw, "srt");
    expect(cues[0].text).toBe("italic");
  });

  it("joins multi-line text with newlines", () => {
    const raw = "1\n00:00:01,000 --> 00:00:02,000\nline1\nline2";
    const cues = parseSubtitles(raw, "srt");
    expect(cues[0].text).toBe("line1\nline2");
  });

  it("normalizes CRLF line endings", () => {
    const raw = "1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n";
    const cues = parseSubtitles(raw, "srt");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("hello");
  });

  it("infers index when missing", () => {
    const raw = "00:00:01,000 --> 00:00:02,000\nno-number";
    const cues = parseSubtitles(raw, "srt");
    expect(cues).toHaveLength(1);
    expect(cues[0].index).toBeGreaterThan(0);
  });
});

describe("parseSubtitles - VTT", () => {
  it("parses WEBVTT with header", () => {
    const raw = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "你好",
    ].join("\n");
    const cues = parseSubtitles(raw, "vtt");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("你好");
  });

  it("handles cue identifiers", () => {
    const raw = [
      "WEBVTT",
      "",
      "intro",
      "00:00:01.000 --> 00:00:02.000",
      "first",
    ].join("\n");
    const cues = parseSubtitles(raw, "vtt");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("first");
  });

  it("skips NOTE and STYLE blocks", () => {
    const raw = [
      "WEBVTT",
      "",
      "NOTE this is a comment",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "real cue",
    ].join("\n");
    const cues = parseSubtitles(raw, "vtt");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("real cue");
  });
});

describe("parseSubtitles - ASS", () => {
  it("parses Dialogue lines", () => {
    const raw = [
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,你好世界",
    ].join("\n");
    const cues = parseSubtitles(raw, "ass");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("你好世界");
    expect(cues[0].time).toContain("0:00:01.00");
  });

  it("strips ASS override codes like {\\an8}", () => {
    const raw = [
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}清洁文本",
    ].join("\n");
    const cues = parseSubtitles(raw, "ass");
    expect(cues[0].text).toBe("清洁文本");
  });

  it("converts \\N to newline", () => {
    const raw = [
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,line1\\Nline2",
    ].join("\n");
    const cues = parseSubtitles(raw, "ass");
    expect(cues[0].text).toBe("line1\nline2");
  });

  it("preserves commas inside the text field", () => {
    const raw = [
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hello, world",
    ].join("\n");
    const cues = parseSubtitles(raw, "ass");
    expect(cues[0].text).toBe("hello, world");
  });

  it("returns empty array when no Dialogue lines", () => {
    expect(parseSubtitles("[Script Info]\nTitle: x", "ass")).toEqual([]);
  });
});
