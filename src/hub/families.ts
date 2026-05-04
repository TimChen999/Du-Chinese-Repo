/**
 * Families tab — phonetic-component networks as a study surface.
 *
 * Three sub-views live in the same pane:
 *   - in-progress  (default): families where the user has engaged with
 *                  ≥1 member but ≥1 still untouched. Sorted to favour
 *                  families closest to consolidating.
 *   - all:         the full ~600 universe, browseable.
 *   - mastered:    every member is "confident" in SRS.
 *
 * Per-family detail view: members grouped by sound-similarity bucket
 * (exact > tone > initial-shift > final-shift). Each row carries the
 * user's per-character SRS bucket inline.
 *
 * Study session: focused walk through the family's untouched members
 * (or all members on demand). "Got it" promotes a char to confident
 * directly; "Need practice" creates a fresh entry in the daily review
 * queue. Both write to the same vocab-store the Vocab tab reads.
 *
 * State sources (no separate database):
 *   - vocab-store    — confidence/bucket per char
 *   - phonetics-lookup — the family universe
 *   - cedict-lookup    — pinyin / gloss / pinyin formatting
 */

import { getAllVocab, markWordConfident, recordWords } from "../background/vocab-store";
import {
  ensureDictionaryLoaded,
  formatPinyin,
  isDictionaryReady,
  lookupExact,
} from "../shared/cedict-lookup";
import {
  allFamilies,
  ensurePhoneticsLoaded,
  isPhoneticsReady,
  lookupFamily,
  type PhoneticFamily,
  type PhoneticMatch,
  type PhoneticMember,
} from "../shared/phonetics-lookup";
import {
  bucketLabel,
  getVocabBucket,
  type VocabBucket,
} from "../shared/srs";
import type { VocabEntry } from "../shared/types";

// ─── State per character ─────────────────────────────────────────────

/**
 * Five-way per-member state, derived from the vocab-store on render.
 * "engaged" splits into three SRS buckets so the row UI can show the
 * actual progress the user has made (per the design spec: don't
 * collapse to a single dot).
 *
 * untouched         — no vocab entry yet
 * not-reviewed      — saved but never reviewed
 * needs-improvement — short interval or recent wrong answer
 * confident         — interval >= SRS_CONFIDENT_INTERVAL_DAYS, no wrong streak
 */
type MemberState = "untouched" | VocabBucket;

interface MemberWithState extends PhoneticMember {
  state: MemberState;
}

interface FamilyState {
  comp: string;
  family: PhoneticFamily;
  members: MemberWithState[];
  confidentCount: number;
  engagedCount: number;
  untouchedCount: number;
}

/**
 * "Engaged" = the union of three SRS buckets that all mean "the user
 * has made a decision about this char." Used for the In-progress
 * filter, where we want any commitment to count.
 */
function isEngaged(state: MemberState): boolean {
  return state !== "untouched";
}

// ─── Derived state per render ────────────────────────────────────────

let vocabIndex: Map<string, VocabEntry> = new Map();

async function refreshVocabIndex(): Promise<void> {
  const all = await getAllVocab();
  vocabIndex = new Map(all.map((e) => [e.chars, e]));
}

function memberStateFor(char: string): MemberState {
  const entry = vocabIndex.get(char);
  if (!entry) return "untouched";
  return getVocabBucket(entry);
}

function buildFamilyState(comp: string, family: PhoneticFamily): FamilyState {
  let confidentCount = 0;
  let engagedCount = 0;
  let untouchedCount = 0;
  const members: MemberWithState[] = family.members.map((m) => {
    const state = memberStateFor(m.char);
    if (state === "confident") confidentCount++;
    else if (state === "untouched") untouchedCount++;
    else engagedCount++; // not-reviewed or needs-improvement
    return { ...m, state };
  });
  return {
    comp,
    family,
    members,
    confidentCount,
    engagedCount,
    untouchedCount,
  };
}

// ─── View modes ──────────────────────────────────────────────────────

type FamilyView = "in-progress" | "all" | "mastered";

let currentView: FamilyView = "in-progress";

function eligibleForView(s: FamilyState, view: FamilyView): boolean {
  switch (view) {
    case "in-progress": {
      const anyEngaged = s.engagedCount > 0 || s.confidentCount > 0;
      return anyEngaged && s.untouchedCount > 0;
    }
    case "mastered":
      return s.untouchedCount === 0 && s.engagedCount === 0;
    case "all":
      return true;
  }
}

