/**
 * Library page entry point -- the unified Reader + Vocab + Flashcards
 * shell. Hosts both initReader() and initHub() inside one tabbed
 * full-page app so the user can flip between features without losing
 * state (e.g. an open EPUB stays mounted while reviewing vocab).
 *
 * Lazy/eager strategy: both initReader and initHub run on load. The
 * reader DOM stays mounted across tab switches so the EPUB renderer
 * doesn't re-parse the spine each time the user comes back.
 *
 * Initial tab is taken from the ?tab= query param (reader|vocab|
 * flashcards), defaulting to "reader". A small bridge syncs the
 * Hub's "Back to List" button (which restores the vocab pane in
 * hub.ts) with the library-level tab indicator.
 */

import {
  initReader,
  captureReaderState,
  restoreReaderPosition,
  migrateThemeIfNeeded,
} from "../reader/reader";
import { initHub, refreshVocabView, refreshFlashcardsView } from "../hub/hub";
import { initFamilies, refreshFamiliesView } from "../hub/families";
import { resolveEffectiveTheme } from "../shared/theme";
import type { ReaderSettings } from "../reader/reader-types";

type LibraryTab = "reader" | "vocab" | "flashcards" | "families";

const VALID_TABS: ReadonlySet<LibraryTab> = new Set([
  "reader",
  "vocab",
  "flashcards",
  "families",
]);

/**
 * Tracks the previously active library tab so activateLibraryTab can
 * detect *transitions* (leaving the reader, entering the reader) and
 * snapshot/restore the reader's exact position. Without this snapshot
 * epub.js's internal window-resize handler can collapse the user back
 * to the spine-item start when the reader pane comes back -- even
 * with the CSS pane-hiding fix, because epub.js's resize→clear→
 * display(start.cfi) chain doesn't depend on the iframe being 0x0.
 *
 * Initialized to null so the first activateLibraryTab call (during
 * initLibrary) doesn't try to capture before any state exists.
 */
let activeLibraryTab: LibraryTab | null = null;

// ─── Tab switching ─────────────────────────────────────────────────

function getTabButton(tab: LibraryTab): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `.library-tab[data-library-tab="${tab}"]`,
  );
}

function getTabPane(tab: LibraryTab): HTMLElement | null {
  return document.getElementById(`library-pane-${tab}`);
}

export function activateLibraryTab(tab: LibraryTab): void {
  const wasReader = activeLibraryTab === "reader";
  const becomesReader = tab === "reader";

  // Snapshot reader position BEFORE flipping any CSS classes. If we
  // wait, epub.js's window-resize listener may already have fired its
  // clear()+display(start.cfi) chain by the time we read the location,
  // and we'd capture the snapped position instead of the user's real
  // one.
  if (wasReader && !becomesReader) {
    captureReaderState();
  }

  document.querySelectorAll<HTMLButtonElement>(".library-tab").forEach((btn) => {
    const isActive = btn.dataset.libraryTab === tab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });

  document.querySelectorAll<HTMLElement>(".library-pane").forEach((pane) => {
    const matches = pane.id === `library-pane-${tab}`;
    pane.classList.toggle("hidden", !matches);
  });

  // The hub's inner #tab-vocab / #tab-flashcards divs live inside the
  // corresponding library panes and must remain visible. Defensive
  // reset in case any standalone-hub code path adds the .hidden class.
  document.getElementById("tab-vocab")?.classList.remove("hidden");
  document.getElementById("tab-flashcards")?.classList.remove("hidden");

  // Refresh the activated pane's contents so the count/list reflect
  // any changes made elsewhere (e.g. words added while reading, or a
  // freshly stored vocab list on first navigation to the tab).
  if (tab === "vocab") {
    void refreshVocabView();
  } else if (tab === "flashcards") {
    void refreshFlashcardsView();
  } else if (tab === "families") {
    void refreshFamiliesView();
  } else if (tab === "reader" && !wasReader && activeLibraryTab !== null) {
    // Re-assert the reader's position after epub.js's resize handler
    // has had a chance to settle. restoreReaderPosition waits two
    // animation frames internally before applying anchor/location.
    void restoreReaderPosition();
  }

  activeLibraryTab = tab;
}

