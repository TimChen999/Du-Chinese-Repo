/**
 * Hub page logic — vocab list, flashcard sessions, theme, reader launch.
 *
 * Exports initHub() for testability (same pattern as popup's initPopup()).
 *
 * See: VOCAB_HUB_SPEC.md for the full feature specification.
 */

import {
  getAllVocab,
  clearVocab,
  removeWord,
  setExampleTranslation,
  updateFlashcardResult,
  importVocab,
} from "../background/vocab-store";
import { convertToPinyin } from "../background/pinyin-service";
import {
  DEFAULT_SETTINGS,
} from "../shared/constants";
import { translateExampleSentence } from "../shared/translate-example";
import {
  bucketLabel,
  getVocabBucket,
  isDue,
  type VocabBucket,
} from "../shared/srs";
import type { ExtensionSettings, PinyinStyle, VocabEntry, VocabExample, WordData } from "../shared/types";
import { resolveEffectiveTheme } from "../shared/theme";
import type { ReaderSettings } from "../reader/reader-types";

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
    vocabBucketSummary: document.getElementById("vocab-bucket-summary") as HTMLDivElement | null,
    vocabList: document.getElementById("vocab-list") as HTMLDivElement,
    clearVocabBtn: document.getElementById("clear-vocab") as HTMLButtonElement,
    fcSetup: document.getElementById("fc-setup") as HTMLDivElement,
    fcSession: document.getElementById("fc-session") as HTMLDivElement,
    fcSummary: document.getElementById("fc-summary") as HTMLDivElement,
    fcAvailable: document.getElementById("fc-available") as HTMLParagraphElement,
    fcBucketSummary: document.getElementById("fc-bucket-summary") as HTMLDivElement | null,
    fcStart: document.getElementById("fc-start") as HTMLButtonElement,
    fcSizeBtns: document.querySelectorAll<HTMLButtonElement>(".fc-size-btn"),
    fcProgress: document.getElementById("fc-progress") as HTMLSpanElement,
    fcClose: document.getElementById("fc-close") as HTMLButtonElement,
    fcChars: document.getElementById("fc-chars") as HTMLDivElement,
    fcAnswer: document.getElementById("fc-answer") as HTMLDivElement,
    fcPinyin: document.getElementById("fc-pinyin") as HTMLDivElement,
    fcDefinition: document.getElementById("fc-definition") as HTMLDivElement,
    fcExample: document.getElementById("fc-example") as HTMLDivElement | null,
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
 * Builds a flashcard session of size N from the vocab list using the
 * SRS scheduler in shared/srs.ts. Cards that are due now (interval
 * elapsed, never reviewed, or last answer wrong) come first, oldest
 * due first with wrong-streak as a tiebreaker so words the user is
 * actively struggling with surface ahead of plain not-yet-reviewed
 * cards. When the due pool is smaller than N, the remaining slots are
 * filled with the soonest-upcoming not-due cards so the user can
 * always start a session of the requested size. The final list is
 * shuffled so the user doesn't see a perfectly sorted order, but the
 * mix of due vs. not-due is preserved.
 */
