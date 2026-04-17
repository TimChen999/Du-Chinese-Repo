/**
 * Hub page logic — vocab list, flashcard sessions, theme, reader launch.
 *
 * Exports initHub() for testability (same pattern as popup's initPopup()).
 *
 * See: VOCAB_HUB_SPEC.md for the full feature specification.
 */

import { getAllVocab, clearVocab, removeWord, updateFlashcardResult, importVocab } from "../background/vocab-store";
import { FLASHCARD_WRONG_POOL_RATIO } from "../shared/constants";
import type { VocabEntry } from "../shared/types";

// ─── Types ───────────────────────────────────────────────────────────

interface FlashcardSession {
  cards: VocabEntry[];
  currentIndex: number;
  results: ("right" | "wrong")[];
  isFlipped: boolean;
}

// ─── DOM References ──────────────────────────────────────────────────

function getElements() {
  return {
    tabButtons: document.querySelectorAll<HTMLButtonElement>(".hub-tab"),
    tabVocab: document.getElementById("tab-vocab") as HTMLDivElement,
    tabFlashcards: document.getElementById("tab-flashcards") as HTMLDivElement,
    vocabSort: document.getElementById("vocab-sort") as HTMLSelectElement,
    vocabList: document.getElementById("vocab-list") as HTMLDivElement,
    clearVocabBtn: document.getElementById("clear-vocab") as HTMLButtonElement,
    fcSetup: document.getElementById("fc-setup") as HTMLDivElement,
    fcSession: document.getElementById("fc-session") as HTMLDivElement,
    fcSummary: document.getElementById("fc-summary") as HTMLDivElement,
    fcAvailable: document.getElementById("fc-available") as HTMLParagraphElement,
    fcStart: document.getElementById("fc-start") as HTMLButtonElement,
    fcSizeBtns: document.querySelectorAll<HTMLButtonElement>(".fc-size-btn"),
    fcProgress: document.getElementById("fc-progress") as HTMLSpanElement,
    fcClose: document.getElementById("fc-close") as HTMLButtonElement,
    fcChars: document.getElementById("fc-chars") as HTMLDivElement,
    fcAnswer: document.getElementById("fc-answer") as HTMLDivElement,
    fcPinyin: document.getElementById("fc-pinyin") as HTMLDivElement,
    fcDefinition: document.getElementById("fc-definition") as HTMLDivElement,
    fcFlip: document.getElementById("fc-flip") as HTMLButtonElement,
    fcJudge: document.getElementById("fc-judge") as HTMLDivElement,
    fcWrong: document.getElementById("fc-wrong") as HTMLButtonElement,
    fcRight: document.getElementById("fc-right") as HTMLButtonElement,
    fcScore: document.getElementById("fc-score") as HTMLParagraphElement,
    fcWrongList: document.getElementById("fc-wrong-list") as HTMLDivElement,
    fcAgain: document.getElementById("fc-again") as HTMLButtonElement,
    fcBack: document.getElementById("fc-back") as HTMLButtonElement,
    exportBtn: document.getElementById("export-vocab") as HTMLButtonElement,
    importBtn: document.getElementById("import-vocab") as HTMLButtonElement,
    importFileInput: document.getElementById("import-file-input") as HTMLInputElement,
    ioStatus: document.getElementById("io-status") as HTMLSpanElement,
  };
}

// ─── Session Algorithm ───────────────────────────────────────────────

/**
 * Builds a flashcard session of size N from the vocab list.
 * Prioritizes words with wrongStreak > 0 (up to 40% of the session),
 * fills the rest with shuffled normal-pool words, then shuffles the
 * combined list.
 */
