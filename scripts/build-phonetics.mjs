#!/usr/bin/env node
/**
 * Build-time phonetic-component index.
 *
 * Reads public/dict/cedict_ts.u8 and public/dict/components.tsv, then
 * derives, for each candidate component, whether it acts as a *phonetic*
 * across the characters that contain it -- i.e. whether its surface
 * reading predicts the readings of its members.
 *
 * The output JSON keys are component characters; each value is the
 * family the UI surfaces (members grouped by sound-similarity bucket).
 * See src/shared/phonetics-lookup.ts for the consumer shape.
 *
 * Filters applied:
 *   - the component itself has a CEDICT reading (otherwise we can't
 *     compute the predictive baseline; e.g. 氵 has no standalone reading)
 *   - per-member: included only when the component's reading plausibly
 *     predicts the member's reading (exact / tone / initial-shift /
 *     final-shift). "Distant" cases are dropped because in those
 *     characters the component is acting semantically, not phonetically
 *     -- e.g. 马 in 腾/驰/驾 is the "horse" semantic component, not the
 *     phonetic one. Including them would mislead the learner.
 *   - family size >= 3 after pruning (worth studying as a group)
 *
 * Reliability is reported as metadata (predictive / total-with-readings)
 * so the UI can warn when a component is *partially* phonetic, but it's
 * no longer a gate: a component with low reliability can still be a
 * phonetic in the subset of characters where it sounds.
 *
 * Idempotent: regenerates each invocation since it's cheap (sub-second
 * on the full dictionary).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CEDICT_PATH = resolve(ROOT, "public", "dict", "cedict_ts.u8");
const COMPONENTS_PATH = resolve(ROOT, "public", "dict", "components.tsv");
const TARGET = resolve(ROOT, "public", "dict", "phonetics.json");

if (!existsSync(CEDICT_PATH) || !existsSync(COMPONENTS_PATH)) {
  console.error(
    "[phonetics] Missing source data. Run download-cedict and download-makemeahanzi first.",
  );
  process.exit(1);
}

mkdirSync(dirname(TARGET), { recursive: true });

// ─── CEDICT parsing (single-char readings + compound-count freq proxy) ──

/** Single Han codepoint test. Range covers BMP CJK plus common ext-A. */
function isHan(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  );
}

/** True for a Unicode IDC operator (U+2FF0..U+2FFB). */
function isIDC(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x2ff0 && cp <= 0x2fff;
}

