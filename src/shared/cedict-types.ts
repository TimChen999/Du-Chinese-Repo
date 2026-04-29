/**
 * CC-CEDICT data shapes shared by the loader, lookup, and consumers.
 *
 * One source line in cedict_ts.u8 looks like:
 *   中國 中国 [Zhong1 guo2] /China/Middle Kingdom/
 *
 * Parsed into a CedictEntry, that line becomes:
 *   { traditional: "中國", simplified: "中国",
 *     pinyinNumeric: "Zhong1 guo2", definitions: ["China", "Middle Kingdom"],
 *     modifiers: [] }
 *
 * Modifiers are CC-CEDICT's structured metadata (classifiers, "abbr. for",
 * "Taiwan pr.", etc.) extracted from `/`-segments that match a strict,
 * known shape. They live on a separate field so the popup can render
 * definitions and modifiers in different visual slots, and so an LLM
 * gloss upgrade can replace `definitions` without losing the dictionary
 * metadata.
 *
 * A single headword (e.g. 行) can have multiple entries with different pinyin,
 * which is why CedictHit returns an array.
 */

/**
 * Reference to another headword, as found inside CC-CEDICT modifiers.
 *  - "張|张[zhang1]"      -> { trad: "張", simp: "张", pinyinNumeric: "zhang1" }
 *  - "五[wu3]"            -> { trad: "五", simp: "五", pinyinNumeric: "wu3" }
 */
export interface CedictRef {
  trad: string;
  simp: string;
  pinyinNumeric: string;
}

/**
 * Structured CC-CEDICT modifier. Extracted only when an entire `/`-segment
 * matches one of the recognised shapes -- no fuzzy matching, no partial
 * extraction. Anything ambiguous stays in `definitions`.
 */
export type CedictModifier =
  | { kind: "classifier"; refs: CedictRef[] }
  | { kind: "altPronunciation"; pinyinNumeric: string; region?: "Taiwan" }
  | { kind: "surname"; name: string }
  | {
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
      ref: CedictRef;
    };

export interface CedictEntry {
  traditional: string;
  simplified: string;
  /** Raw pinyin in CC-CEDICT's numeric form, e.g. "yin2 hang2". */
  pinyinNumeric: string;
  /** One slash-delimited gloss per array slot, with modifier segments removed. */
  definitions: string[];
  /** Structured metadata extracted from modifier segments. May be empty. */
  modifiers: CedictModifier[];
}

export interface CedictHit {
  /** The matched substring (always the simplified headword we keyed on). */
  word: string;
  /** Length of the matched word in characters (= word.length). */
  length: number;
  /** All dictionary entries with this headword (homographs). */
  entries: CedictEntry[];
}
