/**
 * HTML sanitizer used by every renderer that injects untrusted HTML
 * (Markdown -> HTML via marked, DOCX -> HTML via mammoth, raw .html
 * files) into the reader page.
 *
 * The reader runs as an extension page with chrome.* available, so an
 * unfiltered <script> in a malicious file would have full extension
 * privileges. We delegate to DOMPurify with a tightened profile:
 *   - script/style/iframe/object/embed/form/base tags are dropped
 *   - inline event-handler attributes are dropped
 *   - DOMPurify's default URL filter handles javascript: and other
 *     dangerous schemes
 *   - target="_blank" gets stripped by DOMPurify defaults (preventing
 *     reverse-tabnabbing), which we accept as the safer trade-off
 *
 * Returns plain HTML strings so callers can assign to innerHTML
 * directly. Synchronous; large DOCX/HTML documents are handled in the
 * renderer's own load() method.
 */

import DOMPurify from "dompurify";

const FORBIDDEN_TAGS = ["script", "style", "iframe", "object", "embed", "base", "form"];

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
    KEEP_CONTENT: true,
    ALLOW_DATA_ATTR: false,
  });
}
