/**
 * Walks the DOM around a caret position to extract the surrounding
 * sentence as both a string and a Range.
 *
 * Strategy: starting at (textNode, offset), walk backward through the
 * text node's data and then through preceding text nodes (via a
 * TreeWalker scoped to the nearest block-level ancestor) until we hit
 * a sentence delimiter. Walk forward the same way. Concatenate the
 * captured runs into one string. Return a Range that spans start->end.
 *
 * The block-level scope prevents us from accidentally pulling in
 * unrelated paragraphs / headers / sidebar text. SENTENCE_MAX_CHARS
 * is the absolute upper bound so a delimiter-free `<pre>` block doesn't
 * pull in megabytes of source code.
 *
 * See: .claude/ARCHITECTURE_REDESIGN.md Section 9 "Sentence detection".
 */

import {
  SENTENCE_CLAUSE_DELIMS,
  SENTENCE_DELIMS,
  SENTENCE_MAX_CHARS,
  SENTENCE_SOFT_LIMIT_CHARS,
} from "../shared/constants";

export interface SentenceResult {
  /** Full sentence text. */
  text: string;
  /** DOM Range covering the sentence (cross-text-node). */
  range: Range;
  /**
   * True when the soft-limit fallback fired and clause-level commas
   * were used as boundaries instead of full sentence terminators.
   * Reader/UI can ignore this; it's exposed for diagnostics.
   */
  trimmedToClause?: boolean;
}

/**
 * Finds the sentence around (textNode, offset).
 *
 * Two tiers:
 *  1. Primary walk uses SENTENCE_DELIMS (｡｜！｜？｜；) — real sentence
 *     boundaries. Returned as-is when length ≤ SENTENCE_SOFT_LIMIT_CHARS.
 *  2. When the primary result is too long, re-walk with the clause-level
 *     delimiter set (SENTENCE_CLAUSE_DELIMS, Chinese commas) added.
 *     Returns the narrower clause-bounded chunk so the popup translates
 *     a manageable subsection instead of a 200-char wall.
 *
 * Returns null when the caret is in whitespace with no Chinese text in
 * either direction.
 */
export function detectSentence(
  textNode: Text,
  offset: number,
  doc: Document = document,
): SentenceResult | null {
  const primary = walkOnce(textNode, offset, SENTENCE_DELIMS, doc);
  if (!primary) return null;

  if (primary.text.length <= SENTENCE_SOFT_LIMIT_CHARS) return primary;

  // Soft-limit fallback: include commas as additional delimiters.
  const expanded = new Set<string>(SENTENCE_DELIMS);
  for (const d of SENTENCE_CLAUSE_DELIMS) expanded.add(d);
  const clause = walkOnce(textNode, offset, expanded, doc);
  if (clause && clause.text.length < primary.text.length) {
    return { ...clause, trimmedToClause: true };
  }
  // Clause walk didn't shrink it (no commas in range); keep primary.
  return primary;
}

/**
 * Walks backward + forward from (textNode, offset) using the provided
 * delimiter set. Pulled out as a parameterised helper so the tier-1 and
 * tier-2 calls share one implementation.
 */
function walkOnce(
  textNode: Text,
  offset: number,
  delims: Set<string>,
  doc: Document,
): SentenceResult | null {
  const blockAncestor = findBlockAncestor(textNode);

  const backward = walkBackwardForStart(textNode, offset, blockAncestor, delims);
  const forward = walkForwardForEnd(textNode, offset, blockAncestor, delims);

  if (!backward || !forward) return null;

  const { node: startNode, offset: startOffset, prefix } = backward;
  const { node: endNode, offset: endOffset, suffix } = forward;

  const text = prefix + suffix;
  if (!text || text.length === 0) return null;

  const range = doc.createRange();
  try {
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
  } catch {
    return null;
  }
  return { text, range };
}

// ─── Backward walk ─────────────────────────────────────────────────

interface BackwardResult {
  node: Text;
  offset: number;
  /** Captured text from start to the original caret offset (exclusive). */
  prefix: string;
}

