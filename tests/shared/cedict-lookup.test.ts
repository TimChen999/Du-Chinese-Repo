import { describe, it, expect, beforeEach } from "vitest";

import {
  _resetCedictForTests,
  _setCedictForTests,
  ensureDictionaryLoaded,
  findLongest,
  formatModifier,
  formatPinyin,
  formatPinyinSyllable,
  isDictionaryReady,
  lookupExact,
  parseCedict,
  parseLine,
  tryParseModifier,
} from "../../src/shared/cedict-lookup";

describe("parseLine", () => {
  it("parses a standard CC-CEDICT line", () => {
    const line = "中國 中国 [Zhong1 guo2] /China/Middle Kingdom/";
    const e = parseLine(line);
    expect(e).not.toBeNull();
    expect(e?.traditional).toBe("中國");
    expect(e?.simplified).toBe("中国");
    expect(e?.pinyinNumeric).toBe("Zhong1 guo2");
    expect(e?.definitions).toEqual(["China", "Middle Kingdom"]);
  });

  it("parses a single-definition line", () => {
    const line = "你好 你好 [ni3 hao3] /hello/";
    const e = parseLine(line);
    expect(e?.definitions).toEqual(["hello"]);
    expect(e?.modifiers).toEqual([]);
  });

  it("returns null for malformed lines (no brackets)", () => {
    expect(parseLine("not a real entry")).toBeNull();
  });

  it("returns null for malformed lines (no headword space)", () => {
    expect(parseLine("中国[zhong1 guo2] /China/")).toBeNull();
  });

  it("extracts CC-CEDICT modifier segments away from the gloss", () => {
    const e = parseLine("圖片 图片 [tu2 pian4] /picture; photograph/CL:張|张[zhang1]/");
    expect(e?.definitions).toEqual(["picture; photograph"]);
    expect(e?.modifiers).toEqual([
      {
        kind: "classifier",
        refs: [{ trad: "張", simp: "张", pinyinNumeric: "zhang1" }],
      },
    ]);
  });

  it("keeps inline (CL:...) notation in the gloss (sense-scoped, not entry-level)", () => {
    const e = parseLine(
      "望遠鏡 望远镜 [wang4 yuan3 jing4] /telescope (CL:部[bu4]); binoculars (CL:副[fu4])/",
    );
    expect(e?.definitions).toEqual([
      "telescope (CL:部[bu4]); binoculars (CL:副[fu4])",
    ]);
    expect(e?.modifiers).toEqual([]);
  });
});

describe("parseCedict", () => {
  it("indexes both simplified and traditional headwords", () => {
    const map = parseCedict(
      `# CC-CEDICT comment
中國 中国 [Zhong1 guo2] /China/Middle Kingdom/
銀行 银行 [yin2 hang2] /bank/
`,
    );
    expect(map.has("中国")).toBe(true);
    expect(map.has("中國")).toBe(true);
    expect(map.has("银行")).toBe(true);
    expect(map.has("銀行")).toBe(true);
    expect(map.size).toBe(4);
  });

  it("groups homographs under one key", () => {
    const map = parseCedict(
      `行 行 [hang2] /row/
行 行 [xing2] /to walk/
`,
    );
    const entries = map.get("行");
    expect(entries).toBeDefined();
    expect(entries?.length).toBe(2);
    expect(entries?.[0].pinyinNumeric).toBe("hang2");
    expect(entries?.[1].pinyinNumeric).toBe("xing2");
  });

  it("skips comment and blank lines", () => {
    const map = parseCedict(
      `#comment line
#another
中国 中国 [Zhong1 guo2] /China/

`,
    );
    expect(map.size).toBe(1);
  });
});

describe("findLongest", () => {
  beforeEach(() => {
    _resetCedictForTests();
    const map = parseCedict(
      `中国 中国 [Zhong1 guo2] /China/
中国人 中国人 [Zhong1 guo2 ren2] /Chinese person/
人 人 [ren2] /person/
`,
    );
    _setCedictForTests(map);
  });

  it("returns the longest matching prefix", () => {
    const hit = findLongest("中国人民");
    expect(hit?.word).toBe("中国人");
    expect(hit?.length).toBe(3);
  });

  it("falls back to a shorter match when the longest is unknown", () => {
    const hit = findLongest("人民"); // 人民 not in map; 人 is
    expect(hit?.word).toBe("人");
    expect(hit?.length).toBe(1);
  });

  it("returns null when no prefix matches", () => {
    const hit = findLongest("Xyz");
    expect(hit).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(findLongest("")).toBeNull();
  });

  it("respects the maxChars cap", () => {
    // With maxChars=2, 中国人 (3 chars) should be skipped in favor of 中国 (2).
    const hit = findLongest("中国人", 2);
    expect(hit?.word).toBe("中国");
  });
});

