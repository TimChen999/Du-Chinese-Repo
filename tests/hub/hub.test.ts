/**
 * Tests for the hub page UI.
 *
 * Verifies vocab list rendering, sorting, detail card, flashcard setup,
 * session flow, summary, tab switching, theme, and reader button.
 *
 * Follows the same DOM-scaffold + initHub() pattern as popup.test.ts.
 *
 * See: VOCAB_HUB_SPEC.md for the full feature specification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VocabEntry } from "../../src/shared/types";
import { mock } from "../test-helpers";

vi.mock("../../src/background/vocab-store", () => ({
  getAllVocab: vi.fn(),
  clearVocab: vi.fn(),
  removeWord: vi.fn(),
  removeWords: vi.fn(),
  setExampleTranslation: vi.fn(),
  updateFlashcardResult: vi.fn(),
  restoreFlashcardState: vi.fn(),
  importVocab: vi.fn(),
}));

import {
  getAllVocab,
  clearVocab,
  removeWord,
  removeWords,
  setExampleTranslation,
  updateFlashcardResult,
  restoreFlashcardState,
  importVocab,
} from "../../src/background/vocab-store";

const mockedGetAllVocab = getAllVocab as ReturnType<typeof vi.fn>;
const mockedClearVocab = clearVocab as ReturnType<typeof vi.fn>;
const mockedRemoveWord = removeWord as ReturnType<typeof vi.fn>;
const mockedRemoveWords = removeWords as ReturnType<typeof vi.fn>;
const mockedSetExampleTranslation = setExampleTranslation as ReturnType<typeof vi.fn>;
const mockedUpdateResult = updateFlashcardResult as ReturnType<typeof vi.fn>;
const mockedRestoreState = restoreFlashcardState as ReturnType<typeof vi.fn>;
const mockedImportVocab = importVocab as ReturnType<typeof vi.fn>;

// ─── Sample data ─────────────────────────────────────────────────────

const sampleVocab: VocabEntry[] = [
  { chars: "银行", pinyin: "yín háng", definition: "bank", count: 5, firstSeen: 1000, lastSeen: 5000, wrongStreak: 0, totalReviews: 10, totalCorrect: 8, intervalDays: 0, nextDueAt: 0 },
  { chars: "工作", pinyin: "gōng zuò", definition: "to work", count: 3, firstSeen: 2000, lastSeen: 4000, wrongStreak: 0, totalReviews: 0, totalCorrect: 0, intervalDays: 0, nextDueAt: 0 },
  { chars: "学生", pinyin: "xué shēng", definition: "student", count: 7, firstSeen: 500, lastSeen: 3000, wrongStreak: 2, totalReviews: 5, totalCorrect: 2, intervalDays: 0, nextDueAt: 0 },
];

// ─── DOM scaffold ────────────────────────────────────────────────────

function buildHubDOM(): void {
  document.body.innerHTML = `
    <nav class="hub-tab-bar">
      <button class="hub-tab active" data-tab="vocab">Vocab List</button>
      <button class="hub-tab" data-tab="flashcards">Flashcards</button>
    </nav>

    <div id="tab-vocab" class="hub-tab-content">
      <div class="vocab-controls">
        <select id="vocab-sort">
          <option value="frequency">Most frequent</option>
          <option value="recent">Most recent</option>
          <option value="alpha">Alphabetical</option>
        </select>
        <div class="vocab-search">
          <input type="search" id="vocab-search-input" class="vocab-search-input" placeholder="Search" autocomplete="off" />
          <button type="button" id="vocab-search-clear" class="vocab-search-clear hidden" aria-label="Clear search">&times;</button>
        </div>
        <span id="io-status" class="io-status"></span>
        <div class="manage-anchor">
          <button type="button" id="manage-toggle" class="manage-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="Manage vocab">⋮</button>
          <div id="manage-popover" class="manage-popover hidden" role="dialog" aria-label="Manage vocab">
            <div id="manage-menu-panel" class="manage-menu-panel">
              <button type="button" id="import-vocab" class="manage-menu-item">Import</button>
              <button type="button" id="export-vocab" class="manage-menu-item">Export</button>
              <input type="file" id="import-file-input" accept=".json" hidden />
              <div class="manage-menu-divider"></div>
              <button type="button" id="clear-vocab" class="manage-menu-item manage-menu-item-danger">Clear</button>
            </div>
            <div id="clear-select-panel" class="clear-select-panel hidden">
              <button type="button" id="clear-back" class="manage-back-btn">Back</button>
              <div class="clear-popover-row">
                <label for="clear-timeline" class="clear-popover-label">Clear entries</label>
                <select id="clear-timeline" class="clear-popover-select">
                  <option value="7">Older than 7 days</option>
                  <option value="30" selected>Older than 30 days</option>
                  <option value="180">Older than 6 months</option>
                  <option value="365">Older than 1 year</option>
                  <option value="all">All time</option>
                </select>
              </div>
              <label class="clear-popover-checkbox">
                <input type="checkbox" id="clear-only-not-reviewed" />
                <span>Only clear "Not reviewed"</span>
              </label>
              <button type="button" id="clear-execute" class="clear-execute-btn" disabled>Clear 0 entries</button>
            </div>
            <div id="clear-confirm-panel" class="clear-confirm-panel hidden" role="alertdialog">
              <p class="clear-confirm-message">Delete <strong id="clear-confirm-count">0 entries</strong>? This cannot be undone.</p>
              <div class="clear-confirm-actions">
                <button type="button" id="clear-confirm-no" class="clear-confirm-no-btn">No</button>
                <button type="button" id="clear-confirm-yes" class="clear-confirm-yes-btn" aria-label="Hold to confirm deletion">
                  <span class="clear-confirm-yes-fill" aria-hidden="true"></span>
                  <span class="clear-confirm-yes-label">Hold to delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="vocab-list" class="vocab-list"></div>
    </div>

      <div id="tab-flashcards" class="hub-tab-content hidden">
      <div id="fc-setup" class="fc-setup">
        <h2>Review Flashcards</h2>
        <div class="fc-setup-group">
          <p class="fc-setup-label">What to study</p>
          <div id="fc-bucket-summary" class="fc-bucket-summary"></div>
        </div>
        <div class="fc-setup-group">
          <p class="fc-setup-label">How many cards</p>
          <div class="fc-size-buttons">
            <button class="fc-size-btn" data-size="10">10</button>
            <button class="fc-size-btn" data-size="20">20</button>
            <button class="fc-size-btn" data-size="50">50</button>
            <button class="fc-size-btn" data-size="all">All</button>
          </div>
        </div>
        <p id="fc-available" class="fc-available">0 words available</p>
        <button id="fc-start" class="fc-start-btn">Start</button>
      </div>

      <div id="fc-session" class="fc-session hidden">
        <div class="fc-session-header">
          <div class="fc-progress-row">
            <button id="fc-rewind" class="fc-rewind-btn" disabled>&larr;</button>
            <span id="fc-progress" class="fc-progress-text">1/10</span>
            <button id="fc-close" class="fc-close-btn">&times;</button>
          </div>
          <div class="fc-progress-bar">
            <div id="fc-progress-bar-correct" class="fc-progress-bar-correct"></div>
            <div id="fc-progress-bar-wrong" class="fc-progress-bar-wrong"></div>
          </div>
        </div>
        <div class="fc-card">
          <div class="fc-chars-row">
            <div id="fc-chars" class="fc-chars"></div>
            <button id="fc-tts-word" class="fc-tts-btn" type="button">🔊</button>
          </div>
          <div id="fc-answer" class="fc-answer hidden">
            <div id="fc-pinyin" class="fc-pinyin"></div>
            <div id="fc-definition" class="fc-definition"></div>
          </div>
          <div id="fc-example" class="fc-example hidden"></div>
        </div>
        <div id="fc-actions" class="fc-actions">
          <button id="fc-flip" class="fc-flip-btn">Flip</button>
          <div id="fc-judge" class="fc-judge">
            <button id="fc-wrong" class="fc-wrong-btn">&times;</button>
            <button id="fc-right" class="fc-right-btn">&#10003;</button>
          </div>
        </div>
      </div>

      <div id="fc-summary" class="fc-summary hidden">
        <h2>Session Complete</h2>
        <p id="fc-score" class="fc-score"></p>
        <div id="fc-wrong-list" class="fc-wrong-list"></div>
        <div class="fc-summary-actions">
          <button id="fc-again" class="fc-again-btn">Practice Again</button>
          <button id="fc-back" class="fc-back-btn">Back to List</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function loadHub() {
  vi.resetModules();

  vi.doMock("../../src/background/vocab-store", () => ({
    getAllVocab: mockedGetAllVocab,
    clearVocab: mockedClearVocab,
    removeWord: mockedRemoveWord,
    removeWords: mockedRemoveWords,
    setExampleTranslation: mockedSetExampleTranslation,
    updateFlashcardResult: mockedUpdateResult,
    restoreFlashcardState: mockedRestoreState,
    importVocab: mockedImportVocab,
  }));

  const mod = await import("../../src/hub/hub");
  await mod.initHub();
  return mod;
}

/**
 * Stubs the on-device Translator API on `globalThis` so the
 * Translate-button tests can drive successful + failure paths
 * deterministically. Returns the underlying mock so tests can assert
 * call counts.
 */
