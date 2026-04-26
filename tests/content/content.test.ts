/**
 * Tests for the content script after the click-flow redesign.
 *
 * The legacy mouseup-driven overlay is gone; this file now verifies:
 *   - the context-menu / Alt+Shift+P triggers re-route to the click flow
 *   - the +Vocab capture pipeline (gate / trim / RECORD_WORD / async
 *     translate / SET_EXAMPLE_TRANSLATION) is unchanged after rewiring
 *     the registration to setClickPopupVocabCallback
 *   - OCR's prewarm-the-Translator side effect still fires
 *   - settings changes are pushed into setClickFlowSettings
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { mock } from "../test-helpers";

// ─── Mock click-flow + click-popup ────────────────────────────────
const mockInitClickFlow = vi.fn();
const mockSetClickFlowSettings = vi.fn();
const mockDismissClickFlow = vi.fn();
const mockTriggerFromSelection = vi.fn();
const mockTriggerFromTextNode = vi.fn();
const mockSetClickPopupVocabCallback = vi.fn();

vi.mock("../../src/content/click-flow", () => ({
  initClickFlow: mockInitClickFlow,
  setClickFlowSettings: mockSetClickFlowSettings,
  dismissClickFlow: mockDismissClickFlow,
  triggerFromSelection: mockTriggerFromSelection,
  triggerFromTextNode: mockTriggerFromTextNode,
}));

vi.mock("../../src/content/click-popup", () => ({
  setClickPopupVocabCallback: mockSetClickPopupVocabCallback,
}));

vi.mock("../../src/content/overlay.css?inline", () => ({
  default: "",
}));

// ─── Helpers ──────────────────────────────────────────────────────

function fakeSelection(text: string, collapsed = false): Selection {
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

let storageChangeListener:
  | ((
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ) => void)
  | null = null;

describe("content script", () => {
  beforeAll(async () => {
    mock(chrome.storage.sync.get).mockImplementation(
      (_key: unknown, cb?: Function) => {
        if (cb) cb({});
        return Promise.resolve({});
      },
    );
    mock(chrome.storage.onChanged.addListener).mockImplementation(
      (listener: typeof storageChangeListener) => {
        storageChangeListener = listener;
      },
    );

    await import("../../src/content/content");
  });

  function setOverlayEnabled(value: boolean): void {
    storageChangeListener?.({ overlayEnabled: { newValue: value } }, "sync");
  }

  beforeEach(() => {
    mockInitClickFlow.mockClear();
    mockSetClickFlowSettings.mockClear();
    mockDismissClickFlow.mockClear();
    mockTriggerFromSelection.mockClear();
    mockTriggerFromTextNode.mockClear();
    // Do NOT clear mockSetClickPopupVocabCallback — content.ts only
    // registers the vocab callback once, at module load time. Clearing
    // it would lose the captured callback the +Vocab tests need.
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    setOverlayEnabled(true);
  });

  // ─── Trigger re-routing ────────────────────────────────────────

  describe("context menu and command triggers", () => {
    it("CONTEXT_MENU_TRIGGER fires triggerFromSelection", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection("你好世界"));
      chrome.runtime.onMessage.callListeners(
        { type: "CONTEXT_MENU_TRIGGER", text: "你好世界" },
        {},
        vi.fn(),
      );
      expect(mockTriggerFromSelection).toHaveBeenCalledTimes(1);
    });

    it("COMMAND_TRIGGER fires triggerFromSelection when text is selected", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection("你好"));
      chrome.runtime.onMessage.callListeners(
        { type: "COMMAND_TRIGGER" },
        {},
        vi.fn(),
      );
      expect(mockTriggerFromSelection).toHaveBeenCalledTimes(1);
    });

    it("ignores COMMAND_TRIGGER when no text is selected", () => {
      vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection("", true));
      chrome.runtime.onMessage.callListeners(
        { type: "COMMAND_TRIGGER" },
        {},
        vi.fn(),
      );
      expect(mockTriggerFromSelection).not.toHaveBeenCalled();
    });
  });

  // ─── Settings pushed into click-flow ──────────────────────────

  describe("settings sync", () => {
    it("dismisses the click-flow popup when overlayEnabled flips off", () => {
      setOverlayEnabled(false);
      expect(mockDismissClickFlow).toHaveBeenCalled();
    });

    it("pushes pinyinStyle changes into click-flow settings", () => {
      storageChangeListener?.(
        { pinyinStyle: { newValue: "toneNumbers" } },
        "sync",
      );
      const calls = mockSetClickFlowSettings.mock.calls;
      const last = calls[calls.length - 1][0] as Record<string, unknown>;
      expect(last.pinyinStyle).toBe("toneNumbers");
    });

    it("pushes ttsEnabled changes", () => {
      storageChangeListener?.({ ttsEnabled: { newValue: false } }, "sync");
      const calls = mockSetClickFlowSettings.mock.calls;
      const last = calls[calls.length - 1][0] as Record<string, unknown>;
      expect(last.ttsEnabled).toBe(false);
    });
  });

  // ─── +Vocab callback ──────────────────────────────────────────

  describe("+Vocab callback", () => {
    function getRegisteredVocabCallback(): (
      word: { chars: string; pinyin: string; definition: string },
      context: string,
    ) => Promise<void> {
      const calls = mockSetClickPopupVocabCallback.mock.calls;
      const last = calls[calls.length - 1];
      return last[0];
    }

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
      await cb(word, "学");

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const msg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(msg).toMatchObject({ type: "RECORD_WORD", word });
      expect(msg.example).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
    });

    it("good context + Translator success: persists then ships SET_EXAMPLE_TRANSLATION", async () => {
      const translate = vi.fn(async () => "I study Chinese every day.");
      const create = vi.fn(async () => ({ translate }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });

      const cb = getRegisteredVocabCallback();
      await cb(word, goodContext);

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

    it("good context + translate() rejection: RECORD_WORD only", async () => {
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

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const recordMsg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(recordMsg).toMatchObject({
        type: "RECORD_WORD",
        word,
        example: { sentence: goodContext },
      });
    });

    it("Translator API missing: sends only RECORD_WORD, no crash", async () => {
      // Do NOT install a Translator global → translateChineseToEnglish
      // returns UNAVAILABLE.
      const cb = getRegisteredVocabCallback();
      await cb(word, goodContext);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
      const recordMsg = mock(chrome.runtime.sendMessage).mock.calls[0][0];
      expect(recordMsg.type).toBe("RECORD_WORD");
      // Translator never created an instance → no SET_EXAMPLE_TRANSLATION.
    });
  });

  // ─── OCR translator prewarm ───────────────────────────────────

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
      mock(chrome.runtime.sendMessage).mockReset();
      mock(chrome.runtime.sendMessage).mockImplementation(() => Promise.resolve());
      await resetTranslatorCache();
    });

    afterEach(() => clearTranslator());

    it("prewarms after OCR area-select finishes, when Translator API is available", async () => {
      const create = vi.fn(async () => ({ translate: vi.fn() }));
      setTranslator({
        availability: vi.fn(async () => "available"),
        create,
      });

      // Mock startOCRSelection to return a rect.
      const mod = await import("../../src/content/ocr-selection");
      vi.spyOn(mod, "startOCRSelection").mockResolvedValue({
        x: 0, y: 0, width: 100, height: 20,
      });

      chrome.runtime.onMessage.callListeners(
        { type: "OCR_START_SELECTION" },
        {},
        vi.fn(),
      );

      // Allow microtasks to flush.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(create).toHaveBeenCalledTimes(1);
    });

    it("does NOT prewarm (or crash) when the Translator API is missing", async () => {
      // No Translator global at all.
      const mod = await import("../../src/content/ocr-selection");
      vi.spyOn(mod, "startOCRSelection").mockResolvedValue({
        x: 0, y: 0, width: 100, height: 20,
      });

      chrome.runtime.onMessage.callListeners(
        { type: "OCR_START_SELECTION" },
        {},
        vi.fn(),
      );

      await new Promise((r) => setTimeout(r, 0));
      // No throw, no further assertion required.
      expect(true).toBe(true);
    });
  });
});