export function buildSession(vocab: VocabEntry[], size: number): VocabEntry[] {
  if (vocab.length === 0) return [];
  const n = Math.min(size, vocab.length);

  const wrongPool = vocab
    .filter((e) => e.wrongStreak > 0)
    .sort((a, b) => b.wrongStreak - a.wrongStreak);

  const normalPool = shuffleArray(
    vocab.filter((e) => e.wrongStreak === 0),
  );

  const wrongSlots = Math.min(
    Math.ceil(n * FLASHCARD_WRONG_POOL_RATIO),
    wrongPool.length,
  );
  const normalSlots = Math.min(n - wrongSlots, normalPool.length);
  const extraWrong = Math.min(n - wrongSlots - normalSlots, wrongPool.length - wrongSlots);
  const picked: VocabEntry[] = [
    ...wrongPool.slice(0, wrongSlots + extraWrong),
    ...normalPool.slice(0, normalSlots),
  ];

  return shuffleArray(picked);
}

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ─── Vocab Card Overlay ──────────────────────────────────────────────

function dismissVocabCard(): void {
  document.querySelector(".vocab-card-overlay")?.remove();
}

function showVocabCard(
  entry: VocabEntry,
  els: ReturnType<typeof getElements>,
): void {
  dismissVocabCard();

  const overlay = document.createElement("div");
  overlay.className = "vocab-card-overlay";

  const card = document.createElement("div");
  card.className = "vocab-card";

  const closeBtn = document.createElement("button");
  closeBtn.className = "vocab-card-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", dismissVocabCard);

  const chars = document.createElement("div");
  chars.className = "vocab-card-chars";
  chars.textContent = entry.chars;

  const pinyin = document.createElement("div");
  pinyin.className = "vocab-card-pinyin";
  pinyin.textContent = entry.pinyin;

  const def = document.createElement("div");
  def.className = "vocab-card-def";
  def.textContent = entry.definition;

  const meta = document.createElement("div");
  meta.className = "vocab-card-meta";
  const lastSeen = new Date(entry.lastSeen).toLocaleDateString();
  let metaText = `Seen ${entry.count} time${entry.count !== 1 ? "s" : ""} \u00b7 Last: ${lastSeen}`;
  if (entry.totalReviews > 0) {
    const accuracy = Math.round((entry.totalCorrect / entry.totalReviews) * 100);
    metaText += `\nReviews: ${entry.totalReviews} \u00b7 Accuracy: ${accuracy}%`;
  }
  meta.textContent = metaText;
  meta.style.whiteSpace = "pre-line";

  const actions = document.createElement("div");
  actions.className = "vocab-card-actions";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "vocab-card-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    await removeWord(entry.chars);
    dismissVocabCard();
    renderVocabList(els);
  });

  actions.appendChild(deleteBtn);
  card.append(closeBtn, chars, pinyin, def, meta, actions);
  overlay.appendChild(card);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissVocabCard();
  });

  document.body.appendChild(overlay);
}

// ─── Vocab List Rendering ────────────────────────────────────────────

async function renderVocabList(els: ReturnType<typeof getElements>): Promise<void> {
  const entries = await getAllVocab();
  const sortBy = els.vocabSort.value;

  if (sortBy === "recent") {
    entries.sort((a, b) => b.lastSeen - a.lastSeen);
  } else if (sortBy === "alpha") {
    entries.sort((a, b) => a.chars.localeCompare(b.chars, "zh"));
  } else {
    entries.sort((a, b) => b.count - a.count);
  }

  els.vocabList.innerHTML = "";

  if (entries.length === 0) {
    els.vocabList.innerHTML =
      '<div class="vocab-empty">No words saved yet.\nSelect Chinese text on any page to start building your list.</div>';
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "vocab-row";

    const primary = document.createElement("div");
    primary.className = "vocab-row-primary";
    primary.innerHTML =
      `<span class="vocab-chars">${entry.chars}</span>` +
      `<span class="vocab-pinyin">${entry.pinyin}</span>` +
      `<span class="vocab-def">${entry.definition}</span>`;

    const metaDiv = document.createElement("div");
    metaDiv.className = "vocab-row-meta";
    const lastSeen = new Date(entry.lastSeen).toLocaleDateString();
    let metaText = `Seen ${entry.count} time${entry.count !== 1 ? "s" : ""} \u00b7 Last seen ${lastSeen}`;
    if (entry.totalReviews > 0) {
      const accuracy = Math.round((entry.totalCorrect / entry.totalReviews) * 100);
      metaText += ` \u00b7 Reviews: ${entry.totalReviews} \u00b7 Accuracy: ${accuracy}%`;
    }
    metaDiv.textContent = metaText;

    row.appendChild(primary);
    row.appendChild(metaDiv);
    row.addEventListener("click", () => showVocabCard(entry, els));
    els.vocabList.appendChild(row);
  }
}

