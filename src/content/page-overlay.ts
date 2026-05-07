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
interface TesseractSymbol {
  text?: string;
  bbox?: TesseractBbox;
}
interface TesseractWord {
  symbols?: TesseractSymbol[];
}
interface TesseractLine {
  text?: string;
  bbox?: TesseractBbox;
  symbols?: TesseractSymbol[];
  words?: TesseractWord[];
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
  // Compute the image→CSS-pixel scale empirically from the captured
  // image's natural dimensions vs the current viewport. window.
  // devicePixelRatio is unreliable here — Chrome's captureVisibleTab
  // doesn't always match the reported DPR (depends on OS zoom + page
  // zoom + display scaling combinations), and using a wrong DPR makes
  // every overlay strip the wrong size. Measuring directly from the
  // image's naturalWidth / naturalHeight against documentElement's
  // clientWidth / clientHeight gives us the actual conversion factor.
  const img = await loadImage(dataUrl);
  const cssW = document.documentElement.clientWidth || window.innerWidth;
  const cssH = document.documentElement.clientHeight || window.innerHeight;
  const scaleX = cssW / img.naturalWidth;
  const scaleY = cssH / img.naturalHeight;

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("chi_sim");
  try {
    const result = await worker.recognize(dataUrl);
    const out: OcrLine[] = [];
    const lines = (result.data as unknown as { lines?: TesseractLine[] }).lines
      ?? [];
    for (const line of lines) {
      const rawText = (line.text ?? "").trim();
      if (!rawText || !containsChinese(rawText)) continue;
      if (!line.bbox) continue;

      // Tesseract sometimes includes UI decorations (vertical bars,
      // scroll-rail markers, sidebar separators) in a chapter line if
      // they happen to sit at the same Y. Those extend the line bbox
      // far beyond where the actual Chinese text ends, and put junk
      // chars (`|`, `_`, isolated ASCII) into the OCR string. Trim by
      // walking per-symbol bboxes and keeping only "meaningful" chars
      // (CJK ideographs + CJK / common ASCII sentence punctuation).
      const trimmed = trimLineToMeaningful(line);
      const text = trimmed.text;
      if (!text || !containsChinese(text)) continue;

      out.push({
        text,
        bbox: {
          x: trimmed.bbox.x0 * scaleX,
          y: trimmed.bbox.y0 * scaleY,
          width: (trimmed.bbox.x1 - trimmed.bbox.x0) * scaleX,
          height: (trimmed.bbox.y1 - trimmed.bbox.y0) * scaleY,
        },
      });
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

/**
 * Strips trailing UI-decoration noise from a Tesseract line and tightens
 * the line's bbox to the actual span of meaningful characters.
 *
 * Tesseract's chi_sim model occasionally groups decorative glyphs at the
 * page edge (vertical bars, scroll-rail marks, sidebar separators) into
 * a chapter line whose Y-position they share. The result is a line bbox
 * that extends from the chapter text's left edge to the decoration's
 * right edge — much wider than the actual text — plus junk chars like
 * "|", "_", or isolated ASCII at the end of the OCR string.
 *
 * Strategy: walk per-symbol bboxes (line.symbols or, if not exposed
 * directly, line.words[].symbols). Keep symbols whose text is a CJK
 * ideograph or common CJK / ASCII sentence punctuation. Compute the
 * trimmed bbox as the union of kept symbols, and reconstruct the text
 * from kept symbols (or, when symbols aren't available, fall back to
 * regex-trimming the original text and using the original bbox).
 */
function trimLineToMeaningful(
  line: TesseractLine,
): { text: string; bbox: TesseractBbox } {
  const fallbackBbox = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  const fallbackText = (line.text ?? "").trim();

  const symbols: TesseractSymbol[] = line.symbols
    ?? (line.words ?? []).flatMap((w) => w.symbols ?? []);
  if (symbols.length === 0) {
    // No symbol detail available — best-effort regex trim of trailing
    // junk runs, keep the original bbox.
    return { text: stripTrailingJunk(fallbackText), bbox: fallbackBbox };
  }

  // Collect (text, bbox) pairs, dropping symbols without bbox or text.
  const items = symbols
    .map((s) => ({ text: s.text ?? "", bbox: s.bbox }))
    .filter((s) => s.text && s.bbox) as { text: string; bbox: TesseractBbox }[];
  if (items.length === 0) {
    return { text: stripTrailingJunk(fallbackText), bbox: fallbackBbox };
  }

  // Find the index of the last meaningful symbol. Anything past that is
  // edge decoration / junk. CJK ideographs and common sentence
  // punctuation count as meaningful; isolated ASCII letters / "|" / "_"
  // / other stray marks do not.
  let lastMeaningful = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (isMeaningfulChar(items[i].text)) {
      lastMeaningful = i;
      break;
    }
  }
  if (lastMeaningful < 0) {
    return { text: stripTrailingJunk(fallbackText), bbox: fallbackBbox };
  }

  // Likewise drop leading junk (less common but cheap to handle).
  let firstMeaningful = 0;
  for (let i = 0; i < items.length; i++) {
    if (isMeaningfulChar(items[i].text)) {
      firstMeaningful = i;
      break;
    }
  }

  const kept = items.slice(firstMeaningful, lastMeaningful + 1);
  // Bbox as union of kept symbols.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of kept) {
    x0 = Math.min(x0, s.bbox.x0);
    y0 = Math.min(y0, s.bbox.y0);
    x1 = Math.max(x1, s.bbox.x1);
    y1 = Math.max(y1, s.bbox.y1);
  }
  if (!isFinite(x0) || !isFinite(y0)) {
    return { text: stripTrailingJunk(fallbackText), bbox: fallbackBbox };
  }
  return {
    text: kept.map((s) => s.text).join(""),
    bbox: { x0, y0, x1, y1 },
  };
}

function isMeaningfulChar(ch: string): boolean {
  if (!ch) return false;
  // CJK ideographs (basic + Ext-A + Ext-B).
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df)
  ) {
    return true;
  }
  // CJK + common sentence punctuation that legitimately appears in body
  // text. Keep ASCII , . ! ? ; : " ' since the chi_sim model frequently
  // emits ASCII versions of CJK punctuation. Keep CJK quotes and
  // brackets explicitly.
  return /[，。！？；：、""''《》〈〉【】「」『』·,.!?;:"']/.test(ch);
}

