/**
 * Tests for the content script (Step 7).
 *
 * Verifies the full page-side wiring: debounced mouseup handling,
 * Chinese detection gating, PINYIN_REQUEST dispatch, overlay lifecycle
 * driven by Phase 1/Phase 2 responses, dismiss behavior (click-outside
 * and Escape), and context menu / keyboard command triggers.
 *
 * Mocks: overlay.ts functions via vi.mock(), window.getSelection via
 * vi.spyOn, and chrome.runtime.sendMessage via vitest-chrome-mv3.
 * Uses vi.useFakeTimers() for debounce assertions.
 *
 * See: IMPLEMENTATION_GUIDE.md Step 7 "Test file" for the expected
 *      test structure and coverage targets.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { MAX_SELECTION_LENGTH, DEBOUNCE_MS } from "../../src/shared/constants";

// ─── Mock overlay module so we can spy on calls without DOM side effects ──
const mockShowOverlay = vi.fn();
const mockUpdateOverlay = vi.fn();
const mockShowOverlayError = vi.fn();
const mockDismissOverlay = vi.fn();

vi.mock("../../src/content/overlay", () => ({
  showOverlay: mockShowOverlay,
  updateOverlay: mockUpdateOverlay,
  showOverlayError: mockShowOverlayError,
  dismissOverlay: mockDismissOverlay,
}));

vi.mock("../../src/content/overlay.css?inline", () => ({
  default: "",
}));

// ─── Helpers ────────────────────────────────────────────────────────

/** Creates a fake Selection object with a stubbed getBoundingClientRect. */
function fakeSelection(
  text: string,
  collapsed = false,
): Selection {
  const fakeRect = {
    top: 100, left: 200, bottom: 120, right: 400,
    width: 200, height: 20, x: 200, y: 100,
    toJSON: () => ({}),
  } as DOMRect;

  const textNode = document.createTextNode(text);
  document.body.appendChild(textNode);

  const fakeRange = {
    getBoundingClientRect: () => fakeRect,
    commonAncestorContainer: textNode,
    startContainer: textNode,
    endContainer: textNode,
    startOffset: 0,
    endOffset: text.length,
  };

  return {
    toString: () => text,
    isCollapsed: collapsed,
    anchorNode: textNode,
    anchorOffset: 0,
    focusNode: textNode,
    focusOffset: text.length,
    rangeCount: 1,
    getRangeAt: () => fakeRange,
    type: collapsed ? "Caret" : "Range",
    addRange: vi.fn(),
    collapse: vi.fn(),
    collapseToEnd: vi.fn(),
    collapseToStart: vi.fn(),
    containsNode: vi.fn(() => false),
    deleteFromDocument: vi.fn(),
    empty: vi.fn(),
    extend: vi.fn(),
    modify: vi.fn(),
    removeAllRanges: vi.fn(),
    removeRange: vi.fn(),
    selectAllChildren: vi.fn(),
    setBaseAndExtent: vi.fn(),
    setPosition: vi.fn(),
    direction: "ltr" as SelectionDirection,
  } as unknown as Selection;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("content script", () => {
  // Load the content script once for all tests in this suite.
  // Its top-level listeners attach to `document` and `chrome.runtime`.
  beforeAll(async () => {
    chrome.storage.sync.get.mockImplementation(
      (_key: unknown, cb?: Function) => {
        if (cb) cb({});
        return Promise.resolve({});
      },
    );
    chrome.storage.onChanged.addListener.mockImplementation(() => {});

    await import("../../src/content/content");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mockShowOverlay.mockClear();
    mockUpdateOverlay.mockClear();
    mockShowOverlayError.mockClear();
    mockDismissOverlay.mockClear();

    chrome.runtime.sendMessage.mockImplementation(
      (_msg: unknown, cb?: Function) => {
        if (cb) {
          cb({
            type: "PINYIN_RESPONSE_LOCAL",
            words: [{ chars: "你好", pinyin: "nǐ hǎo" }],
          });
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  // ─── mouseup handler ───────────────────────────────────────────
  describe("mouseup handler", () => {
    it("does nothing when selection is collapsed", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("", true),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("does nothing when selected text has no Chinese characters", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("hello world"),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("sends PINYIN_REQUEST when Chinese text is selected", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好世界"),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PINYIN_REQUEST",
          text: "你好世界",
        }),
        expect.any(Function),
      );
    });

    it("truncates text longer than MAX_SELECTION_LENGTH", () => {
      const longText = "你".repeat(MAX_SELECTION_LENGTH + 100);
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection(longText),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      const sentMsg = chrome.runtime.sendMessage.mock.calls[0][0];
      expect(sentMsg.text.length).toBe(MAX_SELECTION_LENGTH);
    });

    it("debounces rapid mouseup events", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好"),
      );

      for (let i = 0; i < 5; i++) {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }

      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ─── overlay lifecycle ────────────────────────────────────────
  describe("overlay lifecycle", () => {
    it("shows overlay after receiving local pinyin response", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好"),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(mockShowOverlay).toHaveBeenCalledWith(
        [{ chars: "你好", pinyin: "nǐ hǎo" }],
        expect.any(Object),
        "auto",
      );
    });

    it("updates overlay when LLM response arrives", () => {
      chrome.runtime.onMessage.callListeners(
        {
          type: "PINYIN_RESPONSE_LLM",
          words: [{ chars: "你好", pinyin: "nǐ hǎo", definition: "hello" }],
          translation: "Hello",
        },
        {},
        vi.fn(),
      );

      expect(mockUpdateOverlay).toHaveBeenCalledWith(
        [{ chars: "你好", pinyin: "nǐ hǎo", definition: "hello" }],
        "Hello",
      );
    });

    it("shows error state when LLM error arrives", () => {
      chrome.runtime.onMessage.callListeners(
        {
          type: "PINYIN_ERROR",
          error: "LLM request failed",
          phase: "llm",
        },
        {},
        vi.fn(),
      );

      expect(mockShowOverlayError).toHaveBeenCalledWith(
        "Translation unavailable \u2014 using local pinyin only.",
      );
    });
  });

  // ─── dismiss behavior ─────────────────────────────────────────
  describe("dismiss behavior", () => {
    it("dismisses overlay on Escape key", () => {
      const host = document.createElement("div");
      host.id = "hg-extension-root";
      document.body.appendChild(host);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(mockDismissOverlay).toHaveBeenCalled();
    });

    it("dismisses overlay on click outside", () => {
      const host = document.createElement("div");
      host.id = "hg-extension-root";
      document.body.appendChild(host);

      document.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );

      expect(mockDismissOverlay).toHaveBeenCalled();
    });

    it("does NOT dismiss overlay when clicking inside it", () => {
      const host = document.createElement("div");
      host.id = "hg-extension-root";
      const child = document.createElement("div");
      host.appendChild(child);
      document.body.appendChild(host);

      mockDismissOverlay.mockClear();

      child.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );

      expect(mockDismissOverlay).not.toHaveBeenCalled();
    });
  });

  // ─── context menu and command triggers ────────────────────────
  describe("context menu and command triggers", () => {
    it("processes text from CONTEXT_MENU_TRIGGER message", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好世界"),
      );

      chrome.runtime.onMessage.callListeners(
        { type: "CONTEXT_MENU_TRIGGER", text: "你好世界" },
        {},
        vi.fn(),
      );

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PINYIN_REQUEST",
          text: "你好世界",
        }),
        expect.any(Function),
      );
    });

    it("processes current selection on COMMAND_TRIGGER message", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好"),
      );

      chrome.runtime.onMessage.callListeners(
        { type: "COMMAND_TRIGGER" },
        {},
        vi.fn(),
      );

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PINYIN_REQUEST",
          text: "你好",
        }),
        expect.any(Function),
      );
    });

    it("ignores COMMAND_TRIGGER when no text is selected", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("", true),
      );

      chrome.runtime.onMessage.callListeners(
        { type: "COMMAND_TRIGGER" },
        {},
        vi.fn(),
      );

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });
  });
});
