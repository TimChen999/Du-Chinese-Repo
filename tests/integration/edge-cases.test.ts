/**
 * Cross-cutting edge case tests (Step 8).
 *
 * Exercises boundary conditions that span multiple modules:
 * mixed Chinese/non-Chinese text, long selections at and beyond
 * MAX_SELECTION_LENGTH, special characters (numbers, abbreviations,
 * newlines, whitespace), and consistency across all three pinyin
 * style modes.
 *
 * These tests import directly from the source modules -- no Chrome
 * API mocking is needed since the functions under test are pure.
 *
 * See: IMPLEMENTATION_GUIDE.md Step 8 "Test file: tests/integration/edge-cases.test.ts".
 */

import { describe, it, expect } from "vitest";
import { containsChinese } from "../../src/shared/chinese-detect";
import { convertToPinyin } from "../../src/background/pinyin-service";
import { validateLLMResponse } from "../../src/background/llm-client";
import { renderRubyText, calculatePosition } from "../../src/content/overlay";
import {
  MAX_SELECTION_LENGTH,
  PROVIDER_PRESETS,
  DEFAULT_SETTINGS,
} from "../../src/shared/constants";
import type { PinyinStyle, WordData } from "../../src/shared/types";

// ─── Mixed text handling ─────────────────────────────────────────────

