/**
 * Page-decode overlay: viewport OCR + per-line text strips layered
 * over the underlying cipher text.
 *
 * Each Tesseract line becomes one visible <div> positioned at the
 * line's bbox in document coordinates. The div renders the OCR'd
 * real-Chinese text on top of the underlying glyphs (which on cipher
 * pages would render as the wrong codepoints for click lookup). The
 * strip's text node is real DOM text, so click-flow's global
 * mousemove/click listeners pick up interactions exactly the same as
 * on regular page text or on the existing select-area OCR result strip.
 *
 * Why this beats the previous per-character / DOM-anchored approaches:
 *  - No per-char alignment needed — Tesseract line bboxes are accurate
 *    enough to position a whole text strip.
 *  - Doesn't depend on the page's DOM structure (which on cipher pages
 *    can be split into per-char spans, broken across pseudo-elements,
 *    or otherwise unreliable for character-level walks).
 *  - One element per OCR line keeps the DOM small and simplifies the
 *    sentence-detect path (click-flow walks the strip's textContent).
 *
 * Lifecycle:
 *   1. Popup "Scan screen" → service worker forwards PAGE_DECODE_BEGIN.
 *   2. content.ts requests captureVisibleTab.
 *   3. runPageDecode() OCRs the screenshot.
 *   4. mountStrips() builds one <div class=strip> per OCR line at
 *      `bbox + scrollOffset`, with the page's body background/color so
 *      the strip blends into the surrounding page styling.
 *   5. Banner top-right shows line count and × dismiss.
 *
 * Resize/zoom dismisses (DPR change shifts positions; reflow changes
 * underlying layout). Scrolling is fine — strips are document-anchored
 * and translate with the page.
 */

import { containsChinese } from "../shared/chinese-detect";

interface OcrLine {
  text: string;
  /** Viewport-relative bbox in CSS pixels. */
  bbox: { x: number; y: number; width: number; height: number };
}

interface TesseractBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TesseractLine {
  text?: string;
  bbox?: TesseractBbox;
}

let overlayContainer: HTMLElement | null = null;
let overlayBanner: HTMLElement | null = null;
let statusToast: HTMLElement | null = null;
let resizeHandler: (() => void) | null = null;
let scrollHandler: (() => void) | null = null;

export function dismissPageOverlay(): void {
  overlayContainer?.remove();
  overlayBanner?.remove();
  statusToast?.remove();
  overlayContainer = null;
  overlayBanner = null;
  statusToast = null;
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
    resizeHandler = null;
  }
  if (scrollHandler) {
    window.removeEventListener("scroll", scrollHandler, true);
    scrollHandler = null;
  }
}

export async function runPageDecode(dataUrl: string): Promise<void> {
  dismissPageOverlay();
  showStatus("Decoding page…");

  try {
    const ocrLines = await ocrViewport(dataUrl);
    if (ocrLines.length === 0) {
      showStatus("No Chinese text recognized");
      setTimeout(hideStatus, 2200);
      return;
    }
    mountStrips(ocrLines);
    hideStatus();
    mountBanner(ocrLines.length);
  } catch (err) {
    console.error("[page-overlay] decode failed:", err);
    showStatus(
      "Decode failed: " + (err instanceof Error ? err.message : String(err)),
    );
    setTimeout(hideStatus, 3000);
  }
}

async function ocrViewport(dataUrl: string): Promise<OcrLine[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("chi_sim");
  try {
    const result = await worker.recognize(dataUrl);
    const dpr = window.devicePixelRatio || 1;
    const out: OcrLine[] = [];
    const lines = (result.data as unknown as { lines?: TesseractLine[] }).lines
      ?? [];
    for (const line of lines) {
      const text = (line.text ?? "").trim();
      if (!text || !containsChinese(text)) continue;
      if (!line.bbox) continue;
      out.push({
        text,
        bbox: {
          x: line.bbox.x0 / dpr,
          y: line.bbox.y0 / dpr,
          width: (line.bbox.x1 - line.bbox.x0) / dpr,
          height: (line.bbox.y1 - line.bbox.y0) / dpr,
        },
      });
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

function mountStrips(lines: OcrLine[]): void {
  const container = document.createElement("div");
  container.id = "pt-page-overlay";
  container.className = "pt-page-overlay-root";

  // Match the page's own background/foreground so the strip blends in.
  // Falls back to white-on-black if the body is transparent (some
  // pages style only inner containers).
  const bodyStyle = window.getComputedStyle(document.body);
  let bg = bodyStyle.backgroundColor;
  if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
    bg = window.getComputedStyle(document.documentElement).backgroundColor;
  }
  if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
    bg = "#ffffff";
  }
  const fg = bodyStyle.color || "#1a1a1a";

  // Strips use position: fixed so they sit at the OCR bboxes' viewport
  // coordinates — same coordinate system the screenshot was captured in.
  // We do NOT add scrollX/scrollY because pages with internal scroll
  // containers (e.g. fanqienovel) keep window.scrollY at 0 even when
  // the chapter is scrolled, so adding scroll offset puts strips in
  // the wrong document region. Fixed positioning sidesteps this and
  // matches what `.pt-ocr-strip` (the select-area result strip) does.
  for (const line of lines) {
    const strip = document.createElement("div");
    strip.className = "pt-page-overlay-strip";
    strip.style.left = `${line.bbox.x}px`;
    strip.style.top = `${line.bbox.y}px`;
    strip.style.minWidth = `${line.bbox.width}px`;
    strip.style.height = `${line.bbox.height}px`;
    strip.style.lineHeight = `${line.bbox.height}px`;
    strip.style.fontSize =
      `${Math.max(12, Math.floor(line.bbox.height * 0.78))}px`;
    strip.style.background = bg;
    strip.style.color = fg;
    strip.textContent = line.text;
    container.appendChild(strip);
  }

  document.body.appendChild(container);
  overlayContainer = container;

  // Resize/zoom dismisses (DPR change shifts captured positions; reflow
  // changes underlying layout).
  resizeHandler = () => dismissPageOverlay();
  window.addEventListener("resize", resizeHandler);
  // Fixed-positioned strips don't follow scroll, so any scroll desyncs
  // them from the underlying text. Capture phase catches scroll from
  // inner scrollable containers (which is how fanqienovel scrolls the
  // chapter), not just window-level scroll.
  scrollHandler = () => dismissPageOverlay();
  window.addEventListener("scroll", scrollHandler, true);
}

function mountBanner(lineCount: number): void {
  const banner = document.createElement("div");
  banner.className = "pt-page-overlay-banner";

  const label = document.createElement("span");
  label.textContent =
    `Decoded view: ${lineCount} line${lineCount === 1 ? "" : "s"}`;
  banner.appendChild(label);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "pt-page-overlay-close";
  close.title = "Close decoded view";
  close.setAttribute("aria-label", "Close decoded view");
  close.textContent = "×";
  close.addEventListener("click", (ev) => {
    ev.stopPropagation();
    dismissPageOverlay();
  });
  banner.appendChild(close);

  document.body.appendChild(banner);
  overlayBanner = banner;
}

function showStatus(msg: string): void {
  if (!statusToast) {
    statusToast = document.createElement("div");
    statusToast.className = "pt-page-overlay-status";
    document.body.appendChild(statusToast);
  }
  statusToast.textContent = msg;
}

function hideStatus(): void {
  statusToast?.remove();
  statusToast = null;
}
