/**
 * Tests for the popup Vocab tab UI (Vocab Step 3).
 *
 * Verifies vocab list rendering (populated and empty states), sorting
 * by frequency and recency, the Clear List confirmation flow, and tab
 * switching between Settings and Vocab panels.
 *
 * Each test builds a DOM scaffold matching popup.html's structure, mocks
 * the vocab-store module, then calls initPopup() directly.
 *
 * See: VOCAB_IMPLEMENTATION_GUIDE.md Step 3 "Test file".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VocabEntry } from "../../src/shared/types";

vi.mock("../../src/background/vocab-store", () => ({
  getAllVocab: vi.fn(),
  clearVocab: vi.fn(),
  removeWord: vi.fn(),
}));

import {
  getAllVocab,
  clearVocab,
  removeWord,
} from "../../src/background/vocab-store";

const mockedGetAllVocab = getAllVocab as ReturnType<typeof vi.fn>;
const mockedClearVocab = clearVocab as ReturnType<typeof vi.fn>;
const mockedRemoveWord = removeWord as ReturnType<typeof vi.fn>;

// ─── Sample data ─────────────────────────────────────────────────────

const sampleVocab: VocabEntry[] = [
  { chars: "银行", pinyin: "yín háng", definition: "bank", count: 5, firstSeen: 1000, lastSeen: 5000 },
  { chars: "工作", pinyin: "gōng zuò", definition: "to work", count: 3, firstSeen: 2000, lastSeen: 4000 },
  { chars: "学生", pinyin: "xué shēng", definition: "student", count: 7, firstSeen: 500, lastSeen: 3000 },
];

// ─── DOM scaffold ────────────────────────────────────────────────────

function buildPopupDOM(): void {
  document.body.innerHTML = `
    <h1>Pinyin Tool Extension</h1>

    <div class="tab-bar">
      <button class="tab-btn active" data-tab="settings">Settings</button>
      <button class="tab-btn" data-tab="vocab">Vocab</button>
    </div>

    <div id="tab-settings">
      <select id="provider">
        <option value="openai">OpenAI</option>
        <option value="gemini">Google Gemini</option>
        <option value="ollama">Ollama (local)</option>
        <option value="custom">Custom</option>
      </select>

      <div id="api-key-group">
        <div class="input-row">
          <input type="password" id="api-key" />
          <button id="toggle-key">Show</button>
        </div>
      </div>

      <input type="text" id="base-url" />

      <div class="input-row">
        <select id="model"></select>
        <button type="button" id="refresh-models" class="hidden">&#x21bb;</button>
      </div>
      <input type="text" id="custom-model" class="hidden" />

      <label><input type="radio" name="pinyin-style" value="toneMarks" /></label>
      <label><input type="radio" name="pinyin-style" value="toneNumbers" /></label>
      <label><input type="radio" name="pinyin-style" value="none" /></label>

      <input type="range" id="font-size" min="12" max="24" step="1" />
      <span id="font-size-label">16</span>

      <select id="theme">
        <option value="auto">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>

      <input type="checkbox" id="llm-enabled" />
      <input type="checkbox" id="tts-enabled" />

      <button id="save-btn">Save Settings</button>
      <div id="status"></div>
    </div>

    <button id="ocr-btn">Select text from image</button>
    <button id="reader-btn">Open Reader</button>

    <div id="tab-vocab" class="hidden">
      <div class="vocab-controls">
        <select id="vocab-sort">
          <option value="frequency">Most frequent</option>
          <option value="recent">Most recent</option>
        </select>
        <button type="button" id="clear-vocab">Clear List</button>
      </div>
      <div id="vocab-list"></div>
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function loadPopup() {
  vi.resetModules();

  vi.doMock("../../src/background/vocab-store", () => ({
    getAllVocab: mockedGetAllVocab,
    clearVocab: mockedClearVocab,
    removeWord: mockedRemoveWord,
  }));

  const mod = await import("../../src/popup/popup");
  await mod.initPopup();
  return mod;
}

function vocabTabBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="vocab"]')!;
}

function settingsTabBtn(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="settings"]')!;
}

function tabSettings(): HTMLDivElement {
  return document.getElementById("tab-settings") as HTMLDivElement;
}

function tabVocab(): HTMLDivElement {
  return document.getElementById("tab-vocab") as HTMLDivElement;
}

function vocabList(): HTMLDivElement {
  return document.getElementById("vocab-list") as HTMLDivElement;
}

function vocabSort(): HTMLSelectElement {
  return document.getElementById("vocab-sort") as HTMLSelectElement;
}

function clearVocabBtn(): HTMLButtonElement {
  return document.getElementById("clear-vocab") as HTMLButtonElement;
}

async function switchToVocabTab(): Promise<void> {
  vocabTabBtn().click();
  await vi.waitFor(() => {
    expect(tabVocab().classList.contains("hidden")).toBe(false);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("vocab tab", () => {
  beforeEach(() => {
    buildPopupDOM();
    chrome.storage.sync.get.mockImplementation(() => Promise.resolve({}));
    chrome.storage.sync.set.mockImplementation(() => Promise.resolve());
    mockedGetAllVocab.mockReset();
    mockedClearVocab.mockReset();
    mockedRemoveWord.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // ─── Rendering ────────────────────────────────────────────────

  describe("rendering", () => {
    it("displays all vocab entries", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadPopup();
      await switchToVocabTab();

      const rows = vocabList().querySelectorAll(".vocab-row");
      expect(rows).toHaveLength(3);
    });

    it("shows empty state when no words recorded", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadPopup();
      await switchToVocabTab();

      const empty = vocabList().querySelector(".vocab-empty");
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toContain("No words recorded");
    });

    it("displays chars, pinyin, definition, and count in each row", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadPopup();
      await switchToVocabTab();

      const row = vocabList().querySelector(".vocab-row")!;
      expect(row.querySelector(".vocab-chars")!.textContent).toBe("银行");
      expect(row.querySelector(".vocab-pinyin")!.textContent).toBe("yín háng");
      expect(row.querySelector(".vocab-def")!.textContent).toBe("bank");
      expect(row.querySelector(".vocab-count")!.textContent).toBe("5");
    });
  });

  // ─── Sorting ──────────────────────────────────────────────────

  describe("sorting", () => {
    it("sorts by frequency descending by default", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadPopup();
      await switchToVocabTab();

      const rows = vocabList().querySelectorAll(".vocab-row");
      const chars = Array.from(rows).map(
        (r) => r.querySelector(".vocab-chars")!.textContent,
      );
      expect(chars).toEqual(["学生", "银行", "工作"]);
    });

    it("sorts by most recent when selected", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadPopup();
      await switchToVocabTab();

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
  });

  // ─── Clear button ─────────────────────────────────────────────

  describe("clear button", () => {
    it("calls clearVocab and re-renders on confirm", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedClearVocab.mockResolvedValue(undefined);
      vi.stubGlobal("confirm", vi.fn(() => true));

      await loadPopup();
      await switchToVocabTab();

      mockedGetAllVocab.mockResolvedValue([]);
      clearVocabBtn().click();

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

      await loadPopup();
      await switchToVocabTab();
      clearVocabBtn().click();

      expect(mockedClearVocab).not.toHaveBeenCalled();
    });
  });

  // ─── Tab switching ────────────────────────────────────────────

  describe("tab switching", () => {
    it("shows settings tab by default", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadPopup();

      expect(tabSettings().classList.contains("hidden")).toBe(false);
      expect(tabVocab().classList.contains("hidden")).toBe(true);
    });

    it("switches to vocab tab on click", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadPopup();

      vocabTabBtn().click();

      expect(tabSettings().classList.contains("hidden")).toBe(true);
      expect(tabVocab().classList.contains("hidden")).toBe(false);
      expect(vocabTabBtn().classList.contains("active")).toBe(true);
      expect(settingsTabBtn().classList.contains("active")).toBe(false);
    });

    it("switches back to settings tab", async () => {
      mockedGetAllVocab.mockResolvedValue([]);
      await loadPopup();

      vocabTabBtn().click();
      settingsTabBtn().click();

      expect(tabSettings().classList.contains("hidden")).toBe(false);
      expect(tabVocab().classList.contains("hidden")).toBe(true);
      expect(settingsTabBtn().classList.contains("active")).toBe(true);
      expect(vocabTabBtn().classList.contains("active")).toBe(false);
    });
  });

  // ─── Vocab card ──────────────────────────────────────────────

  describe("vocab card", () => {
    it("shows floating card overlay when a vocab row is clicked", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadPopup();
      await switchToVocabTab();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const overlay = document.querySelector(".vocab-card-overlay");
      expect(overlay).not.toBeNull();
    });

    it("card displays correct chars, pinyin, and definition", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadPopup();
      await switchToVocabTab();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const card = document.querySelector(".vocab-card")!;
      expect(card.querySelector(".vocab-card-chars")!.textContent).toBe("银行");
      expect(card.querySelector(".vocab-card-pinyin")!.textContent).toBe("yín háng");
      expect(card.querySelector(".vocab-card-def")!.textContent).toBe("bank");
    });

    it("clicking delete calls removeWord and re-renders list", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      mockedRemoveWord.mockResolvedValue(undefined);
      await loadPopup();
      await switchToVocabTab();

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

      await vi.waitFor(() => {
        const rows = vocabList().querySelectorAll(".vocab-row");
        expect(rows).toHaveLength(2);
      });
    });

    it("clicking overlay backdrop dismisses the card", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadPopup();
      await switchToVocabTab();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const overlay = document.querySelector(".vocab-card-overlay") as HTMLDivElement;
      expect(overlay).not.toBeNull();

      overlay.click();
      expect(document.querySelector(".vocab-card-overlay")).toBeNull();
    });

    it("clicking close button dismisses the card", async () => {
      mockedGetAllVocab.mockResolvedValue([sampleVocab[0]]);
      await loadPopup();
      await switchToVocabTab();

      const row = vocabList().querySelector(".vocab-row") as HTMLDivElement;
      row.click();

      const closeBtn = document.querySelector(".vocab-card-close") as HTMLButtonElement;
      closeBtn.click();

      expect(document.querySelector(".vocab-card-overlay")).toBeNull();
    });

    it("only one card is shown at a time", async () => {
      mockedGetAllVocab.mockResolvedValue([...sampleVocab]);
      await loadPopup();
      await switchToVocabTab();

      const rows = vocabList().querySelectorAll(".vocab-row");
      (rows[0] as HTMLDivElement).click();
      (rows[1] as HTMLDivElement).click();

      const overlays = document.querySelectorAll(".vocab-card-overlay");
      expect(overlays).toHaveLength(1);
    });
  });
});
