/**
 * In-memory loader for the build-time phonetic-component index shipped
 * at `dict/phonetics.json`. Mirrors the components-lookup pattern: one
 * shared fetch+parse, idempotent, sub-millisecond lookups once loaded.
 *
 * The data is produced by scripts/build-phonetics.mjs by clustering
 * each component's containing characters by pinyin similarity to the
 * component's own reading. See that script's header for how membership
 * is decided.
 *
 * Two indexes are built on first load:
 *   - `families`: component → PhoneticFamily   (the family card surface)
 *   - `byMember`: char → list of components for which the char is a
 *                 family member (the "what family does 清 belong to?"
 *                 lookup, used by the char detail card cross-link).
 */
import { PHONETICS_DICT_PATH } from "./constants";

/**
 * Sound-similarity bucket between a member character's reading and
 * the family component's reading.
 *   exact         — same initial, final, AND tone
 *   tone          — same initial AND final, tone differs
 *   initial-shift — same final, initial differs (e.g. q→j: 青→静)
 *   final-shift   — same initial, final differs (rarer)
 *
 * "Distant" chars are filtered out at build time (the component is
 * acting semantically there, not phonetically), so they never appear
 * in this surface.
 */
export type PhoneticMatch = "exact" | "tone" | "initial-shift" | "final-shift";

export interface PhoneticMember {
  char: string;
  /** CEDICT-numeric pinyin (e.g. "qing1"). UI formats via formatPinyin. */
  pinyin: string;
  match: PhoneticMatch;
  /** Compound-count freq proxy — number of CEDICT compounds containing
   *  this char. Bigger = more common; used as a secondary sort key. */
  freq: number;
}

export interface PhoneticFamily {
  /** The component's own CEDICT-numeric reading (e.g. "Qing1" for 青). */
  reading: string;
  /**
   * Predictive members ÷ total members with readings. Reported as
   * metadata so the UI can surface a low-reliability warning. A high
   * value (>= 0.8) means the component is *almost always* phonetic in
   * the chars where it appears; a low value means it's often just a
   * semantic component, but the listed members are still genuine
   * phonetic siblings.
   */
  reliability: number;
  /** Sorted by match bucket (exact first), then freq desc. */
  members: PhoneticMember[];
}

let families: Map<string, PhoneticFamily> | null = null;
let byMember: Map<string, string[]> | null = null;
let loadPromise: Promise<Map<string, PhoneticFamily>> | null = null;

export function isPhoneticsReady(): boolean {
  return families !== null;
}

/** Returns the family rooted at `component`, or null when not indexed. */
export function lookupFamily(component: string): PhoneticFamily | null {
  if (!families || !component) return null;
  return families.get(component) ?? null;
}

/**
 * Returns every phonetic family that lists `char` as a member. Most
 * characters belong to exactly one family (the phonetic component is
 * unique by construction), but a few decompositions surface a char in
 * multiple families when more than one of its components is itself a
 * phonetic series. Empty array when the char has no families.
 */
export function familiesContaining(char: string): string[] {
  if (!byMember || !char) return [];
  return byMember.get(char) ?? [];
}

/** Iteration helper for the Families tab list view. */
export function allFamilies(): Array<readonly [string, PhoneticFamily]> {
  if (!families) return [];
  return Array.from(families.entries());
}

export async function ensurePhoneticsLoaded(
  resolveUrl: (path: string) => string = defaultResolveUrl,
): Promise<Map<string, PhoneticFamily>> {
  if (families) return families;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const url = resolveUrl(PHONETICS_DICT_PATH);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch phonetics index (HTTP ${response.status}) from ${url}`,
      );
    }
    const data = (await response.json()) as Record<string, PhoneticFamily>;
    const fams = new Map<string, PhoneticFamily>();
    const inverse = new Map<string, string[]>();
    for (const [comp, fam] of Object.entries(data)) {
      fams.set(comp, fam);
      for (const m of fam.members) {
        let arr = inverse.get(m.char);
        if (!arr) {
          arr = [];
          inverse.set(m.char, arr);
        }
        arr.push(comp);
      }
    }
    families = fams;
    byMember = inverse;
    return fams;
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });

  return loadPromise;
}

function defaultResolveUrl(path: string): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

/** Test-only: clear cached state. */
export function _resetPhoneticsForTests(): void {
  families = null;
  byMember = null;
  loadPromise = null;
}

/** Test-only: install pre-parsed indexes (skips fetch). */
export function _setPhoneticsForTests(
  fams: Map<string, PhoneticFamily>,
): void {
  families = fams;
  const inverse = new Map<string, string[]>();
  for (const [comp, fam] of fams.entries()) {
    for (const m of fam.members) {
      let arr = inverse.get(m.char);
      if (!arr) {
        arr = [];
        inverse.set(m.char, arr);
      }
      arr.push(comp);
    }
  }
  byMember = inverse;
  loadPromise = Promise.resolve(fams);
}
