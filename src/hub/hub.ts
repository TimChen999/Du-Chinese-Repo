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
  removeWords,
  setExampleTranslation,
  updateFlashcardResult,
  restoreFlashcardState,
  importVocab,
} from "../background/vocab-store";
import { convertToPinyin } from "../background/pinyin-service";
import {
  DEFAULT_SETTINGS,
} from "../shared/constants";
import { translateExampleSentence } from "../shared/translate-example";
import {
  ensureDictionaryLoaded,
  formatModifier,
  formatPinyin,
  isDictionaryReady,
  lookupExact,
} from "../shared/cedict-lookup";
import {
  ensureComponentsLoaded,
  isComponentsReady,
  leafComponents,
  lookupComponents,
} from "../shared/components-lookup";
import {
  ensurePhoneticsLoaded,
  familiesContaining,
  isPhoneticsReady,
  lookupFamily,
} from "../shared/phonetics-lookup";
import { openFamilyDetail } from "./families";
import {
  applyReviewResult,
  bucketLabel,
  getVocabBucket,
  isDue,
  type VocabBucket,
} from "../shared/srs";
import type { ExtensionSettings, PinyinStyle, VocabEntry, VocabExample, WordData } from "../shared/types";
import { resolveEffectiveTheme } from "../shared/theme";
import type { ReaderSettings } from "../reader/reader-types";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Snapshot of the SRS-scheduling fields on a vocab entry, captured
 * just before answerCard writes a review result. Pushing one of these
 * onto session.history per answered card is what lets rewindCard undo
 * the storage write -- updateFlashcardResult persists immediately so
 * partial sessions aren't lost on tab close, but that means the
 * rewind path needs an explicit inverse to restore the prior state.
 */
interface SRSSnapshot {
  intervalDays: number;
  nextDueAt: number;
  wrongStreak: number;
  totalReviews: number;
  totalCorrect: number;
}