function walkBackwardForStart(
  textNode: Text,
  offset: number,
  block: Element,
  delims: Set<string>,
): BackwardResult | null {
  const node: Text = textNode;
  let charsCollected = 0;
  // First: check the current text node from offset-1 backward.
  let i = offset - 1;
  let collected = "";

  while (i >= 0 && charsCollected < SENTENCE_MAX_CHARS) {
    const ch = node.data[i];
    if (delims.has(ch)) {
      // Sentence starts at i+1 in this node.
      return { node, offset: i + 1, prefix: collected };
    }
    collected = ch + collected;
    charsCollected++;
    i--;
  }

  // Reached start of node without a delim. Walk to previous text node
  // within block; capture in pieces.
  let curStartNode: Text = node;
  const curStartOffset = 0;
  let prefix = collected;

  let prev = previousTextNode(node, block);
  while (prev && charsCollected < SENTENCE_MAX_CHARS) {
    const data = prev.data;
    let j = data.length - 1;
    let chunk = "";
    while (j >= 0 && charsCollected < SENTENCE_MAX_CHARS) {
      const ch = data[j];
      if (delims.has(ch)) {
        return {
          node: prev,
          offset: j + 1,
          prefix: chunk + prefix,
        };
      }
      chunk = ch + chunk;
      charsCollected++;
      j--;
    }
    prefix = chunk + prefix;
    curStartNode = prev;
    prev = previousTextNode(prev, block);
  }

  return { node: curStartNode, offset: curStartOffset, prefix };
}

// ─── Forward walk ──────────────────────────────────────────────────

interface ForwardResult {
  node: Text;
  offset: number;
  /** Captured text from the original caret offset to end (inclusive of delim). */
  suffix: string;
}

function walkForwardForEnd(
  textNode: Text,
  offset: number,
  block: Element,
  delims: Set<string>,
): ForwardResult | null {
  const node: Text = textNode;
  let charsCollected = 0;
  let i = offset;
  let collected = "";

  while (i < node.data.length && charsCollected < SENTENCE_MAX_CHARS) {
    const ch = node.data[i];
    collected += ch;
    charsCollected++;
    if (delims.has(ch)) {
      return { node, offset: i + 1, suffix: collected };
    }
    i++;
  }

  // Reached end of node without delimiter. Walk forward.
  let curEndNode: Text = node;
  let curEndOffset = node.data.length;
  let suffix = collected;

  let next = nextTextNode(node, block);
  while (next && charsCollected < SENTENCE_MAX_CHARS) {
    const data = next.data;
    let j = 0;
    let chunk = "";
    while (j < data.length && charsCollected < SENTENCE_MAX_CHARS) {
      const ch = data[j];
      chunk += ch;
      charsCollected++;
      if (delims.has(ch)) {
        return {
          node: next,
          offset: j + 1,
          suffix: suffix + chunk,
        };
      }
      j++;
    }
    suffix += chunk;
    curEndNode = next;
    curEndOffset = next.data.length;
    next = nextTextNode(next, block);
  }

  return { node: curEndNode, offset: curEndOffset, suffix };
}

// ─── DOM walk helpers ──────────────────────────────────────────────

/**
 * Returns the nearest block-level ancestor (P, DIV, ARTICLE, SECTION,
 * LI, BLOCKQUOTE, BODY). The sentence detector won't cross this
 * boundary — we want a paragraph break to act as a sentence terminator.
 */
function findBlockAncestor(node: Node): Element {
  let cur: Node | null = node.parentNode;
  while (cur) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as Element;
      const tag = el.tagName;
      if (
        tag === "P" ||
        tag === "DIV" ||
        tag === "ARTICLE" ||
        tag === "SECTION" ||
        tag === "LI" ||
        tag === "BLOCKQUOTE" ||
        tag === "TD" ||
        tag === "TH" ||
        tag === "BODY"
      ) {
        return el;
      }
    }
    cur = cur.parentNode;
  }
  return document.body;
}

/**
 * Finds the next text node in document order that's still within `block`.
 * Skips empty text nodes (data === "").
 */
function nextTextNode(from: Text, block: Element): Text | null {
  const walker = (from.ownerDocument ?? document).createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const data = (node as Text).data;
        return data.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  walker.currentNode = from;
  const next = walker.nextNode();
  return next as Text | null;
}

function previousTextNode(from: Text, block: Element): Text | null {
  const walker = (from.ownerDocument ?? document).createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const data = (node as Text).data;
        return data.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );
  walker.currentNode = from;
  const prev = walker.previousNode();
  return prev as Text | null;
}
