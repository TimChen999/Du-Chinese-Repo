/**
 * In-memory CC-CEDICT loader and longest-match lookup.
 *
 * The dictionary file (`dict/cedict_ts.u8`, ~10 MB, ~125k entries) is fetched
 * once per content-script lifetime and parsed into a Map keyed by the
 * simplified headword. Traditional headwords are folded into the same Map
 * so a click on a traditional character also resolves. Multiple entries
 * per headword (homographs like 行 = háng / xíng) are stored as an array.
 *
 * Lookup is a sub-millisecond longest-prefix match: starting from
 * min(maxLen, text.length) characters and walking down to 1, returning
 * the first prefix that exists in the Map. This is the core of the
 * Zhongwen-style "you hover on 银 and 银行 lights up" behaviour — the
 * longest dictionary entry wins.
 *
 * See: .claude/ARCHITECTURE_REDESIGN.md Section 8 "CC-CEDICT loader design".
 */

import {
  CEDICT_DEFAULT_LOOKUP_CHARS,
  CEDICT_DICT_PATH,
} from "./constants";
import type { CedictEntry, CedictHit } from "./cedict-types";

// ─── Module state ──────────────────────────────────────────────────

/**
 * Headword (simplified or traditional) -> entries with that headword.
 * Populated once by ensureLoaded(); empty before the file finishes parsing.
 */
let dictionary: Map<string, CedictEntry[]> | null = null;

/** Cached load promise so concurrent callers share the same fetch+parse. */
let loadPromise: Promise<Map<string, CedictEntry[]>> | null = null;

// ─── Public API ────────────────────────────────────────────────────

/**
 * True once the dictionary is parsed and ready for synchronous lookup.
 * Hover/click handlers can use this to skip the longest-match path during
 * the first few hundred ms of page life.
 */
export function isDictionaryReady(): boolean {
  return dictionary !== null;
}

/**
 * Triggers (or returns) the async load of cedict_ts.u8 from the extension's
 * web-accessible resources. Resolves to the parsed Map. Idempotent.
 *
 * @param resolveUrl  Optional URL resolver. Defaults to `chrome.runtime.getURL`
 *                    so the function works inside the content script. Tests
 *                    can pass a custom resolver to point at a fixture.
 */