interface FlashcardSession {
  cards: VocabEntry[];
  currentIndex: number;
  /**
   * Per-card answer recorded when the user clicks Right / Wrong.
   * Always satisfies `results.length === currentIndex` while the user
   * is on a not-yet-answered card, so the green/red progress-bar split
   * is just `results.filter(r => r === "right").length / cards.length`.
   * Rewind pops the trailing entry as it walks back.
   */
  results: ("right" | "wrong")[];
  isFlipped: boolean;
  /**
   * Pre-answer SRS snapshots, one per entry in `results`. Same length
   * invariant -- pushed by answerCard before the storage write, popped
   * by rewindCard so the entry can be restored to its prior state via
   * restoreFlashcardState.
   */
  history: SRSSnapshot[];
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
    vocabSearchInput: document.getElementById("vocab-search-input") as HTMLInputElement | null,
    vocabSearchClear: document.getElementById("vocab-search-clear") as HTMLButtonElement | null,
    manageAnchor: document.querySelector(".manage-anchor") as HTMLDivElement | null,
    manageToggle: document.getElementById("manage-toggle") as HTMLButtonElement | null,
    managePopover: document.getElementById("manage-popover") as HTMLDivElement | null,
    manageMenuPanel: document.getElementById("manage-menu-panel") as HTMLDivElement | null,
    clearVocabBtn: document.getElementById("clear-vocab") as HTMLButtonElement,
    clearBack: document.getElementById("clear-back") as HTMLButtonElement | null,
    clearSelectPanel: document.getElementById("clear-select-panel") as HTMLDivElement | null,
    clearTimeline: document.getElementById("clear-timeline") as HTMLSelectElement | null,
    clearOnlyNotReviewed: document.getElementById("clear-only-not-reviewed") as HTMLInputElement | null,
    clearExecute: document.getElementById("clear-execute") as HTMLButtonElement | null,
    clearConfirmPanel: document.getElementById("clear-confirm-panel") as HTMLDivElement | null,
    clearConfirmCount: document.getElementById("clear-confirm-count") as HTMLElement | null,
    clearConfirmNo: document.getElementById("clear-confirm-no") as HTMLButtonElement | null,
    clearConfirmYes: document.getElementById("clear-confirm-yes") as HTMLButtonElement | null,
    fcSetup: document.getElementById("fc-setup") as HTMLDivElement,
    fcSession: document.getElementById("fc-session") as HTMLDivElement,
    fcSummary: document.getElementById("fc-summary") as HTMLDivElement,
    fcAvailable: document.getElementById("fc-available") as HTMLParagraphElement,
    fcBucketSummary: document.getElementById("fc-bucket-summary") as HTMLDivElement | null,
    fcStart: document.getElementById("fc-start") as HTMLButtonElement,
    fcSizeBtns: document.querySelectorAll<HTMLButtonElement>(".fc-size-btn"),
    fcProgress: document.getElementById("fc-progress") as HTMLSpanElement,
    fcRewind: document.getElementById("fc-rewind") as HTMLButtonElement | null,
    fcProgressBarCorrect: document.getElementById("fc-progress-bar-correct") as HTMLDivElement | null,
    fcProgressBarWrong: document.getElementById("fc-progress-bar-wrong") as HTMLDivElement | null,
    fcClose: document.getElementById("fc-close") as HTMLButtonElement,
    fcChars: document.getElementById("fc-chars") as HTMLDivElement,
    fcTtsWord: document.getElementById("fc-tts-word") as HTMLButtonElement | null,
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
    fcReviewWrong: document.getElementById("fc-review-wrong") as HTMLButtonElement | null,
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
/**
 * How a character relates to a phonetic family that's surfaced as a
 * link from its detail card.
 *   member        — char appears in the family's predictive members
 *                   (e.g. 清 in 青's family). Standard "you can study
 *                   this family because you already know one of its
 *                   chars" surface.
 *   head          — char IS the component the family is built around
 *                   (e.g. 青 itself for 青's family). Studying the
 *                   family teaches the user about the chars built
 *                   FROM this character.
 *   decomposition — char's decomposition includes a family-head
 *                   component but the char itself isn't phonetic in
 *                   that family (e.g. 章 contains 音 semantically; the
 *                   sound rule fails so 章 isn't in 音's predictive
 *                   set, but the link is still informative).
 */
type FamilyRelation = "member" | "head" | "decomposition";

interface RelatedFamily {
  comp: string;
  relation: FamilyRelation;
  familySize: number;
  familyReading: string;
}

/**
 * Returns every phonetic family the character is connected to, deduped
 * across the three relation types in priority order: head > member >
 * decomposition. The label rendered next to each link reflects the
 * relation; "decomposition" rows are explicitly tagged so the user
 * knows the char isn't a phonetic sibling of the family.
 *
 * Returns an empty array when the phonetic index isn't loaded yet --
 * callers should re-run after ensurePhoneticsLoaded resolves.
 */
function relatedFamiliesFor(ch: string): RelatedFamily[] {
  if (!isPhoneticsReady()) return [];
  if (!ch || Array.from(ch).length !== 1) return [];

  const out: RelatedFamily[] = [];
  const seen = new Set<string>();

  // Highest priority: char IS a family head. Studying the family means
  // studying chars built from this one.
  const headFam = lookupFamily(ch);
  if (headFam) {
    out.push({
      comp: ch,
      relation: "head",
      familySize: headFam.members.length,
      familyReading: headFam.reading,
    });
    seen.add(ch);
  }

  // Next: char is a phonetic member of one or more families.
  for (const comp of familiesContaining(ch)) {
    if (seen.has(comp)) continue;
    const fam = lookupFamily(comp);
    if (!fam) continue;
    out.push({
      comp,
      relation: "member",
      familySize: fam.members.length,
      familyReading: fam.reading,
    });
    seen.add(comp);
  }

  // Last: char's decomposition contains a family-head component, but
  // the char isn't phonetic in that family (otherwise it would have
  // been picked up as a member already).
  const compEntry = lookupComponents(ch);
  if (compEntry) {
    for (const leaf of leafComponents(compEntry.decomposition, ch)) {
      if (seen.has(leaf)) continue;
      const fam = lookupFamily(leaf);
      if (!fam) continue;
      out.push({
        comp: leaf,
        relation: "decomposition",
        familySize: fam.members.length,
        familyReading: fam.reading,
      });
      seen.add(leaf);
    }
  }

  return out;
}

/** Caption shown to the right of the family glyph for each row. */
function relationLabel(relation: FamilyRelation): string {
  switch (relation) {
    case "head":
      return "Head of family";
    case "member":
      return "You're a member";
    case "decomposition":
      return "Via decomposition";
  }
}

/**
 * Builds a family-link section for the char detail card. Idempotent:
 * clears `section` and re-renders against the current phonetics state,
 * so callers can call this both at mount time and inside the
 * ensurePhoneticsLoaded continuation.
 */
function fillFamilyLinkSection(
  section: HTMLElement,
  ch: string,
  onClickPrelude: () => void,
): void {
  while (section.firstChild) section.removeChild(section.firstChild);
  const related = relatedFamiliesFor(ch);
  if (related.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const heading = document.createElement("div");
  heading.className = "vocab-card-family-heading";
  heading.textContent =
    related.length === 1 ? "Phonetic family" : "Phonetic families";
  section.appendChild(heading);

  for (const r of related) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "vocab-card-family-link";
    item.dataset.relation = r.relation;
    item.addEventListener("click", () => {
      onClickPrelude();
      window.dispatchEvent(
        new CustomEvent("library:switch-tab", { detail: "families" }),
      );
      void openFamilyDetail(r.comp);
    });

    const compGlyph = document.createElement("span");
    compGlyph.className = "vocab-card-family-comp";
    compGlyph.textContent = r.comp;

    const compMeta = document.createElement("div");
    compMeta.className = "vocab-card-family-meta";

    const compLabel = document.createElement("span");
    compLabel.className = "vocab-card-family-comp-label";
    compLabel.textContent = formatPinyin(r.familyReading, "toneMarks");

    const relationTag = document.createElement("span");
    relationTag.className = "vocab-card-family-relation";
    relationTag.textContent = relationLabel(r.relation);

    compMeta.append(compLabel, relationTag);

    const sizeNote = document.createElement("span");
    sizeNote.className = "vocab-card-family-size";
    sizeNote.textContent = `${r.familySize} chars`;

    const arrow = document.createElement("span");
    arrow.className = "vocab-card-family-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";

    item.append(compGlyph, compMeta, sizeNote, arrow);
    section.appendChild(item);
  }
}

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
  // Stop any in-flight karaoke speech first so the audio doesn't keep
  // playing after the card is gone (the highlight has nowhere to land
  // once the overlay is detached).
  stopKaraoke();
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
/**
 * One unit emitted by renderHighlightedSentence. Han segments carry
 * the matching `<ruby>` so the karaoke TTS can re-paint a CSS class
 * onto each one as the sentence is spoken; non-Han segments (English,
 * punctuation, numbers) get null because there's no element to light.
 * The `text` field is what counts toward the per-word timing offset.
 */
interface SentenceSegment {
  text: string;
  element: HTMLElement | null;
}

function renderHighlightedSentence(
  el: HTMLElement,
  sentence: string,
  target: string,
  pinyinStyle: PinyinStyle = "toneMarks",
): SentenceSegment[] {
  const segments = convertToPinyin(sentence, pinyinStyle);
  if (segments.length === 0) {
    renderPlainHighlightedSentence(el, sentence, target);
    // No ruby produced -- karaoke degrades to "no visual highlight"
    // but timing still flows through the speak helper, which advances
    // by character regardless of whether an element is attached.
    return [{ text: sentence, element: null }];
  }
  const out: SentenceSegment[] = [];
  segments.forEach((seg) => {
    if (!isHanSegment(seg)) {
      el.appendChild(document.createTextNode(seg.chars));
      out.push({ text: seg.chars, element: null });
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
    out.push({ text: seg.chars, element: ruby });
  });
  return out;
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
  const sentenceSegments = renderHighlightedSentence(
    sentenceEl,
    example.sentence,
    entry.chars,
    pinyinStyle,
  );

  // Sentence-level TTS with per-word karaoke highlight, mirroring the
  // flashcard face. Sits between the sentence and the X so the user
  // can play audio without tab-targeting the destructive control.
  const ttsBtn = buildTtsButton(example.sentence, "Play sentence", sentenceSegments);

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

  sentenceRow.append(sentenceEl, ttsBtn, xBtn);
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

  // Collapsible section mirroring .vocab-card-chars-section: the heading
  // doubles as the toggle (label on the left, chevron on the right that
  // flips 180° when expanded). Items render eagerly into the panel so
  // the karaoke ruby segments can be wired up at build time, but the
  // panel is hidden until the user expands the section.
  const section = document.createElement("div");
  section.className = "vocab-card-examples";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "vocab-card-examples-toggle";
  toggle.setAttribute("aria-expanded", "false");

  const heading = document.createElement("span");
  heading.className = "vocab-card-examples-heading";
  heading.textContent = examples.length === 1 ? "Example" : "Examples";

  const icon = document.createElement("span");
  icon.className = "vocab-card-examples-toggle-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "˅";

  toggle.append(heading, icon);

  const panel = document.createElement("div");
  panel.className = "vocab-card-examples-panel";
  panel.hidden = true;

  examples.forEach((ex, i) => {
    panel.appendChild(renderExampleItem(entry, ex, i, els, pinyinStyle));
  });

  toggle.addEventListener("click", () => {
    if (panel.hidden) {
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
    } else {
      // Collapsing while audio is playing would orphan a highlight on
      // an off-screen ruby; cancel the karaoke so the next expand starts
      // clean.
      stopKaraoke();
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  });

  section.append(toggle, panel);
  return section;
}

/**
 * Renders CC-CEDICT dictionary details for `chars` into `container`:
 *  - Per-reading rows (pinyin + first 2 definitions) when the headword
 *    has multiple readings (homographs like 王 / 熬).
 *  - Modifier rows (classifiers, "abbr. for", "Taiwan pr.", etc.),
 *    nested under their owning reading when readings are visible,
 *    flat when there's only one reading.
 *
 * No-op when the dictionary isn't loaded or the headword has no entry;
 * safe to call repeatedly (clears prior contents on each call).
 */
function fillCardDetails(container: HTMLElement, chars: string): void {
  while (container.firstChild) container.removeChild(container.firstChild);
  const entries = lookupExact(chars);
  if (!entries) return;
  const showReadings = entries.length > 1;
  for (const entry of entries) {
    if (showReadings) {
      const reading = document.createElement("div");
      reading.className = "vocab-card-reading";
      const pinyin = document.createElement("span");
      pinyin.className = "vocab-card-reading-pinyin";
      pinyin.textContent = formatPinyin(entry.pinyinNumeric, "toneMarks");
      const def = document.createElement("span");
      def.className = "vocab-card-reading-def";
      def.textContent = entry.definitions.slice(0, 2).join("; ");
      reading.appendChild(pinyin);
      reading.appendChild(document.createTextNode(" — "));
      reading.appendChild(def);
      container.appendChild(reading);
    }
    for (const mod of entry.modifiers) {
      const row = document.createElement("div");
      row.className = showReadings
        ? "vocab-card-modifier vocab-card-modifier-nested"
        : "vocab-card-modifier";
      row.textContent = formatModifier(mod, "toneMarks");
      container.appendChild(row);
    }
  }
}

/**
 * Renders a per-character breakdown into `container`. Each character of
 * `chars` is looked up in CC-CEDICT and rendered with its canonical
 * reading(s) and a short gloss (first 2 definitions, or first modifier
 * when the entry is purely cross-references like 踏 -> "see 踏實").
 *
 * The pinyin shown here is CEDICT's canonical reading per character,
 * which may differ from the contextual reading inside the word
 * (e.g. 行 = xíng on its own but háng inside 银行). That's intentional:
 * this panel answers "what does this character mean on its own?".
 *
 * Iterates by codepoint so rare CJK in supplementary planes (surrogate
 * pairs) are handled as single characters rather than being split.
 */
function fillCharsBreakdown(
  container: HTMLElement,
  chars: string,
  onCharClick?: (ch: string) => void,
): void {
  while (container.firstChild) container.removeChild(container.firstChild);
  const charList = Array.from(chars);
  // Dedupe so a repeated character (e.g. 中 in 中共中央) only contributes
  // one set of readings to the panel — repetition inside the word adds
  // no extra information about the character itself.
  const seen = new Set<string>();
  for (const ch of charList) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    const entries = lookupExact(ch);
    if (!entries || entries.length === 0) continue;
    // For multi-reading characters, show the glyph only on the first row
    // and stack subsequent readings underneath. The repeated rows still
    // render an empty han span (visibility:hidden in CSS) so the pinyin
    // column stays aligned with the row above.
    entries.forEach((entry, idx) => {
      const row = document.createElement("div");
      row.className = "vocab-card-char-row";
      if (onCharClick) {
        row.classList.add("vocab-card-char-row-clickable");
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.setAttribute("aria-label", `Look up ${ch}`);
        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onCharClick(ch);
        });
        row.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            ev.stopPropagation();
            onCharClick(ch);
          }
        });
      }

      const han = document.createElement("span");
      han.className = "vocab-card-char-han";
      if (idx === 0) {
        han.textContent = ch;
      } else {
        han.classList.add("vocab-card-char-han-repeat");
        han.textContent = ch;
      }

      const pinyin = document.createElement("span");
      pinyin.className = "vocab-card-char-pinyin";
      pinyin.textContent = formatPinyin(entry.pinyinNumeric, "toneMarks");

      const def = document.createElement("span");
      def.className = "vocab-card-char-def";
      let defText = entry.definitions.slice(0, 2).join("; ");
      if (!defText && entry.modifiers.length > 0) {
        defText = formatModifier(entry.modifiers[0], "toneMarks");
      }
      def.textContent = defText;

      row.appendChild(han);
      row.appendChild(pinyin);
      row.appendChild(document.createTextNode(" — "));
      row.appendChild(def);
      container.appendChild(row);
    });
  }
}

/**
 * Renders the Make Me a Hanzi character-decomposition view into
 * `container` for a single-character headword. Layout:
 *   - The IDS string itself (small, monospace) — readers familiar with
 *     IDC operators (⿰⿱⿲...) get the structural shape at a glance.
 *   - One row per leaf component (IDC operators stripped, headword
 *     filtered out, deduped) with CC-CEDICT pinyin + a short gloss,
 *     styled identically to the per-character breakdown rows above.
 *   - An optional etymology hint (e.g. "A woman 女 with a son 子" for
 *     好), shown only when the upstream entry carried one.
 *
 * No-op when the components dictionary is not loaded or the headword
 * has no entry; safe to call repeatedly. Iterates by codepoint via
 * leafComponents() so any supplementary-plane parts survive.
 */
