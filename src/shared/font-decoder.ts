/**
 * Font-cipher decoder.
 *
 * Some Chinese reading sites (番茄小说 / Bytedance, 起点, JJWXC, etc.) ship
 * a custom @font-face whose glyphs map Private-Use-Area Unicode codepoints
 * (U+E000–U+F8FF) to the visible Chinese characters. The displayed page
 * looks correct but the underlying DOM text is half PUA gibberish, which
 * defeats every text-driven feature (containsChinese rejects PUA, so
 * hover preview, click lookup, sentence segmentation, and the LLM
 * sentence translator all skip the obfuscated chars).
 *
 * Strategy — on-demand per-sentence decoding:
 *   1. At content-script init, detect whether the page uses a cipher
 *      font (cheap PUA-presence scan + @font-face match). If yes, hold
 *      onto the font-family + URL but do NOT OCR anything yet.
 *   2. When the user clicks/hovers, click-flow calls decodeForText with
 *      the current sentence's raw text. We collect just the PUA chars
 *      that aren't in our cache yet (typically 5-20 per sentence) and
 *      OCR only those.
 *   3. Tesseract is initialised lazily on first decode call and kept
 *      warm across subsequent calls so the user doesn't pay the worker
 *      init cost more than once per page.
 *   4. Results merge into a single in-memory map; on every successful
 *      addition we save the full map back to chrome.storage.local
 *      keyed by font URL (30-day TTL) so revisits start with everything
 *      already decoded.
 *   5. translatePua(text) is a synchronous 1:1 substitution wired into
 *      every dictionary call site so segmentation / lookup / display /
 *      LLM all see real Chinese.
 *
 * Why on-demand instead of whole-page upfront: a typical 番茄 chapter
 * has ~200-400 unique cipher glyphs, and tesseract's worker warm-up +
 * trained-data fetch puts a multi-second delay before the first hover
 * works. Per-sentence batches give an instant-feeling first lookup
 * (decode finishes in well under a second for ~15 chars) and cover the
 * whole page incrementally as the user reads.
 *
 * Companion: getCipherFontInfo() lets the click-popup inject the same
 * @font-face into its Shadow DOM so any stray un-translated PUA char
 * still renders as the right visible glyph instead of a tofu box.
 */

// ─── Types ─────────────────────────────────────────────────────────

interface DecodedFontEntry {
  url: string;
  map: Record<string, string>;
  builtAt: number;
}

export type DecoderPhase =
  | "idle"
  | "scanning"
  | "warming-ocr"
  | "decoding"
  | "ready"
  | "skipped"
  | "error";

export interface DecoderProgress {
  phase: DecoderPhase;
  current: number;
  total: number;
  /** Free-form sub-status surfaced from tesseract (e.g. "loading
   *  language traineddata"). Used by the toast to show *where* a long
   *  decode is currently stuck so a hung pipeline is diagnosable
   *  without devtools. */
  detail?: string;
  error?: string;
}

export interface CipherFontInfo {
  family: string;
  /** First src URL extracted from the @font-face rule, or empty when
   *  the rule was inside an unreadable cross-origin stylesheet. */
  src: string;
}

// ─── Module state ──────────────────────────────────────────────────

const PUA_RANGE = { start: 0xe000, end: 0xf8ff };
const STORAGE_KEY = "fontDecoderCache";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Detected cipher font for the current page, or null if not encrypted. */
let cipherFont: CipherFontInfo | null = null;
/** PUA → real-CJK map. Grows as decodeForText is called. */
const activeMap: Map<string, string> = new Map();
/** Cache key (font URL or fallback) used when persisting `activeMap`. */
let cacheKey: string | null = null;

let progress: DecoderProgress = { phase: "idle", current: 0, total: 0 };
const progressListeners = new Set<(p: DecoderProgress) => void>();

let initPromise: Promise<void> | null = null;
let inflightDecode: Promise<void> | null = null;
/** Per-sentence dedup queue: codepoints we still want to decode. */
const pendingCodepoints = new Set<string>();
/** Codepoints we've tried to decode and failed on (Tesseract returned
 *  a non-CJK char). Skipped on subsequent decodeForText calls so a bad
 *  glyph doesn't keep getting re-OCR'd every time it appears. */
