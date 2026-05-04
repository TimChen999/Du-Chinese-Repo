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
 * Study session: focused walk through the family's untouched members.
 * Both buttons write into the same SRS pipeline as the regular
 * flashcard tab so a single "Got it" can't bypass spaced retrieval --
 * the family card is the *introduction*, not the consolidation.
 *   "Got it"        — creates a fresh vocab entry and applies one
 *                     correct review (interval = 1 day, bucket =
 *                     needs-improvement). The daily flashcard queue
 *                     then picks it up and advances it to confident
 *                     over the normal ~1 + 2 + 4 + 7 day spacing.
 *   "Need practice" — creates a fresh vocab entry with no review
 *                     applied (bucket = not-reviewed, due now), so the
 *                     next flashcard session surfaces it immediately.
 *
 * State sources (no separate database):
 *   - vocab-store    — confidence/bucket per char
 *   - phonetics-lookup — the family universe
 *   - cedict-lookup    — pinyin / gloss / pinyin formatting
 */

import {
  getAllVocab,
  recordWords,
  updateFlashcardResult,
} from "../background/vocab-store";
import {
  ensureDictionaryLoaded,
  formatPinyin,
  isDictionaryReady,
  lookupExact,
} from "../shared/cedict-lookup";
import {
  charsContaining,
  ensureComponentsLoaded,
  isComponentsReady,
} from "../shared/components-lookup";
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

/**
 * Inverse index: single-char codepoint → every vocab entry whose
 * `chars` field contains it. Lets a member like 学 in its family pick
 * up state from a saved multi-char word like 学习, so the user gets
 * credit for characters they only ever save in compound form.
 *
 * Direct single-char vocab entries appear here too (the entry whose
 * `chars` is exactly the character is one of its containing entries).
 */
let containingEntries: Map<string, VocabEntry[]> = new Map();

async function refreshVocabIndex(): Promise<void> {
  const all = await getAllVocab();
  containingEntries = new Map();
  for (const entry of all) {
    // Iterate by codepoint so supplementary-plane characters survive.
    const cps = Array.from(entry.chars);
    // Dedupe so a repeated character (e.g. 中 in 中共中央) doesn't
    // double-count its containing entry.
    const seen = new Set<string>();
    for (const ch of cps) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      let arr = containingEntries.get(ch);
      if (!arr) {
        arr = [];
        containingEntries.set(ch, arr);
      }
      arr.push(entry);
    }
  }
}

/** Higher rank == stronger evidence the user knows the character. */
const STATE_RANK: Record<MemberState, number> = {
  untouched: 0,
  "not-reviewed": 1,
  "needs-improvement": 2,
  confident: 3,
};

/**
 * Picks the strongest evidence among every saved word that contains
 * the character. A confident multi-char word (e.g. 学习 mature in SRS)
 * promotes its component chars to "confident" in their respective
 * family views -- you don't need to separately drill 学 to deserve
 * credit for it. Direct single-char entries still go through this
 * path naturally, since they appear as their own containing entry.
 */