export function buildSession(
  vocab: VocabEntry[],
  size: number,
  now: number = Date.now(),
): VocabEntry[] {
  if (vocab.length === 0) return [];
  const n = Math.min(size, vocab.length);

  const due: VocabEntry[] = [];
  const notDue: VocabEntry[] = [];
  for (const entry of vocab) {
    if (isDue(entry, now)) due.push(entry);
    else notDue.push(entry);
  }

  due.sort((a, b) => {
    if (a.wrongStreak !== b.wrongStreak) return b.wrongStreak - a.wrongStreak;
    return a.nextDueAt - b.nextDueAt;
  });
  notDue.sort((a, b) => a.nextDueAt - b.nextDueAt);

  const picked = due.slice(0, n);
  if (picked.length < n) {
    picked.push(...notDue.slice(0, n - picked.length));
  }

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

/**
 * Reads the user's effective extension settings, layering stored
 * values over DEFAULT_SETTINGS. Used by the example-rendering paths
 * (vocab card + flashcard) to derive `pinyinStyle` for ruby
 * rendering. AI Translations no longer gates anything here -- the
 * Translate button uses Chrome's on-device Translator API and is
 * always enabled.
 */
async function getEffectiveSettings(): Promise<ExtensionSettings> {
  const stored = (await chrome.storage.sync.get(null)) as Partial<ExtensionSettings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Re-renders the currently open vocab card with the latest data from
 * storage. Used after example mutations (X / Translate) so the card
 * always reflects authoritative state without duplicating the build
 * logic. Closes the card when the entry has been removed elsewhere.
 */
async function refreshVocabCard(
  chars: string,
  els: ReturnType<typeof getElements>,
): Promise<void> {
  const all = await getAllVocab();
  const fresh = all.find((e) => e.chars === chars);
  if (!fresh) {
    dismissVocabCard();
    return;
  }
  await showVocabCard(fresh, els);
}

/**
 * pinyin-pro flags non-Chinese segments by passing them through
 * unchanged (origin === result). We additionally guard with a Han
 * regex so a Chinese segment that pinyin-pro happens to pass through
 * (e.g. an unknown char it can't romanize) doesn't accidentally get
 * a fallback rendering.
 */
function isHanSegment(seg: WordData): boolean {
  if (seg.chars === seg.pinyin) return false;
  return /\p{Script=Han}/u.test(seg.chars);
}

/**
 * Renders `sentence` into `el` as a sequence of `<ruby>` segments,
 * each carrying word-level pinyin in an `<rt>`. Mirrors how the
 * page overlay's pinyin row presents Chinese text so example
 * sentences read consistently across the extension.
 *
 * The target word is highlighted by attaching `.vocab-example-target`
 * to the matching `<ruby>` element instead of wrapping in an extra
 * span, keeping the ruby base + rt grouped under one element so the
 * pinyin still floats above the highlighted word.
 *
 * Non-Chinese segments (English, punctuation, numbers) are appended
 * as plain text nodes so they don't get an empty rt above them.
 *
 * Falls back to the plain-text highlighter when convertToPinyin
 * yields nothing (e.g. empty input, or pinyin-pro failing on some
 * unusual input).
 */
function renderHighlightedSentence(
  el: HTMLElement,
  sentence: string,
  target: string,
  pinyinStyle: PinyinStyle = "toneMarks",
): void {
  const segments = convertToPinyin(sentence, pinyinStyle);
  if (segments.length === 0) {
    renderPlainHighlightedSentence(el, sentence, target);
    return;
  }
  segments.forEach((seg) => {
    if (!isHanSegment(seg)) {
      el.appendChild(document.createTextNode(seg.chars));
      return;
    }
    const ruby = document.createElement("ruby");
    ruby.className = "vocab-example-ruby";
    if (seg.chars === target) {
      ruby.classList.add("vocab-example-target");
    }
    const base = document.createElement("span");
    base.className = "vocab-example-ruby-base";
    base.textContent = seg.chars;
    const rt = document.createElement("rt");
    rt.textContent = seg.pinyin;
    ruby.append(base, rt);
    el.appendChild(ruby);
  });
}

/**
 * Plain-text fallback when pinyin segmentation produces nothing.
 * Splits on every occurrence of `target` and wraps each match in
 * a span carrying `.vocab-example-target` so the highlight still
 * works without ruby markup.
 */
function renderPlainHighlightedSentence(
  el: HTMLElement,
  sentence: string,
  target: string,
): void {
  if (!target || !sentence.includes(target)) {
    el.textContent = sentence;
    return;
  }
  const parts = sentence.split(target);
  parts.forEach((part, i) => {
    if (part) el.appendChild(document.createTextNode(part));
    if (i < parts.length - 1) {
      const mark = document.createElement("span");
      mark.className = "vocab-example-target";
      mark.textContent = target;
      el.appendChild(mark);
    }
  });
}

/**
 * Builds one .vocab-example block: highlighted sentence row with an
 * inline X (REMOVE_EXAMPLE), and either the stored translation or a
 * Translate button. The Translate button calls Chrome's built-in
 * Translator API directly via translateExampleSentence (the click
 * supplies the transient user activation Translator.create() needs)
 * and patches the stored example via setExampleTranslation; no
 * round-trip to the service worker. On a successful mutation the
 * whole card is re-rendered via refreshVocabCard so the list of
 * examples and the underlying entry stay in sync.
 */
function renderExampleItem(
  entry: VocabEntry,
  example: VocabExample,
  index: number,
  els: ReturnType<typeof getElements>,
  pinyinStyle: PinyinStyle,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "vocab-example";

  const sentenceRow = document.createElement("div");
  sentenceRow.className = "vocab-example-sentence-row";

  const sentenceEl = document.createElement("div");
  sentenceEl.className = "vocab-example-sentence";
  renderHighlightedSentence(sentenceEl, example.sentence, entry.chars, pinyinStyle);

  const xBtn = document.createElement("button");
  xBtn.className = "vocab-example-x";
  xBtn.type = "button";
  xBtn.title = "Remove this example";
  xBtn.setAttribute("aria-label", "Remove example");
  xBtn.textContent = "\u00d7";
  xBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "REMOVE_EXAMPLE",
      chars: entry.chars,
      index,
    });
    await refreshVocabCard(entry.chars, els);
  });

  sentenceRow.append(sentenceEl, xBtn);
  item.appendChild(sentenceRow);

  if (example.translation) {
    const transEl = document.createElement("div");
    transEl.className = "vocab-example-translation";
    transEl.textContent = example.translation;
    item.appendChild(transEl);
  } else {
    const translateBtn = document.createElement("button");
    translateBtn.className = "vocab-example-translate-btn";
    translateBtn.type = "button";
    translateBtn.textContent = "Translate";
    translateBtn.addEventListener("click", async () => {
      translateBtn.disabled = true;
      translateBtn.textContent = "Translating\u2026";
      const result = await translateExampleSentence(example.sentence);
      if (result.ok) {
        await setExampleTranslation(entry.chars, index, result.translation);
        await refreshVocabCard(entry.chars, els);
      } else {
        translateBtn.disabled = false;
        translateBtn.textContent = "Retry translate";
        translateBtn.title = result.error.message;
      }
    });
    item.appendChild(translateBtn);
  }

  return item;
}