const failedCodepoints = new Set<string>();

/**
 * Cached tesseract worker so repeated decodes don't pay warm-up cost.
 * Pre-initialised in the background as soon as we detect a cipher font
 * so the first click doesn't wait on chi_sim trained-data download.
 */
let workerPromise: Promise<unknown> | null = null;

// ─── Public API ────────────────────────────────────────────────────

export function getDecoderProgress(): DecoderProgress {
  return progress;
}

export function onDecoderProgress(
  cb: (p: DecoderProgress) => void,
): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export function getCipherFontInfo(): CipherFontInfo | null {
  return cipherFont;
}

/**
 * Synchronous translator. Replaces every PUA codepoint in `text` with
 * its decoded real char. Pass-through for chars outside the map.
 */
export function translatePua(text: string): string {
  if (!text || activeMap.size === 0) return text;
  let out = "";
  let mutated = false;
  for (const ch of text) {
    const real = activeMap.get(ch);
    if (real) {
      out += real;
      mutated = true;
    } else {
      out += ch;
    }
  }
  return mutated ? out : text;
}

/**
 * True when `ch` is a PUA codepoint AND we've already decoded it. Lets
 * containsChinese() accept decoded chars so the click-flow stops
 * rejecting them as non-Chinese.
 */
export function isDecodablePuaChar(ch: string): boolean {
  if (!ch || activeMap.size === 0) return false;
  return activeMap.has(ch);
}

/**
 * True when the page is known to use a cipher font AND `ch` is in the
 * Private-Use-Area range. Used by containsChinese() to *speculatively*
 * accept PUA chars (and trigger an on-demand decode in click-flow)
 * before any OCR has actually run — so the user's first click on an
 * obfuscated char isn't silently dropped.
 */
export function isPossiblyCipheredChar(ch: string): boolean {
  if (!cipherFont || !ch) return false;
  const code = ch.charCodeAt(0);
  return code >= PUA_RANGE.start && code <= PUA_RANGE.end;
}

/**
 * Init: detects whether the page is using a cipher font and warms the
 * cache from storage. No OCR happens here — that's deferred until the
 * first decodeForText call. Idempotent.
 */
export function initFontDecoder(doc: Document = document): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = runInit(doc).catch((err) => {
    console.error("[font-decoder] init failed:", err);
    setProgress({ phase: "error", current: 0, total: 0, error: String(err) });
  });
  return initPromise;
}

/**
 * Decode just the PUA chars present in `text` that aren't in our cache
 * yet. Resolves once `activeMap` covers every (decodable) char in the
 * input — callers can then synchronously translatePua against it.
 *
 * Safe to call many times; concurrent calls coalesce into one OCR run.
 * No-op when the page isn't encrypted or the input has no PUA chars.
 */
export async function decodeForText(text: string): Promise<void> {
  if (!cipherFont || !text) return;

  let added = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < PUA_RANGE.start || code > PUA_RANGE.end) continue;
    if (activeMap.has(ch)) continue;
    if (failedCodepoints.has(ch)) continue;
    if (pendingCodepoints.has(ch)) continue;
    pendingCodepoints.add(ch);
    added++;
  }
  if (added === 0) {
    // Either nothing to do, or all PUA chars are already pending in
    // the in-flight decode — wait it out so the caller can rely on
    // post-await activeMap.
    if (inflightDecode) await inflightDecode;
    return;
  }

  if (!inflightDecode) {
    inflightDecode = drainAll().finally(() => {
      inflightDecode = null;
    });
  }
  await inflightDecode;
}

/**
 * Drains pending codepoints until the queue is empty. Loops because a
 * caller may add fresh codepoints while a batch is in-flight; without
 * the loop those chars sit in pendingCodepoints forever (the batch
 * captured + cleared the queue at its start, so the second caller's
 * await resolves with nothing actually decoded).
 */
async function drainAll(): Promise<void> {
  while (pendingCodepoints.size > 0) {
    await drainPending();
  }
}

// ─── Init ──────────────────────────────────────────────────────────