// ─── Flashcard Logic ─────────────────────────────────────────────────

let session: FlashcardSession | null = null;
let selectedSize: number | "all" = 10;
let lastSelectedSize: number | "all" = 10;

function showCard(els: ReturnType<typeof getElements>): void {
  if (!session) return;
  const card = session.cards[session.currentIndex];
  els.fcProgress.textContent = `Card ${session.currentIndex + 1} of ${session.cards.length}`;
  els.fcChars.textContent = card.chars;
  els.fcPinyin.textContent = card.pinyin;
  els.fcDefinition.textContent = card.definition;
  els.fcAnswer.classList.add("hidden");
  els.fcFlip.classList.remove("hidden");
  els.fcJudge.classList.add("hidden");
  session.isFlipped = false;
}

function flipCard(els: ReturnType<typeof getElements>): void {
  if (!session || session.isFlipped) return;
  session.isFlipped = true;
  els.fcAnswer.classList.remove("hidden");
  els.fcFlip.classList.add("hidden");
  els.fcJudge.classList.remove("hidden");
}

async function answerCard(
  correct: boolean,
  els: ReturnType<typeof getElements>,
): Promise<void> {
  if (!session) return;
  const card = session.cards[session.currentIndex];
  session.results.push(correct ? "right" : "wrong");
  await updateFlashcardResult(card.chars, correct);

  if (session.currentIndex + 1 < session.cards.length) {
    session.currentIndex++;
    showCard(els);
  } else {
    showSummary(els);
  }
}

function showSummary(els: ReturnType<typeof getElements>): void {
  if (!session) return;
  els.fcSession.classList.add("hidden");
  els.fcSummary.classList.remove("hidden");

  const correct = session.results.filter((r) => r === "right").length;
  const total = session.results.length;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
  els.fcScore.textContent = `${correct} / ${total} correct (${pct}%)`;

  els.fcWrongList.innerHTML = "";
  const wrongCards = session.cards.filter((_, i) => session!.results[i] === "wrong");

  if (wrongCards.length === 0) {
    const congrats = document.createElement("p");
    congrats.className = "fc-congrats";
    congrats.textContent = "You got every word right!";
    els.fcWrongList.appendChild(congrats);
  } else {
    const heading = document.createElement("h3");
    heading.textContent = "Words to review:";
    els.fcWrongList.appendChild(heading);

    for (const card of wrongCards) {
      const item = document.createElement("div");
      item.className = "fc-wrong-item";
      item.innerHTML =
        `<span class="fc-wrong-item-chars">${card.chars}</span>` +
        `<span class="fc-wrong-item-pinyin">${card.pinyin}</span>` +
        `<span class="fc-wrong-item-def">\u2014 ${card.definition}</span>`;
      els.fcWrongList.appendChild(item);
    }
  }
}

async function startSession(els: ReturnType<typeof getElements>): Promise<void> {
  const vocab = await getAllVocab();
  if (vocab.length === 0) return;

  const size = selectedSize === "all" ? vocab.length : selectedSize;
  const cards = buildSession(vocab, size);

  session = {
    cards,
    currentIndex: 0,
    results: [],
    isFlipped: false,
  };

  lastSelectedSize = selectedSize;
  els.fcSetup.classList.add("hidden");
  els.fcSummary.classList.add("hidden");
  els.fcSession.classList.remove("hidden");
  showCard(els);
}