function setupLibraryTabs(): void {
  document.querySelectorAll<HTMLButtonElement>(".library-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.libraryTab as LibraryTab | undefined;
      if (tab && VALID_TABS.has(tab)) {
        activateLibraryTab(tab);
      }
    });
  });
}

// ─── Cross-tab bridges ─────────────────────────────────────────────

/**
 * The flashcards summary screen has a "Back to List" button (#fc-back)
 * that hub.ts uses to restore the vocab pane and re-render the list.
 * Inside the library shell, we additionally need to update the top-
 * level tab indicator so the user sees "Vocab" highlighted instead of
 * "Flashcards".
 */
function setupCrossTabBridges(): void {
  const fcBack = document.getElementById("fc-back");
  fcBack?.addEventListener("click", () => {
    activateLibraryTab("vocab");
  });

  // The Vocab tab's char detail card emits this event when the user
  // clicks the phonetic-family link. We just flip the active tab here;
  // hub/families.ts dispatches its own openFamilyDetail() right after
  // so the family detail panel is already open by the time the pane
  // becomes visible.
  window.addEventListener("library:switch-tab", (e) => {
    const target = (e as CustomEvent<string>).detail;
    if (
      target === "reader" ||
      target === "vocab" ||
      target === "flashcards" ||
      target === "families"
    ) {
      activateLibraryTab(target);
    }
  });
}

// ─── Initial tab from URL ──────────────────────────────────────────

export function getInitialTab(search: string = window.location.search): LibraryTab {
  const params = new URLSearchParams(search);
  const requested = params.get("tab");
  if (requested && VALID_TABS.has(requested as LibraryTab)) {
    return requested as LibraryTab;
  }
  return "reader";
}

// ─── Theme sync ────────────────────────────────────────────────────

/**
 * Resolve and write the effective body[data-theme]. The result is
 * the same one the reader computes -- two storage keys participate:
 *
 *   chrome.storage.sync.theme           -- canonical light/dark/auto
 *                                          (owned by the popup).
 *   readerSettings.theme === "sepia"    -- reader-only override that
 *                                          takes precedence so the
 *                                          whole library shell tints
 *                                          sepia while reading.
 *
 * Reader.css only defines its CSS custom properties (--bg, --text,
 * --border, --accent, --surface, --pinyin, --sidebar-bg, --toolbar-
 * bg) for body[data-theme="light"|"dark"|"sepia"]. If we leave the
 * body in "auto", those vars are undefined inside the reader pane,
 * which makes the settings panel transparent (`background: var(--bg)`)
 * and erases the drop-zone border (`border: 2px dashed var(--border)`).
 * resolveEffectiveTheme() collapses "auto" to "light"/"dark" via
 * prefers-color-scheme before we write the attribute.
 */
async function applyCanonicalTheme(): Promise<void> {
  const stored = await chrome.storage.sync.get(["theme", "readerSettings"]);
  const sharedTheme = stored.theme as string | undefined;
  const reader = stored.readerSettings as Partial<ReaderSettings> | undefined;
  document.body.setAttribute(
    "data-theme",
    resolveEffectiveTheme(reader?.theme, sharedTheme),
  );
}

/**
 * Bind a chrome.storage.onChanged listener so the body[data-theme]
 * attribute tracks live changes from any surface (popup writes the
 * shared key, the reader settings panel writes either or both keys).
 * Without this the library shell would show a stale theme until the
 * next page reload.
 */
function setupThemeSync(): void {
  if (typeof chrome.storage?.onChanged?.addListener !== "function") return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (!changes.theme && !changes.readerSettings) return;
    void applyCanonicalTheme();
  });
}

// ─── Init ──────────────────────────────────────────────────────────

export async function initLibrary(): Promise<void> {
  // Run the one-shot reader-theme -> shared-theme migration BEFORE
  // initReader/applyCanonicalTheme so the first paint reflects any
  // promoted value rather than briefly showing the un-migrated one.
  await migrateThemeIfNeeded();
  await initReader();
  await initHub();
  initFamilies();
  setupLibraryTabs();
  setupCrossTabBridges();
  await applyCanonicalTheme();
  setupThemeSync();
  activateLibraryTab(getInitialTab());
}

// ─── Auto-init ─────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initLibrary();
});
