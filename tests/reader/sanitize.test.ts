/**
 * Tests for the shared HTML sanitizer used by Markdown / HTML / DOCX
 * renderers. Verifies the high-risk vectors (script tags, on*
 * handlers, javascript: URLs, iframes) are stripped while ordinary
 * formatting survives.
 */

import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/reader/renderers/_shared/sanitize";

describe("sanitizeHtml", () => {
  it("strips <script> tags", () => {
    const dirty = '<p>hello</p><script>alert(1)</script>';
    const clean = sanitizeHtml(dirty);
    expect(clean.toLowerCase()).not.toContain("<script");
    expect(clean).toContain("<p>hello</p>");
  });

  it("strips inline event handlers", () => {
    const dirty = '<button onclick="alert(1)">go</button>';
    const clean = sanitizeHtml(dirty);
    expect(clean.toLowerCase()).not.toContain("onclick");
  });

  it("strips javascript: URLs", () => {
    const dirty = '<a href="javascript:alert(1)">click</a>';
    const clean = sanitizeHtml(dirty);
    expect(clean.toLowerCase()).not.toContain("javascript:");
  });

  it("removes <iframe>", () => {
    const dirty = '<p>before</p><iframe src="evil"></iframe><p>after</p>';
    const clean = sanitizeHtml(dirty);
    expect(clean.toLowerCase()).not.toContain("<iframe");
    expect(clean).toContain("before");
    expect(clean).toContain("after");
  });

  it("removes <object> and <embed>", () => {
    const dirty = '<object data="x"></object><embed src="x" />';
    const clean = sanitizeHtml(dirty);
    expect(clean.toLowerCase()).not.toContain("<object");
    expect(clean.toLowerCase()).not.toContain("<embed");
  });

  it("preserves safe formatting", () => {
    const dirty = "<h1>Title</h1><p><strong>bold</strong> and <em>italic</em></p>";
    const clean = sanitizeHtml(dirty);
    expect(clean).toContain("<h1>Title</h1>");
    expect(clean).toContain("<strong>bold</strong>");
    expect(clean).toContain("<em>italic</em>");
  });

  it("preserves Chinese text", () => {
    const dirty = "<p>你好世界</p>";
    expect(sanitizeHtml(dirty)).toContain("你好世界");
  });

  it("preserves http and https links", () => {
    const dirty = '<a href="https://example.com">link</a>';
    const clean = sanitizeHtml(dirty);
    expect(clean).toContain('href="https://example.com"');
  });

  it("strips target=_blank to prevent reverse-tabnabbing", () => {
    const dirty = '<a href="https://example.com" target="_blank">link</a>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain('target="_blank"');
  });

  it("returns a string", () => {
    expect(typeof sanitizeHtml("<p>x</p>")).toBe("string");
  });

  it("handles empty input", () => {
    expect(sanitizeHtml("")).toBe("");
  });
});