export async function ensureDictionaryLoaded(
  resolveUrl: (path: string) => string = defaultResolveUrl,
): Promise<Map<string, CedictEntry[]>> {
  if (dictionary) return dictionary;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const url = resolveUrl(CEDICT_DICT_PATH);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch CC-CEDICT (HTTP ${response.status}) from ${url}`,
      );
    }
    const text = await response.text();
    const map = parseCedict(text);
    dictionary = map;
    return map;
  })().catch((err) => {
    // Allow a future call to retry after a transient failure.
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

/**
 * Longest-prefix match against the dictionary. `text` is typically the
 * remainder of a text node starting at the caret offset; we trim it to
 * `maxChars` first to bound work.
 *
 * Returns null when no prefix of `text` is in the dictionary OR when the
 * dictionary has not yet been loaded — callers should treat both the
 * same: highlight a single character and proceed.
 */
export function findLongest(
  text: string,
  maxChars: number = CEDICT_DEFAULT_LOOKUP_CHARS,
): CedictHit | null {
  if (!dictionary || !text) return null;

  const limit = Math.min(maxChars, text.length);
  for (let len = limit; len >= 1; len--) {
    const candidate = text.slice(0, len);
    const entries = dictionary.get(candidate);
    if (entries && entries.length > 0) {
      return { word: candidate, length: len, entries };
    }
  }
  return null;
}

/**
 * Direct headword lookup. Returns null when the dictionary is not loaded
 * or the headword has no entry. Used by tests and by the popup when an
 * LLM-supplied word is rendered: we call this to keep CC-CEDICT pinyin/
 * gloss available as a fallback row inside the card.
 */
export function lookupExact(headword: string): CedictEntry[] | null {
  if (!dictionary || !headword) return null;
  return dictionary.get(headword) ?? null;
}

// ─── Parsing ───────────────────────────────────────────────────────

/**
 * Parses the full CC-CEDICT text body into a Map keyed by both the
 * simplified and traditional headwords. Comment lines (#-prefixed) and
 * blank lines are skipped.
 *
 * Public for tests; production code should call ensureDictionaryLoaded().
 */
export function parseCedict(body: string): Map<string, CedictEntry[]> {
  const map = new Map<string, CedictEntry[]>();
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    pushEntry(map, entry.simplified, entry);
    if (entry.traditional !== entry.simplified) {
      pushEntry(map, entry.traditional, entry);
    }
  }
  return map;
}

function pushEntry(
  map: Map<string, CedictEntry[]>,
  key: string,
  entry: CedictEntry,
): void {
  const existing = map.get(key);
  if (existing) existing.push(entry);
  else map.set(key, [entry]);
}

/**
 * Parses one CC-CEDICT line. Returns null on malformed input rather than
 * throwing — a few entries each release have unusual edge cases and we
 * shouldn't lose the rest of the dictionary because of a single bad line.
 *
 * Format: `Trad Simp [pin1 yin1] /def1/def2/`
 */
export function parseLine(line: string): CedictEntry | null {
  const bracketStart = line.indexOf("[");
  const bracketEnd = line.indexOf("]", bracketStart + 1);
  if (bracketStart < 0 || bracketEnd < 0) return null;

  const headPart = line.slice(0, bracketStart).trimEnd();
  const spaceIdx = headPart.indexOf(" ");
  if (spaceIdx < 0) return null;

  const traditional = headPart.slice(0, spaceIdx).trim();
  const simplified = headPart.slice(spaceIdx + 1).trim();
  if (!traditional || !simplified) return null;

  const pinyinNumeric = line.slice(bracketStart + 1, bracketEnd).trim();

  const defsStart = line.indexOf("/", bracketEnd);
  if (defsStart < 0) return null;
  const defsBody = line.slice(defsStart + 1);
  const trimmed = defsBody.endsWith("/")
    ? defsBody.slice(0, -1)
    : defsBody;
  const definitions = trimmed.split("/").filter((s) => s.length > 0);
  if (definitions.length === 0) return null;

  return { traditional, simplified, pinyinNumeric, definitions };
}

// ─── Pinyin formatting ─────────────────────────────────────────────

/**
 * Vowel + tone -> diacritic version. Indexed by tone number 1..4.
 * Tone 5 (neutral) is the bare vowel.
 */
const TONE_MARKS: Record<string, string[]> = {
  a: ["a", "ā", "á", "ǎ", "à", "a"],
  e: ["e", "ē", "é", "ě", "è", "e"],
  i: ["i", "ī", "í", "ǐ", "ì", "i"],
  o: ["o", "ō", "ó", "ǒ", "ò", "o"],
  u: ["u", "ū", "ú", "ǔ", "ù", "u"],
  // Special-cased: "u:" in CC-CEDICT represents "ü". Handled in convert().
  v: ["ü", "ǖ", "ǘ", "ǚ", "ǜ", "ü"],
  A: ["A", "Ā", "Á", "Ǎ", "À", "A"],
  E: ["E", "Ē", "É", "Ě", "È", "E"],
  I: ["I", "Ī", "Í", "Ǐ", "Ì", "I"],
  O: ["O", "Ō", "Ó", "Ǒ", "Ò", "O"],
  U: ["U", "Ū", "Ú", "Ǔ", "Ù", "U"],
  V: ["Ü", "Ǖ", "Ǘ", "Ǚ", "Ǜ", "Ü"],
};

/**
 * Converts a single CC-CEDICT pinyin syllable like "hang2" or "lu:e4" or
 * "xx5" into the requested style. The "xx5" syllable means "unknown
 * reading" — we leave it as-is for tone numbers, strip the "5" for
 * marks/none.
 *
 * Tone-mark placement follows the standard Pinyin ordering:
 *   a > e > o > the second vowel of iu/ui (counterintuitive but standard)
 * Otherwise the only vowel.
 */
export function formatPinyinSyllable(
  syllable: string,
  style: "toneMarks" | "toneNumbers" | "none",
): string {
  const m = /^([A-Za-z:]+?)([1-5])?$/.exec(syllable);
  if (!m) return syllable;
  const rawBase = m[1];
  const tone = m[2] ? Number(m[2]) : 0;

  // CC-CEDICT writes ü as "u:" (e.g. lu:e4). Collapse to a marker char
  // 'v'/'V' so we can place a tone mark on it; convert back at end for
  // the no-tone style.
  const base = rawBase.replace(/u:/g, "v").replace(/U:/g, "V");

  if (style === "toneNumbers") {
    return tone ? base.replace(/v/g, "ü").replace(/V/g, "Ü") + tone : base.replace(/v/g, "ü").replace(/V/g, "Ü");
  }

  if (style === "none") {
    return base.replace(/v/g, "ü").replace(/V/g, "Ü");
  }

  // toneMarks: place the diacritic on the right vowel.
  if (!tone || tone === 5 || tone === 0) {
    return base.replace(/v/g, "ü").replace(/V/g, "Ü");
  }

  const idx = pickToneVowel(base);
  if (idx < 0) {
    return base.replace(/v/g, "ü").replace(/V/g, "Ü") + tone;
  }
  const ch = base[idx];
  const replaced = TONE_MARKS[ch]?.[tone] ?? ch;
  // Apply the diacritic at idx, then collapse any remaining v/V to ü/Ü
  // in the rest of the syllable. (E.g. "lve4" -> "lüè", not "lvè".)
  const result = base.slice(0, idx) + replaced + base.slice(idx + 1);
  return result.replace(/v/g, "ü").replace(/V/g, "Ü");
}

/**
 * Tone-mark placement: a > e > o > second of iu/ui > only vowel.
 * Returns the index in `base` where the mark belongs, or -1 if no vowel.
 */
function pickToneVowel(base: string): number {
  const lower = base.toLowerCase();
  const a = lower.indexOf("a");
  if (a >= 0) return a;
  const e = lower.indexOf("e");
  if (e >= 0) return e;
  const o = lower.indexOf("o");
  if (o >= 0) return o;
  // Diphthongs iu/ui: mark the second vowel.
  const iu = lower.indexOf("iu");
  if (iu >= 0) return iu + 1;
  const ui = lower.indexOf("ui");
  if (ui >= 0) return ui + 1;
  // Otherwise pick the only vowel present.
  for (let i = 0; i < lower.length; i++) {
    if ("aeiouv".includes(lower[i])) return i;
  }
  return -1;
}

/**
 * Formats a full pinyin string (space-separated CC-CEDICT syllables) into
 * the user's preferred style.
 */
export function formatPinyin(
  pinyinNumeric: string,
  style: "toneMarks" | "toneNumbers" | "none",
): string {
  if (!pinyinNumeric) return "";
  const syllables = pinyinNumeric.trim().split(/\s+/);
  return syllables.map((s) => formatPinyinSyllable(s, style)).join(" ");
}

// ─── Sentence-level segmentation ───────────────────────────────────

/**
 * Walks `sentence` left-to-right with longest-match against CC-CEDICT
 * and returns one entry per matched word. Non-Chinese runs (English,
 * digits, punctuation) become their own entries with empty pinyin.
 *
 * Used by the click-popup's pinyin strip when the sentence is in
 * Bootstrap state (LLM hasn't returned yet). When the sentence is
 * Hot, callers prefer the LLM's `words` array instead — those carry
 * contextual pinyin that this longest-match path can't produce.
 */
export function segmentSentence(
  sentence: string,
  style: "toneMarks" | "toneNumbers" | "none",
): Array<{ text: string; pinyin: string }> {
  const out: Array<{ text: string; pinyin: string }> = [];
  if (!sentence) return out;

  let i = 0;
  while (i < sentence.length) {
    const ch = sentence[i];
    if (!isCJK(ch)) {
      // Coalesce a run of non-CJK characters into a single entry.
      let j = i;
      while (j < sentence.length && !isCJK(sentence[j])) j++;
      out.push({ text: sentence.slice(i, j), pinyin: "" });
      i = j;
      continue;
    }
    const hit = findLongest(sentence.slice(i));
    if (hit) {
      const entry = hit.entries[0];
      out.push({
        text: hit.word,
        pinyin: formatPinyin(entry.pinyinNumeric, style),
      });
      i += hit.length;
    } else {
      // Unknown CJK char: render bare.
      out.push({ text: ch, pinyin: "" });
      i++;
    }
  }
  return out;
}

function isCJK(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  // CJK Unified Ideographs + Extension A.
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf)
  );
}

// ─── Internal helpers ──────────────────────────────────────────────

function defaultResolveUrl(path: string): string {
  // chrome.runtime is available in the content script and extension pages.
  // Tests pass a custom resolver instead.
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

/** Test-only: clear cached state. Lets unit tests load fixtures repeatedly. */
export function _resetCedictForTests(): void {
  dictionary = null;
  loadPromise = null;
}

/** Test-only: install a pre-parsed dictionary (skips fetch). */
export function _setCedictForTests(map: Map<string, CedictEntry[]>): void {
  dictionary = map;
  loadPromise = Promise.resolve(map);
}
