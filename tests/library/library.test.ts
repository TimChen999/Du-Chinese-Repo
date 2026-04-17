/**
 * Tests for the library page shell.
 *
 * The library page hosts the existing reader, vocab list, and flashcards
 * inside one tabbed full-page app. These tests focus on the library-
 * specific orchestration: top-level tab switching, ?tab= query-param
 * routing, the cross-tab bridge for "Back to List", and theme sync.
 *
 * initReader() and initHub() are mocked so the tests don't drag in
 * epub.js, pinyin-pro, the overlay module, etc. -- those are exercised
 * by the dedicated reader and hub test suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/reader/reader", () => ({
  initReader: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/hub/hub", () => ({
  initHub: vi.fn().mockResolvedValue(undefined),
  refreshVocabView: vi.fn().mockResolvedValue(undefined),
  refreshFlashcardsView: vi.fn().mockResolvedValue(undefined),
}));

import { initReader } from "../../src/reader/reader";
import { initHub, refreshVocabView, refreshFlashcardsView } from "../../src/hub/hub";

const mockedInitReader = initReader as ReturnType<typeof vi.fn>;
const mockedInitHub = initHub as ReturnType<typeof vi.fn>;
const mockedRefreshVocabView = refreshVocabView as ReturnType<typeof vi.fn>;
const mockedRefreshFlashcardsView = refreshFlashcardsView as ReturnType<typeof vi.fn>;

// ─── DOM scaffold ────────────────────────────────────────────────────

function buildLibraryDOM(): void {
  document.body.innerHTML = `
    <header class="library-header">
      <h1 class="library-title">Pinyin Tool — Library</h1>
      <nav class="library-tabs">
        <button class="library-tab active" data-library-tab="reader">Reader</button>
        <button class="library-tab" data-library-tab="vocab">Vocab</button>
        <button class="library-tab" data-library-tab="flashcards">Flashcards</button>
      </nav>
    </header>

    <main class="library-content">
      <section id="library-pane-reader" class="library-pane"></section>
      <section id="library-pane-vocab" class="library-pane hidden">
        <div id="tab-vocab" class="hub-tab-content"></div>
      </section>
      <section id="library-pane-flashcards" class="library-pane hidden">
        <div id="tab-flashcards" class="hub-tab-content">
          <button id="fc-back">Back to List</button>
        </div>
      </section>
    </main>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function loadLibrary() {
  vi.resetModules();

  vi.doMock("../../src/reader/reader", () => ({
    initReader: mockedInitReader,
  }));
  vi.doMock("../../src/hub/hub", () => ({
    initHub: mockedInitHub,
    refreshVocabView: mockedRefreshVocabView,
    refreshFlashcardsView: mockedRefreshFlashcardsView,
  }));

  return await import("../../src/library/library");
}

function tabButton(tab: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    `.library-tab[data-library-tab="${tab}"]`,
  )!;
}

function pane(tab: string): HTMLElement {
  return document.getElementById(`library-pane-${tab}`)!;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("library page", () => {
  beforeEach(() => {
    buildLibraryDOM();
    chrome.storage.sync.get.mockImplementation(() => Promise.resolve({}));
    mockedInitReader.mockReset().mockResolvedValue(undefined);
    mockedInitHub.mockReset().mockResolvedValue(undefined);
    mockedRefreshVocabView.mockReset().mockResolvedValue(undefined);
    mockedRefreshFlashcardsView.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // ─── initLibrary ───────────────────────────────────────────────

  describe("initLibrary", () => {
    it("invokes both initReader and initHub", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      expect(mockedInitReader).toHaveBeenCalledTimes(1);
      expect(mockedInitHub).toHaveBeenCalledTimes(1);
    });

    it("applies the stored theme to body[data-theme]", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "dark" }),
      );

      const mod = await loadLibrary();
      await mod.initLibrary();

      expect(document.body.getAttribute("data-theme")).toBe("dark");
    });

    it("resolves auto to light when prefers-color-scheme is unavailable", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      // jsdom lacks matchMedia, so resolveTheme falls back to "light".
      expect(document.body.getAttribute("data-theme")).toBe("light");
    });

    it("resolves auto to dark when prefers-color-scheme reports dark", async () => {
      const matchMediaSpy = vi.fn(() => ({ matches: true }) as MediaQueryList);
      vi.stubGlobal("matchMedia", matchMediaSpy);

      const mod = await loadLibrary();
      await mod.initLibrary();

      expect(document.body.getAttribute("data-theme")).toBe("dark");
      vi.unstubAllGlobals();
    });

    it("passes sepia through unchanged", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "sepia" }),
      );

      const mod = await loadLibrary();
      await mod.initLibrary();

      expect(document.body.getAttribute("data-theme")).toBe("sepia");
    });
  });

  // ─── Initial tab from URL ──────────────────────────────────────

  describe("getInitialTab", () => {
    it("returns 'reader' when no query param is present", async () => {
      const mod = await loadLibrary();
      expect(mod.getInitialTab("")).toBe("reader");
    });

    it("returns the requested tab when ?tab=vocab", async () => {
      const mod = await loadLibrary();
      expect(mod.getInitialTab("?tab=vocab")).toBe("vocab");
    });

    it("returns the requested tab when ?tab=flashcards", async () => {
      const mod = await loadLibrary();
      expect(mod.getInitialTab("?tab=flashcards")).toBe("flashcards");
    });

    it("falls back to 'reader' when the requested tab is invalid", async () => {
      const mod = await loadLibrary();
      expect(mod.getInitialTab("?tab=bogus")).toBe("reader");
    });
  });

  // ─── Tab switching ─────────────────────────────────────────────

  describe("tab switching", () => {
    it("shows the reader tab by default after init", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      expect(tabButton("reader").classList.contains("active")).toBe(true);
      expect(pane("reader").classList.contains("hidden")).toBe(false);
      expect(pane("vocab").classList.contains("hidden")).toBe(true);
      expect(pane("flashcards").classList.contains("hidden")).toBe(true);
    });

    it("switches to vocab on tab click", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      tabButton("vocab").click();

      expect(tabButton("vocab").classList.contains("active")).toBe(true);
      expect(tabButton("reader").classList.contains("active")).toBe(false);
      expect(pane("vocab").classList.contains("hidden")).toBe(false);
      expect(pane("reader").classList.contains("hidden")).toBe(true);
    });

    it("switches to flashcards on tab click", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      tabButton("flashcards").click();

      expect(tabButton("flashcards").classList.contains("active")).toBe(true);
      expect(pane("flashcards").classList.contains("hidden")).toBe(false);
      expect(pane("reader").classList.contains("hidden")).toBe(true);
      expect(pane("vocab").classList.contains("hidden")).toBe(true);
    });

    it("activateLibraryTab sets aria-selected on the active button", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      mod.activateLibraryTab("vocab");

      expect(tabButton("vocab").getAttribute("aria-selected")).toBe("true");
      expect(tabButton("reader").getAttribute("aria-selected")).toBe("false");
      expect(tabButton("flashcards").getAttribute("aria-selected")).toBe("false");
    });
  });

  // ─── Cross-tab bridge ──────────────────────────────────────────

  describe("fc-back bridge", () => {
    it("clicking fc-back switches the library tab to vocab", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      // Start on flashcards pane
      tabButton("flashcards").click();
      expect(tabButton("flashcards").classList.contains("active")).toBe(true);

      // Hub's "Back to List" button fires
      const fcBack = document.getElementById("fc-back") as HTMLButtonElement;
      fcBack.click();

      expect(tabButton("vocab").classList.contains("active")).toBe(true);
      expect(tabButton("flashcards").classList.contains("active")).toBe(false);
      expect(pane("vocab").classList.contains("hidden")).toBe(false);
      expect(pane("flashcards").classList.contains("hidden")).toBe(true);
    });
  });

  // ─── Tab content refresh ───────────────────────────────────────

  describe("tab activation refreshes hub views", () => {
    it("calls refreshVocabView when activating the vocab tab", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();
      mockedRefreshVocabView.mockClear();

      tabButton("vocab").click();

      expect(mockedRefreshVocabView).toHaveBeenCalledTimes(1);
      expect(mockedRefreshFlashcardsView).not.toHaveBeenCalled();
    });

    it("calls refreshFlashcardsView when activating the flashcards tab", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();
      mockedRefreshFlashcardsView.mockClear();

      tabButton("flashcards").click();

      expect(mockedRefreshFlashcardsView).toHaveBeenCalledTimes(1);
      expect(mockedRefreshVocabView).not.toHaveBeenCalled();
    });

    it("does not call refresh hooks when activating the reader tab", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      tabButton("vocab").click();
      mockedRefreshVocabView.mockClear();
      mockedRefreshFlashcardsView.mockClear();

      tabButton("reader").click();

      expect(mockedRefreshVocabView).not.toHaveBeenCalled();
      expect(mockedRefreshFlashcardsView).not.toHaveBeenCalled();
    });

    it("refreshes vocab view via fc-back bridge", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();
      mockedRefreshVocabView.mockClear();

      const fcBack = document.getElementById("fc-back") as HTMLButtonElement;
      fcBack.click();

      expect(mockedRefreshVocabView).toHaveBeenCalled();
    });

    it("refreshes views on initial activation when ?tab=flashcards", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();
      mockedRefreshFlashcardsView.mockClear();

      mod.activateLibraryTab("flashcards");
      expect(mockedRefreshFlashcardsView).toHaveBeenCalled();
    });
  });

  // ─── Inner-div visibility (regression: blank pane after Back to List) ──

  describe("inner div visibility", () => {
    it("keeps #tab-flashcards visible after activating flashcards tab", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      // Simulate the bug: a stale .hidden class added by the standalone-mode
      // hub code path (e.g. from a prior fc-back click in an older build).
      document.getElementById("tab-flashcards")!.classList.add("hidden");

      tabButton("flashcards").click();

      expect(
        document.getElementById("tab-flashcards")!.classList.contains("hidden"),
      ).toBe(false);
    });

    it("keeps #tab-vocab visible after activating vocab tab", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      document.getElementById("tab-vocab")!.classList.add("hidden");

      tabButton("vocab").click();

      expect(
        document.getElementById("tab-vocab")!.classList.contains("hidden"),
      ).toBe(false);
    });

    it("flashcards pane is not blank after Back to List then re-activating flashcards", async () => {
      const mod = await loadLibrary();
      await mod.initLibrary();

      // Go to flashcards, simulate finishing a session, then click Back to List.
      tabButton("flashcards").click();
      const fcBack = document.getElementById("fc-back") as HTMLButtonElement;
      fcBack.click();

      // The library bridge moves the user to Vocab. Now go back to Flashcards.
      tabButton("flashcards").click();

      // The inner content div must still be visible -- otherwise the user
      // would see a blank pane (the original bug).
      expect(
        document.getElementById("tab-flashcards")!.classList.contains("hidden"),
      ).toBe(false);
      expect(pane("flashcards").classList.contains("hidden")).toBe(false);
    });
  });
});