function compareForList(a: FamilyState, b: FamilyState, view: FamilyView): number {
  if (view === "in-progress") {
    // Closest to consolidating first: fewer untouched, then more engaged
    // (more warm context to leverage).
    if (a.untouchedCount !== b.untouchedCount)
      return a.untouchedCount - b.untouchedCount;
    if (a.engagedCount !== b.engagedCount)
      return b.engagedCount - a.engagedCount;
  } else if (view === "mastered") {
    // Bigger families first as a small reward signal.
    if (a.members.length !== b.members.length)
      return b.members.length - a.members.length;
  } else {
    // All view: most reliable, biggest first -- gives a sensible
    // browse order before any user state exists.
    if (a.family.reliability !== b.family.reliability)
      return b.family.reliability - a.family.reliability;
    if (a.members.length !== b.members.length)
      return b.members.length - a.members.length;
  }
  return a.comp.localeCompare(b.comp);
}

// ─── DOM lookup ──────────────────────────────────────────────────────

function getEls() {
  return {
    list: document.getElementById("fm-list") as HTMLDivElement | null,
    rows: document.getElementById("fm-rows") as HTMLDivElement | null,
    viewHint: document.getElementById("fm-view-hint") as HTMLParagraphElement | null,
    subtabs: document.querySelectorAll<HTMLButtonElement>(".fm-subtab"),
    detail: document.getElementById("fm-detail") as HTMLDivElement | null,
    detailGlyph: document.getElementById("fm-detail-glyph") as HTMLSpanElement | null,
    detailPinyin: document.getElementById("fm-detail-pinyin") as HTMLSpanElement | null,
    detailCoverage: document.getElementById("fm-detail-coverage") as HTMLSpanElement | null,
    reliability: document.getElementById("fm-reliability") as HTMLParagraphElement | null,
    members: document.getElementById("fm-members") as HTMLDivElement | null,
    actions: document.getElementById("fm-actions") as HTMLDivElement | null,
    back: document.getElementById("fm-back") as HTMLButtonElement | null,
    study: document.getElementById("fm-study") as HTMLButtonElement | null,
    session: document.getElementById("fm-study-session") as HTMLDivElement | null,
    sessionClose: document.getElementById("fm-study-close") as HTMLButtonElement | null,
    sessionProgress: document.getElementById("fm-study-progress") as HTMLSpanElement | null,
    sessionComp: document.getElementById("fm-study-comp") as HTMLSpanElement | null,
    sessionChar: document.getElementById("fm-study-char") as HTMLDivElement | null,
    sessionPinyin: document.getElementById("fm-study-pinyin") as HTMLDivElement | null,
    sessionDef: document.getElementById("fm-study-def") as HTMLDivElement | null,
    sessionRelation: document.getElementById("fm-study-relation") as HTMLDivElement | null,
    sessionNeed: document.getElementById("fm-study-need") as HTMLButtonElement | null,
    sessionGot: document.getElementById("fm-study-got") as HTMLButtonElement | null,
    summary: document.getElementById("fm-study-summary") as HTMLDivElement | null,
    summaryText: document.getElementById("fm-study-summary-text") as HTMLParagraphElement | null,
    summaryBack: document.getElementById("fm-study-summary-back") as HTMLButtonElement | null,
  };
}

// ─── Render: list ────────────────────────────────────────────────────

const VIEW_HINT: Record<FamilyView, string> = {
  "in-progress":
    "Families where you have engaged with ≥1 character but ≥1 is still untouched.",
  all: "Every phonetic component in the index.",
  mastered: "Every member is confident in your review queue.",
};

function renderList(): void {
  const els = getEls();
  if (!els.rows || !els.viewHint) return;

  els.viewHint.textContent = VIEW_HINT[currentView];

  els.subtabs.forEach((b) => {
    const isActive = b.dataset.fmView === currentView;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", String(isActive));
  });

  while (els.rows.firstChild) els.rows.removeChild(els.rows.firstChild);

  if (!isPhoneticsReady()) {
    const loading = document.createElement("p");
    loading.className = "fm-empty";
    loading.textContent = "Loading phonetic index…";
    els.rows.appendChild(loading);
    return;
  }

  const states = allFamilies()
    .map(([comp, fam]) => buildFamilyState(comp, fam))
    .filter((s) => eligibleForView(s, currentView))
    .sort((a, b) => compareForList(a, b, currentView));

  if (states.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fm-empty";
    empty.textContent =
      currentView === "in-progress"
        ? "No families in progress yet. Save a few characters to your vocab list and they will surface here."
        : currentView === "mastered"
          ? "No mastered families yet. Mark every member of a family confident to see it here."
          : "No families to show.";
    els.rows.appendChild(empty);
    return;
  }

  for (const s of states) {
    els.rows.appendChild(renderListRow(s));
  }
}

