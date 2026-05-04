/**
 * Tests for the phonetics-lookup module: parsing the build-time index,
 * lookups by component, and the inverse member→component index used by
 * the char detail card cross-link.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  _resetPhoneticsForTests,
  _setPhoneticsForTests,
  allFamilies,
  ensurePhoneticsLoaded,
  familiesContaining,
  isPhoneticsReady,
  lookupFamily,
  type PhoneticFamily,
} from "../../src/shared/phonetics-lookup";

afterEach(() => {
  _resetPhoneticsForTests();
});

function makeFamily(reading: string, members: PhoneticFamily["members"]): PhoneticFamily {
  return { reading, reliability: 1, members };
}

describe("phonetics-lookup", () => {
  it("isPhoneticsReady is false before load", () => {
    expect(isPhoneticsReady()).toBe(false);
    expect(lookupFamily("青")).toBe(null);
    expect(familiesContaining("清")).toEqual([]);
  });

  it("test installer populates families and inverse index", () => {
    const fams = new Map<string, PhoneticFamily>([
      [
        "青",
        makeFamily("Qing1", [
          { char: "清", pinyin: "Qing1", match: "exact", freq: 325 },
          { char: "情", pinyin: "qing2", match: "tone", freq: 362 },
          { char: "静", pinyin: "jing4", match: "initial-shift", freq: 50 },
        ]),
      ],
      [
        "包",
        makeFamily("Bao1", [
          { char: "胞", pinyin: "bao1", match: "exact", freq: 111 },
          { char: "抱", pinyin: "bao4", match: "tone", freq: 60 },
        ]),
      ],
    ]);
    _setPhoneticsForTests(fams);

    expect(isPhoneticsReady()).toBe(true);
    expect(lookupFamily("青")?.reading).toBe("Qing1");
    expect(lookupFamily("不存在的")).toBe(null);

    expect(familiesContaining("清")).toEqual(["青"]);
    expect(familiesContaining("情")).toEqual(["青"]);
    expect(familiesContaining("胞")).toEqual(["包"]);
    expect(familiesContaining("没有")).toEqual([]);
  });

  it("a member appearing in two families is listed in both", () => {
    const fams = new Map<string, PhoneticFamily>([
      [
        "甲",
        makeFamily("jia3", [
          { char: "鸭", pinyin: "ya1", match: "initial-shift", freq: 30 },
        ]),
      ],
      [
        "鸟",
        makeFamily("niao3", [
          { char: "鸭", pinyin: "ya1", match: "initial-shift", freq: 30 },
        ]),
      ],
    ]);
    _setPhoneticsForTests(fams);

    const found = familiesContaining("鸭");
    expect(found).toContain("甲");
    expect(found).toContain("鸟");
    expect(found.length).toBe(2);
  });

  it("allFamilies returns every entry as readonly tuples", () => {
    const fams = new Map<string, PhoneticFamily>([
      ["青", makeFamily("Qing1", [])],
      ["包", makeFamily("Bao1", [])],
    ]);
    _setPhoneticsForTests(fams);

    const list = allFamilies();
    const keys = list.map(([k]) => k).sort();
    expect(keys).toEqual(["包", "青"]);
  });

  it("ensurePhoneticsLoaded uses the supplied resolver and parses JSON", async () => {
    const payload: Record<string, PhoneticFamily> = {
      青: makeFamily("Qing1", [
        { char: "清", pinyin: "Qing1", match: "exact", freq: 325 },
        { char: "情", pinyin: "qing2", match: "tone", freq: 362 },
      ]),
    };

    const fetchSpy = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => payload,
      }) as unknown as Response) as typeof fetch;

    try {
      await ensurePhoneticsLoaded(() => "fixture://phonetics.json");
      expect(isPhoneticsReady()).toBe(true);
      expect(lookupFamily("青")?.members.length).toBe(2);
      expect(familiesContaining("清")).toEqual(["青"]);
    } finally {
      if (fetchSpy) (globalThis as { fetch: typeof fetch }).fetch = fetchSpy;
    }
  });

  it("ensurePhoneticsLoaded surfaces HTTP errors", async () => {
    const fetchSpy = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      ({
        ok: false,
        status: 404,
      }) as unknown as Response) as typeof fetch;

    try {
      await expect(
        ensurePhoneticsLoaded(() => "fixture://missing.json"),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      if (fetchSpy) (globalThis as { fetch: typeof fetch }).fetch = fetchSpy;
    }
  });
});
