/**
 * Shared FormatRenderer scaffold for every format that renders into
 * the reader's own DOM (Text, Markdown, HTML, DOCX, Subtitles).
 *
 * EPUB does its own thing (epub.js -> sandboxed iframe -> separate
 * coordinate space, separate event system) and intentionally does
 * NOT extend this base. PDF is the other exception: it owns canvas +
 * text-layer pages, navigates by page, and re-renders on zoom, so
 * sharing this scaffold would constrain it more than help.
 *
 * What this base provides:
 *   - renderTo() mounts a `.dom-renderer-content` div and asks the
 *     subclass to fill it via renderContent(target).
 *   - Scroll position is the renderer's "location": getCurrentLocation
 *     returns a numeric string, goTo accepts the same shape OR a
 *     `#fragment` to scrollIntoView.
 *   - next/prev scroll by ~90% of the visible viewport, which is the
 *     conventional ebook page-down behavior.
 *   - applySettings writes inline font-size / line-height / font-
 *     family. Theme colors come from body[data-theme] -> CSS vars
 *     declared in reader.css, so each renderer inherits them
 *     automatically without per-renderer overrides.
 *   - Heading-based TOCs work by assigning slug ids during render and
 *     using them as `href`s. goTo("#slug") scrollIntoView's the match.
 *
 * Scroll target detection: the reader-content element is mounted
 * inside a vertically-scrollable .reader-main ancestor; we walk up
 * once on mount and cache the resolved element. Re-resolution would
 * be required if we ever support paginated mode for non-EPUB
 * renderers.
 */

import type {
  FormatRenderer,
  BookMetadata,
  TocEntry,
  ReaderSettings,
  BookmarkAnchor,
} from "../../reader-types";
import { resolveFontFamily } from "./typography";
import { windowAroundAnchor } from "../../../shared/chinese-detect";

const SCROLL_PAGE_FRACTION = 0.9;
const ANCHOR_CONTEXT_CHARS = 20;

export abstract class DomRendererBase implements FormatRenderer {
  abstract readonly formatName: string;
  abstract readonly extensions: string[];

  protected container: HTMLElement | null = null;
  protected contentEl: HTMLElement | null = null;
  protected scrollEl: HTMLElement | null = null;
  protected relocatedCallback: ((index: number) => void) | null = null;
  private scrollListener: (() => void) | null = null;

  abstract load(file: File): Promise<BookMetadata>;
  protected abstract renderContent(target: HTMLElement): Promise<void>;

  async renderTo(container: HTMLElement): Promise<void> {
    this.container = container;
    container.innerHTML = "";
    container.classList.remove("paginated");

    this.contentEl = document.createElement("div");
    this.contentEl.className = `dom-renderer-content ${this.contentClassName()}`;
    container.appendChild(this.contentEl);

    await this.renderContent(this.contentEl);

    this.scrollEl = findScrollableAncestor(container);
    this.attachScrollListener();
  }

  /**
   * Subclasses may add a format-specific class name (e.g. "text-content",
   * "markdown-content") so reader.css can style them differently.
   */
  protected contentClassName(): string {
    return "";
  }

  async goTo(location: string | number): Promise<void> {
    if (!this.scrollEl || !this.contentEl) return;

    if (typeof location === "string" && location.startsWith("#")) {
      const id = location.slice(1);
      if (id) {
        const target = this.contentEl.querySelector(`[id="${cssEscape(id)}"]`) as HTMLElement | null;
        if (target) {
          target.scrollIntoView({ block: "start" });
          return;
        }
      }
    }

    const offset = typeof location === "number" ? location : Number(location);
    if (Number.isFinite(offset)) {
      this.scrollEl.scrollTop = offset;
    }
  }

  async next(): Promise<boolean> {
    if (!this.scrollEl) return false;
    const before = this.scrollEl.scrollTop;
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    this.scrollEl.scrollTop = Math.min(max, before + this.scrollEl.clientHeight * SCROLL_PAGE_FRACTION);
    return this.scrollEl.scrollTop > before;
  }

  async prev(): Promise<boolean> {
    if (!this.scrollEl) return false;
    const before = this.scrollEl.scrollTop;
    this.scrollEl.scrollTop = Math.max(0, before - this.scrollEl.clientHeight * SCROLL_PAGE_FRACTION);
    return this.scrollEl.scrollTop < before;
  }

  getCurrentLocation(): string {
    return String(this.scrollEl?.scrollTop ?? 0);
  }

  getVisibleText(anchor?: string): string {
    if (!this.contentEl) return "";
    const text = this.contentEl.textContent ?? "";
    return windowAroundAnchor(text, anchor ?? "");
  }

  /**
   * DOM renderers don't have an EPUB-style spine. Heading-anchor TOC
   * entries use href="#slug" which goTo() handles directly, so the
   * reader shell never needs to look up an index.
   */
  getSpineIndex(_href: string): number {
    return -1;
  }

