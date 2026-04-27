/**
 * Tests for the PDF renderer.
 *
 * pdfjs-dist is fully mocked at module level so the test never hits a
 * real PDF parser or worker. The mock exposes a tiny PDFDocumentProxy
 * + PDFPageProxy surface that mirrors the methods the renderer calls.
 *
 * jsdom doesn't ship a real CanvasRenderingContext2D or
 * IntersectionObserver, both of which the renderer guards against.
 * Those guards are validated indirectly: the renderTo / applySettings
 * tests would throw if the guards were missing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetDocument = vi.fn();
const mockGlobalWorkerOptions: { workerSrc: string } = { workerSrc: "" };
const mockTextLayerRender = vi.fn().mockResolvedValue(undefined);
const mockTextLayerCtor = vi.fn().mockImplementation(() => ({
  render: mockTextLayerRender,
  cancel: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: mockGetDocument,
  GlobalWorkerOptions: mockGlobalWorkerOptions,
  TextLayer: mockTextLayerCtor,
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker.js",
}));

import { PdfRenderer } from "../../src/reader/renderers/pdf-renderer";
import { DEFAULT_READER_SETTINGS } from "../../src/reader/reader-types";
import { makeBinaryFile, mountInScrollableHost } from "./_test-fixtures";

function buildMockDoc(numPages = 2, options: {
  metadata?: { info?: Record<string, string> } | null;
  outline?: any[] | null;
} = {}) {
  const renderPromise = Promise.resolve(undefined);
  const renderTask = { promise: renderPromise };

  const buildPage = (pageNum: number) => ({
    pageNum,
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 140 * scale,
      scale,
    })),
    render: vi.fn().mockReturnValue(renderTask),
    getTextContent: vi.fn().mockResolvedValue({
      items: [{ str: `page ${pageNum}` }],
    }),
  });

  const doc = {
    numPages,
    getPage: vi.fn((n: number) => Promise.resolve(buildPage(n))),
    getMetadata: vi.fn(() =>
      options.metadata === null
        ? Promise.reject(new Error("no meta"))
        : Promise.resolve(options.metadata ?? { info: {} }),
    ),
    getOutline: vi.fn(() =>
      options.outline === null
        ? Promise.reject(new Error("no outline"))
        : Promise.resolve(options.outline ?? null),
    ),
    getDestination: vi.fn().mockResolvedValue([{ num: 1, gen: 0 }]),
    getPageIndex: vi.fn().mockResolvedValue(0),
    destroy: vi.fn(),
  };

  return doc;
}

describe("PdfRenderer", () => {
  let renderer: PdfRenderer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDocument.mockReset();
    mockGlobalWorkerOptions.workerSrc = "";
    renderer = new PdfRenderer();
  });

  describe("properties", () => {
    it("has formatName PDF", () => {
      expect(renderer.formatName).toBe("PDF");
    });

    it("handles only .pdf", () => {
      expect(renderer.extensions).toEqual([".pdf"]);
    });
  });

  describe("load()", () => {
    it("returns numPages as totalChapters", async () => {
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(buildMockDoc(7)) });
      const meta = await renderer.load(makeFile("a.pdf"));
      expect(meta.totalChapters).toBe(7);
    });

    it("uses metadata title and author when present", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(
          buildMockDoc(2, { metadata: { info: { Title: "三体", Author: "刘慈欣" } } }),
        ),
      });
      const meta = await renderer.load(makeFile("any.pdf"));
      expect(meta.title).toBe("三体");
      expect(meta.author).toBe("刘慈欣");
    });

    it("falls back to filename when metadata missing", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildMockDoc(1, { metadata: { info: {} } })),
      });
      const meta = await renderer.load(makeFile("paper.pdf"));
      expect(meta.title).toBe("paper");
    });

    it("survives metadata rejection", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildMockDoc(1, { metadata: null })),
      });
      const meta = await renderer.load(makeFile("paper.pdf"));
      expect(meta.title).toBe("paper");
      expect(meta.author).toBe("Unknown");
    });

    it("returns empty TOC when outline is missing", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildMockDoc(1, { outline: null })),
      });
      const meta = await renderer.load(makeFile("a.pdf"));
      expect(meta.toc).toEqual([]);
    });

    it("converts outline entries to TOC", async () => {
      const outline = [
        { title: "Chapter 1", dest: "ch1", items: [] },
        { title: "Chapter 2", dest: "ch2", items: [] },
      ];
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildMockDoc(2, { outline })),
      });
      const meta = await renderer.load(makeFile("a.pdf"));
      expect(meta.toc.length).toBe(2);
      expect(meta.toc[0].label).toBe("Chapter 1");
    });

    it("resolves outline entries with explicit-array destinations", async () => {
      // A pdf.js explicit destination's first element is either a
      // page Ref ({num, gen}) or a 0-based integer page index. Many
      // PDFs (notably those produced by ebook conversion tools)
      // emit the integer form. Regression: the Ref path used to
      // call getPageIndex unconditionally, which throws "Invalid
      // pageIndex request" for integer indices, so every TOC href
      // came back empty and clicks were silently ignored.
      const outline = [
        { title: "By Ref", dest: [{ num: 5, gen: 0 }, { name: "XYZ" }, 0, 0, null], items: [] },
        { title: "By Index", dest: [3, { name: "Fit" }], items: [] },
      ];
      const doc = buildMockDoc(10, { outline });
      doc.getPageIndex = vi.fn().mockResolvedValue(1);
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(doc) });
      const meta = await renderer.load(makeFile("a.pdf"));
      expect(meta.toc).toHaveLength(2);
      expect(meta.toc[0].href).toBe("2"); // Ref resolved via getPageIndex (0+1) -> 2 (1+1)
      expect(meta.toc[1].href).toBe("4"); // integer 3 is 0-based -> 4
    });
  });

  describe("renderTo()", () => {
    it("creates one .pdf-page per page", async () => {
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(buildMockDoc(3)) });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.querySelectorAll(".pdf-page")).toHaveLength(3);
    });

    it("attaches a pdf-container class", async () => {
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(buildMockDoc(1)) });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      expect(container.classList.contains("pdf-container")).toBe(true);
    });

    it("creates a canvas and text layer per page", async () => {
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(buildMockDoc(1)) });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      const page = container.querySelector(".pdf-page") as HTMLElement;
      expect(page.querySelector("canvas")).not.toBeNull();
      expect(page.querySelector(".pdf-text-layer")).not.toBeNull();
    });

    it("throws if no PDF was loaded", async () => {
      const container = mountInScrollableHost();
      await expect(renderer.renderTo(container)).rejects.toThrow("No PDF loaded");
    });
  });

  describe("navigation", () => {
    beforeEach(async () => {
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(buildMockDoc(5)) });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
    });

    it("getCurrentLocation starts at page 1", () => {
      expect(renderer.getCurrentLocation()).toBe("1");
    });

    it("goTo updates current page", async () => {
      await renderer.goTo(3);
      expect(renderer.getCurrentLocation()).toBe("3");
    });

    it("goTo clamps invalid pages", async () => {
      await renderer.goTo(99);
      expect(renderer.getCurrentLocation()).toBe("1");
    });

    it("next advances by one page", async () => {
      await renderer.goTo(2);
      const ok = await renderer.next();
      expect(ok).toBe(true);
      expect(renderer.getCurrentLocation()).toBe("3");
    });

    it("prev goes back one page", async () => {
      await renderer.goTo(3);
      const ok = await renderer.prev();
      expect(ok).toBe(true);
      expect(renderer.getCurrentLocation()).toBe("2");
    });

    it("next returns false at the last page", async () => {
      await renderer.goTo(5);
      expect(await renderer.next()).toBe(false);
    });

    it("prev returns false at the first page", async () => {
      await renderer.goTo(1);
      expect(await renderer.prev()).toBe(false);
    });

    // The IntersectionObserver path (jsdom has none, browsers do)
    // is gated on bestPage !== this.currentPage. goTo() assigns
    // currentPage synchronously, so without an explicit notification
    // the observer's post-scroll entries find the gate already
    // closed and the relocated callback never fires -- TOC clicks
    // would scroll the content but leave the footer page indicator
    // stuck on the previous page.
    it("notifies onRelocated when goTo navigates to a new page", async () => {
      const cb = vi.fn();
      renderer.onRelocated(cb);
      await renderer.goTo(3);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(2); // 0-based page index
    });

    it("does not notify onRelocated when goTo lands on the current page", async () => {
      await renderer.goTo(2);
      const cb = vi.fn();
      renderer.onRelocated(cb);
      await renderer.goTo(2);
      expect(cb).not.toHaveBeenCalled();
    });

    // The reader's prev/next button handlers manually adjust
    // metadata.currentChapter after the awaited renderer call
    // returns. Firing the relocated callback here too would advance
    // the footer indicator twice, so the user would see it skip
    // pages even though the content scrolled by one.
    it("does not notify onRelocated for next() and prev()", async () => {
      await renderer.goTo(2);
      const cb = vi.fn();
      renderer.onRelocated(cb);
      await renderer.next();
      await renderer.prev();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("getSpineIndex()", () => {
    it("always returns -1", () => {
      expect(renderer.getSpineIndex("anything")).toBe(-1);
    });
  });

  describe("destroy()", () => {
    it("clears the container and calls pdf.destroy", async () => {
      const doc = buildMockDoc(2);
      mockGetDocument.mockReturnValueOnce({ promise: Promise.resolve(doc) });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      renderer.destroy();
      expect(container.innerHTML).toBe("");
      expect(doc.destroy).toHaveBeenCalled();
    });

    it("can be called when nothing is loaded", () => {
      expect(() => renderer.destroy()).not.toThrow();
    });
  });

  describe("applySettings()", () => {
    it("does not throw when called before load", () => {
      expect(() => renderer.applySettings(DEFAULT_READER_SETTINGS)).not.toThrow();
    });

    it("restores currentPage after a font-size-induced rerender", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildMockDoc(5)),
      });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);

      await renderer.goTo(3);
      expect(renderer.getCurrentLocation()).toBe("3");

      // Bumping fontSize triggers rerenderAllPages (scale change).
      // Without the page restore, this lands the user back on page 1.
      renderer.applySettings({
        ...DEFAULT_READER_SETTINGS,
        fontSize: DEFAULT_READER_SETTINGS.fontSize + 4,
      });
      // applySettings -> rerenderAllPages is async internally;
      // wait a microtask cycle for the rebuild to settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(renderer.getCurrentLocation()).toBe("3");
    });
  });

  describe("captureAnchor() / goToAnchor()", () => {
    function buildPdfDocWithItems() {
      const doc = buildMockDoc(2);
      doc.getPage = vi.fn((n: number) =>
        Promise.resolve({
          pageNum: n,
          getViewport: vi.fn(({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 140 * scale,
            scale,
          })),
          render: vi.fn().mockReturnValue({ promise: Promise.resolve(undefined) }),
          getTextContent: vi.fn().mockResolvedValue({
            items: [
              { str: "你好" },
              { str: "世界" },
              { str: "再见" },
            ],
          }),
        }),
      );
      return doc;
    }

    /**
     * pdfjs-dist's TextLayer is mocked, so the .pdf-text-layer element
     * is empty after render(). Manually populate it with one <span> per
     * item so captureAnchor's span-index lookup has something to walk.
     */
    function populateTextLayerSpans(container: HTMLElement, strings: string[]): void {
      container.querySelectorAll<HTMLElement>(".pdf-text-layer").forEach((layer) => {
        layer.innerHTML = "";
        for (const s of strings) {
          const span = document.createElement("span");
          span.textContent = s;
          layer.appendChild(span);
        }
      });
    }

    it("captures a pdf anchor with the clicked word", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildPdfDocWithItems()),
      });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);

      populateTextLayerSpans(container, ["你好", "世界", "再见"]);
      const layer = container.querySelectorAll<HTMLElement>(".pdf-text-layer")[0];
      const span = layer.querySelectorAll("span")[1];
      const textNode = span.firstChild as Text;

      const wordRange = document.createRange();
      wordRange.setStart(textNode, 0);
      wordRange.setEnd(textNode, 2);

      const anchor = renderer.captureAnchor({ wordRange });
      expect(anchor).not.toBeNull();
      expect(anchor!.word).toBe("世界");
      expect(anchor!.payload.kind).toBe("pdf");
      if (anchor!.payload.kind === "pdf") {
        expect(anchor!.payload.page).toBe(1);
        expect(anchor!.payload.itemIndex).toBe(1);
      }
    });

    it("returns null when wordRange is outside any text layer", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildPdfDocWithItems()),
      });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);

      const stray = document.createElement("div");
      stray.textContent = "stray";
      document.body.appendChild(stray);
      const wordRange = document.createRange();
      wordRange.setStart(stray.firstChild as Text, 0);
      wordRange.setEnd(stray.firstChild as Text, 5);

      expect(renderer.captureAnchor({ wordRange })).toBeNull();
      stray.remove();
    });

    it("goToAnchor returns true and navigates to the page", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildPdfDocWithItems()),
      });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      populateTextLayerSpans(container, ["你好", "世界", "再见"]);

      const ok = await renderer.goToAnchor({
        word: "世界",
        contextBefore: "你好",
        contextAfter: "再见",
        payload: { kind: "pdf", page: 2, itemIndex: 1, charOffset: 0 },
      });
      expect(ok).toBe(true);
      expect(renderer.getCurrentLocation()).toBe("2");
    });

    it("goToAnchor returns false for non-pdf payload", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildPdfDocWithItems()),
      });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      const ok = await renderer.goToAnchor({
        word: "x",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "dom", charOffset: 0 },
      });
      expect(ok).toBe(false);
    });

    it("goToAnchor returns false when page is out of range", async () => {
      mockGetDocument.mockReturnValueOnce({
        promise: Promise.resolve(buildPdfDocWithItems()),
      });
      await renderer.load(makeFile("a.pdf"));
      const container = mountInScrollableHost();
      await renderer.renderTo(container);
      const ok = await renderer.goToAnchor({
        word: "x",
        contextBefore: "",
        contextAfter: "",
        payload: { kind: "pdf", page: 99, itemIndex: 0, charOffset: 0 },
      });
      expect(ok).toBe(false);
    });
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

function makeFile(name: string): File {
  return makeBinaryFile(name, [0x25, 0x50, 0x44, 0x46], "application/pdf");
}