function fillComponentsBreakdown(container: HTMLElement, char: string): void {
  while (container.firstChild) container.removeChild(container.firstChild);
  const entry = lookupComponents(char);
  if (!entry) return;

  const ids = document.createElement("div");
  ids.className = "vocab-card-components-ids";
  ids.textContent = entry.decomposition;
  container.appendChild(ids);

  const leaves = leafComponents(entry.decomposition, char);
  for (const leaf of leaves) {
    const row = document.createElement("div");
    row.className = "vocab-card-char-row";

    const han = document.createElement("span");
    han.className = "vocab-card-char-han";
    han.textContent = leaf;

    const pinyin = document.createElement("span");
    pinyin.className = "vocab-card-char-pinyin";
    const cedictEntries = lookupExact(leaf);
    const cedictEntry = cedictEntries?.[0];
    pinyin.textContent = cedictEntry
      ? formatPinyin(cedictEntry.pinyinNumeric, "toneMarks")
      : "";

    const def = document.createElement("span");
    def.className = "vocab-card-char-def";
    let defText = cedictEntry
      ? cedictEntry.definitions.slice(0, 2).join("; ")
      : "";
    if (!defText && cedictEntry && cedictEntry.modifiers.length > 0) {
      defText = formatModifier(cedictEntry.modifiers[0], "toneMarks");
    }
    def.textContent = defText;

    row.appendChild(han);
    row.appendChild(pinyin);
    if (defText) row.appendChild(document.createTextNode(" — "));
    row.appendChild(def);
    container.appendChild(row);
  }

  if (entry.radical && !leaves.includes(entry.radical)) {
    // Radical wasn't surfaced as a leaf (e.g. it's the whole character
    // or otherwise absent from the IDS). Show it as a separate small
    // line so the user still sees what radical the dictionary assigns.
    const rad = document.createElement("div");
    rad.className = "vocab-card-components-radical";
    rad.textContent = "Radical: ";
    const radHan = document.createElement("span");
    radHan.className = "vocab-card-components-radical-han";
    radHan.textContent = entry.radical;
    rad.appendChild(radHan);
    container.appendChild(rad);
  }

  if (entry.hint) {
    const hint = document.createElement("div");
    hint.className = "vocab-card-components-hint";
    hint.textContent = entry.hint;
    container.appendChild(hint);
  }
}

async function showVocabCard(
  entry: VocabEntry,
  els: ReturnType<typeof getElements>,
): Promise<void> {
  dismissVocabCard();

  const overlay = document.createElement("div");
  overlay.className = "vocab-card-overlay";
  // Opt the whole card out of the page-level click-flow so clicking a
  // Chinese character inside the card never opens the small in-page
  // lookup popup on top of it. The card surfaces its own per-character
  // drill-down via showCharDetailCard.
  overlay.dataset.noClickflow = "";

  const card = document.createElement("div");
  card.className = "vocab-card";

  const closeBtn = document.createElement("button");
  closeBtn.className = "vocab-card-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", dismissVocabCard);

  // Headword row: large chars + a small TTS button so the user can play
  // the word with one click. Mirrors the flashcard face's fc-chars-row
  // layout. The button sits inline next to the characters rather than
  // below them so the visual hierarchy stays "word first".
  const charsRow = document.createElement("div");
  charsRow.className = "vocab-card-chars-row";

  const chars = document.createElement("div");
  chars.className = "vocab-card-chars";
  chars.textContent = entry.chars;

  const charsTts = buildTtsButton(entry.chars, "Play word");
  charsTts.classList.add("vocab-card-chars-tts");

  charsRow.append(chars, charsTts);

  const pinyin = document.createElement("div");
  pinyin.className = "vocab-card-pinyin";
  pinyin.textContent = entry.pinyin;

  const def = document.createElement("div");
  def.className = "vocab-card-def";
  def.textContent = entry.definition;

  // CC-CEDICT dictionary details (alt readings + modifiers) pulled live
  // from the dictionary at render time. Mirrors the popup's Details
  // toggle: a small button sits under the gloss; clicking it expands a
  // panel showing alt readings + modifiers. Hidden entirely when the
  // headword has nothing extra to show (single reading, no modifiers)
  // or when CC-CEDICT isn't loaded.
  const detailsBtn = document.createElement("button");
  detailsBtn.type = "button";
  detailsBtn.className = "vocab-card-details-btn";
  detailsBtn.hidden = true;

  const details = document.createElement("div");
  details.className = "vocab-card-details";
  details.hidden = true;

  detailsBtn.addEventListener("click", () => {
    if (details.hidden) {
      fillCardDetails(details, entry.chars);
      details.hidden = false;
      detailsBtn.setAttribute("aria-expanded", "true");
    } else {
      details.hidden = true;
      detailsBtn.setAttribute("aria-expanded", "false");
    }
  });

  function refreshDetailsAffordance(): void {
    const entries = lookupExact(entry.chars);
    if (!entries || entries.length === 0) {
      detailsBtn.hidden = true;
      details.hidden = true;
      return;
    }
    const hasMultipleReadings = entries.length > 1;
    const hasModifiers = entries.some((e) => e.modifiers.length > 0);
    if (!hasMultipleReadings && !hasModifiers) {
      detailsBtn.hidden = true;
      details.hidden = true;
      return;
    }
    detailsBtn.hidden = false;
    detailsBtn.textContent = hasMultipleReadings
      ? `${entries.length} readings`
      : "Details";
    detailsBtn.setAttribute("aria-expanded", details.hidden ? "false" : "true");
    // If the panel is already open, re-render against the freshly
    // loaded data so a late dictionary arrival doesn't leave it stale.
    if (!details.hidden) fillCardDetails(details, entry.chars);
  }
  refreshDetailsAffordance();

  // Standalone "Characters" section for multi-character words. Lives
  // separately from the Details toggle above so it remains a one-click
  // path to the per-character breakdown regardless of whether the
  // word itself has alt readings or modifiers. Hidden when chars is a
  // single character or when no sub-character has a CEDICT entry.
  //
  // Visual rhythm matches the EXAMPLE section above: a top divider line
  // with an uppercase label, but the heading row is the toggle so the
  // panel expands/collapses inline below it.
  const charsSection = document.createElement("div");
  charsSection.className = "vocab-card-chars-section";
  charsSection.hidden = true;

  const charsToggle = document.createElement("button");
  charsToggle.type = "button";
  charsToggle.className = "vocab-card-chars-toggle";
  charsToggle.setAttribute("aria-expanded", "false");

  const charsLabel = document.createElement("span");
  charsLabel.className = "vocab-card-chars-toggle-label";
  charsLabel.textContent = "Characters";

  const charsIcon = document.createElement("span");
  charsIcon.className = "vocab-card-chars-toggle-icon";
  charsIcon.setAttribute("aria-hidden", "true");
  charsIcon.textContent = "˅"; // ˅ — small downwards chevron, rotates 180° via CSS when expanded

  charsToggle.append(charsLabel, charsIcon);

  const charsPanel = document.createElement("div");
  charsPanel.className = "vocab-card-chars-panel";
  charsPanel.hidden = true;

  // Clicking a row inside the breakdown drills into that character via
  // the hub-styled char detail card (with a back arrow that returns
  // here). Routed through the parent vocab card so the small click-flow
  // popup stays out of this surface.
  const onCharRowClick = (ch: string) => {
    void showCharDetailCard(ch, entry, els);
  };

  charsToggle.addEventListener("click", () => {
    if (charsPanel.hidden) {
      fillCharsBreakdown(charsPanel, entry.chars, onCharRowClick);
      charsPanel.hidden = false;
      charsToggle.setAttribute("aria-expanded", "true");
    } else {
      charsPanel.hidden = true;
      charsToggle.setAttribute("aria-expanded", "false");
    }
  });

  charsSection.append(charsToggle, charsPanel);

  function refreshCharsAffordance(): void {
    const charList = Array.from(entry.chars);
    if (charList.length < 2) {
      charsSection.hidden = true;
      charsPanel.hidden = true;
      return;
    }
    const anyHasEntry = charList.some((ch) => {
      const e = lookupExact(ch);
      return !!e && e.length > 0;
    });
    if (!anyHasEntry) {
      charsSection.hidden = true;
      charsPanel.hidden = true;
      return;
    }
    charsSection.hidden = false;
    if (!charsPanel.hidden)
      fillCharsBreakdown(charsPanel, entry.chars, onCharRowClick);
  }
  refreshCharsAffordance();

  // Components section (Make Me a Hanzi). Single-character words only:
  // multi-char entries already get a per-character breakdown above, and
  // adding a parallel decomposition list there would duplicate rows for
  // little gain. Hidden when the headword has no decomposition entry
  // (rare CJK, the dictionary covers ~9.5k characters).
  const componentsSection = document.createElement("div");
  componentsSection.className = "vocab-card-components-section";
  componentsSection.hidden = true;

  const componentsToggle = document.createElement("button");
  componentsToggle.type = "button";
  componentsToggle.className = "vocab-card-components-toggle";
  componentsToggle.setAttribute("aria-expanded", "false");

  const componentsLabel = document.createElement("span");
  componentsLabel.className = "vocab-card-components-toggle-label";
  componentsLabel.textContent = "Components";

  const componentsIcon = document.createElement("span");
  componentsIcon.className = "vocab-card-components-toggle-icon";
  componentsIcon.setAttribute("aria-hidden", "true");
  componentsIcon.textContent = "˅";

  componentsToggle.append(componentsLabel, componentsIcon);

  const componentsPanel = document.createElement("div");
  componentsPanel.className = "vocab-card-components-panel";
  componentsPanel.hidden = true;

  componentsToggle.addEventListener("click", () => {
    if (componentsPanel.hidden) {
      fillComponentsBreakdown(componentsPanel, entry.chars);
      componentsPanel.hidden = false;
      componentsToggle.setAttribute("aria-expanded", "true");
    } else {
      componentsPanel.hidden = true;
      componentsToggle.setAttribute("aria-expanded", "false");
    }
  });

  componentsSection.append(componentsToggle, componentsPanel);

  function refreshComponentsAffordance(): void {
    const charList = Array.from(entry.chars);
    if (charList.length !== 1) {
      componentsSection.hidden = true;
      componentsPanel.hidden = true;
      return;
    }
    const ce = lookupComponents(entry.chars);
    if (!ce) {
      componentsSection.hidden = true;
      componentsPanel.hidden = true;
      return;
    }
    componentsSection.hidden = false;
    if (!componentsPanel.hidden) {
      fillComponentsBreakdown(componentsPanel, entry.chars);
    }
  }
  refreshComponentsAffordance();

  if (!isDictionaryReady()) {
    void ensureDictionaryLoaded()
      .then(() => {
        if (!document.body.contains(card)) return;
        refreshDetailsAffordance();
        refreshCharsAffordance();
        // Components rows reuse CC-CEDICT pinyin/gloss; refresh once
        // CEDICT lands so an open panel picks up the data instead of
        // showing bare glyphs.
        refreshComponentsAffordance();
      })
      .catch(() => {
        /* warning already logged at init */
      });
  }

  if (!isComponentsReady()) {
    void ensureComponentsLoaded()
      .then(() => {
        if (!document.body.contains(card)) return;
        refreshComponentsAffordance();
      })
      .catch(() => {
        /* warning already logged at init */
      });
  }

  // Phonetic-family cross-link (single-char headwords only). Mirrors
  // the equivalent block in showCharDetailCard so a saved single-char
  // entry exposes the same path into the Families tab the drill-down
  // does. fillFamilyLinkSection handles the head/member/decomposition
  // relation tagging.
  const familySection = document.createElement("div");
  familySection.className = "vocab-card-family-section";
  familySection.hidden = true;

  function refreshFamilyAffordance(): void {
    if (Array.from(entry.chars).length !== 1) {
      familySection.hidden = true;
      while (familySection.firstChild)
        familySection.removeChild(familySection.firstChild);
      return;
    }
    fillFamilyLinkSection(familySection, entry.chars, () => dismissVocabCard());
  }
  refreshFamilyAffordance();

  if (!isPhoneticsReady()) {
    void ensurePhoneticsLoaded()
      .then(() => {
        if (!document.body.contains(card)) return;
        refreshFamilyAffordance();
      })
      .catch((err) => {
        console.warn("[hub] phonetics index failed to load", err);
      });
  }

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

  // Two-step delete: the primary "Delete" button swaps to a
  // Cancel | Confirm pair on first click. Cancel restores the primary
  // button; Confirm performs the destructive removeWord. This guards
  // against accidental clicks given the action's proximity to the
  // Characters toggle directly above it.
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "vocab-card-delete";
  deleteBtn.textContent = "Delete";

  const confirmRow = document.createElement("div");
  confirmRow.className = "vocab-card-delete-confirm";
  confirmRow.hidden = true;

  const confirmPrompt = document.createElement("span");
  confirmPrompt.className = "vocab-card-delete-prompt";
  confirmPrompt.textContent = "Delete this word?";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "vocab-card-delete-cancel";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "vocab-card-delete-confirm-btn";
  confirmBtn.textContent = "Delete";

  confirmRow.append(confirmPrompt, cancelBtn, confirmBtn);

  deleteBtn.addEventListener("click", () => {
    deleteBtn.hidden = true;
    confirmRow.hidden = false;
    confirmBtn.focus();
  });

  cancelBtn.addEventListener("click", () => {
    confirmRow.hidden = true;
    deleteBtn.hidden = false;
  });

  confirmBtn.addEventListener("click", async () => {
    await removeWord(entry.chars);
    dismissVocabCard();
    renderVocabList(els);
  });

  actions.append(deleteBtn, confirmRow);
  card.append(
    closeBtn,
    charsRow,
    pinyin,
    def,
    detailsBtn,
    details,
    bucketRow,
    meta,
    charsSection,
    componentsSection,
    familySection,
    actions,
  );

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
  // Insert above the Characters section so the per-character breakdown
  // remains the bottom-most section before the action buttons.
  if (examples) card.insertBefore(examples, charsSection);
}

