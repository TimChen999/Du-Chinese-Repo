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
} from "../../reader-types";
import { resolveFontFamily } from "./typography";

const SCROLL_PAGE_FRACTION = 0.9;

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

  getVisibleText(): string {
    if (!this.contentEl) return "";
    const text = this.contentEl.textContent ?? "";
    return text.length > 500 ? text.slice(0, 500) : text;
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