function renderListRow(s: FamilyState): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "fm-row";
  row.addEventListener("click", () => openDetail(s.comp));

  const glyph = document.createElement("span");
  glyph.className = "fm-row-glyph";
  glyph.textContent = s.comp;

  const meta = document.createElement("div");
  meta.className = "fm-row-meta";

  const top = document.createElement("div");
  top.className = "fm-row-top";

  const reading = document.createElement("span");
  reading.className = "fm-row-reading";
  reading.textContent = formatPinyin(s.family.reading, "toneMarks");

  const counts = document.createElement("span");
  counts.className = "fm-row-counts";
  counts.textContent = formatCountsLine(s);

  top.append(reading, counts);

  const bar = renderCoverageBar(s);

  meta.append(top, bar);
  row.append(glyph, meta);
  return row;
}

function formatCountsLine(s: FamilyState): string {
  return `${s.confidentCount} confident · ${s.engagedCount} engaged · ${s.untouchedCount} untouched`;
}

function renderCoverageBar(s: FamilyState): HTMLElement {
  const total = s.members.length;
  const bar = document.createElement("div");
  bar.className = "fm-coverage-bar";
  bar.title = `${total} characters total`;
  if (total === 0) return bar;

  const cells: Array<{ cls: string; count: number }> = [
    { cls: "fm-coverage-confident", count: s.confidentCount },
    { cls: "fm-coverage-engaged", count: s.engagedCount },
    { cls: "fm-coverage-untouched", count: s.untouchedCount },
  ];

  for (const cell of cells) {
    if (cell.count <= 0) continue;
    const seg = document.createElement("span");
    seg.className = "fm-coverage-seg " + cell.cls;
    seg.style.flexGrow = String(cell.count);
    bar.appendChild(seg);
  }

  return bar;
}

// ─── Render: detail ──────────────────────────────────────────────────

let activeFamily: FamilyState | null = null;

async function openDetail(comp: string): Promise<void> {
  const fam = lookupFamily(comp);
  if (!fam) return;
  await refreshVocabIndex();
  activeFamily = buildFamilyState(comp, fam);
  showDetail();
}

/**
 * External entry point used by the Vocab tab's char detail card cross-
 * link. Loads the phonetic index if needed, switches to the Families
 * sub-view, and opens the family detail.
 *
 * Accepts the component (e.g. "青") not the member (e.g. "清") -- the
 * caller already knows which family it wants from familiesContaining().
 */
export async function openFamilyDetail(comp: string): Promise<void> {
  if (!isPhoneticsReady()) {
    try {
      await ensurePhoneticsLoaded();
    } catch (err) {
      console.warn("[families] phonetic index failed to load", err);
      return;
    }
  }
  if (!isDictionaryReady()) {
    void ensureDictionaryLoaded().then(() => {
      if (activeFamily?.comp === comp) renderDetail();
    }).catch(() => {});
  }
  await openDetail(comp);
}

function showDetail(): void {
  const els = getEls();
  if (!els.detail || !els.list || !activeFamily) return;
  els.list.classList.add("hidden");
  els.detail.classList.remove("hidden");
  if (els.session) els.session.classList.add("hidden");
  if (els.summary) els.summary.classList.add("hidden");
  renderDetail();
}