function leafComponents(decomp, exclude) {
  const out = [];
  const seen = new Set();
  for (const ch of Array.from(decomp)) {
    if (isIDC(ch) || ch === "？" || ch === "?") continue;
    if (exclude && ch === exclude) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

/**
 * Parses one CEDICT line and returns { simplified, pinyinNumeric } when
 * the line is a regular entry. Skips comments, malformed rows, and
 * surname/erhua-only lines (they'd skew character readings since the
 * "primary" reading we want is the dictionary-canonical one).
 */
function parseCedictLine(line) {
  if (!line || line.startsWith("#")) return null;
  const lb = line.indexOf("[");
  const rb = line.indexOf("]", lb + 1);
  if (lb < 0 || rb < 0) return null;
  const head = line.slice(0, lb).trimEnd();
  const sp = head.indexOf(" ");
  if (sp < 0) return null;
  const simplified = head.slice(sp + 1).trim();
  const pinyinNumeric = line.slice(lb + 1, rb).trim();
  if (!simplified || !pinyinNumeric) return null;
  return { simplified, pinyinNumeric };
}

const cedictText = readFileSync(CEDICT_PATH, "utf8");

/** char → first canonical pinyinNumeric reading we encountered. */
const charPinyin = new Map();

/** char → number of multi-char compound entries containing this char. */
const compoundFreq = new Map();

for (const line of cedictText.split(/\r?\n/)) {
  const e = parseCedictLine(line);
  if (!e) continue;
  const codepoints = Array.from(e.simplified);
  if (codepoints.length === 1) {
    const ch = codepoints[0];
    if (!isHan(ch)) continue;
    if (!charPinyin.has(ch)) charPinyin.set(ch, e.pinyinNumeric);
  } else {
    for (const ch of codepoints) {
      if (!isHan(ch)) continue;
      compoundFreq.set(ch, (compoundFreq.get(ch) ?? 0) + 1);
    }
  }
}

console.log(
  "[phonetics] CEDICT parsed: %d single-char readings, %d chars with compound count",
  charPinyin.size,
  compoundFreq.size,
);

// ─── Components inverse index (component → list of chars containing it) ──

const componentsText = readFileSync(COMPONENTS_PATH, "utf8");
const componentToChars = new Map();

for (const line of componentsText.split(/\r?\n/)) {
  if (!line) continue;
  const parts = line.split("\t");
  const ch = parts[0];
  const decomp = parts[1];
  if (!ch || !decomp) continue;
  for (const leaf of leafComponents(decomp, ch)) {
    if (!isHan(leaf)) continue;
    let arr = componentToChars.get(leaf);
    if (!arr) {
      arr = [];
      componentToChars.set(leaf, arr);
    }
    arr.push(ch);
  }
}

console.log(
  "[phonetics] Component inverse index: %d components",
  componentToChars.size,
);

// ─── Pinyin syllable classifier ────────────────────────────────────────

/**
 * Order-sensitive list: longest prefixes first so "zh" wins over "z".
 * Empty initial is the zero-onset case (e.g. an, ai) — we treat it as
 * a distinct initial bucket so it doesn't merge with random consonants.
 */
const INITIALS = [
  "zh", "ch", "sh",
  "b", "p", "m", "f", "d", "t", "n", "l",
  "g", "k", "h", "j", "q", "x", "r",
  "z", "c", "s",
  "y", "w",
];

/**
 * Splits a single-syllable pinyin token like "qing1" into its initial,
 * final, and tone (1..5; 5 = neutral; 0 when the source omitted a digit).
 * The "u:" digraph (CEDICT writes ü as "u:") is normalized to "v" so
 * initial/final extraction stays lexical. Returns null on multi-syllable
 * input -- we only classify single-character members here.
 */
function parseSyllable(pinyinNumeric) {
  if (!pinyinNumeric) return null;
  const trimmed = pinyinNumeric.trim();
  if (trimmed.includes(" ")) return null;
  const lower = trimmed.toLowerCase().replace(/u:/g, "v");
  const m = /^([a-zv]+)([0-5]?)$/.exec(lower);
  if (!m) return null;
  const body = m[1];
  const tone = m[2] ? parseInt(m[2], 10) : 0;
  let initial = "";
  for (const cand of INITIALS) {
    if (body.startsWith(cand)) {
      initial = cand;
      break;
    }
  }
  const final = body.slice(initial.length);
  if (!final) return null;
  return { initial, final, tone, body };
}

/**
 * Classifies how member's reading relates to the component's reading:
 *   exact         — same initial AND same final AND same tone
 *   tone          — same initial AND same final, tone differs
 *   initial-shift — same final, initial differs (e.g. q→j: 青→静)
 *   final-shift   — same initial, final differs (rarer but real)
 *   distant       — neither initial nor final survives
 *
 * The first four count toward reliability; "distant" does not. We keep
 * distant rows in the family list anyway so the user sees the full
 * coverage and can spot non-predictive cases.
 */
function classifyMatch(base, member) {
  const sameInitial = base.initial === member.initial;
  const sameFinal = base.final === member.final;
  if (sameInitial && sameFinal) {
    return base.tone === member.tone ? "exact" : "tone";
  }
  if (sameFinal) return "initial-shift";
  if (sameInitial) return "final-shift";
  return "distant";
}

const PREDICTIVE = new Set(["exact", "tone", "initial-shift", "final-shift"]);

// ─── Per-component family build ────────────────────────────────────────

const MIN_FAMILY_SIZE = 3;

/** Sort priority for buckets — exact first, weakest match last. */
const MATCH_RANK = {
  exact: 0,
  tone: 1,
  "initial-shift": 2,
  "final-shift": 3,
};

const out = {};
let kept = 0;
let droppedNoBase = 0;
let droppedTooSmall = 0;

for (const [comp, chars] of componentToChars.entries()) {
  if (chars.length < MIN_FAMILY_SIZE) {
    droppedTooSmall++;
    continue;
  }

  const baseReading = charPinyin.get(comp);
  if (!baseReading) {
    droppedNoBase++;
    continue;
  }
  const base = parseSyllable(baseReading);
  if (!base) {
    droppedNoBase++;
    continue;
  }

  /** Dedupe so one char only contributes one row. */
  const seen = new Set();
  const members = [];
  let totalWithReading = 0;
  let predictive = 0;

  for (const ch of chars) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    const memberReading = charPinyin.get(ch);
    if (!memberReading) continue;
    const member = parseSyllable(memberReading);
    if (!member) continue;
    totalWithReading++;
    const match = classifyMatch(base, member);
    if (!PREDICTIVE.has(match)) continue;
    predictive++;
    members.push({
      char: ch,
      pinyin: memberReading,
      match,
      freq: compoundFreq.get(ch) ?? 0,
    });
  }

  if (members.length < MIN_FAMILY_SIZE) {
    droppedTooSmall++;
    continue;
  }

  /**
   * Reliability is now metadata (UI can warn at low values) rather
   * than a gate -- a component that's phonetic in only 30% of its
   * containing chars is still phonetic in *those* chars.
   */
  const reliability =
    totalWithReading > 0
      ? Math.round((predictive / totalWithReading) * 100) / 100
      : 0;

  members.sort((a, b) => {
    const r = MATCH_RANK[a.match] - MATCH_RANK[b.match];
    if (r !== 0) return r;
    if (b.freq !== a.freq) return b.freq - a.freq;
    return a.char.localeCompare(b.char);
  });

  out[comp] = {
    reading: baseReading,
    reliability,
    members,
  };
  kept++;
}

console.log(
  "[phonetics] Kept %d components (dropped %d no-base, %d small)",
  kept,
  droppedNoBase,
  droppedTooSmall,
);

writeFileSync(TARGET, JSON.stringify(out), "utf8");
const fileSize = readFileSync(TARGET).length;
console.log("[phonetics] Wrote %s (%d bytes)", TARGET, fileSize);