describe("lookupExact", () => {
  beforeEach(() => {
    _resetCedictForTests();
    _setCedictForTests(
      parseCedict(`银行 银行 [yin2 hang2] /bank/`),
    );
  });

  it("returns entries when present", () => {
    const e = lookupExact("银行");
    expect(e?.[0].definitions).toContain("bank");
  });

  it("returns null when absent", () => {
    expect(lookupExact("zzz")).toBeNull();
  });
});

describe("ensureDictionaryLoaded", () => {
  beforeEach(() => {
    _resetCedictForTests();
  });

  it("uses the supplied URL resolver and parses the body", async () => {
    const body = `中国 中国 [Zhong1 guo2] /China/`;
    const fetchSpy = (globalThis as unknown as { fetch: typeof fetch }).fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(
        new Response(body, { status: 200 }),
      )) as unknown as typeof fetch;

    try {
      const map = await ensureDictionaryLoaded((p) => `mock://${p}`);
      expect(map.has("中国")).toBe(true);
      expect(isDictionaryReady()).toBe(true);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy;
    }
  });
});

describe("formatPinyinSyllable", () => {
  it("converts numeric to tone-mark form", () => {
    expect(formatPinyinSyllable("hang2", "toneMarks")).toBe("háng");
    expect(formatPinyinSyllable("yin2", "toneMarks")).toBe("yín");
    expect(formatPinyinSyllable("Zhong1", "toneMarks")).toBe("Zhōng");
  });

  it("preserves numeric form for toneNumbers", () => {
    expect(formatPinyinSyllable("hang2", "toneNumbers")).toBe("hang2");
  });

  it("strips tones for the 'none' style", () => {
    expect(formatPinyinSyllable("hang2", "none")).toBe("hang");
  });

  it("handles ü (CC-CEDICT writes 'u:')", () => {
    expect(formatPinyinSyllable("nu:e4", "toneMarks")).toBe("nüè");
    expect(formatPinyinSyllable("nu:e4", "none")).toBe("nüe");
  });

  it("places the mark on the second vowel of iu/ui", () => {
    expect(formatPinyinSyllable("liu2", "toneMarks")).toBe("liú");
    expect(formatPinyinSyllable("hui4", "toneMarks")).toBe("huì");
  });

  it("leaves tone 5 (neutral) without a mark", () => {
    expect(formatPinyinSyllable("de5", "toneMarks")).toBe("de");
  });
});

describe("formatPinyin (multi-syllable)", () => {
  it("formats a space-separated string", () => {
    expect(formatPinyin("yin2 hang2", "toneMarks")).toBe("yín háng");
    expect(formatPinyin("yin2 hang2", "toneNumbers")).toBe("yin2 hang2");
    expect(formatPinyin("yin2 hang2", "none")).toBe("yin hang");
  });

  it("handles empty input", () => {
    expect(formatPinyin("", "toneMarks")).toBe("");
  });
});