function renderDetail(): void {
  const els = getEls();
  if (!activeFamily) return;
  if (!els.members || !els.detailGlyph || !els.detailPinyin || !els.detailCoverage)
    return;

  els.detailGlyph.textContent = activeFamily.comp;
  els.detailPinyin.textContent = formatPinyin(activeFamily.family.reading, "toneMarks");
  els.detailCoverage.textContent = formatCountsLine(activeFamily);

  if (els.reliability) {
    const pct = Math.round(activeFamily.family.reliability * 100);
    if (pct >= 80) {
      els.reliability.textContent = `Reliable phonetic — ${pct}% of containing characters share this sound family.`;
    } else if (pct >= 50) {
      els.reliability.textContent = `Partly reliable — ${pct}% of containing characters share this sound family.`;
    } else {
      els.reliability.textContent = `Low reliability — only ${pct}% of containing characters share this sound. The members below are the genuine phonetic siblings.`;
    }
  }

  // Group members by sound-match bucket so the user sees exact matches
  // first, then drift cases in their own visual cluster.
  while (els.members.firstChild) els.members.removeChild(els.members.firstChild);

  const groups: Record<PhoneticMatch, MemberWithState[]> = {
    exact: [],
    tone: [],
    "initial-shift": [],
    "final-shift": [],
  };
  for (const m of activeFamily.members) groups[m.match].push(m);

  const groupOrder: Array<{ key: PhoneticMatch; title: string; hint?: string }> = [
    { key: "exact", title: "Exact match" },
    { key: "tone", title: "Tone shift" },
    {
      key: "initial-shift",
      title: "Initial shift",
      hint: "The starting consonant differs (a common historical drift).",
    },
    {
      key: "final-shift",
      title: "Final shift",
      hint: "The vowel/ending differs.",
    },
  ];

  for (const grp of groupOrder) {
    const items = groups[grp.key];
    if (items.length === 0) continue;
    const section = document.createElement("div");
    section.className = "fm-member-group";

    const heading = document.createElement("div");
    heading.className = "fm-member-group-heading";
    heading.textContent = grp.title;
    if (grp.hint) {
      const hint = document.createElement("span");
      hint.className = "fm-member-group-hint";
      hint.textContent = " — " + grp.hint;
      heading.appendChild(hint);
    }
    section.appendChild(heading);

    for (const m of items) {
      section.appendChild(renderMemberRow(m));
    }
    els.members.appendChild(section);
  }

  // Action bar — Study (only when there are untouched members)
  if (els.actions) {
    while (els.actions.firstChild) els.actions.removeChild(els.actions.firstChild);
  }
  if (els.study) {
    const untouched = activeFamily.members.filter((m) => m.state === "untouched");
    els.study.hidden = untouched.length === 0;
    els.study.textContent =
      untouched.length === 1
        ? "Study 1 untouched"
        : `Study ${untouched.length} untouched`;
  }
}

function renderMemberRow(m: MemberWithState): HTMLElement {
  const row = document.createElement("div");
  row.className = "fm-member-row fm-state-" + m.state;

  const han = document.createElement("span");
  han.className = "fm-member-han";
  han.textContent = m.char;

  const pinyin = document.createElement("span");
  pinyin.className = "fm-member-pinyin";
  pinyin.textContent = formatPinyin(m.pinyin, "toneMarks");

  const def = document.createElement("span");
  def.className = "fm-member-def";
  def.textContent = glossFor(m.char);

  const status = document.createElement("span");
  status.className = "fm-member-status";
  status.textContent = m.state === "untouched" ? "Untouched" : bucketLabel(m.state);

  row.append(han, pinyin, def, status);
  return row;
}

function glossFor(char: string): string {
  const entries = lookupExact(char);
  const first = entries?.[0];
  if (!first) return "";
  const defs = first.definitions.slice(0, 2).join("; ");
  if (defs) return defs;
  // Short fallback when the entry only carries cross-references --
  // showing nothing would leave a blank column.
  return first.modifiers[0] ? "(see dictionary)" : "";
}

// ─── Study session ───────────────────────────────────────────────────

interface SessionState {
  comp: string;
  reading: string;
  queue: PhoneticMember[];
  index: number;
}

let session: SessionState | null = null;

function startSession(): void {
  if (!activeFamily) return;
  const queue = activeFamily.members
    .filter((m) => m.state === "untouched")
    .map((m) => ({ char: m.char, pinyin: m.pinyin, match: m.match, freq: m.freq }));
  if (queue.length === 0) return;

  session = {
    comp: activeFamily.comp,
    reading: activeFamily.family.reading,
    queue,
    index: 0,
  };

  const els = getEls();
  if (els.detail) els.detail.classList.add("hidden");
  if (els.session) els.session.classList.remove("hidden");
  if (els.summary) els.summary.classList.add("hidden");
  renderStudyCard();
}

function renderStudyCard(): void {
  const els = getEls();
  if (!session) return;
  if (
    !els.sessionProgress ||
    !els.sessionChar ||
    !els.sessionPinyin ||
    !els.sessionDef ||
    !els.sessionRelation ||
    !els.sessionComp
  )
    return;

  if (session.index >= session.queue.length) {
    finishSession();
    return;
  }

  const card = session.queue[session.index];
  els.sessionProgress.textContent = `${session.index + 1} / ${session.queue.length}`;
  els.sessionComp.textContent =
    `${session.comp} ${formatPinyin(session.reading, "toneMarks")} family`;
  els.sessionChar.textContent = card.char;
  els.sessionPinyin.textContent = formatPinyin(card.pinyin, "toneMarks");
  els.sessionDef.textContent = glossFor(card.char);
  els.sessionRelation.textContent = relationHint(card.match, session.reading, card.pinyin);
}