async function runInit(doc: Document): Promise<void> {
  setProgress({ phase: "scanning", current: 0, total: 0 });

  const scan = scanBodyForPuaChars(doc);
  if (scan.codepoints.size === 0 || !scan.fontFamily) {
    setProgress({ phase: "skipped", current: 0, total: 0 });
    return;
  }

  const ruleInfo = findFontFaceRuleFor(doc, scan.fontFamily);
  cipherFont = {
    family: scan.fontFamily,
    src: ruleInfo?.src ?? "",
  };
  cacheKey = cipherFont.src || `${doc.location?.origin ?? ""}|${cipherFont.family}`;

  // Warm activeMap from chrome.storage.local. If a prior visit already
  // OCR'd this font, every char is instantly translatable and we never
  // need to spin tesseract back up.
  const cached = await loadCache(cacheKey);
  if (cached) {
    for (const [k, v] of Object.entries(cached.map)) activeMap.set(k, v);
  }

  // Wait for the page to actually finish loading the cipher font so a
  // racing first decodeForText doesn't try to render unloaded glyphs.
  try {
    if (doc.fonts && typeof doc.fonts.ready?.then === "function") {
      await doc.fonts.ready;
    }
  } catch {
    // Non-fatal.
  }

  setProgress({ phase: "ready", current: activeMap.size, total: activeMap.size });

  // Background pre-warm: kick off chi_sim worker creation now so the
  // first decodeForText() call (typically a click) doesn't sit waiting
  // on the trained-data download. Errors are swallowed — if init fails
  // here it'll be retried on first decode and surface there.
  void ensureWorker().catch((err) => {
    console.warn("[font-decoder] worker pre-warm failed:", err);
  });
}

// ─── Drain ─────────────────────────────────────────────────────────

/**
 * Hard ceiling on a single OCR batch (worker init + grid recognise).
 * Anything past this we treat as a hung pipeline (CSP block, network
 * stall on chi_sim trained data, runaway worker) — abort, mark the
 * batch's codepoints as failed, drop the cached worker so the next
 * decode attempt gets a fresh init, and surface the error in the toast.
 *
 * Without this the toast would sit at "Loading OCR engine…" forever
 * and click-flow's outer 30 s budget would tick down silently while
 * its `.finally()` runs against a still-pending decode promise.
 */
const OCR_BATCH_TIMEOUT_MS = 45_000;

async function drainPending(): Promise<void> {
  if (!cipherFont) {
    pendingCodepoints.clear();
    return;
  }
  if (pendingCodepoints.size === 0) return;

  const codepoints = Array.from(pendingCodepoints);
  pendingCodepoints.clear();
  setProgress({ phase: "decoding", current: 0, total: codepoints.length });

  let recognized: Map<string, string>;
  try {
    recognized = await Promise.race([
      ocrGlyphGrid(codepoints, cipherFont.family, (done) => {
        setProgress({ phase: "decoding", current: done, total: codepoints.length });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("OCR batch timeout")),
          OCR_BATCH_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.error("[font-decoder] OCR failed:", err);
    setProgress({
      phase: "error",
      current: 0,
      total: codepoints.length,
      error: String(err),
    });
    // Mark these as failed so we don't retry immediately on every hover.
    for (const cp of codepoints) failedCodepoints.add(cp);
    // Drop the cached worker so the next decode attempts a fresh init.
    // The stuck worker is leaked rather than terminated — there's no
    // safe way to terminate a tesseract worker that's mid-fetch — but
    // since we're dropping the reference, GC will clean up eventually
    // and a new worker instance will service the next request.
    workerPromise = null;
    workerReady = false;
    workerStatusDetail = "";
    return;
  }

  for (const cp of codepoints) {
    const real = recognized.get(cp);
    if (real) activeMap.set(cp, real);
    else failedCodepoints.add(cp);
  }
  if (cacheKey && recognized.size > 0) {
    await saveCache(cacheKey, mapToObject(activeMap));
  }
  setProgress({
    phase: "ready",
    current: activeMap.size,
    total: activeMap.size,
  });
}

// ─── Detection ─────────────────────────────────────────────────────

interface ScanResult {
  codepoints: Set<string>;
  fontFamily: string | null;
}

function scanBodyForPuaChars(doc: Document): ScanResult {
  const codepoints = new Set<string>();
  let fontFamily: string | null = null;

  const root = doc.body;
  if (!root) return { codepoints, fontFamily };

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const data = (node as Text).data;
      if (!data) return NodeFilter.FILTER_REJECT;
      for (let i = 0; i < data.length; i++) {
        const code = data.charCodeAt(i);
        if (code >= PUA_RANGE.start && code <= PUA_RANGE.end) {
          return NodeFilter.FILTER_ACCEPT;
        }
      }
      return NodeFilter.FILTER_REJECT;
    },
  });

  let cur = walker.nextNode() as Text | null;
  while (cur) {
    const data = cur.data;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code >= PUA_RANGE.start && code <= PUA_RANGE.end) {
        codepoints.add(ch);
        if (!fontFamily) {
          const parent = cur.parentElement;
          if (parent) fontFamily = pickEncryptedFamily(doc, parent);
        }
      }
    }
    cur = walker.nextNode() as Text | null;
  }

  return { codepoints, fontFamily };
}