async function showSetup(els: ReturnType<typeof getElements>): Promise<void> {
  const vocab = await getAllVocab();
  els.fcAvailable.textContent = `${vocab.length} word${vocab.length !== 1 ? "s" : ""} available`;

  if (vocab.length === 0) {
    els.fcStart.disabled = true;
    els.fcAvailable.textContent = "No words saved yet. Select Chinese text on any page to start building your list.";
  } else {
    els.fcStart.disabled = false;
  }

  if (vocab.length < 10) {
    selectedSize = "all";
  }

  els.fcSizeBtns.forEach((btn) => {
    const val = btn.dataset.size!;
    const isSelected = val === String(selectedSize);
    btn.classList.toggle("selected", isSelected);
  });

  els.fcSession.classList.add("hidden");
  els.fcSummary.classList.add("hidden");
  els.fcSetup.classList.remove("hidden");
}

// ─── Theme ───────────────────────────────────────────────────────────

async function applyTheme(): Promise<void> {
  const stored = await chrome.storage.sync.get("theme");
  const theme = stored.theme ?? "auto";
  document.body.setAttribute("data-theme", theme);
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────

function setupKeyboard(els: ReturnType<typeof getElements>): void {
  document.addEventListener("keydown", (e) => {
    if (!session) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (!session.isFlipped) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        flipCard(els);
      }
    } else {
      if (e.key === "ArrowLeft" || e.key === "1") {
        e.preventDefault();
        answerCard(false, els);
      } else if (e.key === "ArrowRight" || e.key === "2") {
        e.preventDefault();
        answerCard(true, els);
      }
    }
  });
}

// ─── Export / Import ─────────────────────────────────────────────────

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function showStatus(
  els: ReturnType<typeof getElements>,
  message: string,
  kind: "success" | "error",
): void {
  if (statusTimer) clearTimeout(statusTimer);
  els.ioStatus.textContent = message;
  els.ioStatus.className = `io-status ${kind}`;
  statusTimer = setTimeout(() => {
    els.ioStatus.textContent = "";
    els.ioStatus.className = "io-status";
  }, 3000);
}