/**
 * Drill-down card surfaced when the user clicks a character row inside
 * a parent vocab card's Characters breakdown. Replaces (rather than
 * stacks on top of) the parent card and surfaces the same hub-styled
 * pinyin/definition/Details/Components blocks the parent card uses so
 * the visual rhythm is identical. The top-left back arrow restores
 * `parentEntry` via showVocabCard, so the user can drill into a
 * character and pop back without losing the parent context.
 *
 * Intentionally lighter than showVocabCard:
 *  - No "+ Vocab" affordance — drill-down has no surrounding example
 *    sentence to capture, and saving every drilled character would
 *    pollute the vocab list.
 *  - No bucket pill / SRS metadata / delete button — the character
 *    isn't a vocab entry here, just a CC-CEDICT lookup.
 */
/**
 * Public entry point used by the Families tab when the user clicks a
 * member character row. The card opens with no back arrow (just the
 * close button) so dismissing returns to whatever surface lay
 * underneath -- in this case the Family detail panel, which doesn't
 * need restoration since it stays mounted.
 */
export function showStandaloneCharDetailCard(ch: string): void {
  showCharDetailCard(ch, null, getElements());
}

function showCharDetailCard(
  ch: string,
  parentEntry: VocabEntry | null,
  els: ReturnType<typeof getElements>,
): void {
  dismissVocabCard();

  const overlay = document.createElement("div");
  overlay.className = "vocab-card-overlay";
  overlay.dataset.noClickflow = "";

  const card = document.createElement("div");
  card.className = "vocab-card vocab-card-char-detail";

  // Back arrow (top-left) -- only when there's a parent vocab card to
  // return to. Standalone openings (e.g. from the Families tab) skip
  // the back arrow because dismissing the overlay leaves the user on
  // whatever surface lay underneath.
  let backBtn: HTMLButtonElement | null = null;
  if (parentEntry) {
    backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "vocab-card-back";
    backBtn.setAttribute("aria-label", `Back to ${parentEntry.chars}`);
    backBtn.textContent = "←"; // left arrow
    backBtn.addEventListener("click", () => {
      void showVocabCard(parentEntry, els);
    });
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "vocab-card-close";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", dismissVocabCard);

  const charsRow = document.createElement("div");
  charsRow.className = "vocab-card-chars-row";

  const chars = document.createElement("div");
  chars.className = "vocab-card-chars";
  chars.textContent = ch;

  const charsTts = buildTtsButton(ch, "Play character");
  charsTts.classList.add("vocab-card-chars-tts");

  charsRow.append(chars, charsTts);

  // Pinyin + definition pulled from CC-CEDICT's first reading. Multiple
  // readings (when present) live in the Details dropdown below, same as
  // the parent vocab card's headword treatment.
  const pinyin = document.createElement("div");
  pinyin.className = "vocab-card-pinyin";

  const def = document.createElement("div");
  def.className = "vocab-card-def";

  function refreshHeadFromCedict(): void {
    const entries = lookupExact(ch);
    const first = entries?.[0];
    pinyin.textContent = first
      ? formatPinyin(first.pinyinNumeric, "toneMarks")
      : "";
    let defText = first ? first.definitions.slice(0, 4).join("; ") : "";
    if (!defText && first && first.modifiers.length > 0) {
      defText = formatModifier(first.modifiers[0], "toneMarks");
    }
    def.textContent = defText;
  }
  refreshHeadFromCedict();

  // Details dropdown (alt readings + modifiers) — reuses the parent
  // card's affordance verbatim so multi-reading characters like 武 (wǔ
  // / mǔ) show both, and modifiers (e.g. classifiers) surface the same
  // way they do on a saved vocab card.
  const detailsBtn = document.createElement("button");
  detailsBtn.type = "button";
  detailsBtn.className = "vocab-card-details-btn";
  detailsBtn.hidden = true;

  const details = document.createElement("div");
  details.className = "vocab-card-details";
  details.hidden = true;

  detailsBtn.addEventListener("click", () => {
    if (details.hidden) {
      fillCardDetails(details, ch);
      details.hidden = false;
      detailsBtn.setAttribute("aria-expanded", "true");
    } else {
      details.hidden = true;
      detailsBtn.setAttribute("aria-expanded", "false");
    }
  });

  function refreshDetailsAffordance(): void {
    const entries = lookupExact(ch);
    if (!entries || entries.length === 0) {
      detailsBtn.hidden = true;
      details.hidden = true;
      return;
    }
    const hasMultipleReadings = entries.length > 1;
    const hasModifiers = entries.some((e) => e.modifiers.length > 0);
    if (!hasMultipleReadings && !hasModifiers) {
      detailsBtn.hidden = true;
      details.hidden = true;
      return;
    }
    detailsBtn.hidden = false;
    detailsBtn.textContent = hasMultipleReadings
      ? `${entries.length} readings`
      : "Details";
    detailsBtn.setAttribute("aria-expanded", details.hidden ? "false" : "true");
    if (!details.hidden) fillCardDetails(details, ch);
  }
  refreshDetailsAffordance();

  // Components dropdown (Make Me a Hanzi). Always single-character here
  // by construction, so we don't need the per-length guard the parent
  // card uses.
  const componentsSection = document.createElement("div");
  componentsSection.className = "vocab-card-components-section";
  componentsSection.hidden = true;

  const componentsToggle = document.createElement("button");
  componentsToggle.type = "button";
  componentsToggle.className = "vocab-card-components-toggle";
  componentsToggle.setAttribute("aria-expanded", "false");

  const componentsLabel = document.createElement("span");
  componentsLabel.className = "vocab-card-components-toggle-label";
  componentsLabel.textContent = "Components";

  const componentsIcon = document.createElement("span");
  componentsIcon.className = "vocab-card-components-toggle-icon";
  componentsIcon.setAttribute("aria-hidden", "true");
  componentsIcon.textContent = "˅";

  componentsToggle.append(componentsLabel, componentsIcon);

  const componentsPanel = document.createElement("div");
  componentsPanel.className = "vocab-card-components-panel";
  componentsPanel.hidden = true;

  componentsToggle.addEventListener("click", () => {
    if (componentsPanel.hidden) {
      fillComponentsBreakdown(componentsPanel, ch);
      componentsPanel.hidden = false;
      componentsToggle.setAttribute("aria-expanded", "true");
    } else {
      componentsPanel.hidden = true;
      componentsToggle.setAttribute("aria-expanded", "false");
    }
  });

  componentsSection.append(componentsToggle, componentsPanel);

  function refreshComponentsAffordance(): void {
    const ce = lookupComponents(ch);
    if (!ce) {
      componentsSection.hidden = true;
      componentsPanel.hidden = true;
      return;
    }
    componentsSection.hidden = false;
    if (!componentsPanel.hidden) fillComponentsBreakdown(componentsPanel, ch);
  }
  refreshComponentsAffordance();

  // Late-arriving dictionaries: when CEDICT or the components data
  // lands after the card mounted, refresh the affordances in place so
  // the user sees data instead of an empty pinyin row / hidden section.
  if (!isDictionaryReady()) {
    void ensureDictionaryLoaded()
      .then(() => {
        if (!document.body.contains(card)) return;
        refreshHeadFromCedict();
        refreshDetailsAffordance();
        refreshComponentsAffordance();
      })
      .catch(() => {
        /* warning already logged at init */
      });
  }
  if (!isComponentsReady()) {
    void ensureComponentsLoaded()
      .then(() => {
        if (!document.body.contains(card)) return;
        refreshComponentsAffordance();
      })
      .catch(() => {
        /* warning already logged at init */
      });
  }

  // Phonetic-family cross-link. Pulls every family the char is
  // related to: head (it IS a family component), member (phonetic
  // sibling), or decomposition (the char's decomposition contains a
  // family head, like 章 → 音 — useful even though 章 isn't phonetic
  // in 音's family).
  const familySection = document.createElement("div");
  familySection.className = "vocab-card-family-section";
  familySection.hidden = true;

  function refreshFamilyAffordance(): void {
    fillFamilyLinkSection(familySection, ch, () => dismissVocabCard());
  }
  refreshFamilyAffordance();

  if (!isPhoneticsReady()) {
    void ensurePhoneticsLoaded()
      .then(() => {
        if (!document.body.contains(card)) return;
        refreshFamilyAffordance();
      })
      .catch((err) => {
        console.warn("[hub] phonetics index failed to load", err);
      });
  }

  if (backBtn) card.appendChild(backBtn);
  card.append(
    closeBtn,
    charsRow,
    pinyin,
    def,
    detailsBtn,
    details,
    componentsSection,
    familySection,
  );

  overlay.appendChild(card);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissVocabCard();
  });

  document.body.appendChild(overlay);
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

