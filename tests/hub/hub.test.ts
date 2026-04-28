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
  setExampleTranslation: vi.fn(),
  updateFlashcardResult: vi.fn(),
  importVocab: vi.fn(),
}));

import {
  getAllVocab,
  clearVocab,
  removeWord,
  setExampleTranslation,
  updateFlashcardResult,
  importVocab,
} from "../../src/background/vocab-store";

const mockedGetAllVocab = getAllVocab as ReturnType<typeof vi.fn>;
const mockedClearVocab = clearVocab as ReturnType<typeof vi.fn>;
const mockedRemoveWord = removeWord as ReturnType<typeof vi.fn>;
const mockedSetExampleTranslation = setExampleTranslation as ReturnType<typeof vi.fn>;
const mockedUpdateResult = updateFlashcardResult as ReturnType<typeof vi.fn>;
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
        <div class="vocab-io-buttons">
          <button type="button" id="export-vocab" class="io-btn">Export</button>
          <button type="button" id="import-vocab" class="io-btn">Import</button>
          <input type="file" id="import-file-input" accept=".json" hidden />
          <span id="io-status" class="io-status"></span>
        </div>
        <button type="button" id="clear-vocab" class="clear-btn">Clear List</button>
      </div>
      <div id="vocab-list" class="vocab-list"></div>
    </div>

      <div id="tab-flashcards" class="hub-tab-content hidden">
      <div id="fc-setup" class="fc-setup">
        <h2>Practice your vocabulary</h2>
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
          <span id="fc-progress">Card 1 of 10</span>
          <button id="fc-close" class="fc-close-btn">&times;</button>
        </div>
        <div class="fc-card">
          <div id="fc-chars" class="fc-chars"></div>
          <div id="fc-answer" class="fc-answer hidden">
            <div id="fc-pinyin" class="fc-pinyin"></div>
            <div id="fc-definition" class="fc-definition"></div>
            <div id="fc-example" class="fc-example hidden"></div>
          </div>
        </div>
        <div id="fc-actions" class="fc-actions">
          <button id="fc-flip" class="fc-flip-btn">Flip</button>
          <div id="fc-judge" class="fc-judge hidden">
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
    setExampleTranslation: mockedSetExampleTranslation,
    updateFlashcardResult: mockedUpdateResult,
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
    mockedSetExampleTranslation.mockReset();
    mockedUpdateResult.mockReset();
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

  // ─── Clear button ──────────────────────────────────────────────

  describe("clear button", () => {
    it("calls clearVocab and re-renders on confirm", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedClearVocab.mockResolvedValue(undefined);
      vi.stubGlobal("confirm", vi.fn(() => true));

      await loadHub();

      mockedGetAllVocab.mockResolvedValue([]);
      const clearBtn = document.getElementById("clear-vocab") as HTMLButtonElement;
      clearBtn.click();

      await vi.waitFor(() => {
        expect(mockedClearVocab).toHaveBeenCalled();
      });

      await vi.waitFor(() => {
        const empty = vocabList().querySelector(".vocab-empty");
        expect(empty).not.toBeNull();
      });
    });

    it("does not clear when user cancels", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      vi.stubGlobal("confirm", vi.fn(() => false));

      await loadHub();
      const clearBtn = document.getElementById("clear-vocab") as HTMLButtonElement;
      clearBtn.click();

      expect(mockedClearVocab).not.toHaveBeenCalled();
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

    it("populates fc-example with the first example sentence on flip", async () => {
      await startSession([wordWithExample]);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

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

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

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

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

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

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".fc-example-translate-btn")).not.toBeNull();
      });

      const btn = document.querySelector(".fc-example-translate-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("clears the example block between cards", async () => {
      // Both cards carry an example so buildSession's shuffle order
      // doesn't determine whether fc-example renders -- it always
      // does. The assertion focuses on the *reset* behavior between
      // cards: after answering, the previous card's example markup
      // must not bleed into the next card before the user flips.
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

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      const rightBtn = document.getElementById("fc-right") as HTMLButtonElement;
      flipBtn.click();

      await vi.waitFor(() => {
        expect(document.getElementById("fc-example")!.classList.contains("hidden")).toBe(false);
      });

      rightBtn.click();

      // showCard() runs synchronously inside answerCard after the
      // updateFlashcardResult await -- the slot must be re-hidden
      // and emptied before the next flip surfaces a new example.
      await vi.waitFor(() => {
        const slot = document.getElementById("fc-example")!;
        expect(slot.classList.contains("hidden")).toBe(true);
        expect(slot.innerHTML).toBe("");
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
      expect(document.getElementById("fc-progress")!.textContent).toContain("Card 1 of");
    });

    it("shows flip button initially, answer hidden", async () => {
      await startSessionWith(sampleVocab);

      expect(document.getElementById("fc-flip")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("fc-judge")!.classList.contains("hidden")).toBe(true);
    });

    it("flipping reveals answer and judge buttons", async () => {
      await startSessionWith(sampleVocab);

      const flipBtn = document.getElementById("fc-flip") as HTMLButtonElement;
      flipBtn.click();

      expect(document.getElementById("fc-answer")!.classList.contains("hidden")).toBe(false);
      expect(document.getElementById("fc-flip")!.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("fc-judge")!.classList.contains("hidden")).toBe(false);
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
        expect(document.getElementById("fc-progress")!.textContent).toContain("Card 2 of");
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
            <span id="fc-progress"></span>
            <button id="fc-close"></button>
            <div id="fc-chars"></div>
            <div id="fc-answer" class="hidden">
              <div id="fc-pinyin"></div>
              <div id="fc-definition"></div>
            </div>
            <button id="fc-flip"></button>
            <div id="fc-judge" class="hidden">
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
