/**
 * Maps mouse coordinates back to a text node + character offset.
 *
 * Two browser APIs do the heavy lifting:
 *  - WebKit/Blink: document.caretRangeFromPoint(x, y) -> Range
 *  - Firefox:      document.caretPositionFromPoint(x, y) -> { offsetNode, offset }
 *
 * Both return the position closest to the pixel. Crucially, this works
 * regardless of `user-select: none` on the page — the API talks DOM, not
 * selection, so it pierces the legacy "I disabled selection so users can't
 * copy" pattern that breaks the old mouseup-based flow.
 *
 * Form fields (`<input>` / `<textarea>`) are a special case: the caret
 * APIs return the element itself rather than the inner text node (the
 * value lives in shadow DOM the page can't traverse). We branch on
 * element type and synthesize a virtual position from el.value.
 */

/**
 * Result of caret resolution. `kind === "text"` means we got a real text
 * node; "input" means a form-field special-case (we still return text +
 * offset so callers can do longest-match against el.value, but the
 * returned `node` is the input element itself).
 */
export interface CaretPosition {
  kind: "text" | "input";
  /** The text node (kind="text") or the input/textarea element (kind="input"). */
  node: Node;
  /** Character offset into the string represented by `node`. */
  offset: number;
  /** The string the offset is into — text node data or el.value. */
  text: string;
}

interface CaretPositionLike {
  offsetNode: Node;
  offset: number;
}

/** Detects whether an element is a writable single-line input. */
function isTextInput(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  // Only types whose visible content is `value` and whose internal anonymous
  // shadow we can't traverse. Hidden/checkbox/radio etc. have no caret idea.
  const t = el.type.toLowerCase();
  return (
    t === "text" ||
    t === "search" ||
    t === "url" ||
    t === "tel" ||
    t === "email" ||
    t === "password" ||
    t === ""
  );
}

function isTextarea(el: Element): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement;
}

/**
 * Resolves (clientX, clientY) to a CaretPosition. Returns null when the
 * point doesn't sit over text we can identify (e.g. over an image, or
 * the page is empty there).
 *
 * For form fields we synthesize an offset by re-doing layout via
 * elementFromPoint (handing back the field) and then asking for the
 * field's selectionStart/Direction at point. Browsers don't expose a
 * "caret offset under (x,y) inside this field" API, so we approximate
 * by asking the field to act as if the user clicked there: we save the
 * existing selection, fire a no-op mousedown/mouseup at the same
 * coordinates would change selectionStart — but that mutates user state.
 * Safer: we just take the field's current selectionStart, which after a
 * fresh click is exactly where the caret is.
 */
export function caretFromPoint(
  clientX: number,
  clientY: number,
  doc: Document = document,
): CaretPosition | null {
  // Form field branch: handled by the click handler before this function
  // is called for hover (hover doesn't move the caret in inputs). For
  // hover over an <input>, we proxy to the field's bounding rect and
  // approximate offset by mapping x to a character position.
  const target = doc.elementFromPoint(clientX, clientY);
  if (target && (isTextInput(target) || isTextarea(target))) {
    return inputCaretFromPoint(target, clientX, clientY);
  }

  // Standard path: caretRangeFromPoint or caretPositionFromPoint.
  const docAny = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => CaretPositionLike | null;
  };

  let node: Node | null = null;
  let offset = 0;

  if (typeof docAny.caretRangeFromPoint === "function") {
    const range = docAny.caretRangeFromPoint(clientX, clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  } else if (typeof docAny.caretPositionFromPoint === "function") {
    const pos = docAny.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  }

  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const data = (node as Text).data;
  if (offset > data.length) offset = data.length;
  return { kind: "text", node, offset, text: data };
}

/**
 * Approximates a caret offset inside an <input>/<textarea>. The browser
 * doesn't expose "what character is at (x,y) inside this field", so we
 * fall back to the field's current `selectionStart` (which the browser
 * sets to the click position when the user actually clicks the field).
 * For hover-time previews we measure: take the field's first character
 * cell width and divide the x-offset by it. That's a rough estimate but
 * good enough to drive a hover highlight inside fixed-width fields and
 * a reasonable best-effort inside proportional ones.
 */
function inputCaretFromPoint(
  el: HTMLInputElement | HTMLTextAreaElement,
  clientX: number,
  clientY: number,
): CaretPosition | null {
  const value = el.value;
  if (!value) return null;

  // If the click already landed (browser updates selectionStart mid-click),
  // prefer that — it's the most accurate.
  if (el.selectionStart !== null) {
    const start = el.selectionStart;
    if (start >= 0 && start <= value.length) {
      return { kind: "input", node: el, offset: start, text: value };
    }
  }

  // Hover-time fallback: approximate via the field's bounding rect.
  const rect = el.getBoundingClientRect();
  const xRel = clientX - rect.left;
  const yRel = clientY - rect.top;
  if (xRel < 0 || yRel < 0) return null;

  // Use the rendered font height as a row hint; assume roughly square cells
  // for CJK characters (no point trying to be cleverer in this branch).
  const cellSize = parseFloat(getComputedStyle(el).fontSize) || 16;
  const col = Math.max(0, Math.floor(xRel / cellSize));
  const offset = Math.min(col, value.length);
  return { kind: "input", node: el, offset, text: value };
}

/**
 * Builds a Range over [startOffset, endOffset) inside `textNode`. Used
 * by the highlight controller to materialize a range for the CSS Custom
 * Highlight API. Returns null if the offsets are out of bounds.
 *
 * Range MUST be created from the same document the text node belongs
 * to (browsers throw WrongDocumentError otherwise). Defaults to the
 * text node's owner document so iframe text nodes (EPUB) Just Work.
 */
export function buildTextRange(
  textNode: Text,
  startOffset: number,
  endOffset: number,
  doc?: Document,
): Range | null {
  const len = textNode.data.length;
  if (startOffset < 0 || endOffset > len || startOffset >= endOffset) {
    return null;
  }
  const owningDoc = doc ?? textNode.ownerDocument ?? document;
  const range = owningDoc.createRange();
  range.setStart(textNode, startOffset);
  range.setEnd(textNode, endOffset);
  return range;
}