/**
 * Builds the optional "Examples" section appended to the vocab card
 * after the meta line. Returns null when the entry has no examples
 * so the caller can simply skip appending instead of carrying empty
 * placeholders.
 */
function renderExamplesSection(
  entry: VocabEntry,
  els: ReturnType<typeof getElements>,
  pinyinStyle: PinyinStyle,
): HTMLElement | null {
  const examples = entry.examples ?? [];
  if (examples.length === 0) return null;

  const section = document.createElement("div");
  section.className = "vocab-card-examples";

  const heading = document.createElement("div");
  heading.className = "vocab-card-examples-heading";
  heading.textContent = examples.length === 1 ? "Example" : "Examples";
  section.appendChild(heading);

  examples.forEach((ex, i) => {
    section.appendChild(renderExampleItem(entry, ex, i, els, pinyinStyle));
  });

  return section;
}

async function showVocabCard(
  entry: VocabEntry,
  els: ReturnType<typeof getElements>,
): Promise<void> {
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

  const bucketRow = document.createElement("div");
  bucketRow.className = "vocab-card-bucket";
  bucketRow.appendChild(renderBucketPill(getVocabBucket(entry)));
  if (entry.intervalDays > 0 && entry.nextDueAt > 0) {
    const dueIn = Math.max(0, Math.round((entry.nextDueAt - Date.now()) / 86_400_000));
    const dueNote = document.createElement("span");
    dueNote.className = "vocab-card-due-note";
    dueNote.textContent =
      dueIn === 0 ? "Due now" : `Next review in ${dueIn} day${dueIn === 1 ? "" : "s"}`;
    bucketRow.appendChild(dueNote);
  }

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
  card.append(closeBtn, chars, pinyin, def, bucketRow, meta, actions);

  overlay.appendChild(card);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissVocabCard();
  });

  // Mount the card synchronously so callers / tests see the overlay
  // immediately. Examples are enriched in a follow-up async pass --
  // they need a pinyin-style read from chrome.storage.sync, and
  // delaying the whole mount on that round-trip would cause a
  // visible blank-then-pop.
  document.body.appendChild(overlay);

  if (!entry.examples || entry.examples.length === 0) return;

  // Storage round-trip just for the user's pinyin-style preference;
  // ruby rendering needs it but the Translate button no longer
  // depends on any settings.
  const settings = await getEffectiveSettings();
  // Bail if the user dismissed / replaced this card while we were
  // awaiting -- prevents a stale examples block from appearing under
  // a different word.
  if (!document.body.contains(overlay)) return;

  const examples = renderExamplesSection(entry, els, settings.pinyinStyle);
  if (examples) card.insertBefore(examples, actions);
}