function pickEncryptedFamily(doc: Document, el: Element): string | null {
  const win = doc.defaultView ?? window;
  const computed = win.getComputedStyle(el);
  const stack = computed.fontFamily;
  if (!stack) return null;
  const families = stack
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""));
  const fontFaceFamilies = collectFontFaceFamilies(doc);
  for (const f of families) {
    if (fontFaceFamilies.has(f)) return f;
  }
  return families[0] ?? null;
}

function collectFontFaceFamilies(doc: Document): Set<string> {
  const set = new Set<string>();
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (rule.constructor.name === "CSSFontFaceRule") {
        const ff = rule as CSSFontFaceRule;
        const name = ff.style.getPropertyValue("font-family");
        if (name) set.add(name.trim().replace(/^["']|["']$/g, ""));
      }
    }
  }
  return set;
}

interface FontFaceRuleInfo {
  family: string;
  src: string;
}

function findFontFaceRuleFor(
  doc: Document,
  family: string,
): FontFaceRuleInfo | null {
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (rule.constructor.name !== "CSSFontFaceRule") continue;
      const ff = rule as CSSFontFaceRule;
      const ruleFamily = ff.style
        .getPropertyValue("font-family")
        ?.trim()
        .replace(/^["']|["']$/g, "");
      if (ruleFamily !== family) continue;
      const src = ff.style.getPropertyValue("src") ?? "";
      const m = src.match(/url\(([^)]+)\)/);
      const url = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
      if (url) return { family, src: url };
    }
  }
  return null;
}

// ─── OCR pipeline ──────────────────────────────────────────────────

const GLYPH_PX = 96;
const CELL_PADDING = 16;
const GRID_COLS = 8;