function stubGlobalTranslator(translation: string) {
  const translateFn = vi.fn(async () => translation);
  const createFn = vi.fn(async () => ({ translate: translateFn }));
  const availabilityFn = vi.fn(async () => "available");
  (globalThis as any).Translator = {
    availability: availabilityFn,
    create: createFn,
  };
  return { availabilityFn, createFn, translateFn };
}

function clearGlobalTranslator() {
  delete (globalThis as any).Translator;
}

function vocabTabBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.hub-tab[data-tab="vocab"]')!;
}

function flashcardsTabBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.hub-tab[data-tab="flashcards"]')!;
}

function vocabList(): HTMLDivElement {
  return document.getElementById("vocab-list") as HTMLDivElement;
}

function vocabSort(): HTMLSelectElement {
  return document.getElementById("vocab-sort") as HTMLSelectElement;
}

async function switchToFlashcards(): Promise<void> {
  flashcardsTabBtn().click();
  await vi.waitFor(() => {
    const tab = document.getElementById("tab-flashcards")!;
    expect(tab.classList.contains("hidden")).toBe(false);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("hub page", () => {
  beforeEach(() => {
    buildHubDOM();
    mock(chrome.storage.sync.get).mockImplementation(() => Promise.resolve({}));
    mock(chrome.storage.sync.set).mockImplementation(() => Promise.resolve());
    mock(chrome.tabs.create).mockImplementation(() => Promise.resolve({} as chrome.tabs.Tab));
    mock(chrome.runtime.getURL).mockImplementation((path: string) => `chrome-extension://test/${path}`);
    mockedGetAllVocab.mockReset();
    mockedClearVocab.mockReset();
    mockedRemoveWord.mockReset();
    mockedRemoveWords.mockReset();
    mockedSetExampleTranslation.mockReset();
    mockedUpdateResult.mockReset();
    mockedRestoreState.mockReset();
    mockedImportVocab.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    clearGlobalTranslator();
    vi.restoreAllMocks();
  });

  // ─── Theme ──────────────────────────────────────────────────────

  describe("theme", () => {
    it("applies theme from storage", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ theme: "dark" }),
      );
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();
      expect(document.body.getAttribute("data-theme")).toBe("dark");
    });

    it("collapses missing/auto theme to a concrete state via prefers-color-scheme", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() => Promise.resolve({}));
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();
      // Hub now uses the shared resolveEffectiveTheme helper; jsdom
      // lacks matchMedia so "auto" collapses to "light" rather than
      // leaking the literal "auto" value into body[data-theme] (which
      // would leave the hub's CSS variables undefined).
      expect(document.body.getAttribute("data-theme")).toBe("light");
    });

    it("applies sepia when readerSettings.theme is sepia", async () => {
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({
          theme: "light",
          readerSettings: { theme: "sepia" },
        }),
      );
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();
      // Reader's sepia override wins so the hub matches the reader's
      // active palette.
      expect(document.body.getAttribute("data-theme")).toBe("sepia");
    });
  });

  // ─── Tab switching ─────────────────────────────────────────────

  describe("tab switching", () => {
    it("shows vocab tab by default", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      expect(document.getElementById("tab-vocab")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("tab-flashcards")!.classList.contains("hidden")).toBe(true);
    });

    it("switches to flashcards tab on click", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      flashcardsTabBtn().click();

      await vi.waitFor(() => {
        expect(document.getElementById("tab-vocab")!.classList.contains("hidden")).toBe(true);
        expect(document.getElementById("tab-flashcards")!.classList.contains("hidden")).toBe(false);
      });
    });

    it("switches back to vocab tab", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      flashcardsTabBtn().click();
      await vi.waitFor(() => {
        expect(document.getElementById("tab-flashcards")!.classList.contains("hidden")).toBe(false);
      });

      vocabTabBtn().click();
      await vi.waitFor(() => {
        expect(document.getElementById("tab-vocab")!.classList.contains("hidden")).toBe(false);
        expect(document.getElementById("tab-flashcards")!.classList.contains("hidden")).toBe(true);
      });
    });
  });

  // ─── Vocab List ────────────────────────────────────────────────

  describe("vocab list", () => {
    it("displays all vocab entries", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      const rows = vocabList().querySelectorAll(".vocab-row");
      expect(rows).toHaveLength(3);
    });

    it("shows empty state when no words", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      const empty = vocabList().querySelector(".vocab-empty");
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toContain("No words saved");
    });

    it("displays chars, pinyin, definition in each row", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row")!;
      expect(row.querySelector(".vocab-chars")!.textContent).toBe("银行");
      expect(row.querySelector(".vocab-pinyin")!.textContent).toBe("yín háng");
      expect(row.querySelector(".vocab-def")!.textContent).toBe("bank");
    });

    it("displays metadata line with seen count and last seen date", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadHub();

      const meta = vocabList().querySelector(".vocab-row-meta")!;
      expect(meta.textContent).toContain("Seen 5 times");
      expect(meta.textContent).toContain("Last seen");
    });

    it("displays review stats when totalReviews > 0", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadHub();

      const meta = vocabList().querySelector(".vocab-row-meta")!;
      expect(meta.textContent).toContain("Reviews: 10");
      expect(meta.textContent).toContain("Accuracy: 80%");
    });

    it("does not display review stats when totalReviews is 0", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[1]]);
      await loadHub();

      const meta = vocabList().querySelector(".vocab-row-meta")!;
      expect(meta.textContent).not.toContain("Reviews:");
    });
  });

  // ─── Sorting ───────────────────────────────────────────────────

  describe("sorting", () => {
    it("sorts by frequency descending by default", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      const rows = vocabList().querySelectorAll(".vocab-row");
      const chars = Array.from(rows).map(
        (r) => r.querySelector(".vocab-chars")!.textContent,
      );
      expect(chars).toEqual(["学生", "银行", "工作"]);
    });

    it("sorts by most recent when selected", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      vocabSort().value = "recent";
      vocabSort().dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const rows = vocabList().querySelectorAll(".vocab-row");
        const chars = Array.from(rows).map(
          (r) => r.querySelector(".vocab-chars")!.textContent,
        );
        expect(chars).toEqual(["银行", "工作", "学生"]);
      });
    });

    it("sorts alphabetically when selected", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      vocabSort().value = "alpha";
      vocabSort().dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const rows = vocabList().querySelectorAll(".vocab-row");
        const chars = Array.from(rows).map(
          (r) => r.querySelector(".vocab-chars")!.textContent,
        );
        expect(chars[0]).toBeDefined();
      });
    });
  });

  // ─── Manage popover ────────────────────────────────────────────

  describe("manage popover", () => {
    /**
     * Builds a vocab snapshot whose lastSeen timestamps span "stale" and
     * "fresh" relative to `now`, so the timeline filter has meaningful
     * input. Two entries are >40 days old, one is fresh.
     */
    function makeTimelineVocab(now: number): VocabEntry[] {
      const day = 86_400_000;
      return [
        { chars: "古旧A", pinyin: "a", definition: "stale a", count: 1, firstSeen: now - 100 * day, lastSeen: now - 90 * day, wrongStreak: 0, totalReviews: 0, totalCorrect: 0, intervalDays: 0, nextDueAt: 0 },
        { chars: "古旧B", pinyin: "b", definition: "stale b", count: 1, firstSeen: now - 100 * day, lastSeen: now - 45 * day, wrongStreak: 0, totalReviews: 2, totalCorrect: 1, intervalDays: 0, nextDueAt: 0 },
        { chars: "新鲜C", pinyin: "c", definition: "fresh c", count: 1, firstSeen: now - 5 * day, lastSeen: now - 1 * day, wrongStreak: 0, totalReviews: 0, totalCorrect: 0, intervalDays: 0, nextDueAt: 0 },
      ];
    }

    /**
     * The hold-to-confirm flow uses fake timers so the 2s wait is
     * controllable in-test. We bind real Date.now at setup so the
     * timeline filter (which depends on actual lastSeen offsets) keeps
     * working — the fake timers only intercept setTimeout/clearTimeout.
     */
    function useFakeHoldTimers() {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }

    /**
     * Open the kebab → click Clear → wait for the clear-select panel to
     * be ready (live count populated). Most tests want to act from this
     * state, so factoring removes the boilerplate.
     */
    async function navigateToClearSelect(): Promise<void> {
      (document.getElementById("manage-toggle") as HTMLButtonElement).click();
      (document.getElementById("clear-vocab") as HTMLButtonElement).click();
      const execute = document.getElementById("clear-execute") as HTMLButtonElement;
      await vi.waitFor(() => expect(execute.disabled).toBe(false));
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("opens menu panel on kebab click", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      const toggle = document.getElementById("manage-toggle") as HTMLButtonElement;
      const popover = document.getElementById("manage-popover")!;
      const menuPanel = document.getElementById("manage-menu-panel")!;
      expect(popover.classList.contains("hidden")).toBe(true);

      toggle.click();
      expect(popover.classList.contains("hidden")).toBe(false);
      expect(menuPanel.classList.contains("hidden")).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    it("clicking Clear in the menu swaps to the clear-select panel", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      (document.getElementById("manage-toggle") as HTMLButtonElement).click();
      (document.getElementById("clear-vocab") as HTMLButtonElement).click();

      const menuPanel = document.getElementById("manage-menu-panel")!;
      const selectPanel = document.getElementById("clear-select-panel")!;
      expect(menuPanel.classList.contains("hidden")).toBe(true);
      expect(selectPanel.classList.contains("hidden")).toBe(false);
    });

    it("Back button on clear-select returns to the menu", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      await navigateToClearSelect();
      (document.getElementById("clear-back") as HTMLButtonElement).click();

      const menuPanel = document.getElementById("manage-menu-panel")!;
      const selectPanel = document.getElementById("clear-select-panel")!;
      expect(menuPanel.classList.contains("hidden")).toBe(false);
      expect(selectPanel.classList.contains("hidden")).toBe(true);
    });

    it("Clear N entries swaps to the confirm panel with the live count", async () => {
      const now = Date.now();
      const vocab = makeTimelineVocab(now);
      mockedGetAllVocab.mockResolvedValue([...vocab]);
      await loadHub();

      await navigateToClearSelect();

      const execute = document.getElementById("clear-execute") as HTMLButtonElement;
      await vi.waitFor(() => {
        expect(execute.textContent).toContain("2");
      });
      execute.click();

      const selectPanel = document.getElementById("clear-select-panel")!;
      const confirmPanel = document.getElementById("clear-confirm-panel")!;
      const confirmCount = document.getElementById("clear-confirm-count")!;
      await vi.waitFor(() => {
        expect(selectPanel.classList.contains("hidden")).toBe(true);
        expect(confirmPanel.classList.contains("hidden")).toBe(false);
        expect(confirmCount.textContent).toBe("2 entries");
      });
      expect(mockedRemoveWords).not.toHaveBeenCalled();
      expect(mockedClearVocab).not.toHaveBeenCalled();
    });

    it("No on the confirm panel returns to the select panel", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      await navigateToClearSelect();
      (document.getElementById("clear-execute") as HTMLButtonElement).click();

      const selectPanel = document.getElementById("clear-select-panel")!;
      const confirmPanel = document.getElementById("clear-confirm-panel")!;
      await vi.waitFor(() => expect(confirmPanel.classList.contains("hidden")).toBe(false));

      (document.getElementById("clear-confirm-no") as HTMLButtonElement).click();
      expect(confirmPanel.classList.contains("hidden")).toBe(true);
      expect(selectPanel.classList.contains("hidden")).toBe(false);
      expect(mockedRemoveWords).not.toHaveBeenCalled();
      expect(mockedClearVocab).not.toHaveBeenCalled();
    });

    it("holding Yes for the full duration clears the targeted entries", async () => {
      const now = Date.now();
      const vocab = makeTimelineVocab(now);
      mockedGetAllVocab.mockResolvedValue([...vocab]);
      mockedRemoveWords.mockResolvedValue(2);
      await loadHub();

      await navigateToClearSelect();
      (document.getElementById("clear-execute") as HTMLButtonElement).click();

      const yesBtn = document.getElementById("clear-confirm-yes") as HTMLButtonElement;
      await vi.waitFor(() => {
        expect(document.getElementById("clear-confirm-panel")!.classList.contains("hidden")).toBe(false);
      });

      useFakeHoldTimers();
      yesBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(yesBtn.classList.contains("holding")).toBe(true);

      vi.advanceTimersByTime(2000);
      vi.useRealTimers();

      await vi.waitFor(() => {
        expect(mockedRemoveWords).toHaveBeenCalledWith(["古旧A", "古旧B"]);
      });
      expect(mockedClearVocab).not.toHaveBeenCalled();
      expect(document.getElementById("manage-popover")!.classList.contains("hidden")).toBe(true);
    });

    it("releasing Yes before the duration cancels the clear", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      await navigateToClearSelect();
      (document.getElementById("clear-execute") as HTMLButtonElement).click();

      const yesBtn = document.getElementById("clear-confirm-yes") as HTMLButtonElement;
      await vi.waitFor(() => {
        expect(document.getElementById("clear-confirm-panel")!.classList.contains("hidden")).toBe(false);
      });

      useFakeHoldTimers();
      yesBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(yesBtn.classList.contains("holding")).toBe(true);

      vi.advanceTimersByTime(500);
      yesBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(yesBtn.classList.contains("holding")).toBe(false);

      vi.advanceTimersByTime(5000);
      vi.useRealTimers();

      expect(mockedRemoveWords).not.toHaveBeenCalled();
      expect(mockedClearVocab).not.toHaveBeenCalled();
    });

    it("uses fast-path clearVocab when nuking all entries with no extra filter", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedClearVocab.mockResolvedValue(undefined);
      await loadHub();

      await navigateToClearSelect();
      const timeline = document.getElementById("clear-timeline") as HTMLSelectElement;
      timeline.value = "all";
      timeline.dispatchEvent(new Event("change"));

      const execute = document.getElementById("clear-execute") as HTMLButtonElement;
      await vi.waitFor(() => expect(execute.disabled).toBe(false));
      execute.click();

      const yesBtn = document.getElementById("clear-confirm-yes") as HTMLButtonElement;
      await vi.waitFor(() => {
        expect(document.getElementById("clear-confirm-panel")!.classList.contains("hidden")).toBe(false);
      });

      useFakeHoldTimers();
      yesBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      vi.advanceTimersByTime(2000);
      vi.useRealTimers();

      await vi.waitFor(() => {
        expect(mockedClearVocab).toHaveBeenCalled();
      });
      expect(mockedRemoveWords).not.toHaveBeenCalled();
    });

    it("Escape steps back from clear-confirm to clear-select and cancels the hold", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      await navigateToClearSelect();
      (document.getElementById("clear-execute") as HTMLButtonElement).click();

      const yesBtn = document.getElementById("clear-confirm-yes") as HTMLButtonElement;
      await vi.waitFor(() => {
        expect(document.getElementById("clear-confirm-panel")!.classList.contains("hidden")).toBe(false);
      });

      useFakeHoldTimers();
      yesBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(yesBtn.classList.contains("holding")).toBe(true);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      // First Escape steps back to clear-select; popover stays open.
      expect(document.getElementById("clear-confirm-panel")!.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("clear-select-panel")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("manage-popover")!.classList.contains("hidden")).toBe(false);
      expect(yesBtn.classList.contains("holding")).toBe(false);

      vi.advanceTimersByTime(5000);
      vi.useRealTimers();

      expect(mockedRemoveWords).not.toHaveBeenCalled();
      expect(mockedClearVocab).not.toHaveBeenCalled();
    });

    it("Escape from menu state closes the popover entirely", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      (document.getElementById("manage-toggle") as HTMLButtonElement).click();
      expect(document.getElementById("manage-popover")!.classList.contains("hidden")).toBe(false);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(document.getElementById("manage-popover")!.classList.contains("hidden")).toBe(true);
    });
  });

  // ─── Vocab search ──────────────────────────────────────────────

  describe("vocab search", () => {
    function searchInput(): HTMLInputElement {
      return document.getElementById("vocab-search-input") as HTMLInputElement;
    }
    function setQuery(q: string): void {
      const input = searchInput();
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    it("filters by Chinese character substring", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      setQuery("银");
      await vi.waitFor(() => {
        const rows = vocabList().querySelectorAll(".vocab-row");
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain("银行");
      });
    });

    it("matches pinyin tone- and case-insensitively", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      // 银行 is "yín háng" — typing "yinhang" without tones should match.
      setQuery("yinhang");
      await vi.waitFor(() => {
        const rows = vocabList().querySelectorAll(".vocab-row");
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain("银行");
      });
    });

    it("matches against the definition", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      setQuery("student");
      await vi.waitFor(() => {
        const rows = vocabList().querySelectorAll(".vocab-row");
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain("学生");
      });
    });

    it("highlights matches with <mark class='vocab-search-hl'>", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      setQuery("bank");
      await vi.waitFor(() => {
        const marks = vocabList().querySelectorAll("mark.vocab-search-hl");
        expect(marks.length).toBeGreaterThan(0);
        expect(marks[0].textContent).toBe("bank");
      });
    });

    it("renders an empty state when the query matches nothing", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      setQuery("zzznonexistent");
      await vi.waitFor(() => {
        const empty = vocabList().querySelector(".vocab-empty");
        expect(empty).not.toBeNull();
        expect(empty!.textContent).toContain("zzznonexistent");
      });
    });

    it("Esc inside the search input clears the query and reverts the list", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      setQuery("银");
      await vi.waitFor(() => {
        expect(vocabList().querySelectorAll(".vocab-row")).toHaveLength(1);
      });

      const input = searchInput();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.waitFor(() => {
        expect(input.value).toBe("");
        expect(vocabList().querySelectorAll(".vocab-row")).toHaveLength(sampleVocab.length);
      });
    });

    it("clear button (×) wipes the query", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      setQuery("银");
      const clearBtn = document.getElementById("vocab-search-clear") as HTMLButtonElement;
      await vi.waitFor(() => {
        expect(clearBtn.classList.contains("hidden")).toBe(false);
      });

      clearBtn.click();
      await vi.waitFor(() => {
        expect(searchInput().value).toBe("");
        expect(vocabList().querySelectorAll(".vocab-row")).toHaveLength(sampleVocab.length);
      });
    });
  });

  // ─── Vocab card ────────────────────────────────────────────────

  describe("vocab card", () => {
    it("shows card overlay when a vocab row is clicked", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const overlay = document.querySelector(".vocab-card-overlay");
      expect(overlay).not.toBeNull();
    });

    it("card displays correct data and review stats", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const card = document.querySelector(".vocab-card")!;
      expect(card.querySelector(".vocab-card-chars")!.textContent).toBe("银行");
      expect(card.querySelector(".vocab-card-pinyin")!.textContent).toBe("yín háng");
      expect(card.querySelector(".vocab-card-def")!.textContent).toBe("bank");
      expect(card.querySelector(".vocab-card-meta")!.textContent).toContain("Reviews: 10");
      expect(card.querySelector(".vocab-card-meta")!.textContent).toContain("Accuracy: 80%");
    });

    it("clicking delete removes word and re-renders", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedRemoveWord.mockResolvedValue(undefined);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      const targetChars = row.querySelector(".vocab-chars")!.textContent!;
      row.click();

      mockedGetAllVocab.mockResolvedValue(
        sampleVocab.filter((e) => e.chars !== targetChars),
      );

      const deleteBtn = document.querySelector(".vocab-card-delete") as HTMLButtonElement;
      deleteBtn.click();

      await vi.waitFor(() => {
        expect(mockedRemoveWord).toHaveBeenCalledWith(targetChars);
      });

      await vi.waitFor(() => {
        expect(document.querySelector(".vocab-card-overlay")).toBeNull();
      });
    });

    it("clicking overlay backdrop dismisses card", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const overlay = document.querySelector(".vocab-card-overlay") as HTMLDivElement;
      overlay.click();

      expect(document.querySelector(".vocab-card-overlay")).toBeNull();
    });

    it("clicking close button dismisses card", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const closeBtn = document.querySelector(".vocab-card-close") as HTMLButtonElement;
      closeBtn.click();

      expect(document.querySelector(".vocab-card-overlay")).toBeNull();
    });

    it("only one card is shown at a time", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      const rows = vocabList().querySelectorAll(".vocab-row");
      (rows[0] as HTMLDivElement).click();
      (rows[1] as HTMLDivElement).click();

      const overlays = document.querySelectorAll(".vocab-card-overlay");
      expect(overlays).toHaveLength(1);
    });
  });

  // ─── Vocab card examples ───────────────────────────────────────

  describe("vocab card examples", () => {
    const wordWithNoExamples: VocabEntry = {
      ...sampleVocab[0],
      examples: undefined,
    };
    const wordWithOneExample: VocabEntry = {
      ...sampleVocab[0],
      examples: [
        { sentence: "我去银行存钱。", translation: "I go to the bank.", capturedAt: 1 },
      ],
    };
    const wordWithTwoExamples: VocabEntry = {
      ...sampleVocab[0],
      examples: [
        { sentence: "我去银行存钱。", translation: "I go to the bank.", capturedAt: 1 },
        { sentence: "银行今天关门。", capturedAt: 2 },
      ],
    };

    it("renders no examples section when entry has no examples", async () => {
      mockedGetAllVocab.mockResolvedValue([wordWithNoExamples]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      // Wait a tick for the async examples-enrichment pass.
      await new Promise((r) => setTimeout(r, 20));

      expect(document.querySelector(".vocab-card-examples")).toBeNull();
    });

    it("renders a single example with translation", async () => {
      mockedGetAllVocab.mockResolvedValue([wordWithOneExample]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll(".vocab-example")).toHaveLength(1);
      });

      const heading = document.querySelector(".vocab-card-examples-heading")!;
      expect(heading.textContent).toBe("Example");
      const translation = document.querySelector(".vocab-example-translation")!;
      expect(translation.textContent).toBe("I go to the bank.");
      // Target word is highlighted by attaching .vocab-example-target to
      // the <ruby> element. The visible characters live in a dedicated
      // base span so we can address them without picking up the <rt>
      // pinyin annotation in the same textContent.
      const target = document.querySelector(".vocab-example-target")!;
      expect(target.tagName.toLowerCase()).toBe("ruby");
      expect(target.querySelector(".vocab-example-ruby-base")!.textContent).toBe("银行");
      expect(target.querySelector("rt")!.textContent).toBeTruthy();
    });

    it("renders two examples and pluralizes the heading", async () => {
      mockedGetAllVocab.mockResolvedValue([wordWithTwoExamples]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll(".vocab-example")).toHaveLength(2);
      });

      const heading = document.querySelector(".vocab-card-examples-heading")!;
      expect(heading.textContent).toBe("Examples");
    });

    it("clicking X sends REMOVE_EXAMPLE and re-renders the card", async () => {
      const oneLeftAfterRemoval: VocabEntry = {
        ...wordWithTwoExamples,
        examples: [wordWithTwoExamples.examples![1]],
      };
      mockedGetAllVocab.mockResolvedValue([wordWithTwoExamples]);
      const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
      chrome.runtime.sendMessage = sendMessageSpy as unknown as typeof chrome.runtime.sendMessage;
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      await vi.waitFor(() => {
        expect(document.querySelectorAll(".vocab-example-x")).toHaveLength(2);
      });

      mockedGetAllVocab.mockResolvedValue([oneLeftAfterRemoval]);
      const xBtn = document.querySelectorAll(".vocab-example-x")[0] as HTMLButtonElement;
      xBtn.click();

      await vi.waitFor(() => {
        expect(sendMessageSpy).toHaveBeenCalledWith({
          type: "REMOVE_EXAMPLE",
          chars: "银行",
          index: 0,
        });
      });

      await vi.waitFor(() => {
        expect(document.querySelectorAll(".vocab-example")).toHaveLength(1);
      });
    });

    it("renders the Translate button enabled regardless of AI Translations setting", async () => {
      // The Translator API is on-device and needs no settings, so the
      // button no longer mirrors the LLM-availability state.
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ llmEnabled: false }),
      );
      mockedGetAllVocab.mockResolvedValue([wordWithTwoExamples]);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".vocab-example-translate-btn")).not.toBeNull();
      });

      const btn = document.querySelector(".vocab-example-translate-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("Translate button calls Translator + setExampleTranslation and re-renders the card", async () => {
      const { translateFn } = stubGlobalTranslator("The bank is closed today.");
      mockedGetAllVocab.mockResolvedValue([wordWithTwoExamples]);
      mockedSetExampleTranslation.mockResolvedValue(undefined);
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".vocab-example-translate-btn")).not.toBeNull();
      });

      const btn = document.querySelector(".vocab-example-translate-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);

      // Have getAllVocab return the freshly-translated entry on the
      // refresh round-trip so the card paints the translation row.
      mockedGetAllVocab.mockResolvedValue([
        {
          ...wordWithTwoExamples,
          examples: [
            wordWithTwoExamples.examples![0],
            { ...wordWithTwoExamples.examples![1], translation: "The bank is closed today." },
          ],
        },
      ]);
      btn.click();

      await vi.waitFor(() => {
        expect(translateFn).toHaveBeenCalledWith("银行今天关门。");
      });
      await vi.waitFor(() => {
        expect(mockedSetExampleTranslation).toHaveBeenCalledWith(
          "银行",
          1,
          "The bank is closed today.",
        );
      });
    });

    it("Translate button shows Retry on Translator failure and never persists", async () => {
      // Translator API missing entirely (older Chrome / mobile / Edge).
      // The button should surface a clear error inline instead of
      // silently failing or persisting an empty translation.
      mockedGetAllVocab.mockResolvedValue([wordWithTwoExamples]);
      mockedSetExampleTranslation.mockResolvedValue(undefined);
      clearGlobalTranslator();
      await loadHub();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".vocab-example-translate-btn")).not.toBeNull();
      });

      const btn = document.querySelector(".vocab-example-translate-btn") as HTMLButtonElement;
      btn.click();

      await vi.waitFor(() => {
        expect(btn.textContent).toBe("Retry translate");
      });
      expect(btn.disabled).toBe(false);
      expect(btn.title.toLowerCase()).toContain("translation");
      expect(mockedSetExampleTranslation).not.toHaveBeenCalled();
    });
  });

  // ─── Flashcard examples on flip ────────────────────────────────

  describe("flashcard example on flip", () => {
    const wordWithExample: VocabEntry = {
      chars: "银行",
      pinyin: "yín háng",
      definition: "bank",
      count: 1,
      firstSeen: 1000,
      lastSeen: 5000,
      wrongStreak: 0,
      totalReviews: 0,
      totalCorrect: 0,
      intervalDays: 0,
      nextDueAt: 0,
      examples: [
        { sentence: "我去银行存钱。", translation: "I go to the bank.", capturedAt: 1 },
      ],
    };

    async function startSession(vocab: VocabEntry[]) {
      mockedGetAllVocab.mockResolvedValue([...vocab]);
      mockedUpdateResult.mockResolvedValue(undefined);
      await loadHub();
      await switchToFlashcards();
      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });
    }

    it("populates fc-example on the initial front face (visible without flipping)", async () => {
      await startSession([wordWithExample]);

      // The example block now lives outside fc-answer, so it surfaces
      // as soon as showCard runs -- no flip needed.
      await vi.waitFor(() => {
        const example = document.getElementById("fc-example")!;
        expect(example.classList.contains("hidden")).toBe(false);
        expect(example.querySelector(".fc-example-sentence")).not.toBeNull();
      });

      const trans = document.querySelector(".fc-example-translation")!;
      expect(trans.textContent).toBe("I go to the bank.");
    });

    it("hides fc-example when the card has no examples", async () => {
      const noExample: VocabEntry = { ...wordWithExample, examples: [] };
      await startSession([noExample]);

      // Give renderFlashcardExample a tick to settle.
      await new Promise((r) => setTimeout(r, 20));

      const example = document.getElementById("fc-example")!;
      expect(example.classList.contains("hidden")).toBe(true);
    });

    it("shows a Translate button when example has no translation", async () => {
      const untranslated: VocabEntry = {
        ...wordWithExample,
        examples: [{ sentence: "我去银行存钱。", capturedAt: 1 }],
      };
      await startSession([untranslated]);

      await vi.waitFor(() => {
        expect(document.querySelector(".fc-example-translate-btn")).not.toBeNull();
      });

      const btn = document.querySelector(".fc-example-translate-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("Translate button on flashcard stays enabled regardless of AI Translations setting", async () => {
      // The Translator API is on-device and needs no settings, so the
      // flashcard button no longer mirrors the LLM-availability state.
      mock(chrome.storage.sync.get).mockImplementation(() =>
        Promise.resolve({ llmEnabled: false }),
      );
      const untranslated: VocabEntry = {
        ...wordWithExample,
        examples: [{ sentence: "我去银行存钱。", capturedAt: 1 }],
      };
      await startSession([untranslated]);

      await vi.waitFor(() => {
        expect(document.querySelector(".fc-example-translate-btn")).not.toBeNull();
      });

      const btn = document.querySelector(".fc-example-translate-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("re-renders fc-example for each card so previous markup doesn't bleed", async () => {
      // The example block is always visible across flips; what we
      // care about between cards is that the new card's content
      // replaces the old one's, not that the slot is briefly empty.
      const wordA: VocabEntry = {
        ...wordWithExample,
        chars: "银行",
        examples: [{ sentence: "我去银行存钱。", translation: "Go to bank.", capturedAt: 1 }],
      };
      const wordB: VocabEntry = {
        ...wordWithExample,
        chars: "工作",
        pinyin: "gōng zuò",
        definition: "to work",
        examples: [{ sentence: "他在工作。", translation: "He is working.", capturedAt: 2 }],
      };
      await startSession([wordA, wordB]);

      await vi.waitFor(() => {
        const trans = document.querySelector(".fc-example-translation");
        expect(trans?.textContent).toBe("Go to bank.");
      });

      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;
      rightBtn.click();

      // After answering, showCard fires renderFlashcardExample again
      // for card B; the old "Go to bank." translation is replaced by
      // the new card's content.
      await vi.waitFor(() => {
        const trans = document.querySelector(".fc-example-translation");
        expect(trans?.textContent).toBe("He is working.");
      });
    });
  });

  // ─── Flashcard setup ───────────────────────────────────────────

  describe("flashcard setup", () => {
    it("shows the live session summary line on the setup screen", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();
      await switchToFlashcards();

      const available = document.getElementById("fc-available")!;
      // Sample list has only 3 entries, so showSetup forces "all" and
      // the summary line announces the full deck.
      expect(available.textContent).toContain("Practice all 3 cards");
    });

    it("renders a clickable bucket chip strip with counts", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();
      await switchToFlashcards();

      const summary = document.getElementById("fc-bucket-summary")!;
      const chips = summary.querySelectorAll<HTMLButtonElement>(".vocab-bucket-summary-chip");
      // All / Confident / Needs improvement / Not reviewed
      expect(chips).toHaveLength(4);
      expect(chips[0].textContent).toContain("All: 3");
      // sampleVocab: 1 confident-eligible (totalReviews>0, no streak, but
      // intervalDays=0 → needs-improvement), 1 not-reviewed, 1 streak →
      // both reviewed entries land in "needs-improvement".
      expect(chips[0].classList.contains("active")).toBe(true);
    });

    it("filters the deck when a bucket chip is clicked", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();
      await switchToFlashcards();

      const summary = document.getElementById("fc-bucket-summary")!;
      const notReviewedChip = Array.from(
        summary.querySelectorAll<HTMLButtonElement>(".vocab-bucket-summary-chip"),
      ).find((c) => c.textContent?.includes("Not reviewed"))!;
      notReviewedChip.click();

      await vi.waitFor(() => {
        const available = document.getElementById("fc-available")!;
        expect(available.textContent).toContain("from Not reviewed");
      });
    });

    it("disables start when no words", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();
      await switchToFlashcards();

      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      expect(startBtn.disabled).toBe(true);
    });

    it("selects 'All' by default when fewer than 10 words", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();
      await switchToFlashcards();

      const allBtn = document.querySelector('.fc-size-btn[data-size="all"]') as HTMLButtonElement;
      expect(allBtn.classList.contains("selected")).toBe(true);
    });

    it("highlights selected size button", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();
      await switchToFlashcards();

      const btn20 = document.querySelector('.fc-size-btn[data-size="20"]') as HTMLButtonElement;
      btn20.click();
      expect(btn20.classList.contains("selected")).toBe(true);

      const allBtn = document.querySelector('.fc-size-btn[data-size="all"]') as HTMLButtonElement;
      expect(allBtn.classList.contains("selected")).toBe(false);
    });
  });

  // ─── Flashcard session ─────────────────────────────────────────

  describe("flashcard session", () => {
    async function startSessionWith(vocab: VocabEntry[]) {
      mockedGetAllVocab.mockResolvedValue([...vocab]);
      mockedUpdateResult.mockResolvedValue(undefined);
      await loadHub();
      await switchToFlashcards();

      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });
    }

    it("starts a session and shows first card", async () => {
      await startSessionWith(sampleVocab);

      const chars = document.getElementById("fc-chars")!;
      expect(chars.textContent!.length).toBeGreaterThan(0);
      expect(document.getElementById("fc-progress")!.textContent).toBe("1/3");
    });

    it("shows flip and judge buttons initially with answer hidden (honor system)", async () => {
      await startSessionWith(sampleVocab);

      // Flip + judge are always visible -- the honor-system flow lets
      // the user grade themselves from either face. Answer area is the
      // only thing toggled by the flip.
      expect(document.getElementById("fc-flip")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("fc-judge")!.classList.contains("hidden")).toBe(false);
    });

    it("flipping reveals answer; judge and flip remain visible", async () => {
      await startSessionWith(sampleVocab);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-flip")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-judge")!.classList.contains("hidden")).toBe(false);
    });

    it("flip is a true toggle: a second click hides the answer again", async () => {
      await startSessionWith(sampleVocab);
      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;

      flipBtn.click();
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);

      flipBtn.click();
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(true);

      flipBtn.click();
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);
    });

    it("can grade Right without ever flipping (honor system)", async () => {
      await startSessionWith(sampleVocab);

      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;
      rightBtn.click();

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), true);
      });
    });

    it("answering right calls updateFlashcardResult with correct=true", async () => {
      await startSessionWith(sampleVocab);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;
      rightBtn.click();

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), true);
      });
    });

    it("answering wrong calls updateFlashcardResult with correct=false", async () => {
      await startSessionWith(sampleVocab);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

      const wrongBtn = document.getElementById("fc-wrong") as HTMLButtonElement;
      wrongBtn.click();

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), false);
      });
    });

    it("advances to next card after answering", async () => {
      await startSessionWith(sampleVocab);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;

      flipBtn.click();
      rightBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-progress")!.textContent).toBe("2/3");
      });
    });

    it("shows summary after last card", async () => {
      const oneWord = [sampleVocab[0]];
      await startSessionWith(oneWord);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;

      flipBtn.click();
      rightBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
      });
    });

    it("closing session early shows summary", async () => {
      await startSessionWith(sampleVocab);

      const closeBtn = document.getElementById("fc-close") as HTMLButtonElement;
      closeBtn.click();

      expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
    });
  });

  // ─── Front sentence & TTS ─────────────────────────────────────

  describe("front sentence & TTS", () => {
    /**
     * Stubs SpeechSynthesisUtterance + window.speechSynthesis so the
     * TTS handlers don't blow up in jsdom (which doesn't ship the
     * Web Speech API). Returns the spy so individual tests can assert
     * on the text passed in.
     */
    function stubSpeechSynthesis() {
      const speakSpy = vi.fn();
      const cancelSpy = vi.fn();
      const utterances: Array<{ text: string; lang: string }> = [];
      class FakeUtterance {
        text: string;
        lang = "";
        constructor(text: string) {
          this.text = text;
        }
      }
      (globalThis as any).SpeechSynthesisUtterance = vi.fn(function (this: FakeUtterance, t: string) {
        const u = new FakeUtterance(t);
        utterances.push(u);
        return u;
      });
      (globalThis as any).speechSynthesis = {
        speak: (u: { text: string; lang: string }) => {
          speakSpy(u);
        },
        cancel: cancelSpy,
      };
      return { speakSpy, cancelSpy, utterances };
    }

    function clearSpeechSynthesis() {
      delete (globalThis as any).SpeechSynthesisUtterance;
      delete (globalThis as any).speechSynthesis;
    }

    afterEach(() => {
      clearSpeechSynthesis();
    });

    /**
     * Builds a deterministic single-card session whose entry has one
     * stored example, so the example block + TTS paths have data to
     * render. Math.random is mocked near 1 so the shuffle is a no-op.
     */
    async function startSingleCardWithExample(): Promise<void> {
      const vocab: VocabEntry[] = [
        {
          chars: "银行",
          pinyin: "yín háng",
          definition: "bank",
          count: 1,
          firstSeen: 1000,
          lastSeen: 2000,
          wrongStreak: 0,
          totalReviews: 0,
          totalCorrect: 0,
          intervalDays: 0,
          nextDueAt: 0,
          examples: [{ sentence: "我去银行取钱。", capturedAt: 2000 }],
        },
      ];
      mockedGetAllVocab.mockResolvedValue(vocab);
      mockedUpdateResult.mockResolvedValue(undefined);
      const rand = vi.spyOn(Math, "random").mockReturnValue(0.99999);
      await loadHub();
      await switchToFlashcards();
      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });
      rand.mockRestore();
    }

    it("renders the sentence with ruby and a TTS button on the initial front face", async () => {
      await startSingleCardWithExample();

      // The example block lives outside fc-answer so it stays visible
      // across flips. fc-answer (pinyin + def) is what flips.
      const exampleSlot = document.getElementById("fc-example")!;
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(true);
      await vi.waitFor(() => {
        expect(exampleSlot.classList.contains("hidden")).toBe(false);
        expect(exampleSlot.querySelector("ruby")).not.toBeNull();
        expect(exampleSlot.querySelector("button.fc-tts-btn")).not.toBeNull();
      });
      // Front-mode class is on so CSS hides rt + translation; the
      // same DOM is reused on the back without rebuilding.
      expect(exampleSlot.classList.contains("fc-front-mode")).toBe(true);
    });

    it("hides the example block when the card has no stored example", async () => {
      mockedGetAllVocab.mockResolvedValue([
        {
          chars: "测试",
          pinyin: "cè shì",
          definition: "test",
          count: 1,
          firstSeen: 1000,
          lastSeen: 2000,
          wrongStreak: 0,
          totalReviews: 0,
          totalCorrect: 0,
          intervalDays: 0,
          nextDueAt: 0,
        },
      ]);
      mockedUpdateResult.mockResolvedValue(undefined);
      await loadHub();
      await switchToFlashcards();
      (document.getElementById("fc-start") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });

      const exampleSlot = document.getElementById("fc-example")!;
      expect(exampleSlot.classList.contains("hidden")).toBe(true);
    });

    it("keeps the same example block visible after flipping; front-mode class toggles", async () => {
      await startSingleCardWithExample();
      const exampleSlot = document.getElementById("fc-example")!;
      await vi.waitFor(() =>
        expect(exampleSlot.querySelector("ruby")).not.toBeNull(),
      );
      const sentenceNodeBefore = exampleSlot.querySelector("ruby");
      expect(exampleSlot.classList.contains("fc-front-mode")).toBe(true);

      (document.getElementById("fc-flip") as HTMLButtonElement).click();

      // After flipping, the answer area appears, the same sentence
      // node is still in place (not re-created), and front-mode is
      // off so CSS reveals rt + translation.
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);
      expect(exampleSlot.classList.contains("hidden")).toBe(false);
      expect(exampleSlot.classList.contains("fc-front-mode")).toBe(false);
      expect(exampleSlot.querySelector("ruby")).toBe(sentenceNodeBefore);

      // Flipping back returns to front-mode without rebuilding.
      (document.getElementById("fc-flip") as HTMLButtonElement).click();
      expect(exampleSlot.classList.contains("fc-front-mode")).toBe(true);
      expect(exampleSlot.querySelector("ruby")).toBe(sentenceNodeBefore);
    });

    it("speaks the word when the word TTS button is clicked", async () => {
      const { speakSpy, cancelSpy } = stubSpeechSynthesis();
      await startSingleCardWithExample();

      const ttsBtn = document.getElementById("fc-tts-word") as HTMLButtonElement;
      ttsBtn.click();

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(speakSpy).toHaveBeenCalledTimes(1);
      const utterance = speakSpy.mock.calls[0][0];
      expect(utterance.text).toBe("银行");
      expect(utterance.lang).toBe("zh-CN");
    });

    it("speaks the sentence when the example speaker button is clicked", async () => {
      const { speakSpy } = stubSpeechSynthesis();
      await startSingleCardWithExample();

      const exampleSlot = document.getElementById("fc-example")!;
      await vi.waitFor(() =>
        expect(exampleSlot.querySelector("button.fc-tts-btn")).not.toBeNull(),
      );
      const sentenceBtn = exampleSlot.querySelector("button.fc-tts-btn") as HTMLButtonElement;
      sentenceBtn.click();

      expect(speakSpy).toHaveBeenCalledTimes(1);
      expect(speakSpy.mock.calls[0][0].text).toBe("我去银行取钱。");
    });

    it("paints the karaoke highlight on each ruby as the sentence plays", async () => {
      vi.useFakeTimers();
      try {
        const { speakSpy } = stubSpeechSynthesis();
        // The fake-timers + mocked Math.random combination must not
        // interfere with the async startup. Reuse the helper but
        // restore a non-async flush at the end.
        await startSingleCardWithExample();

        const exampleSlot = document.getElementById("fc-example")!;
        await vi.waitFor(() =>
          expect(exampleSlot.querySelector("ruby")).not.toBeNull(),
        );
        const rubies = Array.from(exampleSlot.querySelectorAll("ruby"));
        // Sentence is "我去银行取钱。" -- pinyin-pro segments yield at
        // least one ruby; assert the karaoke walks through them.
        expect(rubies.length).toBeGreaterThan(0);

        const sentenceBtn = exampleSlot.querySelector("button.fc-tts-btn") as HTMLButtonElement;
        sentenceBtn.click();

        // The mocked synth.speak captures the utterance. Manually fire
        // its onstart so the karaoke timers are scheduled.
        const utterance = speakSpy.mock.calls[0][0] as { onstart?: () => void };
        expect(typeof utterance.onstart).toBe("function");
        utterance.onstart!();

        // First segment should light up immediately (offset 0).
        await vi.advanceTimersByTimeAsync(1);
        expect(rubies[0].classList.contains("fc-tts-active")).toBe(true);

        // Advance through the whole sentence; later rubies pick up the
        // highlight in turn while earlier ones drop it.
        await vi.advanceTimersByTimeAsync(5_000);
        const stillActive = rubies.filter((r) => r.classList.contains("fc-tts-active"));
        // Only the final segment's ruby should remain lit at this point.
        expect(stillActive.length).toBeLessThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not throw when speech synthesis is unavailable", async () => {
      // No stub installed: speechSynthesis is undefined in jsdom.
      await startSingleCardWithExample();
      const ttsBtn = document.getElementById("fc-tts-word") as HTMLButtonElement;
      expect(() => ttsBtn.click()).not.toThrow();
    });
  });

  // ─── Progress bar & rewind ────────────────────────────────────

  describe("progress bar & rewind", () => {
    /**
     * Builds a 4-card deck with deterministic order ("a", "b", "c", "d")
     * by re-importing hub with a buildSession spy that returns the deck
     * verbatim. Avoids the production shuffle so the rewind tests can
     * make assertions about which card is on screen at each step.
     */
    async function startOrderedSession(chars: string[]) {
      const vocab: VocabEntry[] = chars.map((c) => ({
        chars: c,
        pinyin: `${c}-pinyin`,
        definition: `${c}-def`,
        count: 1,
        firstSeen: 1000,
        lastSeen: 2000,
        wrongStreak: 0,
        totalReviews: 0,
        totalCorrect: 0,
        intervalDays: 0,
        nextDueAt: 0,
      }));
      mockedGetAllVocab.mockResolvedValue(vocab);
      mockedUpdateResult.mockResolvedValue(undefined);
      mockedRestoreState.mockResolvedValue(undefined);

      // Force the session order to match `chars` so the test can rely
      // on which card is on screen at each step. Math.random near 1
      // (specifically ≥ (i/(i+1)) for every i) makes each Fisher-Yates
      // step swap an element with itself -- a true no-op shuffle.
      const rand = vi.spyOn(Math, "random").mockReturnValue(0.99999);

      await loadHub();
      await switchToFlashcards();
      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });

      rand.mockRestore();
    }

    function flip() {
      (document.getElementById("fc-flip") as HTMLButtonElement).click();
    }
    function answerRight() {
      (document.getElementById("fc-right") as HTMLButtonElement).click();
    }
    function answerWrong() {
      (document.getElementById("fc-wrong") as HTMLButtonElement).click();
    }
    function rewind() {
      (document.getElementById("fc-rewind") as HTMLButtonElement).click();
    }

    function chars(): string {
      return document.getElementById("fc-chars")!.textContent ?? "";
    }
    function progress(): string {
      return document.getElementById("fc-progress")!.textContent ?? "";
    }
    function correctWidth(): string {
      return (document.getElementById("fc-progress-bar-correct") as HTMLDivElement).style.width;
    }
    function wrongWidth(): string {
      return (document.getElementById("fc-progress-bar-wrong") as HTMLDivElement).style.width;
    }
    function rewindBtn(): HTMLButtonElement {
      return document.getElementById("fc-rewind") as HTMLButtonElement;
    }

    it("renders N/T format and zero-width bar at session start", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      expect(progress()).toBe("1/4");
      expect(correctWidth()).toBe("0%");
      expect(wrongWidth()).toBe("0%");
    });

    it("disables the rewind button on the first card", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      expect(rewindBtn().disabled).toBe(true);
    });

    it("grows the green bar segment after a Right answer", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      flip();
      answerRight();
      await vi.waitFor(() => expect(progress()).toBe("2/4"));
      expect(correctWidth()).toBe("25%");
      expect(wrongWidth()).toBe("0%");
    });

    it("grows the red bar segment after a Wrong answer", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      flip();
      answerWrong();
      await vi.waitFor(() => expect(progress()).toBe("2/4"));
      expect(correctWidth()).toBe("0%");
      expect(wrongWidth()).toBe("25%");
    });

    it("accumulates green + red across mixed answers", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      flip(); answerRight();
      await vi.waitFor(() => expect(progress()).toBe("2/4"));
      flip(); answerWrong();
      await vi.waitFor(() => expect(progress()).toBe("3/4"));
      flip(); answerRight();
      await vi.waitFor(() => expect(progress()).toBe("4/4"));
      // Two right, one wrong, before the last card answer.
      expect(correctWidth()).toBe("50%");
      expect(wrongWidth()).toBe("25%");
    });

    it("rewinds to the previous card and preserves order", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      expect(chars()).toBe("a");

      flip(); answerRight();
      await vi.waitFor(() => expect(chars()).toBe("b"));

      flip(); answerWrong();
      await vi.waitFor(() => expect(chars()).toBe("c"));

      rewind();
      await vi.waitFor(() => expect(chars()).toBe("b"));
      expect(progress()).toBe("2/4");

      rewind();
      await vi.waitFor(() => expect(chars()).toBe("a"));
      expect(progress()).toBe("1/4");
      expect(rewindBtn().disabled).toBe(true);

      // Going forward again restores the same order.
      flip(); answerRight();
      await vi.waitFor(() => expect(chars()).toBe("b"));
      flip(); answerRight();
      await vi.waitFor(() => expect(chars()).toBe("c"));
    });

    it("shrinks the bar when an answer is rewound", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      flip(); answerRight();
      await vi.waitFor(() => expect(correctWidth()).toBe("25%"));
      flip(); answerWrong();
      await vi.waitFor(() => expect(wrongWidth()).toBe("25%"));

      rewind();
      await vi.waitFor(() => expect(wrongWidth()).toBe("0%"));
      // The earlier Right answer is still on the bar.
      expect(correctWidth()).toBe("25%");

      rewind();
      await vi.waitFor(() => expect(correctWidth()).toBe("0%"));
      expect(wrongWidth()).toBe("0%");
    });

    it("calls restoreFlashcardState with the pre-answer snapshot on rewind", async () => {
      await startOrderedSession(["a", "b", "c", "d"]);
      flip(); answerRight();
      await vi.waitFor(() => expect(chars()).toBe("b"));

      rewind();
      await vi.waitFor(() => expect(chars()).toBe("a"));

      expect(mockedRestoreState).toHaveBeenCalledTimes(1);
      const [restoredChars, snapshot] = mockedRestoreState.mock.calls[0];
      expect(restoredChars).toBe("a");
      // Pre-answer snapshot for a fresh card mirrors the seed values.
      expect(snapshot).toEqual({
        intervalDays: 0,
        nextDueAt: 0,
        wrongStreak: 0,
        totalReviews: 0,
        totalCorrect: 0,
      });
    });

    it("rewinds from the summary screen back to the last card", async () => {
      await startOrderedSession(["a", "b"]);
      flip(); answerRight();
      await vi.waitFor(() => expect(chars()).toBe("b"));
      flip(); answerRight();

      // After the last card, summary takes over.
      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
      });

      rewind();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(true);
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
        expect(chars()).toBe("b");
      });
      expect(progress()).toBe("2/2");
      // The bar drops the last green segment (one Right left).
      expect(correctWidth()).toBe("50%");
    });

    it("re-answering a rewound card does not double-count totals", async () => {
      await startOrderedSession(["a", "b"]);
      flip(); answerRight();
      await vi.waitFor(() => expect(chars()).toBe("b"));
      rewind();
      await vi.waitFor(() => expect(chars()).toBe("a"));
      flip(); answerWrong();
      await vi.waitFor(() => expect(chars()).toBe("b"));

      // After rewind, the bar reflects only the new wrong answer.
      expect(correctWidth()).toBe("0%");
      expect(wrongWidth()).toBe("50%");

      // Two writes: original Right, then post-rewind Wrong. The restore
      // call sits between them; the second updateFlashcardResult is
      // applied on top of the restored (pre-answer) state, so totals
      // can't drift.
      expect(mockedUpdateResult).toHaveBeenCalledTimes(2);
      expect(mockedRestoreState).toHaveBeenCalledTimes(1);
    });

    it("ignores rewind clicks when there is nothing to rewind", async () => {
      await startOrderedSession(["a", "b"]);
      // Rewind on first card is a no-op (button disabled, but force the
      // click path anyway to confirm the handler short-circuits).
      rewind();
      await new Promise((r) => setTimeout(r, 10));
      expect(mockedRestoreState).not.toHaveBeenCalled();
      expect(chars()).toBe("a");
      expect(progress()).toBe("1/2");
    });
  });

  // ─── Flashcard summary ─────────────────────────────────────────

  describe("flashcard summary", () => {
    async function completeSession(answers: boolean[]) {
      const vocab = answers.map((_, i) => ({
        chars: `word${i}`,
        pinyin: `pinyin${i}`,
        definition: `def${i}`,
        count: 1,
        firstSeen: 1000,
        lastSeen: 2000,
        wrongStreak: 0,
        totalReviews: 0,
        totalCorrect: 0,
      }));
      mockedGetAllVocab.mockResolvedValue([...vocab]);
      mockedUpdateResult.mockResolvedValue(undefined);
      await loadHub();
      await switchToFlashcards();

      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });

      for (const correct of answers) {
        const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
        flipBtn.click();
        const btn = correct
          ? document.getElementById("fc-right") as HTMLButtonElement
          : document.getElementById("fc-wrong") as HTMLButtonElement;
        btn.click();
        await vi.waitFor(() => {});
      }
    }

    it("shows correct score", async () => {
      await completeSession([true, true, false]);

      await vi.waitFor(() => {
        const score = document.getElementById("fc-score")!;
        expect(score.textContent).toContain("2 / 3 correct");
        expect(score.textContent).toContain("67%");
      });
    });

    it("lists wrong words in review section", async () => {
      await completeSession([true, false, false]);

      await vi.waitFor(() => {
        const wrongList = document.getElementById("fc-wrong-list")!;
        const items = wrongList.querySelectorAll(".fc-wrong-item");
        expect(items.length).toBe(2);
      });
    });

    it("shows congratulatory message when all correct", async () => {
      await completeSession([true, true]);

      await vi.waitFor(() => {
        const wrongList = document.getElementById("fc-wrong-list")!;
        const congrats = wrongList.querySelector(".fc-congrats");
        expect(congrats).not.toBeNull();
        expect(congrats!.textContent).toContain("every word right");
      });
    });

    it("Practice Again returns to setup", async () => {
      await completeSession([true]);

      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
      });

      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      const againBtn = document.getElementById("fc-again") as HTMLButtonElement;
      againBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-setup")!.classList.contains("hidden")).toBe(false);
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(true);
      });
    });

    it("Back to List switches to vocab tab", async () => {
      await completeSession([true]);

      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
      });

      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      const backBtn = document.getElementById("fc-back") as HTMLButtonElement;
      backBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("tab-vocab")!.classList.contains("hidden")).toBe(false);
        expect(document.getElementById("tab-flashcards")!.classList.contains("hidden")).toBe(true);
      });
    });

    it("Back to List does not hide #tab-flashcards when no .hub-tab buttons exist (library mode)", async () => {
      // Build a library-style scaffold: same hub IDs, but no .hub-tab nav.
      // hub.ts must not touch #tab-flashcards/#tab-vocab visibility here,
      // because those divs live inside the library panes and need to stay
      // visible for future tab activations.
      document.body.innerHTML = `
        <div id="tab-vocab">
          <select id="vocab-sort">
            <option value="frequency">Most frequent</option>
          </select>
          <button id="export-vocab"></button>
          <button id="import-vocab"></button>
          <input type="file" id="import-file-input" />
          <span id="io-status"></span>
          <button id="clear-vocab"></button>
          <div id="vocab-list"></div>
        </div>
        <div id="tab-flashcards">
          <div id="fc-setup">
            <button class="fc-size-btn" data-size="10">10</button>
            <button class="fc-size-btn" data-size="all">All</button>
            <p id="fc-available"></p>
            <button id="fc-start"></button>
          </div>
          <div id="fc-session" class="hidden">
            <button id="fc-rewind" disabled></button>
            <span id="fc-progress"></span>
            <button id="fc-close"></button>
            <div id="fc-progress-bar-correct"></div>
            <div id="fc-progress-bar-wrong"></div>
            <div id="fc-chars"></div>
            <button id="fc-tts-word"></button>
            <div id="fc-answer" class="hidden">
              <div id="fc-pinyin"></div>
              <div id="fc-definition"></div>
            </div>
            <div id="fc-example" class="hidden"></div>
            <button id="fc-flip"></button>
            <div id="fc-judge">
              <button id="fc-wrong"></button>
              <button id="fc-right"></button>
            </div>
          </div>
          <div id="fc-summary" class="hidden">
            <p id="fc-score"></p>
            <div id="fc-wrong-list"></div>
            <button id="fc-again"></button>
            <button id="fc-back"></button>
          </div>
        </div>
      `;

      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      mockedUpdateResult.mockResolvedValue(undefined);
      await loadHub();

      // Run a one-card session to land on the summary screen.
      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();
      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;
      rightBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
      });

      // Click Back to List. Without .hub-tab buttons present, hub.ts must
      // leave #tab-flashcards alone -- the library shell handles tab swap.
      const backBtn = document.getElementById("fc-back") as HTMLButtonElement;
      backBtn.click();

      expect(document.getElementById("tab-flashcards")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("tab-vocab")!.classList.contains("hidden")).toBe(false);
    });
  });

  // ─── Library-facing refresh hooks ──────────────────────────────

  describe("refreshVocabView", () => {
    it("re-renders the vocab list from current storage", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      const mod = await loadHub();

      // List starts empty.
      expect(vocabList().querySelector(".vocab-empty")).not.toBeNull();

      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await mod.refreshVocabView();

      expect(vocabList().querySelectorAll(".vocab-row")).toHaveLength(3);
    });

    it("is a safe no-op when the vocab DOM is missing", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      const mod = await loadHub();

      // Wipe the DOM entirely.
      document.body.innerHTML = "";

      await expect(mod.refreshVocabView()).resolves.toBeUndefined();
    });
  });

  describe("refreshFlashcardsView", () => {
    it("updates the available word count when called", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      const mod = await loadHub();

      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await mod.refreshFlashcardsView();

      const available = document.getElementById("fc-available")!;
      // refreshFlashcardsView re-renders the live summary line; the
      // exact phrasing is asserted by the dedicated setup tests above.
      expect(available.textContent).toContain("Practice all 3 cards");
    });

    it("shows the setup screen and hides summary when called from summary state", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      mockedUpdateResult.mockResolvedValue(undefined);
      const mod = await loadHub();
      await switchToFlashcards();

      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();
      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;
      rightBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(false);
      });

      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await mod.refreshFlashcardsView();

      expect(document.getElementById("fc-setup")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-summary")!.classList.contains("hidden")).toBe(true);
    });

    it("preserves an active session when called mid-session", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedUpdateResult.mockResolvedValue(undefined);
      const mod = await loadHub();
      await switchToFlashcards();

      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();
      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });

      await mod.refreshFlashcardsView();

      // Session view stays mounted; setup is not re-shown.
      expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-setup")!.classList.contains("hidden")).toBe(true);
    });

    it("is a safe no-op when the flashcards DOM is missing", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      const mod = await loadHub();

      document.body.innerHTML = "";

      await expect(mod.refreshFlashcardsView()).resolves.toBeUndefined();
    });
  });

  // ─── Keyboard shortcuts ────────────────────────────────────────

  describe("keyboard shortcuts", () => {
    async function startSessionForKeyboard() {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedUpdateResult.mockResolvedValue(undefined);
      await loadHub();
      await switchToFlashcards();

      const startBtn = document.getElementById("fc-start") as HTMLButtonElement;
      startBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-session")!.classList.contains("hidden")).toBe(false);
      });
    }

    it("Space key flips the card", async () => {
      await startSessionForKeyboard();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));

      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);
    });

    it("Enter key flips the card", async () => {
      await startSessionForKeyboard();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);
    });

    it("ArrowRight answers right after flip", async () => {
      await startSessionForKeyboard();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), true);
      });
    });

    it("ArrowLeft answers wrong after flip", async () => {
      await startSessionForKeyboard();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), false);
      });
    });

    it("key '2' answers right after flip", async () => {
      await startSessionForKeyboard();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), true);
      });
    });

    it("key '1' answers wrong after flip", async () => {
      await startSessionForKeyboard();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));

      await vi.waitFor(() => {
        expect(mockedUpdateResult).toHaveBeenCalledWith(expect.any(String), false);
      });
    });
  });

  // ─── Export / Import ────────────────────────────────────────────

  describe("export/import", () => {
    it("export triggers download with correct JSON structure", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadHub();

      const origURL = globalThis.URL;
      const createObjectURL = vi.fn((_blob: Blob) => "blob:test");
      const revokeObjectURL = vi.fn();
      globalThis.URL = Object.assign(origURL, { createObjectURL, revokeObjectURL });

      const clickSpy = vi.fn();
      const origCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === "a") {
          vi.spyOn(el, "click").mockImplementation(clickSpy);
        }
        return el;
      });

      const exportBtn = document.getElementById("export-vocab") as HTMLButtonElement;
      exportBtn.click();

      await vi.waitFor(() => {
        expect(createObjectURL).toHaveBeenCalled();
      });

      const blob = createObjectURL.mock.calls[0][0] as Blob;
      const reader = new FileReader();
      const text = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(blob);
      });
      const parsed = JSON.parse(text);

      expect(parsed.version).toBe(1);
      expect(parsed.exportedAt).toBeDefined();
      expect(parsed.entries).toHaveLength(3);
      expect(parsed.entries[0].chars).toBeDefined();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalled();

      globalThis.URL = origURL;
    });

    it("export shows error when no words exist", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      const exportBtn = document.getElementById("export-vocab") as HTMLButtonElement;
      exportBtn.click();

      await vi.waitFor(() => {
        const status = document.getElementById("io-status")!;
        expect(status.textContent).toContain("Nothing to export");
      });
    });

    it("import button opens file picker", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      const importBtn = document.getElementById("import-vocab") as HTMLButtonElement;
      importBtn.click();

      expect(clickSpy).toHaveBeenCalled();
    });

    it("import calls importVocab, re-renders list, shows status", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      mockedImportVocab.mockResolvedValue({ added: 2, updated: 1 });
      await loadHub();

      const payload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: sampleVocab,
      });
      const file = new File([payload], "vocab.json", { type: "application/json" });

      const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        expect(mockedImportVocab).toHaveBeenCalled();
      });

      await vi.waitFor(() => {
        const status = document.getElementById("io-status")!;
        expect(status.textContent).toContain("2 new");
        expect(status.textContent).toContain("1 updated");
      });
    });

    it("import preserves saved examples (sentence + translation)", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      mockedImportVocab.mockResolvedValue({ added: 1, updated: 0 });
      await loadHub();

      const payload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: [
          {
            chars: "权威",
            pinyin: "quán wēi",
            definition: "authority",
            count: 6,
            firstSeen: 1777000000000,
            lastSeen: 1777200000000,
            wrongStreak: 0,
            totalReviews: 1,
            totalCorrect: 1,
            intervalDays: 1,
            nextDueAt: 1777300000000,
            examples: [
              {
                sentence: "他是这个领域的权威。",
                translation: "He is an authority in this field.",
                capturedAt: 1777100000000,
              },
              { sentence: "无效", capturedAt: 1777100000001 },
              { sentence: "", capturedAt: 1777100000002 },
              { foo: "bar" },
            ],
          },
        ],
      });
      const file = new File([payload], "vocab.json", { type: "application/json" });

      const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        expect(mockedImportVocab).toHaveBeenCalled();
      });

      const passed = mockedImportVocab.mock.calls[0][0] as Array<{
        chars: string;
        examples?: Array<{ sentence: string; translation?: string; capturedAt: number }>;
      }>;
      expect(passed).toHaveLength(1);
      expect(passed[0].examples).toEqual([
        {
          sentence: "他是这个领域的权威。",
          translation: "He is an authority in this field.",
          capturedAt: 1777100000000,
        },
        { sentence: "无效", capturedAt: 1777100000001 },
      ]);
    });

    it("import rejects invalid JSON gracefully", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      const file = new File(["not json"], "bad.json", { type: "application/json" });

      const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const status = document.getElementById("io-status")!;
        expect(status.textContent).toContain("Invalid JSON");
      });

      expect(mockedImportVocab).not.toHaveBeenCalled();
    });

    it("import rejects files missing required fields", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      const payload = JSON.stringify({
        version: 1,
        entries: [{ chars: "好" }, { foo: "bar" }],
      });
      const file = new File([payload], "bad.json", { type: "application/json" });

      const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const status = document.getElementById("io-status")!;
        expect(status.textContent).toContain("No valid entries");
      });

      expect(mockedImportVocab).not.toHaveBeenCalled();
    });

    it("import rejects files with no version field", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadHub();

      const payload = JSON.stringify({ entries: sampleVocab });
      const file = new File([payload], "bad.json", { type: "application/json" });

      const fileInput = document.getElementById("import-file-input") as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const status = document.getElementById("io-status")!;
        expect(status.textContent).toContain("Invalid vocab file format");
      });

      expect(mockedImportVocab).not.toHaveBeenCalled();
    });
  });
});