// \u2500\u2500\u2500 Vocab search \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Live-filters the rendered list by case- and tone-insensitive substring
// match across chars, pinyin, definition, last-seen date, and seen
// count. Composes with the bucket filter (search runs after) so chip
// counts keep showing the full distribution.

let vocabSearchQuery = "";

/**
 * Strips combining diacritics so tone-marked pinyin (`n\u01d0h\u01ceo`, `l\u01da`)
 * matches the tone-free form a user types (`nihao`, `lu`). NFD splits
 * precomposed vowels into base + combining mark; we drop the marks. The
 * result has the same length as the original NFC string for the pinyin
 * we store, so substring indexes line up between haystack and original
 * \u2014 that's what makes index-aligned highlighting possible.
 */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeForSearch(s: string): string {
  return stripDiacritics(s.toLowerCase());
}

/**
 * Returns all [start, end) positions in `text` where a normalized form
 * of `query` matches. Indexes are valid against the original string
 * because stripDiacritics on NFC pinyin preserves length.
 */
function findMatchRanges(text: string, query: string): [number, number][] {
  if (!query) return [];
  const haystack = normalizeForSearch(text);
  const needle = normalizeForSearch(query);
  if (!needle) return [];
  const ranges: [number, number][] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    ranges.push([idx, idx + needle.length]);
    from = idx + needle.length;
  }
  return ranges;
}

/**
 * Appends `text` to `parent`, wrapping any spans matching the current
 * search query in <mark class="vocab-search-hl">. Built with DOM nodes
 * (not innerHTML) so user-supplied vocab definitions can't sneak HTML
 * into the page.
 */
function appendWithHighlights(parent: Element, text: string, query: string): void {
  const ranges = findMatchRanges(text, query);
  if (ranges.length === 0) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, start)));
    }
    const mark = document.createElement("mark");
    mark.className = "vocab-search-hl";
    mark.textContent = text.slice(start, end);
    parent.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function metaTextFor(entry: VocabEntry): string {
  const lastSeen = new Date(entry.lastSeen).toLocaleDateString();
  let metaText = `Seen ${entry.count} time${entry.count !== 1 ? "s" : ""} \u00b7 Last seen ${lastSeen}`;
  if (entry.totalReviews > 0) {
    const accuracy = Math.round((entry.totalCorrect / entry.totalReviews) * 100);
    metaText += ` \u00b7 Reviews: ${entry.totalReviews} \u00b7 Accuracy: ${accuracy}%`;
  }
  return metaText;
}

/**
 * Used by the row filter (not by the highlighter). Drops whitespace in
 * addition to lower-casing and stripping tones, so a query like
 * "yinhang" still matches stored pinyin "yín háng" — the user
 * shouldn't have to remember inter-syllable spacing. The highlighter
 * keeps the stricter literal-substring rule, so a query that only
 * matches loosely just produces an unhighlighted row.
 */
function normalizeForMatch(s: string): string {
  return normalizeForSearch(s).replace(/\s+/g, "");
}

function entryMatchesSearch(entry: VocabEntry, query: string): boolean {
  if (!query) return true;
  const q = normalizeForMatch(query);
  if (!q) return true;
  if (normalizeForMatch(entry.chars).includes(q)) return true;
  if (normalizeForMatch(entry.pinyin).includes(q)) return true;
  if (normalizeForMatch(entry.definition).includes(q)) return true;
  // Match against the rendered meta line so the user can search by
  // last-seen date or seen-count exactly as it appears in the row.
  if (normalizeForMatch(metaTextFor(entry)).includes(q)) return true;
  return false;
}

