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
import { DEFAULT_SETTINGS, MAX_SELECTION_LENGTH, DEBOUNCE_MS } from "../../src/shared/constants";
import { mock } from "../test-helpers";

// ─── Mock overlay module so we can spy on calls without DOM side effects ──
const mockShowOverlay = vi.fn();
const mockUpdateOverlay = vi.fn();
const mockUpdateOverlayFallback = vi.fn();
const mockShowOverlayError = vi.fn();
const mockShowTruncationNotice = vi.fn();
const mockDismissOverlay = vi.fn();

const mockSetVocabCallback = vi.fn();
const mockSetOverlayContext = vi.fn();

vi.mock("../../src/content/overlay", () => ({
  showOverlay: mockShowOverlay,
  updateOverlay: mockUpdateOverlay,
  updateOverlayFallback: mockUpdateOverlayFallback,
  showOverlayError: mockShowOverlayError,
  showTruncationNotice: mockShowTruncationNotice,
  dismissOverlay: mockDismissOverlay,
  setVocabCallback: mockSetVocabCallback,
  setOverlayContext: mockSetOverlayContext,
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
    direction: "ltr",
  } as unknown as Selection;
}

// ─── Tests ──────────────────────────────────────────────────────────

/**
 * Captured chrome.storage.onChanged listener registered by the content
 * script at import time. Tests use this to flip cached settings (e.g.
 * overlayEnabled) without rebuilding the module.
 */
let storageChangeListener:
  | ((
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => void)
  | null = null;

describe("content script", () => {
  // Load the content script once for all tests in this suite.
  // Its top-level listeners attach to `document` and `chrome.runtime`.
  beforeAll(async () => {
    mock(chrome.storage.sync.get).mockImplementation(
      (_key: unknown, cb?: Function) => {
        if (cb) cb({});
        return Promise.resolve({});
      },
    );
    mock(chrome.storage.onChanged.addListener).mockImplementation((listener: typeof storageChangeListener) => {
      storageChangeListener = listener;
    });

    await import("../../src/content/content");
  });

  /** Mutates the content script's cached settings via the storage event. */
  function setOverlayEnabled(value: boolean): void {
    storageChangeListener?.(
      { overlayEnabled: { newValue: value } },
      "sync",
    );
  }

  /** Mutates the content script's cached llmEnabled flag. */
  function setLlmEnabled(value: boolean): void {
    storageChangeListener?.(
      { llmEnabled: { newValue: value } },
      "sync",
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockShowOverlay.mockClear();
    mockUpdateOverlay.mockClear();
    mockUpdateOverlayFallback.mockClear();
    mockShowOverlayError.mockClear();
    mockShowTruncationNotice.mockClear();
    mockDismissOverlay.mockClear();

    mock(chrome.runtime.sendMessage).mockImplementation(
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
    // Reset overlayEnabled so a test that disabled it does not leak
    // into the next case (the module-level cache lives across tests).
    setOverlayEnabled(true);
    // Same hygiene for llmEnabled -- the cached flag survives across
    // tests via the module-level closure, so any case that flipped it
    // off needs an explicit reset here.
    setLlmEnabled(true);
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

      const sentMsg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
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

    // Regression: clicking the overlay close button (or any element inside
    // the Shadow DOM host) used to re-trigger the document mouseup handler,
    // which re-ran processSelection on the still-alive page selection and
    // re-opened the popup immediately after dismissal.
    it("ignores mouseup when target is inside the overlay host", () => {
      const host = document.createElement("div");
      host.id = "hg-extension-root";
      const child = document.createElement("button");
      host.appendChild(child);
      document.body.appendChild(host);

      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好世界"),
      );

      child.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
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
        true,
        true,
        DEFAULT_SETTINGS.fontSize,
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
        true,
      );
    });

    it("shows error state when LLM error arrives", () => {
      chrome.runtime.onMessage.callListeners(
        {
          type: "PINYIN_ERROR",
          error: "API key is invalid or expired.",
          phase: "llm",
        },
        {},
        vi.fn(),
      );

      expect(mockShowOverlayError).toHaveBeenCalledWith(
        "API key is invalid or expired.",
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

  // ─── overlayEnabled gate ──────────────────────────────────────
  describe("overlayEnabled gate", () => {
    it("ignores mouseup selections when overlayEnabled is false", () => {
      setOverlayEnabled(false);
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好世界"),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
      expect(mockShowOverlay).not.toHaveBeenCalled();
    });

    it("still processes CONTEXT_MENU_TRIGGER when overlayEnabled is false", () => {
      setOverlayEnabled(false);
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

    it("still processes COMMAND_TRIGGER when overlayEnabled is false", () => {
      setOverlayEnabled(false);
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

    it("re-enables mouseup processing when toggled back on", () => {
      setOverlayEnabled(false);
      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好"),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

      setOverlayEnabled(true);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PINYIN_REQUEST",
          text: "你好",
        }),
        expect.any(Function),
      );
    });
  });

  // ─── fontSize cache ───────────────────────────────────────────
  describe("fontSize cache", () => {
    it("forwards an updated fontSize from chrome.storage.onChanged to showOverlay", () => {
      storageChangeListener?.(
        { fontSize: { newValue: 22 } },
        "sync",
      );

      vi.spyOn(window, "getSelection").mockReturnValue(
        fakeSelection("你好"),
      );

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(mockShowOverlay).toHaveBeenCalledWith(
        [{ chars: "你好", pinyin: "nǐ hǎo" }],
        expect.any(Object),
        "auto",
        true,
        true,
        22,
      );

      // Reset to default so subsequent tests in other suites are unaffected.
      storageChangeListener?.(
        { fontSize: { newValue: DEFAULT_SETTINGS.fontSize } },
        "sync",
      );
    });
  });

  // ─── +Vocab callback (gate + on-device translate pipeline) ────
  describe("+Vocab callback", () => {
    /**
     * Returns the vocab callback content.ts registered with overlay
     * at module-import time. The callback closes over the on-device
     * Translator wrapper and the example-quality gate.
     */
    function getRegisteredVocabCallback(): (
      word: { chars: string; pinyin: string; definition: string },
      context: string,
    ) => Promise<void> {
      const calls = mockSetVocabCallback.mock.calls;
      const last = calls[calls.length - 1];
      return last[0];
    }

    function setTranslator(impl: unknown): void {
      (globalThis as { Translator?: unknown }).Translator = impl as never;
    }

    function clearTranslator(): void {
      delete (globalThis as { Translator?: unknown }).Translator;
    }

    /**
     * The shared translate-example module caches the Translator
     * instance per importing context. content.ts and the test file
     * both pull from the same module record, so we reset it between
     * cases to keep "Translator missing" / "create() rejects" /
     * "happy path" tests isolated.
     */
    async function resetTranslatorCache(): Promise<void> {
      const mod = await import("../../src/shared/translate-example");
      mod._resetForTests();
    }

    beforeEach(async () => {
      // Real timers here -- the callback awaits the async Translator
      // call and the inner `await Promise.resolve()` chain inside it,
      // which fake timers disrupt for promise resolution tests.
      vi.useRealTimers();
      // A fresh sendMessage spy per test so call counts are clean.
      mock(chrome.runtime.sendMessage).mockReset();
      mock(chrome.runtime.sendMessage).mockImplementation(() => Promise.resolve());
      await resetTranslatorCache();
    });

    afterEach(() => {
      clearTranslator();
    });

    const word = { chars: "学习", pinyin: "xué xí", definition: "to study" };
    const goodContext = "我每天都在学习中文。";

    it("low-quality context: sends RECORD_WORD without an example, never invokes Translator", async () => {
      const create = vi.fn(async () => ({ translate: vi.fn() }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });

      const cb = getRegisteredVocabCallback();
      await cb(word, "学"); // context too short to pass isUsableExample

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const msg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(msg).toMatchObject({ type: "RECORD_WORD", word });
      expect(msg.example).toBeUndefined();
      // The gate short-circuited before we got near the Translator call.
      expect(create).not.toHaveBeenCalled();
    });

    it("good context + Translator success: persists the word first, then ships SET_EXAMPLE_TRANSLATION", async () => {
      const translate = vi.fn(async () => "I study Chinese every day.");
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });

      const cb = getRegisteredVocabCallback();
      await cb(word, goodContext);

      // Two messages: the immediate RECORD_WORD (with the trimmed
      // sentence but no translation yet) and the follow-up
      // SET_EXAMPLE_TRANSLATION once the on-device call resolved.
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);

      const recordMsg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(recordMsg.type).toBe("RECORD_WORD");
      expect(recordMsg.word).toEqual(word);
      expect(recordMsg.example).toMatchObject({ sentence: goodContext });
      expect(recordMsg.example.translation).toBeUndefined();

      const setMsg = mock(chrome.runtime.sendMessage).mock.calls[1][0];
      expect(setMsg).toMatchObject({
        type: "SET_EXAMPLE_TRANSLATION",
        chars: word.chars,
        sentence: goodContext,
        translation: "I study Chinese every day.",
      });

      expect(translate).toHaveBeenCalledWith(goodContext);
    });

    it("good context + translate() rejection: sends RECORD_WORD, no SET_EXAMPLE_TRANSLATION", async () => {
      const translate = vi.fn(async () => {
        throw new Error("model died");
      });
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });

      const cb = getRegisteredVocabCallback();
      await cb(word, goodContext);

      // RECORD_WORD lands; the failed translation just doesn't ship a
      // follow-up message. The user can re-trigger via the hub
      // Translate button later.
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const recordMsg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(recordMsg).toMatchObject({
        type: "RECORD_WORD",
        word,
        example: { sentence: goodContext },
      });
    });

    it("good context with Translator API missing: sends only RECORD_WORD, no crash", async () => {
      clearTranslator();

      const cb = getRegisteredVocabCallback();
      await cb(word, goodContext);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const recordMsg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(recordMsg).toMatchObject({
        type: "RECORD_WORD",
        word,
        example: { sentence: goodContext },
      });
    });
  });

  // ─── Non-LLM on-device translator fallback ─────────────────────
  //
  // The fallback runs entirely in the content script's main world via
  // Chrome's globalThis.Translator. These tests stub the API directly
  // and toggle the cached llmEnabled flag through the storage event
  // path so we can verify the gating + the two-phase paint without
  // actually hitting the real Translator (which jsdom doesn't have).
  describe("non-LLM fallback", () => {
    function setTranslator(impl: unknown): void {
      (globalThis as { Translator?: unknown }).Translator = impl as never;
    }

    function clearTranslator(): void {
      delete (globalThis as { Translator?: unknown }).Translator;
    }

    /**
     * The on-device wrapper caches the Translator instance per
     * importing context. content.ts and the test file both pull from
     * the same module record, so we reset it between cases to keep
     * "Translator missing" / "create() rejects" / "happy path" tests
     * isolated.
     */
    async function resetTranslatorCache(): Promise<void> {
      const mod = await import("../../src/shared/translate-example");
      mod._resetForTests();
    }

    /**
     * Drives a single mouseup-triggered selection through the content
     * script with the supplied selection text and returns once both
     * the PINYIN_RESPONSE_LOCAL callback (synchronous via the mocked
     * sendMessage) and any awaited fallback work have settled.
     */
    async function runMouseupWith(text: string): Promise<void> {
      vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection(text));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      // Drain the microtask queue (and any timer-resolved promises) so
      // the fallback's awaited translate() calls resolve before the
      // assertion runs.
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }

    beforeEach(async () => {
      // The shared sendMessage stub from the parent describe replies
      // with a 1-segment response by default; the fallback tests need
      // a multi-segment response so per-segment translation paths get
      // exercised. Override locally.
      mock(chrome.runtime.sendMessage).mockReset();
      mock(chrome.runtime.sendMessage).mockImplementation(
        (_msg: unknown, cb?: Function) => {
          if (cb) {
            cb({
              type: "PINYIN_RESPONSE_LOCAL",
              words: [
                { chars: "我", pinyin: "wǒ" },
                { chars: "学习", pinyin: "xué xí" },
                { chars: "中文", pinyin: "zhōng wén" },
              ],
            });
          }
        },
      );
      await resetTranslatorCache();
      mockUpdateOverlayFallback.mockClear();
    });

    afterEach(() => {
      clearTranslator();
    });

    it("when llmEnabled is true, runs only the full quick preview (no segment glosses)", async () => {
      const translate = vi.fn(async (s: string) => `EN(${s})`);
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      // Default state has llmEnabled=true; be explicit here for clarity.
      setLlmEnabled(true);

      await runMouseupWith("我学习中文");

      expect(create).toHaveBeenCalledTimes(1);
      expect(translate).toHaveBeenCalledTimes(1);
      expect(translate).toHaveBeenCalledWith("我学习中文");
      expect(translate).not.toHaveBeenCalledWith("我");
      expect(translate).not.toHaveBeenCalledWith("学习");
      expect(translate).not.toHaveBeenCalledWith("中文");

      expect(mockUpdateOverlayFallback).toHaveBeenCalledTimes(1);
      const preview = mockUpdateOverlayFallback.mock.calls[0];
      expect(preview[1]).toBe("EN(我学习中文)");
      expect(preview[0].every((w: { definition: string }) => w.definition === "")).toBe(true);
    });

    it("does not let a late quick preview overwrite an already-rendered LLM response", async () => {
      let resolveTranslate: ((value: string) => void) | null = null;
      const translate = vi.fn(
        () => new Promise<string>((resolve) => {
          resolveTranslate = resolve;
        }),
      );
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      setLlmEnabled(true);

      vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection("我学习中文"));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(translate).toHaveBeenCalledWith("我学习中文");

      chrome.runtime.onMessage.callListeners(
        {
          type: "PINYIN_RESPONSE_LLM",
          words: [{ chars: "我", pinyin: "wǒ", definition: "I; me" }],
          translation: "I study Chinese.",
        },
        {},
        vi.fn(),
      );

      resolveTranslate!("EN(我学习中文)");
      await new Promise((r) => setTimeout(r, 0));

      expect(mockUpdateOverlay).toHaveBeenCalledWith(
        [{ chars: "我", pinyin: "wǒ", definition: "I; me" }],
        "I study Chinese.",
        true,
      );
      expect(mockUpdateOverlayFallback).not.toHaveBeenCalled();
    });

    it("lets a late quick preview replace an LLM error row while keeping the error badge", async () => {
      let resolveTranslate: ((value: string) => void) | null = null;
      const translate = vi.fn(
        () => new Promise<string>((resolve) => {
          resolveTranslate = resolve;
        }),
      );
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      setLlmEnabled(true);

      vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection("我学习中文"));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(translate).toHaveBeenCalledWith("我学习中文");

      chrome.runtime.onMessage.callListeners(
        {
          type: "PINYIN_ERROR",
          error: "LLM request failed (HTTP 400).",
          phase: "llm",
        },
        {},
        vi.fn(),
      );

      resolveTranslate!("EN(我学习中文)");
      await new Promise((r) => setTimeout(r, 0));

      expect(mockShowOverlayError).toHaveBeenCalledWith(
        "LLM request failed (HTTP 400).",
      );
      expect(mockUpdateOverlayFallback).toHaveBeenCalledTimes(1);
      const preview = mockUpdateOverlayFallback.mock.calls[0];
      expect(preview[1]).toBe("EN(我学习中文)");
      expect(mockUpdateOverlay).not.toHaveBeenCalledWith(
        expect.anything(),
        "EN(我学习中文)",
        expect.anything(),
      );
    });

    it("does NOT run the fallback when llmEnabled is false but Translator API is missing", async () => {
      // When the API isn't there, the showOverlay loading-row decision
      // also flips off so the user doesn't see a perpetual spinner.
      clearTranslator();
      setLlmEnabled(false);

      await runMouseupWith("我学习中文");

      expect(mockUpdateOverlayFallback).not.toHaveBeenCalled();
      // showOverlay's "expectTranslation" param (5th arg) should be
      // false in this branch -- nothing will fill the row.
      const args = mockShowOverlay.mock.calls[0];
      expect(args[4]).toBe(false);
    });

    it("runs the fallback when llmEnabled is false and Translator is available", async () => {
      const translate = vi.fn(async (s: string) => `EN(${s})`);
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      setLlmEnabled(false);

      await runMouseupWith("我学习中文");

      // Full translation always called once; per-segment translations
      // run in parallel after that, one per unique Chinese segment.
      expect(translate).toHaveBeenCalledWith("我学习中文");
      expect(translate).toHaveBeenCalledWith("我");
      expect(translate).toHaveBeenCalledWith("学习");
      expect(translate).toHaveBeenCalledWith("中文");

      // Two-phase paint: Phase A uses the full translation with empty
      // definitions, Phase B re-renders with per-segment glosses.
      expect(mockUpdateOverlayFallback).toHaveBeenCalledTimes(2);

      const phaseA = mockUpdateOverlayFallback.mock.calls[0];
      expect(phaseA[1]).toBe("EN(我学习中文)");
      expect(phaseA[0].every((w: { definition: string }) => w.definition === "")).toBe(true);

      const phaseB = mockUpdateOverlayFallback.mock.calls[1];
      expect(phaseB[1]).toBe("EN(我学习中文)");
      const defs = (phaseB[0] as { chars: string; definition: string }[]).map(
        (w) => [w.chars, w.definition],
      );
      expect(defs).toEqual([
        ["我", "EN(我)"],
        ["学习", "EN(学习)"],
        ["中文", "EN(中文)"],
      ]);
    });

    it("forwards the full-translation error to showOverlayError when create() rejects", async () => {
      const create = vi.fn(async () => {
        throw new Error("download blocked");
      });
      setTranslator({
        availability: vi.fn(async () => "downloadable"),
        create,
      });
      setLlmEnabled(false);

      await runMouseupWith("我学习中文");

      // The full translation failure short-circuits -- no fallback
      // overlay paint, just the error row replacing the loading state.
      expect(mockUpdateOverlayFallback).not.toHaveBeenCalled();
      expect(mockShowOverlayError).toHaveBeenCalled();
      const msg = mockShowOverlayError.mock.calls[0][0];
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });

    it("reserves the translation row up front when fallback will run (expectTranslation=true)", async () => {
      const translate = vi.fn(async (s: string) => `EN(${s})`);
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      setLlmEnabled(false);

      await runMouseupWith("我学习中文");

      // 5th arg of showOverlay is the loading-row flag. With LLM off
      // but Translator available, the fallback fills the row, so the
      // flag must be true (otherwise the row is never injected and
      // updateOverlayFallback has to create it after the fact).
      const args = mockShowOverlay.mock.calls[0];
      expect(args[4]).toBe(true);
    });
  });

  // ─── OCR translator prewarm ────────────────────────────────────
  describe("OCR translator prewarm", () => {
    function setTranslator(impl: unknown): void {
      (globalThis as { Translator?: unknown }).Translator = impl as never;
    }

    function clearTranslator(): void {
      delete (globalThis as { Translator?: unknown }).Translator;
    }

    async function resetTranslatorCache(): Promise<void> {
      const mod = await import("../../src/shared/translate-example");
      mod._resetForTests();
    }

    beforeEach(async () => {
      vi.useRealTimers();
      await resetTranslatorCache();
    });

    afterEach(() => {
      clearTranslator();
    });

    it("prewarms the on-device Translator after the OCR drag finishes when llmEnabled is false", async () => {
      // Stub a Translator whose create() resolves successfully.
      // Without prewarming the create() would only fire when the
      // fallback runs after Tesseract finishes; here we assert it
      // fires inside the OCR_START_SELECTION handler instead.
      const translate = vi.fn(async (s: string) => `EN(${s})`);
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      setLlmEnabled(false);

      // Stub startOCRSelection so OCR_START_SELECTION resolves to a
      // synthetic rect immediately, mimicking the user finishing a
      // drag without us having to drive a real selection mask.
      const ocrMod = await import("../../src/content/ocr-selection");
      vi.spyOn(ocrMod, "startOCRSelection").mockResolvedValue({
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      });

      // Trigger the SW -> content message that kicks off the OCR
      // selection flow.
      chrome.runtime.onMessage.callListeners(
        { type: "OCR_START_SELECTION" },
        {},
        vi.fn(),
      );

      // Drain microtasks so handleOCRStartSelection's awaits resolve.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // Translator.create() ran during the OCR-start handler, BEFORE
      // any actual translation happens, so the user's drag-mouseup
      // activation is still valid for create()'s NotAllowedError gate.
      expect(create).toHaveBeenCalledTimes(1);
      // No translate() yet -- prewarm only sets up the instance.
      expect(translate).not.toHaveBeenCalled();

      // Restore.
      setLlmEnabled(true);
    });

    it("does NOT prewarm when llmEnabled is true (LLM path will handle translation)", async () => {
      const create = vi.fn(async () => ({
        translate: vi.fn(async () => "ok"),
      }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });
      setLlmEnabled(true);

      const ocrMod = await import("../../src/content/ocr-selection");
      vi.spyOn(ocrMod, "startOCRSelection").mockResolvedValue({
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      });

      chrome.runtime.onMessage.callListeners(
        { type: "OCR_START_SELECTION" },
        {},
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(create).not.toHaveBeenCalled();
    });

    it("does NOT prewarm (or crash) when the Translator API is missing", async () => {
      clearTranslator();
      setLlmEnabled(false);

      const ocrMod = await import("../../src/content/ocr-selection");
      vi.spyOn(ocrMod, "startOCRSelection").mockResolvedValue({
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      });

      // Just shouldn't throw and shouldn't try to call into a
      // nonexistent global.
      expect(() => {
        chrome.runtime.onMessage.callListeners(
          { type: "OCR_START_SELECTION" },
          {},
          vi.fn(),
        );
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 0));

      setLlmEnabled(true);
    });
  });
});
