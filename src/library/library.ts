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

import { initReader } from "../reader/reader";
import { initHub, refreshVocabView, refreshFlashcardsView } from "../hub/hub";

type LibraryTab = "reader" | "vocab" | "flashcards";

const VALID_TABS: ReadonlySet<LibraryTab> = new Set(["reader", "vocab", "flashcards"]);

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
  }
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
 * Resolve the user's theme preference to a concrete CSS state.
 *
 * Reader.css only defines its CSS custom properties (--bg, --text,
 * --border, --accent, --surface, --pinyin, --sidebar-bg, --toolbar-
 * bg) for body[data-theme="light"|"dark"|"sepia"]. If we leave the
 * body in "auto", those vars are undefined inside the reader pane,
 * which makes the settings panel transparent (`background: var(--bg)`)
 * and erases the drop-zone border (`border: 2px dashed var(--border)`).
 *
 * To keep reader.css, hub.css, and library.css all aligned we resolve
 * "auto" to "light" or "dark" via prefers-color-scheme before writing
 * to body[data-theme]. "sepia" is reader-only but valid; pass through.
 */
function resolveTheme(theme: string): "light" | "dark" | "sepia" {
  if (theme === "light" || theme === "dark" || theme === "sepia") return theme;
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

async function applyCanonicalTheme(): Promise<void> {
  const stored = await chrome.storage.sync.get("theme");
  const theme = (stored.theme as string) ?? "auto";
  document.body.setAttribute("data-theme", resolveTheme(theme));
}

// ─── Init ──────────────────────────────────────────────────────────

export async function initLibrary(): Promise<void> {
  await initReader();
  await initHub();
  setupLibraryTabs();
  setupCrossTabBridges();
  await applyCanonicalTheme();
  activateLibraryTab(getInitialTab());
}

// ─── Auto-init ─────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initLibrary();
});