function relationHint(match: PhoneticMatch, base: string, member: string): string {
  const baseStripped = stripTone(base);
  const memberStripped = stripTone(member);
  switch (match) {
    case "exact":
      return `Exact match — sounds the same as ${formatPinyin(base, "toneMarks")}.`;
    case "tone":
      return `Same syllable, different tone (${baseStripped}).`;
    case "initial-shift":
      return `Same final, initial shifted — common historical drift.`;
    case "final-shift":
      return `Same initial, final shifted — ${memberStripped} vs ${baseStripped}.`;
  }
}

function stripTone(pinyinNumeric: string): string {
  return pinyinNumeric.replace(/[0-5]/g, "").toLowerCase();
}

async function answerCard(action: "got" | "need"): Promise<void> {
  if (!session) return;
  const card = session.queue[session.index];
  if (!card) return;

  const word = wordDataFor(card.char, card.pinyin);
  if (action === "got") {
    await markWordConfident(word);
  } else {
    // "Need practice" — record as fresh entry in the queue (not-reviewed
    // bucket). recordWords increments count if it already exists; for
    // untouched members it doesn't, so this is a clean insert.
    await recordWords([word]);
  }

  session.index++;
  renderStudyCard();
}

function wordDataFor(
  char: string,
  pinyinNumeric: string,
): { chars: string; pinyin: string; definition: string } {
  const entries = lookupExact(char);
  const first = entries?.[0];
  const def = first ? first.definitions.slice(0, 2).join("; ") : "";
  return {
    chars: char,
    pinyin: formatPinyin(pinyinNumeric, "toneMarks"),
    definition: def,
  };
}

async function finishSession(): Promise<void> {
  const els = getEls();
  if (!session) return;
  const total = session.queue.length;
  if (els.session) els.session.classList.add("hidden");
  if (els.summary) els.summary.classList.remove("hidden");
  if (els.summaryText) {
    els.summaryText.textContent =
      total === 1
        ? `1 character processed in the ${session.comp} family.`
        : `${total} characters processed in the ${session.comp} family.`;
  }
  // Refresh underlying state so a return to the detail view shows the
  // new bucket badges.
  await refreshVocabIndex();
  if (activeFamily) {
    activeFamily = buildFamilyState(activeFamily.comp, activeFamily.family);
  }
}

function endSessionAndReturn(): void {
  session = null;
  const els = getEls();
  if (els.session) els.session.classList.add("hidden");
  if (els.summary) els.summary.classList.add("hidden");
  if (activeFamily) {
    showDetail();
  } else {
    closeDetail();
  }
}

function closeDetail(): void {
  const els = getEls();
  if (!els.detail || !els.list) return;
  activeFamily = null;
  els.detail.classList.add("hidden");
  if (els.session) els.session.classList.add("hidden");
  if (els.summary) els.summary.classList.add("hidden");
  els.list.classList.remove("hidden");
  void refreshFamiliesView();
}

// ─── Setup ───────────────────────────────────────────────────────────

let initialized = false;

export function initFamilies(): void {
  if (initialized) return;
  initialized = true;

  const els = getEls();
  els.subtabs.forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.dataset.fmView as FamilyView | undefined;
      if (v === "in-progress" || v === "all" || v === "mastered") {
        currentView = v;
        renderList();
      }
    });
  });

  els.back?.addEventListener("click", () => closeDetail());
  els.study?.addEventListener("click", () => startSession());
  els.sessionClose?.addEventListener("click", () => endSessionAndReturn());
  els.sessionGot?.addEventListener("click", () => void answerCard("got"));
  els.sessionNeed?.addEventListener("click", () => void answerCard("need"));
  els.summaryBack?.addEventListener("click", () => endSessionAndReturn());
}

/**
 * Re-renders the families list against the live vocab store. Called by
 * the library shell when the user activates the Families tab so the
 * state badges always reflect any vocab/SRS changes made elsewhere.
 *
 * Loads the dictionaries on first call (CEDICT for glosses, phonetics
 * for the family universe). Both loaders are idempotent.
 */
export async function refreshFamiliesView(): Promise<void> {
  await refreshVocabIndex();
  if (!isDictionaryReady()) {
    void ensureDictionaryLoaded().then(() => renderList()).catch(() => {});
  }
  if (!isPhoneticsReady()) {
    try {
      await ensurePhoneticsLoaded();
    } catch (err) {
      console.warn("[families] phonetic index failed to load", err);
    }
  }
  renderList();
}