  onRelocated(callback: (spineIndex: number) => void): void {
    this.relocatedCallback = callback;
  }

  applySettings(settings: ReaderSettings): void {
    if (!this.contentEl) return;
    this.contentEl.style.fontSize = `${settings.fontSize}px`;
    this.contentEl.style.lineHeight = String(settings.lineSpacing);
    this.contentEl.style.fontFamily = resolveFontFamily(settings.fontFamily);
  }

  /**
   * Build a BookmarkAnchor from the current window selection.
   *
   * The anchor's primary key is an absolute character offset against
   * `contentEl.textContent` -- robust across font/theme/line-spacing
   * changes (those reflow pixels but don't reshape the text node tree).
   * `word` + surrounding context provide the snippet-based fallback used
   * by goToAnchor() when the offset doesn't land on the same word
   * (e.g. parser output drift between sessions).
   *
   * Subclasses can override to swap in a more specific payload (the
   * subtitle renderer does this to anchor on cue index instead of a
   * transcript-wide offset).
   */
  captureAnchor(hint?: { wordRange: Range }): BookmarkAnchor | null {
    if (!this.contentEl) return null;

    // Click-flow path: anchor on the exact clicked word's range. A
    // normal click leaves window.getSelection() collapsed, so without
    // this branch the bookmark anchor never moves with the click.
    if (hint?.wordRange) {
      const range = hint.wordRange;
      if (!this.contentEl.contains(range.startContainer)) return null;
      const charOffset = absoluteCharOffset(
        this.contentEl,
        range.startContainer,
        range.startOffset,
      );
      if (charOffset < 0) return null;
      const word = range.toString().trim();
      if (!word) return null;
      const fullText = this.contentEl.textContent ?? "";
      const contextBefore = fullText.slice(
        Math.max(0, charOffset - ANCHOR_CONTEXT_CHARS),
        charOffset,
      );
      const contextAfter = fullText.slice(
        charOffset + word.length,
        charOffset + word.length + ANCHOR_CONTEXT_CHARS,
      );
      return {
        word,
        contextBefore,
        contextAfter,
        payload: { kind: "dom", charOffset },
      };
    }

    // Fallback: drag-select path (right-click menu, manual selection).
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    if (!this.contentEl.contains(range.startContainer)) return null;

    const charOffset = absoluteCharOffset(
      this.contentEl,
      range.startContainer,
      range.startOffset,
    );
    if (charOffset < 0) return null;

    const word = sel.toString().trim();
    if (!word) return null;

    const fullText = this.contentEl.textContent ?? "";
    const contextBefore = fullText.slice(
      Math.max(0, charOffset - ANCHOR_CONTEXT_CHARS),
      charOffset,
    );
    const contextAfter = fullText.slice(
      charOffset + word.length,
      charOffset + word.length + ANCHOR_CONTEXT_CHARS,
    );

    return {
      word,
      contextBefore,
      contextAfter,
      payload: { kind: "dom", charOffset },
    };
  }

  async goToAnchor(anchor: BookmarkAnchor): Promise<boolean> {
    if (!this.contentEl) return false;
    if (anchor.payload.kind !== "dom") return false;

    const target = this.resolveDomAnchorOffset(anchor);
    if (target == null) return false;

    const located = nodeAtOffset(this.contentEl, target);
    if (!located) return false;

    const el =
      located.node.parentElement ??
      (located.node.nodeType === Node.ELEMENT_NODE
        ? (located.node as HTMLElement)
        : null);
    if (!el) return false;

    el.scrollIntoView({ block: "center" });
    return true;
  }

  /**
   * Resolve an anchor's character offset against the current contentEl,
   * preferring the saved exact offset but falling back to a snippet
   * search when that doesn't land on the same word. Subclasses that
   * scope offsets to subtrees (subtitle cues) reuse this helper after
   * narrowing `contentEl` virtually via the snippet path's haystack.
   */
  protected resolveDomAnchorOffset(anchor: BookmarkAnchor): number | null {
    if (!this.contentEl) return null;
    if (anchor.payload.kind !== "dom") return null;
    const charOffset = anchor.payload.charOffset;
    const text = this.contentEl.textContent ?? "";
    if (charOffset >= 0 && charOffset + anchor.word.length <= text.length) {
      const slice = text.slice(charOffset, charOffset + anchor.word.length);
      if (slice === anchor.word) return charOffset;
    }
    return snippetSearch(text, anchor, charOffset);
  }