function stripTrailingJunk(text: string): string {
  // Iteratively strip trailing whitespace / single non-meaningful chars.
  let out = text.trim();
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (isMeaningfulChar(last)) break;
    out = out.slice(0, -1).trim();
  }
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load screenshot"));
    img.src = src;
  });
}

interface PageTextStyle {
  fontSize: number;
  lineHeight: number;
  color: string;
  fontFamily: string;
  bg: string;
}

/**
 * Samples the page's actual rendered text style by walking common
 * content-bearing elements (article, paragraphs, divs with chapter-ish
 * class names) and grabbing the first one that contains a meaningful
 * amount of Chinese text. Returns its computed font-size, line-height,
 * color, font-family, and effective background colour. The strips use
 * these so they look like the surrounding page text instead of being
 * sized from Tesseract bboxes.
 */
function detectPageTextStyle(): PageTextStyle {
  const fallback: PageTextStyle = {
    fontSize: 16,
    lineHeight: 22,
    color: "#1a1a1a",
    fontFamily:
      '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif',
    bg: "#ffffff",
  };

  const selectors = [
    'article p', 'main p', '[class*="chapter"] p', '[class*="content"] p',
    '[class*="reader"] p', 'p',
    'article', 'main', '[class*="chapter"]', '[class*="content"]',
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of Array.from(els).slice(0, 8)) {
      const text = (el.textContent || "").trim();
      if (text.length < 20) continue;
      if (!containsChinese(text)) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const fontSize = parseFloat(cs.fontSize) || fallback.fontSize;
      let lineHeight = parseFloat(cs.lineHeight);
      if (!isFinite(lineHeight) || lineHeight <= 0) {
        lineHeight = fontSize * 1.5;
      }
      return {
        fontSize,
        lineHeight,
        color: cs.color || fallback.color,
        fontFamily: cs.fontFamily || fallback.fontFamily,
        bg: effectiveBackground(el as HTMLElement) || fallback.bg,
      };
    }
  }
  return fallback;
}

/**
 * Walks up the DOM from `el` looking for the first ancestor with a
 * non-transparent background colour. Pages often style only inner
 * containers and leave body transparent, so a naive
 * getComputedStyle(body).backgroundColor read returns nothing useful.
 */
function effectiveBackground(el: HTMLElement): string {
  let cur: HTMLElement | null = el;
  while (cur) {
    const bg = window.getComputedStyle(cur).backgroundColor;
    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    cur = cur.parentElement;
  }
  return "";
}

function mountStrips(lines: OcrLine[]): void {
  const container = document.createElement("div");
  container.id = "pt-page-overlay";
  container.className = "pt-page-overlay-root";

  // Sample the page's actual text style (font-size, line-height, color,
  // background, font-family) from a Chinese-bearing block element. This
  // is more reliable than deriving sizes from Tesseract's bbox heights —
  // Tesseract line bboxes can include considerable padding above and
  // below the visible glyph, and that ratio varies wildly between
  // sites. Using the page's own computed text style guarantees the
  // strip looks like the surrounding text.
  const pageStyle = detectPageTextStyle();
  const viewportW =
    document.documentElement.clientWidth || window.innerWidth || 1024;

  // Strips use position: fixed so they sit at the OCR bboxes' viewport
  // coordinates — same coordinate system the screenshot was captured in.
  // We do NOT add scrollX/scrollY because pages with internal scroll
  // containers (e.g. fanqienovel) keep window.scrollY at 0 even when
  // the chapter is scrolled, so adding scroll offset puts strips in
  // the wrong document region. Fixed positioning sidesteps this.
  for (const line of lines) {
    const strip = document.createElement("div");
    strip.className = "pt-page-overlay-strip";

    // Vertical placement: centre the strip inside the OCR bbox so the
    // strip's text glyph centre aligns with the underlying page glyph
    // centre. Tesseract's line bbox usually extends above the visible
    // glyph (line-spacing padding); placing strip.top at bbox.y0 with a
    // shorter strip height makes the strip render above the glyph
    // instead of over it. Centring fixes this regardless of how much
    // padding Tesseract includes.
    const stripHeight = pageStyle.lineHeight;
    const centreY = line.bbox.y + line.bbox.height / 2;
    strip.style.left = `${line.bbox.x}px`;
    strip.style.top = `${centreY - stripHeight / 2}px`;
    // Width: at least the OCR bbox width, but cap at viewport so the
    // strip never extends off-screen. `overflow: hidden` clips past
    // the cap so a single mis-OCR'd long line doesn't spill out.
    const maxW = Math.max(0, viewportW - line.bbox.x - 8);
    const width = Math.min(line.bbox.width, maxW);
    strip.style.width = `${width}px`;
    strip.style.height = `${stripHeight}px`;
    strip.style.lineHeight = `${stripHeight}px`;
    strip.style.fontSize = `${pageStyle.fontSize}px`;
    strip.style.fontFamily = pageStyle.fontFamily;
    strip.style.background = pageStyle.bg;
    strip.style.color = pageStyle.color;
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
