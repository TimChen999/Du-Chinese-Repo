/**
 * In-memory loader for the Make Me a Hanzi character-decomposition file
 * shipped at `dict/components.tsv`. Mirrors the cedict-lookup pattern:
 * one shared fetch+parse, idempotent, sub-millisecond lookups once
 * loaded.
 *
 * The file is a small TSV (~310 KB, ~9.5k entries) produced at build
 * time by scripts/download-makemeahanzi.mjs. Each row carries:
 *   <character>\t<decomposition>\t<radical>\t<etymologyHint>
 * where <decomposition> uses Unicode IDC operators (U+2FF0..U+2FFB) to
 * describe how the character is composed.
 */

import { COMPONENTS_DICT_PATH } from "./constants";

export interface ComponentsEntry {
  /** IDS string, e.g. "⿰女子" for 好. */
  decomposition: string;
  /** Single primary-radical character; "" when the source had none. */
  radical: string;
  /** Free-form etymology blurb from upstream; "" when absent. */
  hint: string;
}

let dictionary: Map<string, ComponentsEntry> | null = null;
let loadPromise: Promise<Map<string, ComponentsEntry>> | null = null;

/**
 * Lazy inverse index: leaf-component → every character whose
 * decomposition lists that leaf. Built on first call to
 * charsContaining(); rebuilt automatically after _resetComponentsForTests.
 *
 * Used by the Families tab to surface decomposition-only siblings
 * (chars that contain a phonetic head but aren't phonetic members,
 * e.g. 章 vs. 音).
 */
let inverseIndex: Map<string, string[]> | null = null;

export function isComponentsReady(): boolean {
  return dictionary !== null;
}

export function lookupComponents(char: string): ComponentsEntry | null {
  if (!dictionary || !char) return null;
  return dictionary.get(char) ?? null;
}

/**
 * Returns every character whose decomposition (per Make Me a Hanzi)
 * lists `component` as a leaf. Builds the inverse index lazily on
 * first call. Returns an empty array when the dictionary isn't
 * loaded or the component appears in no decompositions.
 *
 * Iteration order isn't guaranteed; callers should sort.
 */
export function charsContaining(component: string): string[] {
  if (!dictionary || !component) return [];
  if (!inverseIndex) {
    const m = new Map<string, string[]>();
    for (const [ch, entry] of dictionary) {
      for (const leaf of leafComponents(entry.decomposition, ch)) {
        let arr = m.get(leaf);
        if (!arr) {
          arr = [];
          m.set(leaf, arr);
        }
        arr.push(ch);
      }
    }
    inverseIndex = m;
  }
  return inverseIndex.get(component) ?? [];
}

export async function ensureComponentsLoaded(
  resolveUrl: (path: string) => string = defaultResolveUrl,
): Promise<Map<string, ComponentsEntry>> {
  if (dictionary) return dictionary;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const url = resolveUrl(COMPONENTS_DICT_PATH);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch components dictionary (HTTP ${response.status}) from ${url}`,
      );
    }
    const text = await response.text();
    const map = parseComponentsTsv(text);
    dictionary = map;
    return map;
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

export function parseComponentsTsv(body: string): Map<string, ComponentsEntry> {
  const map = new Map<string, ComponentsEntry>();
  for (const line of body.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const ch = parts[0];
    const decomposition = parts[1];
    if (!ch || !decomposition) continue;
    map.set(ch, {
      decomposition,
      radical: parts[2] ?? "",
      hint: parts[3] ?? "",
    });
  }
  return map;
}

/**
 * True for Unicode Ideographic Description Characters (U+2FF0..U+2FFB).
 * These are the structural operators (⿰⿱⿲...) inside an IDS string and
 * should be filtered out when extracting the leaf component glyphs.
 */
export function isIDC(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2ff0 && code <= 0x2fff;
}

/**
 * Returns the leaf components from an IDS string with IDC operators and
 * the upstream "?" unknown-component sentinel removed. Iterates by
 * codepoint so supplementary-plane characters survive. Dedupes while
 * preserving first-occurrence order. Optionally drops `exclude` (used
 * by the UI to avoid listing the headword as its own component).
 */
export function leafComponents(
  decomposition: string,
  exclude?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of Array.from(decomposition)) {
    if (isIDC(ch) || ch === "？" || ch === "?") continue;
    if (exclude && ch === exclude) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

function defaultResolveUrl(path: string): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

/** Test-only: clear cached state. */
export function _resetComponentsForTests(): void {
  dictionary = null;
  loadPromise = null;
  inverseIndex = null;
}

/** Test-only: install a pre-parsed map (skips fetch). */
export function _setComponentsForTests(map: Map<string, ComponentsEntry>): void {
  dictionary = map;
  loadPromise = Promise.resolve(map);
  inverseIndex = null;
}