async function ocrGlyphGrid(
  codepoints: string[],
  fontFamily: string,
  onProgress: (done: number) => void,
): Promise<Map<string, string>> {
  const cellW = GLYPH_PX + CELL_PADDING * 2;
  const cellH = GLYPH_PX + CELL_PADDING * 2;
  const cols = Math.min(GRID_COLS, codepoints.length);
  const rows = Math.ceil(codepoints.length / cols);

  // Explicitly tell the FontFaceSet to load the glyphs we're about to
  // render. document.fonts.ready resolved at init time, but a font set
  // to font-display: block can still be waiting on the actual binary;
  // canvas would then silently fall back to a system font that has
  // *no* glyph for the PUA codepoint, producing blank cells that
  // Tesseract reads as garbage. font-load is a no-op if already loaded.
  try {
    const text = codepoints.join("");
    await document.fonts.load(`${GLYPH_PX}px "${fontFamily}"`, text);
  } catch (err) {
    console.warn("[font-decoder] document.fonts.load failed:", err);
  }

  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black";
  ctx.font = `${GLYPH_PX}px "${fontFamily}"`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  for (let i = 0; i < codepoints.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = col * cellW + cellW / 2;
    const cy = row * cellH + cellH / 2;
    ctx.fillText(codepoints[i], cx, cy);
  }
  onProgress(0);
  console.debug(
    "[font-decoder] grid built:",
    codepoints.length,
    "glyphs,",
    canvas.width,
    "x",
    canvas.height,
    "px",
  );

  // Worker warm-up may not have finished yet — drive the toast through
  // its sub-statuses so the user can see *what* is loading instead of
  // a frozen "Decoding N glyphs…" while chi_sim trained-data downloads.
  const worker = await awaitWorkerWithProgress();
  console.debug("[font-decoder] worker ready, recognizing…");
  const recognizeStart = performance.now();
  // Request blocks/symbols so we can map each recognised char to its
  // grid cell by bbox center, not by output order. Order-based mapping
  // breaks when Tesseract emits a duplicate or skips a cell — every
  // subsequent codepoint then gets the wrong recognition.
  const result = await worker.recognize(canvas, {}, { blocks: true });
  console.debug(
    "[font-decoder] recognised in",
    Math.round(performance.now() - recognizeStart),
    "ms",
  );
  const map = new Map<string, string>();
  // confidence-of-best-symbol-so-far per cell; lets us prefer the
  // higher-confidence read when two symbols land in the same cell.
  const cellConfidence = new Map<number, number>();

  type TessSymbol = {
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  };
  const blocks = (result.data.blocks ?? []) as Array<{
    paragraphs?: Array<{
      lines?: Array<{
        words?: Array<{ symbols?: TessSymbol[] }>;
      }>;
    }>;
  }>;
  for (const b of blocks) {
    for (const para of b.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          for (const sym of word.symbols ?? []) {
            const ch = sym.text;
            if (!ch || !isAcceptedChar(ch)) continue;
            const cx = (sym.bbox.x0 + sym.bbox.x1) / 2;
            const cy = (sym.bbox.y0 + sym.bbox.y1) / 2;
            const col = Math.floor(cx / cellW);
            const row = Math.floor(cy / cellH);
            if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
            const idx = row * cols + col;
            if (idx >= codepoints.length) continue;
            const prev = cellConfidence.get(idx) ?? -1;
            if (sym.confidence > prev) {
              cellConfidence.set(idx, sym.confidence);
              map.set(codepoints[idx], ch);
            }
          }
        }
      }
    }
  }
  console.debug(
    "[font-decoder] mapped",
    map.size,
    "of",
    codepoints.length,
    "glyphs",
  );
  onProgress(codepoints.length);
  return map;
}

/**
 * Resolves the chrome.runtime URLs for the locally-bundled tesseract
 * assets. We ship worker.min.js + tesseract-core-simd-lstm.wasm(.js) +
 * chi_sim.traineddata.gz inside the extension (under tesseract/) so:
 *   - No remote code execution. Required by Chrome Web Store MV3 policy.
 *   - No CDN dependency. Sites with strict Content-Security-Policy (e.g.
 *     番茄小说) that block jsDelivr / blob: workers can't disable OCR.
 *   - First-OCR latency is just disk read instead of a 7+ MB CDN fetch.
 *
 * Exported so content.ts's image-OCR path uses the same local assets
 * — otherwise the existing OCR feature still hits the CDN.
 */
export function localTesseractPaths(): {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
} {
  if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return {};
  return {
    workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL(
      "tesseract/tesseract-core-simd-lstm.wasm.js",
    ),
    langPath: chrome.runtime.getURL("tesseract"),
  };
}

/**
 * Returns a warm tesseract.js worker, creating + initialising one on
 * first call. The promise is cached, so concurrent callers share the
 * same warm-up. Used both by ocrGlyphGrid and by the init pre-warmer
 * so the first click doesn't pay the (~10s on a cold connection)
 * trained-data download cost.
 */
/** Latest tesseract logger status (e.g. "loading language traineddata").
 *  Mirrored into the toast detail by ocrGlyphGrid when the user is
 *  actively waiting on a decode — see drainPending. */
let workerStatusDetail = "";
let workerReady = false;

async function ensureWorker(): Promise<
  Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>
> {
  const tess = await import("tesseract.js");
  if (!workerPromise) {
    const startedAt = performance.now();
    workerStatusDetail = "starting OCR engine";
    workerPromise = tess
      .createWorker("chi_sim", undefined, {
        ...localTesseractPaths(),
        logger: (m: { status: string; progress: number }) => {
          if (!m.status) return;
          console.debug(
            "[font-decoder] tesseract:",
            m.status,
            Math.round(m.progress * 100) + "%",
          );
          if (m.status !== "recognizing text") {
            workerStatusDetail = m.status;
          }
        },
      })
      .then(async (w) => {
        await w.setParameters({
          tessedit_pageseg_mode: tess.PSM.SINGLE_BLOCK,
          tessedit_char_whitelist: cjkWhitelist(),
        });
        console.debug(
          "[font-decoder] worker ready in",
          Math.round(performance.now() - startedAt),
          "ms",
        );
        workerReady = true;
        return w;
      });
  }
  return workerPromise as Promise<
    Awaited<ReturnType<typeof tess.createWorker>>
  >;
}