async function handleExport(els: ReturnType<typeof getElements>): Promise<void> {
  const entries = await getAllVocab();
  if (entries.length === 0) {
    showStatus(els, "Nothing to export.", "error");
    return;
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pinyin-tool-vocab-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showStatus(els, `Exported ${entries.length} words.`, "success");
}

function isValidEntry(obj: unknown): obj is { chars: string; pinyin: string; definition: string } {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.chars === "string" && typeof o.pinyin === "string" && typeof o.definition === "string";
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function handleImport(
  file: File,
  els: ReturnType<typeof getElements>,
): Promise<void> {
  let text: string;
  try {
    text = await readFileAsText(file);
  } catch {
    showStatus(els, "Failed to read file.", "error");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    showStatus(els, "Invalid JSON file.", "error");
    return;
  }

  const data = parsed as Record<string, unknown>;
  if (typeof data.version !== "number" || !Array.isArray(data.entries)) {
    showStatus(els, "Invalid vocab file format.", "error");
    return;
  }

  const valid = (data.entries as unknown[]).filter(isValidEntry);
  if (valid.length === 0) {
    showStatus(els, "No valid entries found.", "error");
    return;
  }

  const entries = valid.map((e) => {
    const raw = e as Record<string, unknown>;
    return {
      chars: raw.chars as string,
      pinyin: raw.pinyin as string,
      definition: raw.definition as string,
      count: typeof raw.count === "number" ? raw.count : 1,
      firstSeen: typeof raw.firstSeen === "number" ? raw.firstSeen : Date.now(),
      lastSeen: typeof raw.lastSeen === "number" ? raw.lastSeen : Date.now(),
      wrongStreak: typeof raw.wrongStreak === "number" ? raw.wrongStreak : 0,
      totalReviews: typeof raw.totalReviews === "number" ? raw.totalReviews : 0,
      totalCorrect: typeof raw.totalCorrect === "number" ? raw.totalCorrect : 0,
    };
  });

  const result = await importVocab(entries);
  showStatus(els, `Imported ${result.added + result.updated} words (${result.added} new, ${result.updated} updated).`, "success");
  await renderVocabList(els);
}

// ─── Initialization ──────────────────────────────────────────────────

export async function initHub(): Promise<void> {
  const els = getElements();
  await applyTheme();

  // Tab switching
  els.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const tab = btn.dataset.tab;
      els.tabVocab.classList.toggle("hidden", tab !== "vocab");
      els.tabFlashcards.classList.toggle("hidden", tab !== "flashcards");

      if (tab === "vocab") {
        renderVocabList(els);
      } else if (tab === "flashcards") {
        session = null;
        showSetup(els);
      }
    });
  });

  // Vocab controls
  els.vocabSort.addEventListener("change", () => renderVocabList(els));
  els.clearVocabBtn.addEventListener("click", async () => {
    if (confirm("Clear all recorded words?")) {
      await clearVocab();
      renderVocabList(els);
    }
  });

  // Export / Import
  els.exportBtn.addEventListener("click", () => handleExport(els));
  els.importBtn.addEventListener("click", () => els.importFileInput.click());
  els.importFileInput.addEventListener("change", async () => {
    const file = els.importFileInput.files?.[0];
    if (file) {
      await handleImport(file, els);
      els.importFileInput.value = "";
    }
  });

  // Flashcard size selection
  els.fcSizeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.size!;
      selectedSize = val === "all" ? "all" : parseInt(val, 10);
      els.fcSizeBtns.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });

  // Flashcard controls
  els.fcStart.addEventListener("click", () => startSession(els));
  els.fcFlip.addEventListener("click", () => flipCard(els));
  els.fcWrong.addEventListener("click", () => answerCard(false, els));
  els.fcRight.addEventListener("click", () => answerCard(true, els));
  els.fcClose.addEventListener("click", () => showSummary(els));
  els.fcAgain.addEventListener("click", () => {
    selectedSize = lastSelectedSize;
    showSetup(els);
  });
  els.fcBack.addEventListener("click", () => {
    session = null;
    // Only swap the inner #tab-vocab/#tab-flashcards visibility in
    // standalone hub mode. When the hub is mounted inside the library
    // shell, those inner divs live inside #library-pane-vocab and
    // #library-pane-flashcards respectively and must stay visible --
    // hiding them would blank out the corresponding library pane on
    // the next visit. The library binds its own fc-back listener that
    // calls activateLibraryTab("vocab") + refreshVocabView().
    if (els.tabButtons.length > 0) {
      els.tabButtons.forEach((b) => b.classList.remove("active"));
      const vocabTab = document.querySelector<HTMLButtonElement>('.hub-tab[data-tab="vocab"]');
      vocabTab?.classList.add("active");
      els.tabFlashcards.classList.add("hidden");
      els.tabVocab.classList.remove("hidden");
      renderVocabList(els);
    }
  });

  // Keyboard shortcuts
  setupKeyboard(els);

  // Initial render
  await renderVocabList(els);
}

// initHub() is invoked by the library shell (src/library/library.ts);
// the hub no longer ships as a standalone page.

// ─── Public refresh hooks (used by the library shell) ─────────────

/**
 * Re-renders the vocab list using the live storage contents. Safe to
 * call repeatedly. Used by the library shell when the user activates
 * the Vocab tab so the list always reflects words added since the
 * last visit (e.g. while reading).
 */
export async function refreshVocabView(): Promise<void> {
  const els = getElements();
  if (!els.vocabList) return;
  await renderVocabList(els);
}

/**
 * Refreshes the flashcards setup screen (word count, button state).
 * Used by the library shell when the user activates the Flashcards
 * tab. Skipped when an active session card is on screen so that
 * navigating away to Vocab and back does not interrupt the user.
 */
export async function refreshFlashcardsView(): Promise<void> {
  const els = getElements();
  if (!els.fcSetup) return;
  if (els.fcSession && !els.fcSession.classList.contains("hidden")) {
    return;
  }
  session = null;
  await showSetup(els);
}
