/**
 * Type definitions for the built-in file reader.
 *
 * FormatRenderer is the adapter interface that each file format implements.
 * The reader shell operates exclusively through this interface, so adding a
 * new format only requires a new class + registry entry.
 *
 * See: READER_SPEC.md Section 3 "Architecture" for the adapter pattern,
 *      READER_SPEC.md Section 10 "Reading State Persistence" for state types.
 */

export type ReaderTheme = "light" | "dark" | "sepia" | "auto";

export interface TocEntry {
  label: string;
  href: string;
  level: number;
  children?: TocEntry[];
}

export interface BookMetadata {
  title: string;
  author: string;
  language?: string;
  coverUrl?: string;
  toc: TocEntry[];
  totalChapters: number;
  currentChapter: number;
}

export interface FormatRenderer {
  readonly formatName: string;
  readonly extensions: string[];

  load(file: File): Promise<BookMetadata>;
  renderTo(container: HTMLElement): Promise<void>;
  goTo(location: string | number): Promise<void>;
  next(): Promise<boolean>;
  prev(): Promise<boolean>;
  getCurrentLocation(): string;
  getVisibleText(): string;
  getSpineIndex(href: string): number;
  onRelocated(callback: (spineIndex: number) => void): void;
  applySettings(settings: ReaderSettings): void;
  resize(): void | Promise<void>;
  destroy(): void;
}

export interface ReadingState {
  fileHash: string;
  fileName: string;
  title: string;
  author: string;
  location: string;
  currentChapter: number;
  totalChapters: number;
  lastOpened: number;
  coverDataUrl?: string;
}

export interface ReaderSettings {
  fontSize: number;
  fontFamily: string;
  lineSpacing: number;
  theme: ReaderTheme;
  readingMode: "scroll" | "paginated";
  pinyinEnabled: boolean;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: "system",
  lineSpacing: 1.8,
  theme: "auto",
  readingMode: "scroll",
  pinyinEnabled: true,
};

export const MAX_RECENT_FILES = 20;
export const AUTOSAVE_INTERVAL_MS = 30_000;
export const DEBOUNCE_SAVE_MS = 2_000;