function setupVocabSearch(els: ReturnType<typeof getElements>): void {
  if (!els.vocabSearchInput) return;
  const updateClearVisibility = (): void => {
    const hasQuery = !!vocabSearchQuery;
    els.vocabSearchClear?.classList.toggle("hidden", !hasQuery);
  };
  els.vocabSearchInput.addEventListener("input", () => {
    vocabSearchQuery = els.vocabSearchInput?.value ?? "";
    updateClearVisibility();
    void renderVocabList(els);
  });
  els.vocabSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && vocabSearchQuery) {
      e.stopPropagation();
      els.vocabSearchInput!.value = "";
      vocabSearchQuery = "";
      updateClearVisibility();
      void renderVocabList(els);
    }
  });
  els.vocabSearchClear?.addEventListener("click", () => {
    if (!els.vocabSearchInput) return;
    els.vocabSearchInput.value = "";
    vocabSearchQuery = "";
    updateClearVisibility();
    els.vocabSearchInput.focus();
    void renderVocabList(els);
  });
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

  // Bucket filter first; chip counts on the strip above use the full
  // distribution so the user can see "I have 12 confident words" while
  // looking at a search-narrowed list.
  const bucketFiltered =
    selectedBucketFilter === "all"
      ? allEntries
      : allEntries.filter((e) => getVocabBucket(e) === selectedBucketFilter);

  // Search refines the bucket-filtered set. Empty query matches all.
  const query = vocabSearchQuery.trim();
  const entries = query
    ? bucketFiltered.filter((e) => entryMatchesSearch(e, query))
    : bucketFiltered;

  els.vocabList.innerHTML = "";

  if (allEntries.length === 0) {
    els.vocabList.innerHTML =
      '<div class="vocab-empty">No words saved yet.\nSelect Chinese text on any page to start building your list.</div>';
    return;
  }

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vocab-empty";
    if (query && selectedBucketFilter !== "all") {
      empty.textContent = `No matches for "${query}" in "${bucketLabel(selectedBucketFilter as VocabBucket)}".`;
    } else if (query) {
      empty.textContent = `No matches for "${query}".`;
    } else {
      empty.textContent = `No words in "${bucketLabel(selectedBucketFilter as VocabBucket)}".`;
    }
    els.vocabList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "vocab-row";

    const primary = document.createElement("div");
    primary.className = "vocab-row-primary";
    const charsSpan = document.createElement("span");
    charsSpan.className = "vocab-chars";
    appendWithHighlights(charsSpan, entry.chars, query);
    const pinyinSpan = document.createElement("span");
    pinyinSpan.className = "vocab-pinyin";
    appendWithHighlights(pinyinSpan, entry.pinyin, query);
    const defSpan = document.createElement("span");
    defSpan.className = "vocab-def";
    appendWithHighlights(defSpan, entry.definition, query);
    primary.appendChild(charsSpan);
    primary.appendChild(pinyinSpan);
    primary.appendChild(defSpan);
    primary.appendChild(renderBucketPill(getVocabBucket(entry)));

    const metaDiv = document.createElement("div");
    metaDiv.className = "vocab-row-meta";
    appendWithHighlights(metaDiv, metaTextFor(entry), query);

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
  els.fcProgress.textContent = `${session.currentIndex + 1}/${session.cards.length}`;
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
  // Judge buttons stay visible across the whole session -- the flow is
  // deliberately honor-system: the user can flip back and forth, hit
  // the speaker, or just click ✓/× without flipping at all. showCard
  // only resets the *front* face of the new card.
  session.isFlipped = false;

  // Render the example block on the front face too so the sentence
  // is visible regardless of flip state. The same block stays put when
  // the user flips between faces -- only fc-answer (pinyin + def) is
  // toggled by flipCard. The .fc-front-mode class hides rt + the
  // translation via CSS while we're on the front face so the sentence
  // shows plain characters only; flipCard removes it.
  if (els.fcExample) els.fcExample.classList.add("fc-front-mode");
  void renderFlashcardExample(els);

  updateProgressBar(els);
  updateRewindButton(els);
}

/**
 * Speaks the supplied text via the browser SpeechSynthesis API with
 * the zh-CN locale so the user gets Mandarin pronunciation when a
 * Chinese voice is installed (Chrome doesn't ship one itself, so the
 * underlying OS provides it). Cancels any in-flight utterance first
 * so rapid clicks don't queue. No-op when the API is unavailable
 * (e.g. older browsers, headless test environments).
 */
function speakChinese(text: string): void {
  if (!text) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  synth.speak(utterance);
}

// ─── Karaoke-style sentence playback ────────────────────────────────
// Mirrors src/content/click-tts.ts: speak the whole sentence with one
// utterance so prosody is preserved, then schedule per-word timers
// that re-paint a `.fc-tts-active` class onto each ruby as it is read.
// We can't rely on `boundary` events because most Chinese voices in
// Chrome don't fire them; the legacy overlay's per-character timing
// was solid in practice, so the same approach is used here.

/** Mid-of-range estimate for Chinese TTS at rate=1.0 (ms per char). */
const FC_MS_PER_CHAR_AT_RATE_1 = 200;
/** Mild slowdown for clarity, identical to click-tts.ts. */
const FC_TTS_RATE = 0.85;

/** Active highlight classes + timer ids so we can clean them up. */
let karaokeTimers: number[] = [];
let karaokeRubies: HTMLElement[] = [];

function clearKaraokeTimers(): void {
  for (const id of karaokeTimers) window.clearTimeout(id);
  karaokeTimers = [];
}

function clearKaraokeHighlight(): void {
  for (const el of karaokeRubies) el.classList.remove("fc-tts-active");
  karaokeRubies = [];
}

/**
 * Hard-stop any in-flight karaoke playback and drop the active class.
 * Called when the surrounding UI is about to disappear (vocab card
 * dismissed, examples panel collapsed) so a stale highlight or audible
 * speech doesn't outlive the element it was painted onto.
 */
function stopKaraoke(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  clearKaraokeTimers();
  clearKaraokeHighlight();
}

/**
 * Speak the sentence with per-word highlight timing. `segments` drives
 * the timeline: each segment's `text.length` adds to the cumulative
 * character offset, and at that offset the previous ruby's class is
 * cleared and the current segment's ruby (when present) is lit. On
 * end / error / cancellation we drop all classes and timers.
 *
 * Cancels any in-flight utterance first so rapid clicks don't queue.
 * Falls back to a plain speak when the SpeechSynthesisUtterance ctor
 * is missing (jsdom, old browsers) so behavior is still functional.
 */
function speakSentenceWithKaraoke(
  text: string,
  segments: SentenceSegment[],
): void {
  if (!text) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  if (typeof SpeechSynthesisUtterance === "undefined") return;

  const synth = window.speechSynthesis;
  synth.cancel();
  clearKaraokeTimers();
  clearKaraokeHighlight();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = FC_TTS_RATE;

  const msPerChar = FC_MS_PER_CHAR_AT_RATE_1 / utterance.rate;

  utterance.onstart = () => {
    let cursor = 0;
    for (const seg of segments) {
      const offsetMs = cursor * msPerChar;
      const segEl = seg.element;
      const id = window.setTimeout(() => {
        clearKaraokeHighlight();
        if (segEl) {
          segEl.classList.add("fc-tts-active");
          karaokeRubies.push(segEl);
        }
      }, offsetMs);
      karaokeTimers.push(id);
      cursor += seg.text.length;
    }
  };

  const cleanup = () => {
    clearKaraokeTimers();
    clearKaraokeHighlight();
  };
  utterance.onend = cleanup;
  utterance.onerror = cleanup;

  synth.speak(utterance);
}

/**
 * Builds the small Feather-style speaker button reused for the word
 * and the example sentence on both faces. When `segments` is provided
 * the click runs the karaoke speaker (per-word highlight); otherwise
 * a plain speakChinese is used (correct for the single-word button).
 */
function buildTtsButton(
  text: string,
  label: string,
  segments?: SentenceSegment[],
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "fc-tts-btn fc-tts-btn-inline";
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
    '<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
    "</svg>";
  btn.addEventListener("click", (e) => {
    // Prevent the click from bubbling to any parent click-flow handler
    // (e.g. a future "tap card to flip" listener) that we don't want
    // to fire when the user just wants to play audio.
    e.stopPropagation();
    if (segments && segments.length > 0) {
      speakSentenceWithKaraoke(text, segments);
    } else {
      speakChinese(text);
    }
  });
  return btn;
}

/**
 * Paints the green/red progress-bar segments based on session results.
 * Each segment's width is its share of the total deck (in percent), so
 * the green slice plus red slice plus untouched gray track add up to
 * 100%. Idempotent and cheap; called from showCard, answerCard, and
 * rewindCard so the bar always matches results.
 *
 * No-op when the bar elements aren't in the DOM (some test scaffolds
 * mount a minimal session without the header) so callers don't need
 * defensive checks at the call sites.
 */
function updateProgressBar(els: ReturnType<typeof getElements>): void {
  if (!session) return;
  if (!els.fcProgressBarCorrect || !els.fcProgressBarWrong) return;
  const total = session.cards.length;
  if (total === 0) {
    els.fcProgressBarCorrect.style.width = "0%";
    els.fcProgressBarWrong.style.width = "0%";
    return;
  }
  let right = 0;
  let wrong = 0;
  for (const r of session.results) {
    if (r === "right") right++;
    else wrong++;
  }
  els.fcProgressBarCorrect.style.width = `${(right / total) * 100}%`;
  els.fcProgressBarWrong.style.width = `${(wrong / total) * 100}%`;
}

/**
 * Disables the rewind button when there is nothing to rewind to (i.e.
 * results.length === 0 — first card, untouched). Otherwise enables it.
 * Visibility is preserved so the layout stays stable across the first
 * answer; only the disabled attribute toggles.
 */
function updateRewindButton(els: ReturnType<typeof getElements>): void {
  if (!session || !els.fcRewind) return;
  els.fcRewind.disabled = session.results.length === 0;
}