// ─── Vocab List Rendering ────────────────────────────────────────────

/**
 * Active bucket filter for the vocab list. "all" shows every entry
 * regardless of bucket; the three concrete bucket values restrict the
 * list to that bucket only. Lifted to module scope so clicks on the
 * summary chips persist across re-renders without round-tripping
 * through storage.
 */
let selectedBucketFilter: VocabBucket | "all" = "all";

/**
 * Builds the small inline pill that shows an entry's SRS bucket. The
 * three states each get their own modifier class so theming can recolor
 * them per palette without touching this code.
 */
function renderBucketPill(bucket: VocabBucket): HTMLElement {
  const pill = document.createElement("span");
  pill.className = `vocab-bucket-pill vocab-bucket-${bucket}`;
  pill.textContent = bucketLabel(bucket);
  return pill;
}

/**
 * Renders the bucket-counts strip above the vocab list. Each chip is
 * a clickable filter toggle: clicking restricts the list to that
 * bucket (and re-clicking the active chip clears the filter). The
 * "All" chip explicitly clears the filter and lights up when no
 * bucket-specific filter is active. When the vocab list is empty the
 * strip stays empty so the existing empty-state message carries the
 * page on its own.
 */
function renderBucketSummary(
  container: HTMLElement,
  entries: VocabEntry[],
  els: ReturnType<typeof getElements>,
): void {
  container.innerHTML = "";
  if (entries.length === 0) return;

  const counts: Record<VocabBucket, number> = {
    confident: 0,
    "needs-improvement": 0,
    "not-reviewed": 0,
  };
  for (const e of entries) counts[getVocabBucket(e)]++;

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "vocab-bucket-summary-chip vocab-bucket-all";
  if (selectedBucketFilter === "all") allChip.classList.add("active");
  allChip.textContent = `All: ${entries.length}`;
  allChip.addEventListener("click", () => {
    if (selectedBucketFilter === "all") return;
    selectedBucketFilter = "all";
    void renderVocabList(els);
  });
  container.appendChild(allChip);

  const order: VocabBucket[] = ["confident", "needs-improvement", "not-reviewed"];
  for (const bucket of order) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `vocab-bucket-summary-chip vocab-bucket-${bucket}`;
    if (selectedBucketFilter === bucket) chip.classList.add("active");
    chip.textContent = `${bucketLabel(bucket)}: ${counts[bucket]}`;
    chip.addEventListener("click", () => {
      // Re-clicking the active chip toggles the filter off so the
      // user can return to the full list with one click.
      selectedBucketFilter = selectedBucketFilter === bucket ? "all" : bucket;
      void renderVocabList(els);
    });
    container.appendChild(chip);
  }
}

