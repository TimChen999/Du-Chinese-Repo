/**
 * Subtitle parser for SRT, WebVTT, and ASS/SSA files.
 *
 * Each variant maps to a flat SubtitleCue[]: index, the original
 * timestamp string for display, and the human-readable text. The
 * subtitle renderer treats cues as opaque blocks; only this module
 * understands timestamp formats or ASS dialogue layout.
 *
 * Why not a third-party library: SRT and VTT are trivially regex-able,
 * and the ASS subset we care about (Dialogue lines, comma-separated)
 * is also small. Skipping a dep keeps the bundle lean and avoids
 * pulling video-codec utilities we'll never use.
 */

export interface SubtitleCue {
  index: number;
  time: string;
  text: string;
}

export type SubtitleFormat = "srt" | "vtt" | "ass";

export function detectSubtitleFormat(extension: string): SubtitleFormat {
  const ext = extension.toLowerCase().replace(/^\./, "");
  if (ext === "vtt") return "vtt";
  if (ext === "ass" || ext === "ssa") return "ass";
  return "srt";
}

export function parseSubtitles(text: string, format: SubtitleFormat): SubtitleCue[] {
  switch (format) {
    case "vtt":
      return parseVtt(text);
    case "ass":
      return parseAss(text);
    default:
      return parseSrt(text);
  }
}

// ─── SRT ────────────────────────────────────────────────────────────

const SRT_TIME = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/;

function parseSrt(raw: string): SubtitleCue[] {
  const blocks = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split(/\n{2,}/);

  const cues: SubtitleCue[] = [];
  let autoIndex = 1;

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let i = 0;
    let index = autoIndex;
    if (/^\d+$/.test(lines[0])) {
      index = parseInt(lines[0], 10) || autoIndex;
      i = 1;
    }

    const timeMatch = lines[i]?.match(SRT_TIME);
    if (!timeMatch) continue;
    const time = `${timeMatch[1]} --> ${timeMatch[2]}`;
    const text = lines.slice(i + 1).join("\n");
    if (!text) continue;

    cues.push({ index, time, text: stripFormattingTags(text) });
    autoIndex = index + 1;
  }

  return cues;
}

// ─── WebVTT ─────────────────────────────────────────────────────────

const VTT_TIME = /(\d{1,2}:)?(\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}:\d{2}\.\d{3})/;

function parseVtt(raw: string): SubtitleCue[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n+/i, "");
  const blocks = withoutHeader.trim().split(/\n{2,}/);

  const cues: SubtitleCue[] = [];
  let autoIndex = 1;

  for (const block of blocks) {
    if (/^(NOTE|STYLE|REGION)\b/i.test(block)) continue;

    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let i = 0;
    if (!VTT_TIME.test(lines[0]) && lines[1] && VTT_TIME.test(lines[1])) {
      i = 1;
    }

    const m = lines[i]?.match(VTT_TIME);
    if (!m) continue;
    const startHour = m[1] ?? "";
    const endHour = m[3] ?? "";
    const time = `${startHour}${m[2]} --> ${endHour}${m[4]}`;
    const text = lines.slice(i + 1).join("\n");
    if (!text) continue;

    cues.push({ index: autoIndex++, time, text: stripFormattingTags(text) });
  }

  return cues;
}

// ─── ASS / SSA ──────────────────────────────────────────────────────

function parseAss(raw: string): SubtitleCue[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const cues: SubtitleCue[] = [];
  let autoIndex = 1;
  let format: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Format:") && format === null) {
      format = trimmed.slice("Format:".length).split(",").map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!trimmed.startsWith("Dialogue:")) continue;

    const fields = trimmed.slice("Dialogue:".length).split(",");
    const cols = format ?? ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

    const startIdx = cols.indexOf("start");
    const endIdx = cols.indexOf("end");
    const textIdx = cols.indexOf("text");

    if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue;

    const start = fields[startIdx]?.trim();
    const end = fields[endIdx]?.trim();
    const textParts = fields.slice(textIdx).join(",").trim();

    if (!start || !end || !textParts) continue;

    const cleanText = stripAssOverrides(textParts);
    if (!cleanText) continue;

    cues.push({
      index: autoIndex++,
      time: `${start} --> ${end}`,
      text: cleanText,
    });
  }

  return cues;
}

// ─── Helpers ────────────────────────────────────────────────────────

function stripFormattingTags(text: string): string {
  return text.replace(/<\/?[^>]+>/g, "").trim();
}

function stripAssOverrides(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}