function flipCard(els: ReturnType<typeof getElements>): void {
  if (!session) return;
  // True toggle: flipping after the answer is showing returns to the
  // front face. Judge buttons remain visible either way -- the flow is
  // honor-system, so the user can answer from either side.
  //
  // The example block (sentence + ruby + translation) is rendered once
  // per card by showCard and stays put across flips; flipping toggles
  // fc-answer (pinyin + definition) and the .fc-front-mode class on
  // fc-example, which CSS uses to hide rt + the translation while
  // we're on the front face so the sentence shows plain characters.
  session.isFlipped = !session.isFlipped;
  els.fcAnswer.classList.toggle("hidden", !session.isFlipped);
  if (els.fcExample) {
    els.fcExample.classList.toggle("fc-front-mode", !session.isFlipped);
  }
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
  const sentenceSegments = renderHighlightedSentence(
    sentenceEl,
    example.sentence,
    card.chars,
    settings.pinyinStyle,
  );
  slot.appendChild(sentenceEl);
  slot.appendChild(buildTtsButton(example.sentence, "Play sentence", sentenceSegments));

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

  // Snapshot BEFORE the storage write so rewind can restore the
  // pre-answer SRS state. Same shape regardless of correct/wrong --
  // applyReviewResult mutates intervalDays / nextDueAt / wrongStreak /
  // totalReviews / totalCorrect, so all five are captured.
  session.history.push({
    intervalDays: card.intervalDays ?? 0,
    nextDueAt: card.nextDueAt ?? 0,
    wrongStreak: card.wrongStreak ?? 0,
    totalReviews: card.totalReviews ?? 0,
    totalCorrect: card.totalCorrect ?? 0,
  });

  session.results.push(correct ? "right" : "wrong");
  await updateFlashcardResult(card.chars, correct);

  // Mirror the persisted change onto our in-memory card so a rewind +
  // re-answer captures a fresh, accurate snapshot the second time
  // through. Without this, history.push would re-record the original
  // pre-session values on the next answer, drifting the rewind from
  // what's on disk.
  const next = applyReviewResult(card, correct, Date.now());
  card.intervalDays = next.intervalDays;
  card.nextDueAt = next.nextDueAt;
  card.wrongStreak = next.wrongStreak;
  card.totalReviews = next.totalReviews;
  card.totalCorrect = next.totalCorrect;

  if (session.currentIndex + 1 < session.cards.length) {
    session.currentIndex++;
    showCard(els);
  } else {
    showSummary(els);
  }
}

/**
 * Walks one step backwards through the session: pops the last result
 * + snapshot, restores the previous card's SRS state in storage, and
 * re-renders that card's question side. Order is preserved because
 * `session.cards` is built once in startSession and never mutated --
 * rewind only moves currentIndex.
 *
 * Safe to call when there's nothing to rewind (no-op). Also safe from
 * the summary screen: the summary is hidden, the session view is
 * brought back, and the just-answered final card is restored.
 */
async function rewindCard(els: ReturnType<typeof getElements>): Promise<void> {
  if (!session) return;
  if (session.results.length === 0) return;

  // Pop the trailing result + snapshot for the card we're undoing.
  session.results.pop();
  const snapshot = session.history.pop()!;

  // If we're on the summary screen, currentIndex still points to the
  // last card (showSummary doesn't advance past the deck). In that
  // case the card-to-restore is exactly cards[currentIndex]. Otherwise
  // we just answered a card and advanced one slot; step back to the
  // card whose answer we're undoing.
  const onSummary = !els.fcSummary.classList.contains("hidden");
  if (!onSummary) {
    session.currentIndex = Math.max(0, session.currentIndex - 1);
  }

  const restoredCard = session.cards[session.currentIndex];
  await restoreFlashcardState(restoredCard.chars, snapshot);

  // Mirror the restore onto the in-memory card so a re-answer captures
  // a fresh snapshot built from the actual current state.
  restoredCard.intervalDays = snapshot.intervalDays;
  restoredCard.nextDueAt = snapshot.nextDueAt;
  restoredCard.wrongStreak = snapshot.wrongStreak;
  restoredCard.totalReviews = snapshot.totalReviews;
  restoredCard.totalCorrect = snapshot.totalCorrect;

  if (onSummary) {
    els.fcSummary.classList.add("hidden");
    els.fcSession.classList.remove("hidden");
  }

  showCard(els);
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

  if (els.fcReviewWrong) {
    if (wrongCards.length === 0) {
      els.fcReviewWrong.classList.add("hidden");
    } else {
      els.fcReviewWrong.textContent = `Review ${wrongCards.length} missed`;
      els.fcReviewWrong.classList.remove("hidden");
    }
  }

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
    history: [],
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

    // Honor-system flow: shortcuts work regardless of which face is
    // showing. Space/Enter toggles the flip; 1/← grades wrong; 2/→
    // grades right -- the user can answer without ever flipping.
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      flipCard(els);
    } else if (e.key === "ArrowLeft" || e.key === "1") {
      e.preventDefault();
      answerCard(false, els);
    } else if (e.key === "ArrowRight" || e.key === "2") {
      e.preventDefault();
      answerCard(true, els);
    }
  });
}

// ─── Manage popover (Import / Export / Clear) ────────────────────────
// Right-edge kebab on the vocab tab opens a single popover that swaps
// between three panels in place:
//
//   menu          → Import / Export / Clear…
//   clear-select  → timeline + "Only Not reviewed" + Clear N entries
//   clear-confirm → "Are you sure?" with No / Hold-to-delete Yes
//
// Import and Export close the popover and leave a brief inline message
// in #io-status. Clear advances to the clear-select state and from
// there to clear-confirm. The Yes button on clear-confirm requires
// CLEAR_HOLD_DURATION_MS of continuous pointer/mouse hold before
// firing; releasing early cancels and snaps the fill back. The same
// confirmation path is used regardless of how many entries are being
// removed.
//
// Esc steps back one state (clear-confirm → clear-select → menu →
// closed) and cancels any in-flight hold; outside-click closes the
// whole popover.

const CLEAR_HOLD_DURATION_MS = 2000;

type ManageState = "menu" | "clear-select" | "clear-confirm";