async function renderVocabList(els: ReturnType<typeof getElements>): Promise<void> {
  const allEntries = await getAllVocab();
  const sortBy = els.vocabSort.value;

  if (sortBy === "recent") {
    allEntries.sort((a, b) => b.lastSeen - a.lastSeen);
  } else if (sortBy === "alpha") {
    allEntries.sort((a, b) => a.chars.localeCompare(b.chars, "zh"));
  } else {
    allEntries.sort((a, b) => b.count - a.count);
  }

  if (els.vocabBucketSummary) {
    renderBucketSummary(els.vocabBucketSummary, allEntries, els);
  }

  // Counts strip uses the unfiltered list so each chip always reflects
  // the full distribution; the row list below is what the filter applies
  // to.
  const entries =
    selectedBucketFilter === "all"
      ? allEntries
      : allEntries.filter((e) => getVocabBucket(e) === selectedBucketFilter);

  els.vocabList.innerHTML = "";

  if (allEntries.length === 0) {
    els.vocabList.innerHTML =
      '<div class="vocab-empty">No words saved yet.\nSelect Chinese text on any page to start building your list.</div>';
    return;
  }

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vocab-empty";
    empty.textContent = `No words in "${bucketLabel(selectedBucketFilter as VocabBucket)}".`;
    els.vocabList.appendChild(empty);
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
    primary.appendChild(renderBucketPill(getVocabBucket(entry)));

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

/**
 * Active bucket filter for the flashcard setup screen. "all" includes
 * every entry; the three concrete bucket values restrict the deck to
 * that bucket only. Lifted to module scope so chip clicks persist
 * across re-renders without a storage round-trip — same shape as the
 * vocab list's selectedBucketFilter, but tracked separately so the two
 * tabs don't share state.
 */
let fcBucketFilter: VocabBucket | "all" = "all";

/** "Practice N cards" / "Practice N from {bucket}" — live setup summary. */
function formatSessionEstimate(count: number, bucket: VocabBucket | "all", isAll: boolean): string {
  const noun = count === 1 ? "card" : "cards";
  const prefix = isAll ? `Practice all ${count}` : `Practice ${count}`;
  if (bucket === "all") {
    return `${prefix} ${noun}`;
  }
  return `${prefix} from ${bucketLabel(bucket)}`;
}

function showCard(els: ReturnType<typeof getElements>): void {
  if (!session) return;
  const card = session.cards[session.currentIndex];
  els.fcProgress.textContent = `Card ${session.currentIndex + 1} of ${session.cards.length}`;
  els.fcChars.textContent = card.chars;
  els.fcPinyin.textContent = card.pinyin;
  els.fcDefinition.textContent = card.definition;
  // Reset the example block so the previous card's sentence never
  // flashes into view before the new one's flip computes.
  if (els.fcExample) {
    els.fcExample.innerHTML = "";
    els.fcExample.classList.add("hidden");
  }
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
  void renderFlashcardExample(els);
}

/**
 * Populates the .fc-example block with the first stored example
 * sentence for the current card, mirroring the vocab card's logic
 * but limited to slot 0 to keep the flashcard face uncluttered.
 * Shows a Translate button when the sentence has no translation;
 * the button is always enabled because Chrome's on-device Translator
 * API needs no settings configuration.
 *
 * Async because it has to consult chrome.storage.sync for the
 * pinyin-style preference (used to render the ruby annotations); the
 * surrounding flip happens synchronously so the user sees pinyin /
 * definition immediately even if this block hasn't resolved yet.
 */
async function renderFlashcardExample(
  els: ReturnType<typeof getElements>,
): Promise<void> {
  if (!session || !els.fcExample) return;
  const card = session.cards[session.currentIndex];
  const example = card.examples?.[0];
  const slot = els.fcExample;
  slot.innerHTML = "";
  if (!example) {
    slot.classList.add("hidden");
    return;
  }

  // Capture the index we're rendering for so a stale resolve from a
  // prior flip can't paint over a newer card.
  const renderingIndex = session.currentIndex;

  // Storage round-trip just for the user's pinyin-style preference;
  // the Translate button no longer depends on any AI settings.
  const settings = await getEffectiveSettings();
  if (!session || session.currentIndex !== renderingIndex) return;

  const sentenceEl = document.createElement("div");
  sentenceEl.className = "fc-example-sentence";
  renderHighlightedSentence(sentenceEl, example.sentence, card.chars, settings.pinyinStyle);
  slot.appendChild(sentenceEl);

  if (example.translation) {
    const transEl = document.createElement("div");
    transEl.className = "fc-example-translation";
    transEl.textContent = example.translation;
    slot.appendChild(transEl);
    slot.classList.remove("hidden");
    return;
  }

  const translateBtn = document.createElement("button");
  translateBtn.className = "fc-example-translate-btn";
  translateBtn.type = "button";
  translateBtn.textContent = "Translate";
  translateBtn.addEventListener("click", async () => {
    translateBtn.disabled = true;
    translateBtn.textContent = "Translating\u2026";
    const result = await translateExampleSentence(example.sentence);
    if (!session || session.currentIndex !== renderingIndex) return;
    if (result.ok) {
      // Patch the in-memory card so re-flipping in the same session
      // shows the translation without another Translator call.
      if (!card.examples) card.examples = [];
      if (card.examples[0]) card.examples[0].translation = result.translation;
      // Also persist so the next session / card-render sees it.
      await setExampleTranslation(card.chars, 0, result.translation);
      const transEl = document.createElement("div");
      transEl.className = "fc-example-translation";
      transEl.textContent = result.translation;
      translateBtn.replaceWith(transEl);
    } else {
      translateBtn.disabled = false;
      translateBtn.textContent = "Retry translate";
      translateBtn.title = result.error.message;
    }
  });
  slot.appendChild(translateBtn);
  slot.classList.remove("hidden");
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

  const pool = filteredFcEntries(vocab);
  if (pool.length === 0) return;

  const size = selectedSize === "all" ? pool.length : selectedSize;
  const cards = buildSession(pool, size);

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

/**
 * Renders the "What to study" chip strip on the setup screen. Mirrors
 * the vocab tab's bucket summary chip-by-chip so the two surfaces feel
 * like the same control. Clicking a bucket chip filters the deck to
 * that bucket; re-clicking the active chip clears the filter.
 *
 * Empty buckets (e.g. zero "Confident" cards on day one) get an inert
 * disabled chip rather than a clickable one — selecting a bucket that
 * can't seed a session would just leave Start disabled with no way out.
 */
function renderFcBucketSummary(
  container: HTMLElement,
  entries: VocabEntry[],
  els: ReturnType<typeof getElements>,
): void {
  container.innerHTML = "";
  if (entries.length === 0) return;

  const counts: Record<VocabBucket, number> = {
    confident: 0,
    "needs-improvement": 0,
    "not-reviewed": 0,
  };
  for (const e of entries) counts[getVocabBucket(e)]++;

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "vocab-bucket-summary-chip vocab-bucket-all";
  if (fcBucketFilter === "all") allChip.classList.add("active");
  allChip.textContent = `All: ${entries.length}`;
  allChip.addEventListener("click", () => {
    if (fcBucketFilter === "all") return;
    fcBucketFilter = "all";
    void showSetup(els);
  });
  container.appendChild(allChip);

  const order: VocabBucket[] = ["confident", "needs-improvement", "not-reviewed"];
  for (const bucket of order) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `vocab-bucket-summary-chip vocab-bucket-${bucket}`;
    if (fcBucketFilter === bucket) chip.classList.add("active");
    if (counts[bucket] === 0) chip.disabled = true;
    chip.textContent = `${bucketLabel(bucket)}: ${counts[bucket]}`;
    chip.addEventListener("click", () => {
      fcBucketFilter = fcBucketFilter === bucket ? "all" : bucket;
      void showSetup(els);
    });
    container.appendChild(chip);
  }
}

/**
 * Returns the entries that match the active flashcard bucket filter.
 * Centralized so showSetup (for the live summary) and startSession
 * (for the actual deck) stay in sync — drift between the two would
 * mean the user sees a different count than they get.
 */
function filteredFcEntries(vocab: VocabEntry[]): VocabEntry[] {
  if (fcBucketFilter === "all") return vocab;
  return vocab.filter((e) => getVocabBucket(e) === fcBucketFilter);
}

async function showSetup(els: ReturnType<typeof getElements>): Promise<void> {
  const vocab = await getAllVocab();

  if (els.fcBucketSummary) {
    renderFcBucketSummary(els.fcBucketSummary, vocab, els);
  }

  // If the active bucket no longer has any members (e.g. user cleared
  // the list while the chip was selected), fall back to "all" so the
  // setup screen can't end up in an unrecoverable disabled state.
  const filtered = filteredFcEntries(vocab);
  if (fcBucketFilter !== "all" && filtered.length === 0) {
    fcBucketFilter = "all";
  }
  const pool = filteredFcEntries(vocab);

  // Default size selection: stick with "all" while the pool is small
  // enough that 10/20/50 don't make sense as choices.
  if (pool.length < 10) {
    selectedSize = "all";
  }

  els.fcSizeBtns.forEach((btn) => {
    const val = btn.dataset.size!;
    const isSelected = val === String(selectedSize);
    btn.classList.toggle("selected", isSelected);
  });

  if (vocab.length === 0) {
    els.fcStart.disabled = true;
    els.fcAvailable.textContent =
      "No words saved yet. Select Chinese text on any page to start building your list.";
  } else if (pool.length === 0) {
    els.fcStart.disabled = true;
    els.fcAvailable.textContent = `No words in ${bucketLabel(fcBucketFilter as VocabBucket)}.`;
  } else {
    els.fcStart.disabled = false;
    const requested = selectedSize === "all" ? pool.length : selectedSize;
    const effective = Math.min(requested, pool.length);
    const isAll = selectedSize === "all" || requested >= pool.length;
    els.fcAvailable.textContent = formatSessionEstimate(effective, fcBucketFilter, isAll);
  }

  els.fcSession.classList.add("hidden");
  els.fcSummary.classList.add("hidden");
  els.fcSetup.classList.remove("hidden");
}

// ─── Theme ───────────────────────────────────────────────────────────

/**
 * Apply the same effective body[data-theme] the library shell and
 * reader compute, so a hub mounted standalone (or before the
 * library shell's applyCanonicalTheme runs) renders with valid CSS
 * variables instead of a transparent background.
 *
 * Reader sepia override wins; otherwise the canonical shared theme
 * collapses "auto" via prefers-color-scheme. See src/shared/theme.ts.
 */
async function applyTheme(): Promise<void> {
  const stored = await chrome.storage.sync.get(["theme", "readerSettings"]);
  const sharedTheme = stored.theme as string | undefined;
  const reader = stored.readerSettings as Partial<ReaderSettings> | undefined;
  document.body.setAttribute(
    "data-theme",
    resolveEffectiveTheme(reader?.theme, sharedTheme),
  );
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
      intervalDays: typeof raw.intervalDays === "number" ? raw.intervalDays : 0,
      nextDueAt: typeof raw.nextDueAt === "number" ? raw.nextDueAt : 0,
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

  // Flashcard size selection. Toggle the selected class synchronously
  // so the click feels instant, then re-render the whole setup screen
  // so the live summary line and Start enabled-state catch up. Cheap
  // because showSetup just re-reads vocab + repaints.
  els.fcSizeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.size!;
      selectedSize = val === "all" ? "all" : parseInt(val, 10);
      els.fcSizeBtns.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      void showSetup(els);
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