/** Drives the toast through the worker-warmup phase while a click is
 *  actually waiting on it. Returns once the worker is ready. */
async function awaitWorkerWithProgress(): Promise<
  Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>
> {
  if (workerReady) return ensureWorker();
  // Drive toast updates until ensureWorker resolves.
  const promise = ensureWorker();
  let cancelled = false;
  const ticker = (async () => {
    while (!cancelled && !workerReady) {
      setProgress({
        phase: "warming-ocr",
        current: 0,
        total: 0,
        detail: workerStatusDetail || "starting OCR engine",
      });
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  try {
    return await promise;
  } finally {
    cancelled = true;
    await ticker;
  }
}

/**
 * Tesseract OCR character whitelist. Includes:
 *   - CJK Unified Ideographs (U+4E00..U+9FFF) — the bulk of the cipher
 *   - ASCII alphanumerics (0-9, A-Z, a-z) — Bytedance / 番茄's font
 *     also remaps Latin letters and digits via PUA codepoints, since
 *     a chapter can mention "Web 3.0" or "Q版" without breaking
 *     character. Excluding them caused those glyphs to be dropped.
 *
 * Generated lazily on first use; bigger than the trained data's natural
 * vocabulary is fine — Tesseract just won't propose chars outside it.
 */
let cachedWhitelist: string | null = null;
function cjkWhitelist(): string {
  if (cachedWhitelist) return cachedWhitelist;
  const parts: string[] = [];
  for (let cp = 0x4e00; cp <= 0x9fff; cp++) parts.push(String.fromCharCode(cp));
  parts.push("0123456789");
  parts.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  parts.push("abcdefghijklmnopqrstuvwxyz");
  cachedWhitelist = parts.join("");
  return cachedWhitelist;
}

/**
 * True for any character we'll accept as a valid OCR output for a
 * cipher glyph: CJK Unified Ideographs (incl. Extension A) and ASCII
 * alphanumerics. Anything else (punctuation, whitespace, garbled
 * symbols Tesseract slipped through) is rejected; the cell stays
 * unmapped so callers fall through to the original PUA char.
 */
function isAcceptedChar(ch: string): boolean {
  if (!ch || ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  return false;
}

// ─── Cache ─────────────────────────────────────────────────────────

async function loadCache(key: string): Promise<DecodedFontEntry | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY)) as Record<
      string,
      Record<string, DecodedFontEntry>
    >;
    const all = stored[STORAGE_KEY] ?? {};
    const entry = all[key];
    if (!entry) return null;
    if (Date.now() - entry.builtAt > CACHE_TTL_MS) return null;
    return entry;
  } catch (err) {
    console.warn("[font-decoder] cache load failed:", err);
    return null;
  }
}

async function saveCache(
  key: string,
  map: Record<string, string>,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY)) as Record<
      string,
      Record<string, DecodedFontEntry>
    >;
    const all = stored[STORAGE_KEY] ?? {};
    all[key] = { url: key, map, builtAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  } catch (err) {
    console.warn("[font-decoder] cache save failed:", err);
  }
}

function mapToObject(m: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

// ─── Internals ─────────────────────────────────────────────────────

function setProgress(next: DecoderProgress): void {
  progress = next;
  for (const cb of progressListeners) {
    try {
      cb(next);
    } catch (err) {
      console.error("[font-decoder] progress listener threw:", err);
    }
  }
}

/** Test-only: reset module state so unit tests can re-run init. */
export function _resetFontDecoderForTests(): void {
  activeMap.clear();
  pendingCodepoints.clear();
  failedCodepoints.clear();
  cipherFont = null;
  cacheKey = null;
  initPromise = null;
  inflightDecode = null;
  workerPromise = null;
  progress = { phase: "idle", current: 0, total: 0 };
}