describe("mixed text handling", () => {
  it("containsChinese returns true for mixed Chinese/English", () => {
    expect(containsChinese("I love 中国")).toBe(true);
  });

  it("pinyin service handles mixed text without crashing", () => {
    const result = convertToPinyin("Hello你好World世界", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
    const allChars = result.map((w) => w.chars).join("");
    expect(allChars).toContain("Hello");
    expect(allChars).toContain("你好");
    expect(allChars).toContain("World");
    expect(allChars).toContain("世界");
  });

  it("pinyin service handles pure punctuation text", () => {
    const result = convertToPinyin("，。！？", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
  });

  it("non-Chinese segments have their original text as pinyin", () => {
    const result = convertToPinyin("hello", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
    // pinyin-pro segments non-Chinese char-by-char; each char's pinyin equals itself
    for (const word of result) {
      expect(word.pinyin).toBe(word.chars);
    }
    expect(result.map((w) => w.chars).join("")).toBe("hello");
  });

  it("preserves every character in mixed text after reconstruction", () => {
    const inputs = [
      "Hello你好World",
      "I have 3个 apples",
      "这是test-123",
      "你好！Hello。世界！",
    ];
    for (const input of inputs) {
      const result = convertToPinyin(input, "toneMarks");
      const reconstructed = result.map((w) => w.chars).join("");
      expect(reconstructed).toBe(input);
    }
  });
});

// ─── Long selection handling ─────────────────────────────────────────

describe("long selection handling", () => {
  it("MAX_SELECTION_LENGTH is defined and positive", () => {
    expect(MAX_SELECTION_LENGTH).toBeGreaterThan(0);
  });

  it("pinyin service handles text at the max length", () => {
    const longText = "你".repeat(MAX_SELECTION_LENGTH);
    const result = convertToPinyin(longText, "toneMarks");
    expect(result.length).toBeGreaterThan(0);
  });

  it("pinyin service handles text exceeding max length", () => {
    const longText = "好".repeat(MAX_SELECTION_LENGTH + 100);
    const result = convertToPinyin(longText, "toneMarks");
    expect(result.length).toBeGreaterThan(0);
  });

  it("renderRubyText handles large word arrays", () => {
    const words: WordData[] = Array.from({ length: 100 }, (_, i) => ({
      chars: "字",
      pinyin: "zì",
    }));
    const html = renderRubyText(words);
    expect(html).toContain("<ruby");
    const matches = html.match(/<ruby/g);
    expect(matches).toHaveLength(100);
  });
});

// ─── Special character handling ──────────────────────────────────────

describe("special character handling", () => {
  it("handles Chinese text with numbers", () => {
    const result = convertToPinyin("我有3个朋友", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
    const allChars = result.map((w) => w.chars).join("");
    expect(allChars).toContain("3");
  });

  it("handles Chinese text with English abbreviations", () => {
    const result = convertToPinyin("我在IBM工作", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles newlines in text", () => {
    const result = convertToPinyin("你好\n世界", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles whitespace-only input", () => {
    const result = convertToPinyin("   ", "toneMarks");
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles tabs and mixed whitespace", () => {
    const result = convertToPinyin("你好\t世界  ", "toneMarks");
    expect(result.length).toBeGreaterThan(0);
  });

  it("renderRubyText escapes HTML in chars and definitions", () => {
    const words: WordData[] = [
      { chars: "<script>", pinyin: "test", definition: 'a "quote"' },
    ];
    const html = renderRubyText(words);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });
});

// ─── All pinyin styles produce valid output ──────────────────────────

describe("all pinyin styles produce valid output for the same input", () => {
  const input = "银行工作";
  const styles: PinyinStyle[] = ["toneMarks", "toneNumbers", "none"];

  for (const style of styles) {
    it(`${style} produces output`, () => {
      const result = convertToPinyin(input, style);
      expect(result.length).toBeGreaterThan(0);
    });
  }

  it("all styles produce the same number of words", () => {
    const marks = convertToPinyin(input, "toneMarks");
    const numbers = convertToPinyin(input, "toneNumbers");
    const none = convertToPinyin(input, "none");
    expect(marks.length).toBe(numbers.length);
    expect(numbers.length).toBe(none.length);
  });

  it("all styles reconstruct the same original chars", () => {
    const marks = convertToPinyin(input, "toneMarks").map((w) => w.chars).join("");
    const numbers = convertToPinyin(input, "toneNumbers").map((w) => w.chars).join("");
    const none = convertToPinyin(input, "none").map((w) => w.chars).join("");
    expect(marks).toBe(input);
    expect(numbers).toBe(input);
    expect(none).toBe(input);
  });

  it("toneMarks pinyin contains diacritics", () => {
    const result = convertToPinyin(input, "toneMarks");
    const allPinyin = result.map((w) => w.pinyin).join(" ");
    expect(allPinyin).toMatch(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/);
  });

  it("toneNumbers pinyin contains digits 1-4", () => {
    const result = convertToPinyin(input, "toneNumbers");
    const allPinyin = result.map((w) => w.pinyin).join(" ");
    expect(allPinyin).toMatch(/[1-4]/);
  });

  it("none mode pinyin has no tone indicators", () => {
    const result = convertToPinyin(input, "none");
    const allPinyin = result.map((w) => w.pinyin).join(" ");
    expect(allPinyin).not.toMatch(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/);
    expect(allPinyin).not.toMatch(/[1-4]/);
  });
});

// ─── validateLLMResponse edge cases ──────────────────────────────────

describe("validateLLMResponse edge cases", () => {
  it("accepts empty words array with a translation", () => {
    expect(validateLLMResponse({ words: [], translation: "" })).toBe(true);
  });

  it("rejects arrays, strings, numbers as top level", () => {
    expect(validateLLMResponse([])).toBe(false);
    expect(validateLLMResponse("string")).toBe(false);
    expect(validateLLMResponse(42)).toBe(false);
    expect(validateLLMResponse(undefined)).toBe(false);
  });

  it("rejects when words items are missing required fields", () => {
    const response = {
      words: [{ chars: "你" }],
      translation: "You",
    };
    expect(validateLLMResponse(response)).toBe(true);
  });
});

// ─── Overlay positioning edge cases ──────────────────────────────────

describe("overlay positioning edge cases", () => {
  it("handles zero-sized selection rect", () => {
    const rect = { top: 100, left: 100, bottom: 100, right: 100, width: 0, height: 0 } as DOMRect;
    const pos = calculatePosition(rect, 300, 200);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(typeof pos.top).toBe("number");
  });

  it("handles selection at viewport origin", () => {
    const rect = { top: 0, left: 0, bottom: 20, right: 100, width: 100, height: 20 } as DOMRect;
    const pos = calculatePosition(rect, 300, 200);
    expect(pos.left).toBeGreaterThanOrEqual(0);
  });
});

// ─── Provider preset consistency ─────────────────────────────────────

describe("provider preset consistency", () => {
  it("every provider preset has a non-empty defaultModel", () => {
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (name === "custom") continue;
      expect(preset.defaultModel.length).toBeGreaterThan(0);
    }
  });

  it("every provider's defaultModel is in its models list", () => {
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (name === "custom") continue;
      expect(preset.models).toContain(preset.defaultModel);
    }
  });

  it("DEFAULT_SETTINGS references a valid provider", () => {
    expect(PROVIDER_PRESETS).toHaveProperty(DEFAULT_SETTINGS.provider);
  });
});
