/**
 * Per-file manual bookmark storage.
 *
 * Bookmarks live under `reader_bookmarks_${fileHash}` in chrome.storage.
 * local (not .sync -- we'd outgrow the 100KB total / 8KB per-item caps
 * on a single heavy book). Kept in their own bucket rather than nested
 * inside ReadingState so the curated user list isn't clobbered by the
 * autosave path that overwrites ReadingState every few seconds.
 *
 * The list is read newest-first (sorted by createdAt) and capped at
 * MAX_BOOKMARKS_PER_FILE; when the cap is hit, the oldest entry is
 * dropped before the new one is added. v1 has no UI for "this file's
 * bookmarks list is full" -- the cap is generous (100) and silent
 * eviction is the conventional behavior for cap-enforced lists.
 *
 * deriveLabel() builds a snippet like "...你好,[世界]再见..." that
 * works as a default human-readable identifier when the anchor's word
 * is non-empty. EPUB anchors that lack contextBefore/After (e.g. when
 * the iframe selection couldn't be probed) still get a usable label
 * via the word alone.
 */

import type { BookmarkAnchor, ManualBookmark } from "./reader-types";
import { MAX_BOOKMARKS_PER_FILE } from "./reader-types";

const KEY_PREFIX = "reader_bookmarks_";

function key(fileHash: string): string {
  return `${KEY_PREFIX}${fileHash}`;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for unusual environments (older jsdom in some tests).
  return `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read raw bookmarks for a file. Returned newest-first; absent files
 * yield an empty array (not null) so callers can iterate without a
 * null guard.
 */
export async function listBookmarks(fileHash: string): Promise<ManualBookmark[]> {
  if (!fileHash) return [];
  const k = key(fileHash);
  const result = await chrome.storage.local.get(k);
  const raw = result[k] as ManualBookmark[] | undefined;
  if (!Array.isArray(raw)) return [];
  // Defensive copy + sort so the stored order doesn't matter.
  return [...raw].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Append a new bookmark for `fileHash`. Returns the freshly minted
 * record so the caller can render it without an extra round-trip.
 *
 * `chapter` carries the user-readable location captured at save time
 * (e.g. spine index + TOC label). It's optional so non-reader callers
 * and tests don't have to fabricate it.
 */
export async function addBookmark(
  fileHash: string,
  anchor: BookmarkAnchor,
  label?: string,
  chapter?: { index?: number; label?: string },
): Promise<ManualBookmark> {
  const existing = await listBookmarks(fileHash);
  const bookmark: ManualBookmark = {
    id: newId(),
    fileHash,
    anchor,
    label: (label ?? deriveLabel(anchor)).trim() || deriveLabel(anchor),
    createdAt: Date.now(),
    ...(chapter?.index !== undefined ? { chapterIndex: chapter.index } : {}),
    ...(chapter?.label ? { chapterLabel: chapter.label } : {}),
  };
  // Insert at the front so newest-first order is stable in storage too,
  // even though listBookmarks re-sorts on read.
  const next = [bookmark, ...existing];
  if (next.length > MAX_BOOKMARKS_PER_FILE) {
    // Drop oldest (tail) entries to stay under the cap.
    next.length = MAX_BOOKMARKS_PER_FILE;
  }
  await chrome.storage.local.set({ [key(fileHash)]: next });
  return bookmark;
}

export async function removeBookmark(fileHash: string, id: string): Promise<void> {
  const existing = await listBookmarks(fileHash);
  const next = existing.filter((b) => b.id !== id);
  if (next.length === existing.length) return; // nothing to do
  await chrome.storage.local.set({ [key(fileHash)]: next });
}

/**
 * Build a human-readable snippet for the bookmarks UI. Format:
 *   "...contextBefore[word]contextAfter..."
 * trimmed to ~60 visible characters, with leading/trailing ellipsis
 * preserved when the original snippet was longer than that window.
 *
 * Falls back to the bare word when context is empty (EPUB anchors
 * sometimes lack it) and to "(empty bookmark)" when even the word
 * is absent (defensive -- shouldn't happen in normal flow).
 */
export function deriveLabel(anchor: BookmarkAnchor): string {
  const word = (anchor.word ?? "").trim();
  const before = (anchor.contextBefore ?? "").replace(/\s+/g, " ");
  const after = (anchor.contextAfter ?? "").replace(/\s+/g, " ");

  if (!word && !before && !after) return "(empty bookmark)";

  // Each side gets up to 20 chars, the word fills the middle wrapped
  // in [brackets] so it's visually distinct in dense text.
  const left = before.length > 20 ? `\u2026${before.slice(-20)}` : before;
  const right = after.length > 20 ? `${after.slice(0, 20)}\u2026` : after;
  if (!word) return (left + right).trim() || "(empty bookmark)";
  return `${left}[${word}]${right}`.trim();
}