describe("tryParseModifier — strict matching", () => {
  it("matches a single classifier with trad|simp pair", () => {
    expect(tryParseModifier("CL:張|张[zhang1]")).toEqual({
      kind: "classifier",
      refs: [{ trad: "張", simp: "张", pinyinNumeric: "zhang1" }],
    });
  });

  it("matches multiple comma-separated classifiers", () => {
    expect(tryParseModifier("CL:尊[zun1], 張|张[zhang1]")).toEqual({
      kind: "classifier",
      refs: [
        { trad: "尊", simp: "尊", pinyinNumeric: "zun1" },
        { trad: "張", simp: "张", pinyinNumeric: "zhang1" },
      ],
    });
  });

  it("matches comma-separated classifiers with no space after comma", () => {
    expect(tryParseModifier("CL:份[fen4],頓|顿[dun4]")).toEqual({
      kind: "classifier",
      refs: [
        { trad: "份", simp: "份", pinyinNumeric: "fen4" },
        { trad: "頓", simp: "顿", pinyinNumeric: "dun4" },
      ],
    });
  });

  it("matches `abbr. for` cross-reference", () => {
    expect(
      tryParseModifier("abbr. for 百科全書|百科全书[bai3 ke1 quan2 shu1]"),
    ).toEqual({
      kind: "abbrFor",
      ref: {
        trad: "百科全書",
        simp: "百科全书",
        pinyinNumeric: "bai3 ke1 quan2 shu1",
      },
    });
  });

  it("matches `old variant of` with single-char ref (no | pair)", () => {
    expect(tryParseModifier("old variant of 五[wu3]")).toEqual({
      kind: "oldVariantOf",
      ref: { trad: "五", simp: "五", pinyinNumeric: "wu3" },
    });
  });

  it("matches `Taiwan pr.` and `also pr.`", () => {
    expect(tryParseModifier("Taiwan pr. [xia4hai2]")).toEqual({
      kind: "altPronunciation",
      pinyinNumeric: "xia4hai2",
      region: "Taiwan",
    });
    expect(tryParseModifier("also pr. [zhong4 yong4]")).toEqual({
      kind: "altPronunciation",
      pinyinNumeric: "zhong4 yong4",
    });
  });

  it("matches `surname X` with Latin romanization", () => {
    expect(tryParseModifier("surname Ding")).toEqual({
      kind: "surname",
      name: "Ding",
    });
  });

  it("matches the other cross-reference verbs", () => {
    expect(tryParseModifier("see 基友[ji1 you3]")).toMatchObject({
      kind: "see",
    });
    expect(tryParseModifier("see also 個|个[ge4]")).toMatchObject({
      kind: "seeAlso",
    });
    expect(tryParseModifier("variant of 個|个[ge4]")).toMatchObject({
      kind: "variantOf",
    });
    expect(tryParseModifier("erhua variant of 花[hua1]")).toMatchObject({
      kind: "erhuaOf",
    });
    expect(tryParseModifier("short for 個|个[ge4]")).toMatchObject({
      kind: "shortFor",
    });
    expect(tryParseModifier("equivalent to 個|个[ge4]")).toMatchObject({
      kind: "equivalentTo",
    });
    expect(tryParseModifier("also written 個|个[ge4]")).toMatchObject({
      kind: "alsoWritten",
    });
  });

  it("rejects partial matches — segment must be the full modifier", () => {
    // Has trailing prose after the ref → not a pure modifier.
    expect(
      tryParseModifier("variant of 個|个[ge4] used in some contexts"),
    ).toBeNull();
    // Missing the bracketed pinyin.
    expect(tryParseModifier("variant of 個")).toBeNull();
    // Inline parenthesised CL: inside a definition is NOT extracted.
    expect(tryParseModifier("telescope (CL:部[bu4])")).toBeNull();
    // Plain English definition.
    expect(tryParseModifier("picture; photograph")).toBeNull();
    // (idiom) tag at start of segment is NOT a modifier (sense-level).
    expect(tryParseModifier("(idiom) to take the lead")).toBeNull();
  });

  it("rejects `surname` with non-Latin payload (avoid garbage)", () => {
    // Strict: only Latin-romanized surnames are accepted.
    expect(tryParseModifier("surname 张")).toBeNull();
    expect(tryParseModifier("surname")).toBeNull();
  });
});

describe("formatModifier", () => {
  it("formats classifiers with simp char + tone-marked pinyin", () => {
    expect(
      formatModifier(
        {
          kind: "classifier",
          refs: [{ trad: "張", simp: "张", pinyinNumeric: "zhang1" }],
        },
        "toneMarks",
      ),
    ).toBe("Classifier: 张 zhāng");
  });

  it("pluralises label when multiple classifier refs", () => {
    expect(
      formatModifier(
        {
          kind: "classifier",
          refs: [
            { trad: "尊", simp: "尊", pinyinNumeric: "zun1" },
            { trad: "張", simp: "张", pinyinNumeric: "zhang1" },
          ],
        },
        "toneMarks",
      ),
    ).toBe("Classifiers: 尊 zūn, 张 zhāng");
  });

  it("formats abbr. for with tone-marked pinyin", () => {
    expect(
      formatModifier(
        {
          kind: "abbrFor",
          ref: {
            trad: "百科全書",
            simp: "百科全书",
            pinyinNumeric: "bai3 ke1 quan2 shu1",
          },
        },
        "toneMarks",
      ),
    ).toBe("Abbreviation of: 百科全书 bǎi kē quán shū");
  });

  it("formats Taiwan pronunciation with tone marks", () => {
    expect(
      formatModifier(
        {
          kind: "altPronunciation",
          pinyinNumeric: "zhong4 yong4",
          region: "Taiwan",
        },
        "toneMarks",
      ),
    ).toBe("Taiwan pr.: zhòng yòng");
  });

  it("formats surname plainly", () => {
    expect(
      formatModifier({ kind: "surname", name: "Ding" }, "toneMarks"),
    ).toBe("Surname: Ding");
  });
});