  destroy(): void {
    this.detachScrollListener();
    if (this.container) this.container.innerHTML = "";
    this.container = null;
    this.contentEl = null;
    this.scrollEl = null;
    this.relocatedCallback = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private attachScrollListener(): void {
    if (!this.scrollEl) return;
    this.detachScrollListener();
    this.scrollListener = () => {
      // DOM renderers have no chapter concept, so they always pass 0.
      // The reader uses this purely as a "save your place" trigger.
      this.relocatedCallback?.(0);
    };
    this.scrollEl.addEventListener("scroll", this.scrollListener, { passive: true });
  }

  private detachScrollListener(): void {
    if (this.scrollEl && this.scrollListener) {
      this.scrollEl.removeEventListener("scroll", this.scrollListener);
    }
    this.scrollListener = null;
  }
}

// ─── Helpers exported for renderers that need them ────────────────

/**
 * Build a hierarchical TocEntry tree from the headings inside `root`.
 * Each heading gets a stable id (assigned in place if missing) so
 * goTo("#id") can scrollIntoView it. Used by Markdown / HTML / DOCX.
 */
export function buildHeadingToc(root: HTMLElement): TocEntry[] {
  const headings = Array.from(
    root.querySelectorAll<HTMLHeadingElement>("h1, h2, h3"),
  );
  if (headings.length === 0) return [];

  const usedIds = new Set<string>();
  const flat: { level: number; entry: TocEntry }[] = [];

  for (const h of headings) {
    const label = (h.textContent ?? "").trim();
    if (!label) continue;

    let id = h.id || slugify(label);
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `${slugify(label)}-${suffix++}`;
    }
    usedIds.add(id);
    h.id = id;

    const level = parseInt(h.tagName.slice(1), 10);
    flat.push({
      level,
      entry: { label, href: `#${id}`, level: level - 1, children: undefined },
    });
  }

  return nestHeadings(flat);
}

function nestHeadings(flat: { level: number; entry: TocEntry }[]): TocEntry[] {
  const root: TocEntry[] = [];
  const stack: { level: number; node: TocEntry }[] = [];

  for (const { level, entry } of flat) {
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(entry);
    } else {
      const parent = stack[stack.length - 1].node;
      (parent.children ??= []).push(entry);
    }
    stack.push({ level, node: entry });
  }

  return root;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "section";
}

function cssEscape(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }
  return id.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function findScrollableAncestor(el: HTMLElement | null): HTMLElement {
  let cur: HTMLElement | null = el?.parentElement ?? null;
  while (cur) {
    const overflow = getComputedStyle(cur).overflowY;
    if (overflow === "auto" || overflow === "scroll") return cur;
    cur = cur.parentElement;
  }
  return document.documentElement;
}

// ─── Bookmark-anchor helpers (exported for subclass reuse) ─────────

/**
 * Walk text nodes inside `root` and return the absolute character
 * offset (within root.textContent) of `targetOffset` characters into
 * `targetNode`. Returns -1 if `targetNode` isn't a descendant of root.
 */
export function absoluteCharOffset(
  root: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === targetNode) {
      return cursor + Math.min(targetOffset, (node.nodeValue ?? "").length);
    }
    cursor += (node.nodeValue ?? "").length;
    node = walker.nextNode();
  }
  // targetNode might be an element (range start can be on element when
  // selecting start-of-node); try a containment check instead.
  if (targetNode.nodeType === Node.ELEMENT_NODE && root.contains(targetNode)) {
    const w2 = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT);
    const first = w2.nextNode();
    if (first) return absoluteCharOffset(root, first, 0);
  }
  return -1;
}

/**
 * Inverse of absoluteCharOffset: locate the text node containing the
 * `target`-th character within `root` and return that node + the
 * relative offset into it. Clamps to the last node when the offset
 * runs past the end.
 */
export function nodeAtOffset(
  root: HTMLElement,
  target: number,
): { node: Node; offset: number } | null {
  if (target < 0) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let lastNode: Node | null = null;
  let node = walker.nextNode();
  while (node) {
    const len = (node.nodeValue ?? "").length;
    if (target <= cursor + len) {
      return { node, offset: target - cursor };
    }
    cursor += len;
    lastNode = node;
    node = walker.nextNode();
  }
  if (lastNode) {
    return { node: lastNode, offset: (lastNode.nodeValue ?? "").length };
  }
  return null;
}

/**
 * Snippet-based fallback when the saved char offset doesn't land on
 * the expected word. Tries (a) a window around the saved offset, then
 * (b) the contextBefore + word combination for disambiguation, then
 * (c) the first global occurrence. Returns null if `word` is empty or
 * unfindable.
 */
export function snippetSearch(
  haystack: string,
  anchor: BookmarkAnchor,
  hint: number,
): number | null {
  const word = anchor.word;
  if (!word) return null;

  const windowStart = Math.max(0, hint - 200);
  const localHit = haystack.indexOf(word, windowStart);
  if (localHit >= 0 && localHit - hint < 400) return localHit;

  if (anchor.contextBefore) {
    const probe = anchor.contextBefore + word;
    const probeHit = haystack.indexOf(probe);
    if (probeHit >= 0) return probeHit + anchor.contextBefore.length;
  }

  const globalHit = haystack.indexOf(word);
  return globalHit >= 0 ? globalHit : null;
}