function parseClearTimelineDays(value: string | undefined): number | "all" {
  if (value === "all") return "all";
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Returns the entries that match the current popover selection. Pure
 * read of `vocab` — used both for the live count on the execute button
 * and for collecting the chars-keys to pass to removeWords on confirm.
 */
function selectClearTargets(
  vocab: VocabEntry[],
  timelineDays: number | "all",
  onlyNotReviewed: boolean,
  now: number = Date.now(),
): VocabEntry[] {
  return vocab.filter((entry) => {
    if (onlyNotReviewed && getVocabBucket(entry) !== "not-reviewed") return false;
    if (timelineDays === "all") return true;
    const cutoff = now - timelineDays * 86_400_000;
    return entry.lastSeen < cutoff;
  });
}

function isManagePopoverOpen(els: ReturnType<typeof getElements>): boolean {
  return !!els.managePopover && !els.managePopover.classList.contains("hidden");
}

/**
 * Show exactly one of the three panels inside the popover. Swapping
 * states never closes the popover; closing is a separate concern.
 */
function showManageState(
  els: ReturnType<typeof getElements>,
  state: ManageState,
): void {
  els.manageMenuPanel?.classList.toggle("hidden", state !== "menu");
  els.clearSelectPanel?.classList.toggle("hidden", state !== "clear-select");
  els.clearConfirmPanel?.classList.toggle("hidden", state !== "clear-confirm");
  // Any state change cancels a half-finished hold animation.
  els.clearConfirmYes?.classList.remove("holding");
}

function closeManagePopover(els: ReturnType<typeof getElements>): void {
  if (!els.managePopover) return;
  els.managePopover.classList.add("hidden");
  els.manageToggle?.setAttribute("aria-expanded", "false");
  els.clearVocabBtn?.setAttribute("aria-expanded", "false");
  // Reset to the menu state so reopening doesn't drop the user back
  // mid-flow on a previous open.
  showManageState(els, "menu");
}

function openManagePopover(els: ReturnType<typeof getElements>): void {
  if (!els.managePopover) return;
  els.managePopover.classList.remove("hidden");
  els.manageToggle?.setAttribute("aria-expanded", "true");
  showManageState(els, "menu");
}

/**
 * Recomputes the live count on the "Clear N entries" execute button and
 * its enabled state. Confirmation is now handled by the second-step
 * panel, so the execute button only gates on whether anything matches.
 */
async function refreshClearPopoverState(
  els: ReturnType<typeof getElements>,
): Promise<void> {
  if (!els.clearExecute || !els.clearTimeline) return;
  const timeline = parseClearTimelineDays(els.clearTimeline.value);
  const onlyNotReviewed = !!els.clearOnlyNotReviewed?.checked;

  const vocab = await getAllVocab();
  const targets = selectClearTargets(vocab, timeline, onlyNotReviewed);
  const count = targets.length;

  els.clearExecute.textContent = `Clear ${count} ${count === 1 ? "entry" : "entries"}`;
  els.clearExecute.disabled = count === 0;
  els.clearExecute.classList.toggle("clear-execute-btn-armed", count > 0);
}

/**
 * Returns the current state of the manage popover, or null when the
 * popover is closed. Used to drive Esc-stepping and outside-click
 * dismissal without a separate state variable.
 */
function getManageState(
  els: ReturnType<typeof getElements>,
): ManageState | null {
  if (!isManagePopoverOpen(els)) return null;
  if (els.clearConfirmPanel && !els.clearConfirmPanel.classList.contains("hidden")) {
    return "clear-confirm";
  }
  if (els.clearSelectPanel && !els.clearSelectPanel.classList.contains("hidden")) {
    return "clear-select";
  }
  return "menu";
}

function setupManagePopover(els: ReturnType<typeof getElements>): void {
  // Older callers / minimal test fixtures may not include the popover
  // markup; fall back to the simple confirm() flow so the page still
  // works without the new UI mounted.
  if (
    !els.managePopover ||
    !els.manageAnchor ||
    !els.manageToggle ||
    !els.manageMenuPanel ||
    !els.clearTimeline ||
    !els.clearExecute ||
    !els.clearSelectPanel ||
    !els.clearConfirmPanel ||
    !els.clearConfirmYes ||
    !els.clearConfirmNo
  ) {
    els.clearVocabBtn?.addEventListener("click", async () => {
      if (confirm("Clear all recorded words?")) {
        await clearVocab();
        renderVocabList(els);
      }
    });
    els.exportBtn?.addEventListener("click", () => handleExport(els));
    els.importBtn?.addEventListener("click", () => els.importFileInput?.click());
    els.importFileInput?.addEventListener("change", async () => {
      const file = els.importFileInput?.files?.[0];
      if (file) {
        await handleImport(file, els);
        if (els.importFileInput) els.importFileInput.value = "";
      }
    });
    return;
  }

  // Open / close the popover from the kebab. Reopening always lands
  // on the menu state — closeManagePopover resets it.
  els.manageToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isManagePopoverOpen(els)) {
      cancelHold();
      closeManagePopover(els);
    } else {
      openManagePopover(els);
    }
  });

  // Import / Export close the popover and let #io-status carry the
  // result. Import opens the OS file dialog via the hidden input.
  els.exportBtn?.addEventListener("click", () => {
    closeManagePopover(els);
    void handleExport(els);
  });
  els.importBtn?.addEventListener("click", () => {
    closeManagePopover(els);
    els.importFileInput?.click();
  });
  els.importFileInput?.addEventListener("change", async () => {
    const file = els.importFileInput?.files?.[0];
    if (file) {
      await handleImport(file, els);
      if (els.importFileInput) els.importFileInput.value = "";
    }
  });

  // Menu → clear-select: refresh the live count using the current
  // timeline default before the user sees the panel.
  els.clearVocabBtn?.addEventListener("click", () => {
    showManageState(els, "clear-select");
    void refreshClearPopoverState(els);
  });

  els.clearBack?.addEventListener("click", () => {
    cancelHold();
    showManageState(els, "menu");
  });

  els.clearTimeline.addEventListener("change", () => {
    void refreshClearPopoverState(els);
  });
  els.clearOnlyNotReviewed?.addEventListener("change", () => {
    void refreshClearPopoverState(els);
  });

  // Keep clicks inside the popover from bubbling to the outside-click
  // handler that closes it.
  els.managePopover.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // clear-select → clear-confirm: read the current target snapshot,
  // swap to the confirm panel, and freeze the snapshot so a concurrent
  // vocab-store mutation between the confirm dialog opening and the
  // hold completing doesn't change the outcome under the user's
  // fingers.
  let pendingTargets: VocabEntry[] = [];
  let pendingTimeline: number | "all" = 30;
  let pendingOnlyNotReviewed = false;
  let pendingTotal = 0;

  els.clearExecute.addEventListener("click", async () => {
    if (!els.clearTimeline || !els.clearConfirmCount) return;
    const timeline = parseClearTimelineDays(els.clearTimeline.value);
    const onlyNotReviewed = !!els.clearOnlyNotReviewed?.checked;
    const vocab = await getAllVocab();
    const targets = selectClearTargets(vocab, timeline, onlyNotReviewed);
    if (targets.length === 0) return;

    pendingTargets = targets;
    pendingTimeline = timeline;
    pendingOnlyNotReviewed = onlyNotReviewed;
    pendingTotal = vocab.length;

    els.clearConfirmCount.textContent =
      `${targets.length} ${targets.length === 1 ? "entry" : "entries"}`;
    showManageState(els, "clear-confirm");
  });

  els.clearConfirmNo.addEventListener("click", () => {
    cancelHold();
    showManageState(els, "clear-select");
  });

  // Hold-to-confirm: a single setTimeout for the full 2s. The CSS
  // transition on the fill provides the visual; releasing or leaving
  // the button before the timer fires cancels both. We listen on
  // pointer events so mouse, touch, and pen all work consistently —
  // jsdom dispatches them in tests too.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    els.clearConfirmYes?.classList.remove("holding");
  }

  async function fireClear(): Promise<void> {
    holdTimer = null;
    els.clearConfirmYes?.classList.remove("holding");
    if (pendingTargets.length === 0) {
      closeManagePopover(els);
      return;
    }

    // Fast path: nuking the entire store with no filter. Skips the
    // per-entry walk and lets the storage layer drop the whole key.
    if (
      pendingTimeline === "all" &&
      !pendingOnlyNotReviewed &&
      pendingTargets.length === pendingTotal
    ) {
      await clearVocab();
    } else {
      await removeWords(pendingTargets.map((e) => e.chars));
    }

    const removed = pendingTargets.length;
    showStatus(els, `Cleared ${removed} ${removed === 1 ? "word" : "words"}.`, "success");
    pendingTargets = [];
    closeManagePopover(els);
    await renderVocabList(els);
  }

  function startHold(e: Event): void {
    e.preventDefault();
    if (holdTimer !== null) return;
    els.clearConfirmYes?.classList.add("holding");
    holdTimer = setTimeout(() => {
      void fireClear();
    }, CLEAR_HOLD_DURATION_MS);
  }

  els.clearConfirmYes.addEventListener("pointerdown", startHold);
  els.clearConfirmYes.addEventListener("pointerup", cancelHold);
  els.clearConfirmYes.addEventListener("pointerleave", cancelHold);
  els.clearConfirmYes.addEventListener("pointercancel", cancelHold);
  // Mouse fallback for environments where PointerEvent isn't dispatched
  // (older jsdom, reduced-feature browsers). Identical semantics.
  els.clearConfirmYes.addEventListener("mousedown", startHold);
  els.clearConfirmYes.addEventListener("mouseup", cancelHold);
  els.clearConfirmYes.addEventListener("mouseleave", cancelHold);

  // Outside-click closes the whole popover (cancels any in-flight
  // hold). Escape steps back one state at a time so the user can back
  // out of clear-confirm without losing the timeline they just picked,
  // matching the same pattern used in macOS-style nested menus.
  document.addEventListener("click", (e) => {
    if (!isManagePopoverOpen(els)) return;
    const target = e.target as Node | null;
    if (target && els.manageAnchor?.contains(target)) return;
    cancelHold();
    closeManagePopover(els);
  });
  document.addEventListener("keydown", (e) => {
    const state = getManageState(els);
    if (e.key !== "Escape" || state === null) return;
    cancelHold();
    if (state === "clear-confirm") {
      showManageState(els, "clear-select");
    } else if (state === "clear-select") {
      showManageState(els, "menu");
    } else {
      closeManagePopover(els);
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

function parseImportedExamples(raw: unknown): VocabExample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VocabExample[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const ex = item as Record<string, unknown>;
    if (typeof ex.sentence !== "string" || ex.sentence.length === 0) continue;
    const capturedAt = typeof ex.capturedAt === "number" ? ex.capturedAt : Date.now();
    const parsed: VocabExample = { sentence: ex.sentence, capturedAt };
    if (typeof ex.translation === "string" && ex.translation.length > 0) {
      parsed.translation = ex.translation;
    }
    out.push(parsed);
  }
  return out.length > 0 ? out : undefined;
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

  const entries: VocabEntry[] = valid.map((e) => {
    const raw = e as Record<string, unknown>;
    const entry: VocabEntry = {
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
    const examples = parseImportedExamples(raw.examples);
    if (examples) entry.examples = examples;
    return entry;
  });

  const result = await importVocab(entries);
  showStatus(els, `Imported ${result.added + result.updated} words (${result.added} new, ${result.updated} updated).`, "success");
  await renderVocabList(els);
}

// ─── Initialization ──────────────────────────────────────────────────

export async function initHub(): Promise<void> {
  const els = getElements();
  await applyTheme();

  // Fire-and-forget CC-CEDICT load so vocab cards can render dictionary
  // modifiers (classifiers, "abbr. for", etc.) live without per-entry
  // storage. The card's modifier section retroactively populates if the
  // dictionary lands while a card is already open.
  void ensureDictionaryLoaded().catch((err) => {
    console.warn("[hub] CC-CEDICT load failed; vocab cards will skip modifier rows.", err);
  });

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
  setupVocabSearch(els);
  setupManagePopover(els);

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
  els.fcRewind?.addEventListener("click", () => void rewindCard(els));

  // Word-level TTS lives in the static header next to fc-chars and is
  // wired once. The handler reads the current card from `session` at
  // click time so it picks up rewinds / advances without re-binding.
  els.fcTtsWord?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!session) return;
    speakChinese(session.cards[session.currentIndex].chars);
  });
  els.fcAgain.addEventListener("click", () => {
    selectedSize = lastSelectedSize;
    showSetup(els);
  });
  els.fcReviewWrong?.addEventListener("click", () => {
    if (!session) return;
    const wrongCards = session.cards.filter(
      (_, i) => session!.results[i] === "wrong",
    );
    if (wrongCards.length === 0) return;
    session = {
      cards: wrongCards,
      currentIndex: 0,
      results: [],
      isFlipped: false,
      history: [],
    };
    els.fcSetup.classList.add("hidden");
    els.fcSummary.classList.add("hidden");
    els.fcSession.classList.remove("hidden");
    showCard(els);
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
