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
import type {
  CedictEntry,
  CedictHit,
  CedictModifier,
  CedictRef,
} from "./cedict-types";
import { translatePua } from "./font-decoder";

// ─── Module state ──────────────────────────────────────────────────

/**
 * Headword (simplified or traditional) -> entries with that headword.
 * Populated once by ensureLoaded(); empty before the file finishes parsing.
 */
let dictionary: Map<string, CedictEntry[]> | null = null;

/** Cached load promise so concurrent callers share the same fetch+parse. */
let loadPromise: Promise<Map<string, CedictEntry[]>> | null = null;

/**
 * Lazy reverse index: simplified-character -> every multi-character
 * CC-CEDICT entry whose simplified headword contains that character.
 * Built on first call to wordsContaining(); rebuilt automatically after
 * _resetCedictForTests.
 *
 * Keyed by every unique character in the simplified headword (not just
 * the first), so it serves both "words beginning with X" and "words
 * containing X" via the same map. Single-character entries are skipped
 * since the WORDS view is about compound words, not the headword
 * itself.
 */
let wordsByCharIndex: Map<string, CedictEntry[]> | null = null;

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

  // PUA chars from font-cipher pages are translated to their decoded
  // real chars before dictionary lookup. Translation is a 1:1 char
  // substitution, so `length` (slice index) still maps onto the source
  // string's offsets — caret/range math is unchanged. The returned
  // `word` is the real-char form, which is what the popup renders.
  const translated = translatePua(text);
  const limit = Math.min(maxChars, translated.length);
  for (let len = limit; len >= 1; len--) {
    const candidate = translated.slice(0, len);
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
  return dictionary.get(translatePua(headword)) ?? null;
}

/**
 * Returns `headword` rendered in the requested script. The conversion
 * is purely CC-CEDICT-driven and uses no extra resources, and works
 * BIDIRECTIONALLY — entries are keyed in the dictionary by both their
 * traditional and simplified forms, so a lookup hits regardless of
 * which form `headword` is currently in:
 *
 *   1. If the headword exactly matches a CC-CEDICT entry (under either
 *      key), return that entry's `traditional` or `simplified` field
 *      depending on the requested script. Handles multi-char words
 *      like 体育 ↔ 體育 correctly because CC-CEDICT stores the pair
 *      as a unit.
 *   2. Otherwise, fall back to per-character substitution: each char is
 *      looked up as its own CC-CEDICT entry; if found, swap to that
 *      entry's matching field. Covers compositional words whose pieces
 *      are dictionary-known.
 *   3. Unknown characters (rare CJK, punctuation, non-Han) pass through
 *      unchanged.
 *
 * Returns the input unchanged when the dictionary isn't loaded yet, or
 * the headword has no CC-CEDICT coverage at all.
 *
 * Note: per-character conversion has inherent ambiguity for some chars
 * (e.g. 后 can be either 后 or 後 depending on context). CC-CEDICT picks
 * one mapping per single-char entry; users wanting context-aware
 * conversion would need to bundle OpenCC. For dictionary-surface
 * display this limitation is acceptable — the CC-CEDICT mapping is
 * the same one used by Pleco and other major dictionaries.
 */