function memberStateFor(char: string): MemberState {
  const containing = containingEntries.get(char);
  if (!containing || containing.length === 0) return "untouched";
  let best: MemberState = "untouched";
  let bestRank = -1;
  for (const e of containing) {
    const bucket = getVocabBucket(e);
    const rank = STATE_RANK[bucket];
    if (rank > bestRank) {
      bestRank = rank;
      best = bucket;
    }
  }
  return best;
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

/**
 * Six sort modes that line up with the dropdown in library.html. The
 * default depends on the active view -- "leverage" only really makes
 * sense for in-progress, so the renderer falls back to a sensible
 * per-view default when the user hasn't picked a sort yet.
 */
type FamilySort =
  | "leverage"
  | "mastered"
  | "size"
  | "reliability"
  | "frequency"
  | "alpha";

let currentView: FamilyView = "in-progress";
let currentSort: FamilySort = "leverage";
let searchQuery = "";

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

/**
 * Sum of compound-frequency proxies across all members. Bigger value
 * means the family contains more high-coverage characters, i.e. it
 * pays more rent in everyday Chinese. Cached on the FamilyState since
 * computing it is O(members).
 */
const totalFreqCache = new WeakMap<FamilyState, number>();
function totalFreq(s: FamilyState): number {
  let cached = totalFreqCache.get(s);
  if (cached === undefined) {
    cached = 0;
    for (const m of s.members) cached += m.freq;
    totalFreqCache.set(s, cached);
  }
  return cached;
}

/**
 * Per-view default sort. Used when the user opens a sub-tab without
 * changing the dropdown; "leverage" only makes sense in-progress, and
 * "mastered" is meaningless when nothing is mastered yet, so each tab
 * falls back to whatever produces the most useful first row.
 */
function defaultSortFor(view: FamilyView): FamilySort {
  if (view === "in-progress") return "leverage";
  if (view === "mastered") return "size";
  return "reliability";
}

function compareForList(
  a: FamilyState,
  b: FamilyState,
  sort: FamilySort,
): number {
  switch (sort) {
    case "leverage": {
      // Closest to consolidating first: fewer untouched, then more
      // engaged (more warm context to leverage).
      if (a.untouchedCount !== b.untouchedCount)
        return a.untouchedCount - b.untouchedCount;
      if (a.engagedCount !== b.engagedCount)
        return b.engagedCount - a.engagedCount;
      break;
    }
    case "mastered": {
      // Most confident members in absolute count; ties broken by
      // proportion so smaller-but-fully-known families don't get
      // buried behind half-known big ones.
      if (a.confidentCount !== b.confidentCount)
        return b.confidentCount - a.confidentCount;
      const propA = a.confidentCount / Math.max(1, a.members.length);
      const propB = b.confidentCount / Math.max(1, b.members.length);
      if (propA !== propB) return propB - propA;
      break;
    }
    case "size":
      if (a.members.length !== b.members.length)
        return b.members.length - a.members.length;
      break;
    case "reliability":
      if (a.family.reliability !== b.family.reliability)
        return b.family.reliability - a.family.reliability;
      // Stable tiebreaker: bigger families ahead of small noise.
      if (a.members.length !== b.members.length)
        return b.members.length - a.members.length;
      break;
    case "frequency":
      // Sum of CEDICT compound counts across members -- a proxy for
      // how often the family's characters appear in everyday text.
      if (totalFreq(a) !== totalFreq(b)) return totalFreq(b) - totalFreq(a);
      break;
    case "alpha":
      // Falls through to the comp tiebreaker below.
      break;
  }
  return a.comp.localeCompare(b.comp);
}

// ─── Search ──────────────────────────────────────────────────────────

/**
 * Strips combining tone marks and lowercases so a query like "qing"
 * matches stored "Qīng". Mirrors the vocab list's normalizer in
 * hub.ts (kept separate to avoid a cross-module import for one fn).
 */
function normalizeForSearch(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Matches the search query against the family's component, the
 * component's reading (raw and tone-formatted), and every member
 * char + reading. Empty query short-circuits to true.
 */
function matchesSearch(s: FamilyState, query: string): boolean {
  if (!query) return true;
  const needle = normalizeForSearch(query);
  if (!needle) return true;

  if (s.comp.includes(query)) return true;

  const compReadingNumeric = normalizeForSearch(s.family.reading);
  if (compReadingNumeric.includes(needle)) return true;
  const compReadingTones = normalizeForSearch(
    formatPinyin(s.family.reading, "toneMarks"),
  );
  if (compReadingTones.includes(needle)) return true;

  for (const m of s.members) {
    if (m.char.includes(query)) return true;
    const memberNumeric = normalizeForSearch(m.pinyin);
    if (memberNumeric.includes(needle)) return true;
    const memberTones = normalizeForSearch(formatPinyin(m.pinyin, "toneMarks"));
    if (memberTones.includes(needle)) return true;
  }
  return false;
}

// ─── DOM lookup ──────────────────────────────────────────────────────

function getEls() {
  return {
    list: document.getElementById("fm-list") as HTMLDivElement | null,
    rows: document.getElementById("fm-rows") as HTMLDivElement | null,
    viewHint: document.getElementById("fm-view-hint") as HTMLParagraphElement | null,
    subtabs: document.querySelectorAll<HTMLButtonElement>(".fm-subtab"),
    sort: document.getElementById("fm-sort") as HTMLSelectElement | null,
    searchInput: document.getElementById("fm-search-input") as HTMLInputElement | null,
    searchClear: document.getElementById("fm-search-clear") as HTMLButtonElement | null,
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
    .filter((s) => matchesSearch(s, searchQuery))
    .sort((a, b) => compareForList(a, b, currentSort));

  if (states.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fm-empty";
    if (searchQuery) {
      empty.textContent = `No families match "${searchQuery}".`;
    } else {
      empty.textContent =
        currentView === "in-progress"
          ? "No families in progress yet. Save a few characters to your vocab list and they will surface here."
          : currentView === "mastered"
            ? "No mastered families yet. Move every member of a family to confident to see it here."
            : "No families to show.";
    }
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
  if (!isComponentsReady()) {
    void ensureComponentsLoaded().then(() => {
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

  // Decomposition-only siblings: chars that contain this component
  // but aren't phonetic family members (e.g. 章/竟 in 音's family).
  // Useful for visual recognition and disambiguation; clearly
  // separated from the phonetic groups so the user can't mistake
  // them for sound siblings.
  appendDecompositionSection(els.members, activeFamily);

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

/** Hard cap on untouched decomp-only chars rendered. Components like
 *  氵 / 口 contain 400+ chars; an unbounded list would dominate the
 *  family card. Engaged/confident chars are always shown regardless. */
const DECOMP_UNTOUCHED_CAP = 24;

/**
 * Looks up CC-CEDICT pinyin (numeric form) for a single character.
 * Returns null when the dictionary isn't loaded or the char has no
 * entry. Single-char-aware: uses the first reading only.
 */
function readingFor(char: string): string | null {
  const entries = lookupExact(char);
  return entries?.[0]?.pinyinNumeric ?? null;
}

/**
 * True when `char` is a traditional-only form whose simplified
 * counterpart exists as a different character (e.g. 韻 → 韵, 應 → 应,
 * 聽 → 听). Used to keep traditional duplicates out of the
 * decomposition-only section: a simplified-Chinese reader would see
 * 韻 right next to 韵 and reasonably wonder why both are listed.
 *
 * Returns false for chars unchanged across scripts (山, 水), chars
 * with no CEDICT entry, and chars where the dictionary isn't loaded
 * yet -- the safer default is "keep it visible" while data is missing.
 */
function isTraditionalOnly(char: string): boolean {
  const entries = lookupExact(char);
  if (!entries || entries.length === 0) return false;
  // True only when EVERY entry for this char keys it as the
  // traditional form of some other simplified char. If at least one
  // entry uses `char` as its simplified form, treat it as a primary
  // simplified character.
  return entries.every(
    (e) => e.traditional === char && e.simplified !== char,
  );
}

/**
 * Builds the "Also contain X (different sound)" section under the
 * phonetic member groups. Filters the components-inverse-index to the
 * complement of the phonetic family (engaged/confident chars first,
 * then untouched up to a cap, with a "+ N more" indicator).
 */
function appendDecompositionSection(
  container: HTMLElement,
  fam: FamilyState,
): void {
  if (!isComponentsReady()) return;
  const familyMemberSet = new Set(fam.members.map((m) => m.char));
  const all = charsContaining(fam.comp);
  if (all.length === 0) return;

  const withState = all
    .filter((ch) => ch !== fam.comp && !familyMemberSet.has(ch))
    // Drop traditional-only forms whose simplified counterpart would
    // appear above as a phonetic member or below as its own decomp
    // entry; listing both 韻 and 韵 reads as a duplicate.
    .filter((ch) => !isTraditionalOnly(ch))
    .map((ch) => ({ ch, state: memberStateFor(ch) }));
  if (withState.length === 0) return;

  // Sort: any-state-but-untouched first (so the user's known chars
  // surface), then alphabetical (Han codepoint order) within bands.
  withState.sort((a, b) => {
    const aRank = STATE_RANK[a.state];
    const bRank = STATE_RANK[b.state];
    if (aRank !== bRank) return bRank - aRank;
    return a.ch.localeCompare(b.ch);
  });

  // Cap untouched rows; always show engaged ones.
  const visible: { ch: string; state: MemberState }[] = [];
  let untouchedShown = 0;
  for (const item of withState) {
    if (item.state === "untouched") {
      if (untouchedShown >= DECOMP_UNTOUCHED_CAP) continue;
      untouchedShown++;
    }
    visible.push(item);
  }
  const totalUntouched = withState.filter((x) => x.state === "untouched").length;
  const hiddenCount = totalUntouched - untouchedShown;

  const section = document.createElement("div");
  section.className = "fm-member-group fm-decomp-group";

  const heading = document.createElement("div");
  heading.className = "fm-member-group-heading";
  heading.textContent = `Also contain ${fam.comp}`;
  const hint = document.createElement("span");
  hint.className = "fm-member-group-hint";
  hint.textContent =
    " — visually shared but not phonetically related. " +
    "Useful for recognition / disambiguation.";
  heading.appendChild(hint);
  section.appendChild(heading);

  for (const item of visible) {
    section.appendChild(renderDecompRow(item.ch, item.state));
  }

  if (hiddenCount > 0) {
    const more = document.createElement("div");
    more.className = "fm-decomp-more";
    more.textContent = `+ ${hiddenCount} more rare ${
      hiddenCount === 1 ? "character" : "characters"
    }`;
    section.appendChild(more);
  }

  container.appendChild(section);
}

/**
 * Row layout matches renderMemberRow so the decomposition section
 * reads like a continuation of the phonetic groups, but the parent
 * section's `.fm-decomp-group` class lets CSS subtly tint it
 * differently so the visual boundary is obvious.
 */
function renderDecompRow(ch: string, state: MemberState): HTMLElement {
  const row = document.createElement("div");
  row.className = "fm-member-row fm-state-" + state;

  const han = document.createElement("span");
  han.className = "fm-member-han";
  han.textContent = ch;

  const pinyin = document.createElement("span");
  pinyin.className = "fm-member-pinyin";
  const reading = readingFor(ch);
  pinyin.textContent = reading ? formatPinyin(reading, "toneMarks") : "";

  const def = document.createElement("span");
  def.className = "fm-member-def";
  def.textContent = glossFor(ch);

  const status = document.createElement("span");
  status.className = "fm-member-status";
  status.textContent = state === "untouched" ? "Untouched" : bucketLabel(state);

  row.append(han, pinyin, def, status);
  return row;
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

  // Both branches first ensure a vocab entry exists at the not-reviewed
  // baseline. Family study only enqueues untouched members, so this is
  // always a clean insert (recordWords increments count on existing
  // entries; for untouched it doesn't).
  const word = wordDataFor(card.char, card.pinyin);
  await recordWords([word]);
  if (action === "got") {
    // One correct review -- advances to needs-improvement (interval = 1
    // day). The daily flashcard queue then progresses it to confident
    // over the same SRS schedule everything else uses.
    await updateFlashcardResult(card.char, true);
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
        // Pull the dropdown back to the per-view default whenever the
        // user hops sub-tabs -- "leverage" is meaningless on Mastered,
        // and "mastered" is meaningless on In-progress, so silently
        // redirect to whatever produces the most useful first row.
        currentSort = defaultSortFor(v);
        if (els.sort) els.sort.value = currentSort;
        renderList();
      }
    });
  });

  els.sort?.addEventListener("change", () => {
    if (!els.sort) return;
    const v = els.sort.value as FamilySort;
    if (
      v === "leverage" ||
      v === "mastered" ||
      v === "size" ||
      v === "reliability" ||
      v === "frequency" ||
      v === "alpha"
    ) {
      currentSort = v;
      renderList();
    }
  });

  els.searchInput?.addEventListener("input", () => {
    searchQuery = els.searchInput?.value.trim() ?? "";
    if (els.searchClear) {
      els.searchClear.classList.toggle("hidden", searchQuery.length === 0);
    }
    renderList();
  });

  els.searchClear?.addEventListener("click", () => {
    if (!els.searchInput) return;
    els.searchInput.value = "";
    searchQuery = "";
    els.searchClear?.classList.add("hidden");
    els.searchInput.focus();
    renderList();
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
  // The decomposition-only section in the family detail panel needs
  // the components dictionary; trigger the load even if the user
  // never opens a detail card -- it's the same data hub.ts already
  // pulls for the Components dropdown so the round-trip is shared.
  if (!isComponentsReady()) {
    void ensureComponentsLoaded()
      .then(() => {
        if (activeFamily) renderDetail();
      })
      .catch(() => {});
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
