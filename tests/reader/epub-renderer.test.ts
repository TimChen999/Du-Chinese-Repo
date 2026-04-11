/**
 * Tests for the EpubRenderer class.
 *
 * Mocks epub.js internals (Book, Rendition) to test the renderer's
 * metadata extraction, navigation, text extraction, and cleanup
 * without needing a real EPUB file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EpubRenderer, FONT_FAMILY_MAP, THEME_COLORS } from "../../src/reader/renderers/epub-renderer";
import type { ReaderSettings } from "../../src/reader/reader-types";
import { DEFAULT_READER_SETTINGS } from "../../src/reader/reader-types";

// ─── Shared mock state (module-level so vi.mock and tests share it) ─

let latestMockBook: ReturnType<typeof createMockBook> | null = null;
let latestMockRendition: ReturnType<typeof createMockRendition> | null = null;

function createMockRendition() {
  return {
    display: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    currentLocation: vi.fn().mockReturnValue({
      start: { cfi: "epubcfi(/6/4)" },
    }),
    getContents: vi.fn().mockReturnValue([
      {
        document: {
          body: { textContent: "这是测试文本内容" },
        },
      },
    ]),
    destroy: vi.fn(),
    resize: vi.fn(),
    on: vi.fn(),
    themes: { override: vi.fn(), default: vi.fn() },
  };
}

function createMockBook(mockRendition: ReturnType<typeof createMockRendition>) {
  const spineItems = [
    { href: "ch1.xhtml", index: 0 },
    { href: "ch2.xhtml", index: 1 },
    { href: "ch3.xhtml", index: 2 },
  ];

  return {
    ready: Promise.resolve(),
    loaded: {
      metadata: Promise.resolve({
        title: "三体",
        creator: "刘慈欣",
        language: "zh",
      }),
      navigation: Promise.resolve({
        toc: [
          {
            id: "ch1",
            label: "  第一章  ",
            href: "ch1.xhtml",
            subitems: [
              { id: "s1", label: "第一节", href: "ch1.xhtml#s1" },
            ],
          },
          { id: "ch2", label: "第二章", href: "ch2.xhtml" },
        ],
      }),
    },
    spine: {
      get: vi.fn((idx: number) => spineItems[idx] ?? null),
      each: vi.fn((fn: Function) => {
        spineItems.forEach(fn);
      }),
    },
    coverUrl: vi.fn().mockResolvedValue("blob:cover-url"),
    renderTo: vi.fn().mockImplementation(() => {
      latestMockRendition = createMockRendition();
      return latestMockRendition;
    }),
    destroy: vi.fn(),
  };
}

vi.mock("epubjs", () => ({
  default: vi.fn((_input: any) => {
    latestMockRendition = createMockRendition();
    latestMockBook = createMockBook(latestMockRendition);
    return latestMockBook;
  }),
}));

// ─── Tests ─────────────────────────────────────────────────────────

describe("EpubRenderer", () => {
  let renderer: EpubRenderer;

  beforeEach(() => {
    vi.clearAllMocks();
    latestMockBook = null;
    latestMockRendition = null;
    renderer = new EpubRenderer();
  });

  async function loadAndRender(): Promise<{
    book: ReturnType<typeof createMockBook>;
    rendition: ReturnType<typeof createMockRendition>;
  }> {
    const file = createMockFile("test.epub");
    await renderer.load(file);
    const book = latestMockBook!;
    const container = document.createElement("div");
    await renderer.renderTo(container);
    const rendition = latestMockRendition!;
    return { book, rendition };
  }

  describe("properties", () => {
    it("has formatName EPUB", () => {
      expect(renderer.formatName).toBe("EPUB");
    });

    it("handles .epub extension", () => {
      expect(renderer.extensions).toEqual([".epub"]);
    });
  });

  describe("load()", () => {
    it("extracts title from metadata", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.title).toBe("三体");
    });

    it("extracts author from metadata", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.author).toBe("刘慈欣");
    });

    it("extracts cover URL", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.coverUrl).toBe("blob:cover-url");
    });

    it("converts TOC with trimmed labels", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.toc[0].label).toBe("第一章");
    });

    it("converts nested TOC entries", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.toc[0].children).toHaveLength(1);
      expect(meta.toc[0].children![0].label).toBe("第一节");
    });

    it("counts spine items for totalChapters", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.totalChapters).toBe(3);
    });

    it("starts at chapter 0", async () => {
      const file = createMockFile("test.epub");
      const meta = await renderer.load(file);
      expect(meta.currentChapter).toBe(0);
    });

    it("falls back to filename when title is empty", async () => {
      const ePub = (await import("epubjs")).default as any;
      ePub.mockImplementationOnce((_input: any) => {
        latestMockRendition = createMockRendition();
        latestMockBook = createMockBook(latestMockRendition);
        latestMockBook.loaded.metadata = Promise.resolve({
          title: "",
          creator: "",
          language: "",
        });
        return latestMockBook;
      });

      const r = new EpubRenderer();
      const file = createMockFile("fallback-book.epub");
      const meta = await r.load(file);
      expect(meta.title).toBe("fallback-book.epub");
    });
  });

  describe("renderTo()", () => {
    it("calls book.renderTo with correct options", async () => {
      const file = createMockFile("test.epub");
      await renderer.load(file);
      const book = latestMockBook!;
      const container = document.createElement("div");
      await renderer.renderTo(container);

      expect(book.renderTo).toHaveBeenCalledWith(container, {
        width: "100%",
        height: "100%",
        spread: "none",
        flow: "scrolled-doc",
        allowScriptedContent: false,
      });
    });

    it("calls rendition.display() to show first page", async () => {
      const { rendition } = await loadAndRender();
      expect(rendition.display).toHaveBeenCalled();
    });

    it("throws when no book is loaded", async () => {
      const container = document.createElement("div");
      await expect(renderer.renderTo(container)).rejects.toThrow("No book loaded");
    });
  });

  describe("goTo()", () => {
    it("navigates by spine index (number)", async () => {
      const { rendition } = await loadAndRender();
      await renderer.goTo(1);
      expect(rendition.display).toHaveBeenCalledWith("ch2.xhtml");
    });

    it("navigates by string location (href or CFI)", async () => {
      const { rendition } = await loadAndRender();
      await renderer.goTo("ch1.xhtml");
      expect(rendition.display).toHaveBeenCalledWith("ch1.xhtml");
    });

    it("does nothing when rendition is not initialized", async () => {
      await renderer.goTo(0);
    });
  });

  describe("next() / prev()", () => {
    it("next() delegates to rendition.next()", async () => {
      const { rendition } = await loadAndRender();
      const result = await renderer.next();
      expect(rendition.next).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("prev() delegates to rendition.prev()", async () => {
      const { rendition } = await loadAndRender();
      const result = await renderer.prev();
      expect(rendition.prev).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it("next() returns false when no rendition", async () => {
      const result = await renderer.next();
      expect(result).toBe(false);
    });

    it("prev() returns false when no rendition", async () => {
      const result = await renderer.prev();
      expect(result).toBe(false);
    });
  });

  describe("getCurrentLocation()", () => {
    it("returns CFI string from current location", async () => {
      await loadAndRender();
      const location = renderer.getCurrentLocation();
      expect(location).toBe("epubcfi(/6/4)");
    });

    it("returns empty string when no rendition", () => {
      expect(renderer.getCurrentLocation()).toBe("");
    });
  });

  describe("getVisibleText()", () => {
    it("returns body text from contents", async () => {
      await loadAndRender();
      const text = renderer.getVisibleText();
      expect(text).toBe("这是测试文本内容");
    });

    it("returns empty string when no rendition", () => {
      expect(renderer.getVisibleText()).toBe("");
    });
  });

  describe("destroy()", () => {
    it("cleans up rendition and book", async () => {
      const { rendition, book } = await loadAndRender();
      renderer.destroy();
      expect(rendition.destroy).toHaveBeenCalled();
      expect(book.destroy).toHaveBeenCalled();
    });

    it("handles destroy when nothing is loaded", () => {
      expect(() => renderer.destroy()).not.toThrow();
    });
  });

  describe("convertToc()", () => {
    it("converts flat NavItem list to TocEntry list", () => {
      const navItems = [
        { id: "1", label: "Chapter 1", href: "c1.xhtml" },
        { id: "2", label: "Chapter 2", href: "c2.xhtml" },
      ];
      const result = renderer.convertToc(navItems as any);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        label: "Chapter 1",
        href: "c1.xhtml",
        level: 0,
        children: undefined,
      });
    });

    it("handles subitems recursively", () => {
      const navItems = [
        {
          id: "1",
          label: "Chapter 1",
          href: "c1.xhtml",
          subitems: [
            { id: "1.1", label: "Section 1", href: "c1.xhtml#s1" },
          ],
        },
      ];
      const result = renderer.convertToc(navItems as any);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].label).toBe("Section 1");
    });

    it("trims whitespace from labels", () => {
      const navItems = [
        { id: "1", label: "  Spaced Label  ", href: "test.xhtml" },
      ];
      const result = renderer.convertToc(navItems as any);
      expect(result[0].label).toBe("Spaced Label");
    });
  });

  describe("getRendition()", () => {
    it("returns null before renderTo()", () => {
      expect(renderer.getRendition()).toBeNull();
    });

    it("returns the rendition after renderTo()", async () => {
      await loadAndRender();
      expect(renderer.getRendition()).not.toBeNull();
    });
  });

  describe("getSpineIndex()", () => {
    it("returns the correct index for a known href", async () => {
      const file = createMockFile("test.epub");
      await renderer.load(file);
      expect(renderer.getSpineIndex("ch2.xhtml")).toBe(1);
    });

    it("strips fragment before matching", async () => {
      const file = createMockFile("test.epub");
      await renderer.load(file);
      expect(renderer.getSpineIndex("ch1.xhtml#s1")).toBe(0);
    });

    it("returns -1 for unknown href", async () => {
      const file = createMockFile("test.epub");
      await renderer.load(file);
      expect(renderer.getSpineIndex("nonexistent.xhtml")).toBe(-1);
    });

    it("returns -1 when no book is loaded", () => {
      expect(renderer.getSpineIndex("ch1.xhtml")).toBe(-1);
    });
  });

  describe("onRelocated()", () => {
    it("fires callback with spine index on relocated event", async () => {
      const { rendition } = await loadAndRender();
      const callback = vi.fn();
      renderer.onRelocated(callback);

      const relocatedHandler = rendition.on.mock.calls.find(
        (call: any[]) => call[0] === "relocated",
      );
      expect(relocatedHandler).toBeDefined();

      relocatedHandler![1]({ start: { index: 2 } });
      expect(callback).toHaveBeenCalledWith(2);
    });

    it("does not fire callback when index is missing", async () => {
      const { rendition } = await loadAndRender();
      const callback = vi.fn();
      renderer.onRelocated(callback);

      const relocatedHandler = rendition.on.mock.calls.find(
        (call: any[]) => call[0] === "relocated",
      );
      relocatedHandler![1]({ start: {} });
      expect(callback).not.toHaveBeenCalled();
    });

    it("does nothing when rendition is not initialized", () => {
      expect(() => renderer.onRelocated(() => {})).not.toThrow();
    });
  });

  describe("applySettings()", () => {
    function makeSettings(overrides: Partial<ReaderSettings> = {}): ReaderSettings {
      return { ...DEFAULT_READER_SETTINGS, theme: "light", ...overrides };
    }

    it("overrides font-size on the rendition", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ fontSize: 24 }));
      expect(rendition.themes.override).toHaveBeenCalledWith("font-size", "24px");
    });

    it("overrides font-family with mapped CSS value", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ fontFamily: "noto-serif" }));
      expect(rendition.themes.override).toHaveBeenCalledWith(
        "font-family",
        FONT_FAMILY_MAP["noto-serif"],
      );
    });

    it("falls back to system font for unknown fontFamily", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ fontFamily: "unknown-font" }));
      expect(rendition.themes.override).toHaveBeenCalledWith(
        "font-family",
        FONT_FAMILY_MAP["system"],
      );
    });

    it("overrides line-height on the rendition", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ lineSpacing: 2.0 }));
      expect(rendition.themes.override).toHaveBeenCalledWith("line-height", "2");
    });

    it("applies light theme colors", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ theme: "light" }));
      expect(rendition.themes.override).toHaveBeenCalledWith("color", THEME_COLORS.light.text);
      expect(rendition.themes.override).toHaveBeenCalledWith("background-color", THEME_COLORS.light.bg);
    });

    it("applies dark theme colors", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ theme: "dark" }));
      expect(rendition.themes.override).toHaveBeenCalledWith("color", THEME_COLORS.dark.text);
      expect(rendition.themes.override).toHaveBeenCalledWith("background-color", THEME_COLORS.dark.bg);
    });

    it("applies sepia theme colors", async () => {
      const { rendition } = await loadAndRender();
      renderer.applySettings(makeSettings({ theme: "sepia" }));
      expect(rendition.themes.override).toHaveBeenCalledWith("color", THEME_COLORS.sepia.text);
      expect(rendition.themes.override).toHaveBeenCalledWith("background-color", THEME_COLORS.sepia.bg);
    });

    it("resolves auto theme via matchMedia", async () => {
      const { rendition } = await loadAndRender();
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as any;
      renderer.applySettings(makeSettings({ theme: "auto" }));
      expect(rendition.themes.override).toHaveBeenCalledWith("color", THEME_COLORS.dark.text);
      expect(rendition.themes.override).toHaveBeenCalledWith("background-color", THEME_COLORS.dark.bg);
    });

    it("does not throw when no rendition exists", () => {
      expect(() => renderer.applySettings(makeSettings())).not.toThrow();
    });
  });

  describe("applyReadingMode()", () => {
    function makeSettings(overrides: Partial<ReaderSettings> = {}): ReaderSettings {
      return { ...DEFAULT_READER_SETTINGS, theme: "light", ...overrides };
    }

    it("recreates rendition with paginated flow", async () => {
      const { book } = await loadAndRender();
      book.renderTo.mockClear();

      await renderer.applyReadingMode("paginated", makeSettings());

      expect(book.renderTo).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ flow: "paginated" }),
      );
    });

    it("does nothing when mode is already the same", async () => {
      const { book } = await loadAndRender();
      book.renderTo.mockClear();

      await renderer.applyReadingMode("scroll", makeSettings());
      expect(book.renderTo).not.toHaveBeenCalled();
    });

    it("restores saved location after mode change", async () => {
      await loadAndRender();
      await renderer.applyReadingMode("paginated", makeSettings());

      const newRendition = latestMockRendition!;
      expect(newRendition.display).toHaveBeenCalledWith("epubcfi(/6/4)");
    });

    it("applies settings to the new rendition", async () => {
      await loadAndRender();
      const settings = makeSettings({ fontSize: 22, theme: "dark" });
      await renderer.applyReadingMode("paginated", settings);

      const newRendition = latestMockRendition!;
      expect(newRendition.themes.override).toHaveBeenCalledWith("font-size", "22px");
      expect(newRendition.themes.override).toHaveBeenCalledWith("color", THEME_COLORS.dark.text);
    });
  });

  describe("FONT_FAMILY_MAP", () => {
    it("has entries for all supported font keys", () => {
      expect(FONT_FAMILY_MAP).toHaveProperty("system");
      expect(FONT_FAMILY_MAP).toHaveProperty("serif");
      expect(FONT_FAMILY_MAP).toHaveProperty("sans-serif");
      expect(FONT_FAMILY_MAP).toHaveProperty("noto-sans");
      expect(FONT_FAMILY_MAP).toHaveProperty("noto-serif");
    });

    it("includes CJK fallbacks in serif stack", () => {
      expect(FONT_FAMILY_MAP["serif"]).toContain("Noto Serif CJK SC");
    });

    it("includes CJK fallbacks in sans-serif stack", () => {
      expect(FONT_FAMILY_MAP["sans-serif"]).toContain("Noto Sans CJK SC");
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function createMockFile(name: string): File {
  const blob = new Blob(["fake-epub-content"], {
    type: "application/epub+zip",
  });
  const file = new File([blob], name, { type: "application/epub+zip" });
  if (!file.arrayBuffer) {
    file.arrayBuffer = () =>
      new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
      });
  }
  return file;
}