export function toDisplayScript(
  headword: string,
  script: "simplified" | "traditional",
): string {
  if (!headword || !dictionary) return headword;

  const pickField = (e: CedictEntry): string =>
    script === "traditional" ? e.traditional : e.simplified;

  const entries = dictionary.get(headword);
  if (entries && entries.length > 0) {
    return pickField(entries[0]);
  }

  // Per-character fallback. Iterate by codepoint so supplementary-plane
  // CJK survives as a single character (rather than being split into
  // surrogate halves and corrupting the lookup).
  let out = "";
  for (const ch of Array.from(headword)) {
    const charEntries = dictionary.get(ch);
    if (charEntries && charEntries.length > 0) {
      out += pickField(charEntries[0]);
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Returns CC-CEDICT entries whose simplified headword contains
 * `headword` as a contiguous substring, sorted with words *beginning
 * with* the headword first (then by length ascending, then
 * alphabetically). Excludes the entry that matches the headword
 * exactly.
 *
 * Powers the "Words" section on character/word cards. Works for both
 * single-char (默 -> 默默, 默契, ..., 沉默, 幽默) and multi-char
 * headwords (中国 -> 中国人, 中国话, ...; 腌制 -> [] when no entries
 * contain it as a substring).
 *
 * Builds the per-char reverse index lazily on first call. The dictionary
 * keys traditional and simplified to the same entry, so iterating
 * `dictionary.values()` would surface each entry twice — we dedupe by
 * iterating distinct entries via a per-call seen-set.
 */
export function wordsContaining(headword: string): CedictEntry[] {
  if (!dictionary || !headword) return [];
  if (!wordsByCharIndex) {
    const m = new Map<string, CedictEntry[]>();
    const seen = new Set<CedictEntry>();
    for (const entries of dictionary.values()) {
      for (const entry of entries) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        const chars = Array.from(entry.simplified);
        if (chars.length < 2) continue;
        // Index by every unique character. A repeated char (e.g. 上上 in
        // 上上下下) only contributes one bucket entry per word.
        const uniqueChars = new Set(chars);
        for (const ch of uniqueChars) {
          let arr = m.get(ch);
          if (!arr) {
            arr = [];
            m.set(ch, arr);
          }
          arr.push(entry);
        }
      }
    }
    wordsByCharIndex = m;
  }
  const firstChar = Array.from(headword)[0];
  if (!firstChar) return [];
  const candidates = wordsByCharIndex.get(firstChar);
  if (!candidates) return [];
  const headChars = Array.from(headword);
  const filtered =
    headChars.length === 1
      ? candidates.filter((e) => e.simplified !== headword)
      : candidates.filter(
          (e) => e.simplified !== headword && e.simplified.includes(headword),
        );
  filtered.sort((a, b) => {
    const aStarts = a.simplified.startsWith(headword) ? 0 : 1;
    const bStarts = b.simplified.startsWith(headword) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    if (a.simplified.length !== b.simplified.length) {
      return a.simplified.length - b.simplified.length;
    }
    return a.simplified.localeCompare(b.simplified, "zh");
  });
  return filtered;
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
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const definitions: string[] = [];
  const modifiers: CedictModifier[] = [];
  for (const seg of segments) {
    const mod = tryParseModifier(seg);
    if (mod) modifiers.push(mod);
    else definitions.push(seg);
  }
  if (definitions.length === 0 && modifiers.length === 0) return null;

  return { traditional, simplified, pinyinNumeric, definitions, modifiers };
}

// ─── Modifier extraction (strict, deterministic) ───────────────────
//
// Each `/`-segment is tested against a fixed set of patterns. A segment
// is extracted as a modifier ONLY when the entire segment matches one
// of these shapes -- no partial extraction, no fuzzy matching. This
// guarantees the popup renders modifiers without ever surfacing
// half-parsed prose.
//
// REF = `simp[pinyin]` or `trad|simp[pinyin]`, where simp/trad are runs
// of Han characters and pinyin is the bracketed CC-CEDICT numeric form.

const HAN = "[\\p{Script=Han}]+";
const PINYIN_BODY = "[A-Za-z0-9: ]+";
const REF_SOURCE = `(${HAN})(?:\\|(${HAN}))?\\[(${PINYIN_BODY})\\]`;

const RE_CLASSIFIER = new RegExp(
  `^CL:${REF_SOURCE}(?:,\\s*${REF_SOURCE})*$`,
  "u",
);
const RE_REF_LIST_ITEM = new RegExp(REF_SOURCE, "gu");

const RE_SURNAME = /^surname ([A-Z][A-Za-z']*)$/;
const RE_TAIWAN_PR = /^Taiwan pr\. \[([A-Za-z0-9: ]+)\]$/;
const RE_ALSO_PR = /^also pr\. \[([A-Za-z0-9: ]+)\]$/;

const PREFIX_MODIFIERS: Array<{
  prefix: string;
  kind: Extract<
    CedictModifier,
    {
      kind:
        | "variantOf"
        | "oldVariantOf"
        | "abbrFor"
        | "shortFor"
        | "equivalentTo"
        | "erhuaOf"
        | "see"
        | "seeAlso"
        | "alsoWritten";
    }
  >["kind"];
}> = [
  { prefix: "old variant of ", kind: "oldVariantOf" },
  { prefix: "variant of ", kind: "variantOf" },
  { prefix: "erhua variant of ", kind: "erhuaOf" },
  { prefix: "abbr. for ", kind: "abbrFor" },
  { prefix: "short for ", kind: "shortFor" },
  { prefix: "equivalent to ", kind: "equivalentTo" },
  { prefix: "see also ", kind: "seeAlso" },
  { prefix: "see ", kind: "see" },
  { prefix: "also written ", kind: "alsoWritten" },
];

const RE_REF_FULL = new RegExp(`^${REF_SOURCE}$`, "u");

/**
 * Tests a single `/`-segment against the strict modifier patterns.
 * Returns a structured modifier on a full match, or null if the segment
 * is a regular definition (or anything we don't deterministically
 * recognise).
 */
export function tryParseModifier(segment: string): CedictModifier | null {
  // Classifier: CL:REF(,REF)*
  if (segment.startsWith("CL:") && RE_CLASSIFIER.test(segment)) {
    const refs: CedictRef[] = [];
    const body = segment.slice(3);
    for (const m of body.matchAll(RE_REF_LIST_ITEM)) {
      refs.push(refFromMatch(m[1], m[2], m[3]));
    }
    if (refs.length > 0) return { kind: "classifier", refs };
  }

  // Surname: Latin-only romanization (strict).
  const surnameMatch = RE_SURNAME.exec(segment);
  if (surnameMatch) return { kind: "surname", name: surnameMatch[1] };

  // Alternate pronunciations.
  const taiwanMatch = RE_TAIWAN_PR.exec(segment);
  if (taiwanMatch) {
    return {
      kind: "altPronunciation",
      pinyinNumeric: taiwanMatch[1].trim(),
      region: "Taiwan",
    };
  }
  const alsoMatch = RE_ALSO_PR.exec(segment);
  if (alsoMatch) {
    return { kind: "altPronunciation", pinyinNumeric: alsoMatch[1].trim() };
  }

  // Cross-reference verbs: prefix + single REF, with the entire segment
  // consumed by the prefix and exactly one REF.
  for (const { prefix, kind } of PREFIX_MODIFIERS) {
    if (!segment.startsWith(prefix)) continue;
    const rest = segment.slice(prefix.length);
    const m = RE_REF_FULL.exec(rest);
    if (m) {
      return { kind, ref: refFromMatch(m[1], m[2], m[3]) };
    }
  }

  return null;
}

function refFromMatch(
  first: string,
  second: string | undefined,
  pinyin: string,
): CedictRef {
  if (second) return { trad: first, simp: second, pinyinNumeric: pinyin.trim() };
  return { trad: first, simp: first, pinyinNumeric: pinyin.trim() };
}

/**
 * Renders a modifier as a human-readable string for the definition-card
 * UI. Pinyin is converted to the requested style. The label "Classifier:"
 * is pluralised when multiple refs are present.
 */
export function formatModifier(
  mod: CedictModifier,
  style: "toneMarks" | "toneNumbers" | "none",
): string {
  switch (mod.kind) {
    case "classifier": {
      const label = mod.refs.length > 1 ? "Classifiers" : "Classifier";
      const parts = mod.refs.map((r) => formatRef(r, style));
      return `${label}: ${parts.join(", ")}`;
    }
    case "surname":
      return `Surname: ${mod.name}`;
    case "altPronunciation": {
      const region = mod.region ? `${mod.region} pr.` : "Also pr.";
      return `${region}: ${formatPinyin(mod.pinyinNumeric, style)}`;
    }
    case "variantOf":
      return `Variant of: ${formatRef(mod.ref, style)}`;
    case "oldVariantOf":
      return `Old variant of: ${formatRef(mod.ref, style)}`;
    case "erhuaOf":
      return `Erhua of: ${formatRef(mod.ref, style)}`;
    case "abbrFor":
      return `Abbreviation of: ${formatRef(mod.ref, style)}`;
    case "shortFor":
      return `Short for: ${formatRef(mod.ref, style)}`;
    case "equivalentTo":
      return `Equivalent to: ${formatRef(mod.ref, style)}`;
    case "see":
      return `See: ${formatRef(mod.ref, style)}`;
    case "seeAlso":
      return `See also: ${formatRef(mod.ref, style)}`;
    case "alsoWritten":
      return `Also written: ${formatRef(mod.ref, style)}`;
  }
}

function formatRef(
  ref: CedictRef,
  style: "toneMarks" | "toneNumbers" | "none",
): string {
  const pinyin = formatPinyin(ref.pinyinNumeric, style);
  return pinyin ? `${ref.simp} ${pinyin}` : ref.simp;
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
  // Decode PUA chars first so the segmenter sees real CJK and produces
  // correct word boundaries on font-cipher pages.
  sentence = translatePua(sentence);

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
  wordsByCharIndex = null;
}

/** Test-only: install a pre-parsed dictionary (skips fetch). */
export function _setCedictForTests(map: Map<string, CedictEntry[]>): void {
  dictionary = map;
  loadPromise = Promise.resolve(map);
  wordsByCharIndex = null;
}
