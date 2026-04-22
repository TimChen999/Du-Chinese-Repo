/**
 * Tests for the Shadow DOM overlay component (Step 6).
 *
 * Verifies the seven exported functions: createOverlay, showOverlay,
 * updateOverlay, showOverlayError, dismissOverlay, renderRubyText,
 * and calculatePosition.
 * Uses jsdom's limited Shadow DOM support -- queries go through
 * host.shadowRoot rather than document.querySelector.
 *
 * See: IMPLEMENTATION_GUIDE.md Step 6 "Test file" for the expected
 *      test structure and coverage targets.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createOverlay,
  showOverlay,
  updateOverlay,
  showOverlayError,
  dismissOverlay,
  renderRubyText,
  calculatePosition,
  setVocabCallback,
} from "../../src/content/overlay";
import type { WordData } from "../../src/shared/types";

describe("overlay", () => {
  afterEach(() => {
    dismissOverlay();
  });

  // ─── createOverlay ─────────────────────────────────────────────
  describe("createOverlay", () => {
    it("creates a shadow DOM root in the document body", () => {
      const root = createOverlay();
      expect(root).toBeDefined();
      const host = document.getElementById("hg-extension-root");
      expect(host).not.toBeNull();
      expect(host!.shadowRoot).toBe(root);
    });

    it("reuses existing root on second call", () => {
      const root1 = createOverlay();
      const root2 = createOverlay();
      expect(root1).toBe(root2);
      const hosts = document.querySelectorAll("#hg-extension-root");
      expect(hosts.length).toBe(1);
    });

    it("injects a <style> element into the shadow root", () => {
      const root = createOverlay();
      const style = root.querySelector("style");
      expect(style).not.toBeNull();
    });
  });

  // ─── renderRubyText ────────────────────────────────────────────
  describe("renderRubyText", () => {
    it("renders ruby elements for each word", () => {
      const words: WordData[] = [
        { chars: "你好", pinyin: "nǐ hǎo" },
        { chars: "世界", pinyin: "shì jiè" },
      ];
      const html = renderRubyText(words);
      expect(html).toContain("<ruby");
      expect(html).toContain("<rt>nǐ hǎo</rt>");
      expect(html).toContain("<rt>shì jiè</rt>");
      expect(html).toContain("你好");
      expect(html).toContain("世界");
    });

    it("adds hg-word class, data-chars, and data-pinyin attributes", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const html = renderRubyText(words);
      expect(html).toContain('class="hg-word"');
      expect(html).toContain('data-chars="好"');
      expect(html).toContain('data-pinyin="hǎo"');
    });

    it("includes data-definition when present", () => {
      const words: WordData[] = [
        { chars: "好", pinyin: "hǎo", definition: "good" },
      ];
      const html = renderRubyText(words);
      expect(html).toContain('data-definition="good"');
    });

    it("omits data-definition when absent", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const html = renderRubyText(words);
      expect(html).not.toContain("data-definition");
    });

    it("returns empty string for empty array", () => {
      expect(renderRubyText([])).toBe("");
    });

    it("escapes HTML characters in chars and pinyin", () => {
      const words: WordData[] = [{ chars: "<b>", pinyin: "a&b" }];
      const html = renderRubyText(words);
      expect(html).toContain("&lt;b&gt;");
      expect(html).toContain("a&amp;b");
      expect(html).not.toContain("<b>");
    });
  });

  // ─── calculatePosition ────────────────────────────────────────
  describe("calculatePosition", () => {
    it("places overlay below the selection by default", () => {
      const rect = makeDOMRect(100, 200, 200, 20);
      const pos = calculatePosition(rect, 300, 200);
      expect(pos.top).toBeGreaterThan(rect.bottom);
    });

    it("places overlay above when insufficient space below", () => {
      const rect = makeDOMRect(700, 200, 200, 20);
      const pos = calculatePosition(rect, 300, 200);
      expect(pos.top).toBeLessThan(rect.top);
    });

    it("never returns negative left position", () => {
      const rect = makeDOMRect(100, 5, 45, 20);
      const pos = calculatePosition(rect, 500, 200);
      expect(pos.left).toBeGreaterThanOrEqual(0);
    });

    it("clamps left so overlay does not exceed viewport width", () => {
      const rect = makeDOMRect(100, 900, 100, 20);
      const pos = calculatePosition(rect, 500, 200);
      expect(pos.left + 500).toBeLessThanOrEqual(window.innerWidth);
    });

    it("centers overlay horizontally on the selection", () => {
      const rect = makeDOMRect(100, 400, 100, 20);
      const pos = calculatePosition(rect, 200, 100);
      const selCenter = rect.left + rect.width / 2;
      const overlayCenter = pos.left + 200 / 2;
      expect(Math.abs(selCenter - overlayCenter)).toBeLessThan(10);
    });
  });

  // ─── showOverlay / dismissOverlay ──────────────────────────────
  describe("showOverlay / dismissOverlay", () => {
    it("renders overlay with pinyin content", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      const rect = makeDOMRect(100, 200, 100, 20);
      showOverlay(words, rect, "light");

      const host = document.getElementById("hg-extension-root");
      expect(host).not.toBeNull();
      const shadow = host!.shadowRoot!;
      const overlay = shadow.querySelector(".hg-overlay");
      expect(overlay).not.toBeNull();
      expect(overlay!.innerHTML).toContain("好");
      expect(overlay!.innerHTML).toContain("hǎo");
    });

    it("applies the light theme class", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light");

      const host = document.getElementById("hg-extension-root");
      const overlay = host!.shadowRoot!.querySelector(".hg-overlay");
      expect(overlay!.classList.contains("hg-light")).toBe(true);
    });

    it("applies the dark theme class", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "dark");

      const host = document.getElementById("hg-extension-root");
      const overlay = host!.shadowRoot!.querySelector(".hg-overlay");
      expect(overlay!.classList.contains("hg-dark")).toBe(true);
    });

    it("shows loading indicator in the translation area", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light");

      const host = document.getElementById("hg-extension-root");
      const loading = host!.shadowRoot!.querySelector(".hg-loading");
      expect(loading).not.toBeNull();
      expect(loading!.textContent).toContain("Loading");
    });

    it("shows loading indicator when llmEnabled is explicitly true", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light", false, true);

      const host = document.getElementById("hg-extension-root");
      const translation = host!.shadowRoot!.querySelector(".hg-translation");
      expect(translation).not.toBeNull();
      expect(translation!.classList.contains("hg-loading")).toBe(true);
    });

    it("omits the translation row when llmEnabled is false", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light", false, false);

      const host = document.getElementById("hg-extension-root");
      const translation = host!.shadowRoot!.querySelector(".hg-translation");
      expect(translation).toBeNull();
      // The pinyin row is still rendered.
      expect(host!.shadowRoot!.querySelector(".hg-pinyin-row")).not.toBeNull();
    });

    it("includes a close button", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light");

      const host = document.getElementById("hg-extension-root");
      const btn = host!.shadowRoot!.querySelector(".hg-close-btn");
      expect(btn).not.toBeNull();
    });

    it("dismissOverlay removes the overlay from DOM", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light");
      dismissOverlay();

      const host = document.getElementById("hg-extension-root");
      expect(host).toBeNull();
    });

    it("replaces content when showOverlay is called again", () => {
      showOverlay(
        [{ chars: "你", pinyin: "nǐ" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "dark",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const overlays = shadow.querySelectorAll(".hg-overlay");
      expect(overlays.length).toBe(1);
      expect(overlays[0].innerHTML).toContain("好");
      expect(overlays[0].classList.contains("hg-dark")).toBe(true);
    });
  });

  // ─── updateOverlay ─────────────────────────────────────────────
  describe("updateOverlay", () => {
    it("replaces loading indicator with translation text", () => {
      const words: WordData[] = [{ chars: "好", pinyin: "hǎo" }];
      showOverlay(words, makeDOMRect(100, 200, 100, 20), "light");

      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      expect(shadow.querySelector(".hg-loading")).toBeNull();
      const translation = shadow.querySelector(".hg-translation");
      expect(translation!.textContent).toBe("Good.");
    });

    it("updates ruby elements with definition data", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );

      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good; fine" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const word = host!.shadowRoot!.querySelector(".hg-word");
      expect(word!.getAttribute("data-definition")).toBe("good; fine");
    });

    it("does nothing if overlay has been dismissed", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      dismissOverlay();

      expect(() =>
        updateOverlay(
          [{ chars: "好", pinyin: "hǎo", definition: "good" }],
          "Good.",
        ),
      ).not.toThrow();
    });
  });

  // ─── showOverlayError ──────────────────────────────────────────
  describe("showOverlayError", () => {
    it("replaces loading indicator with an error message", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );

      showOverlayError("Translation unavailable — using local pinyin only.");

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      expect(shadow.querySelector(".hg-loading")).toBeNull();
      const translation = shadow.querySelector(".hg-translation");
      expect(translation!.textContent).toBe(
        "Translation unavailable — using local pinyin only.",
      );
    });

    it("does nothing if overlay has been dismissed", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      dismissOverlay();

      expect(() =>
        showOverlayError("Translation unavailable."),
      ).not.toThrow();
    });
  });

  // ─── Word click handler (definition card toggle) ───────────────
  describe("word click handler", () => {
    it("shows a definition card when a word with definition is clicked", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();

      const card = shadow.querySelector(".hg-definition-card");
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain("好");
      expect(card!.textContent).toContain("good");
    });

    it("removes the definition card on second click (toggle)", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();
      word.click();

      expect(shadow.querySelector(".hg-definition-card")).toBeNull();
    });

    it("does nothing when a word without definition is clicked", () => {
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();

      expect(shadow.querySelector(".hg-definition-card")).toBeNull();
    });
  });

  // ─── Add to Vocab button ──────────────────────────────────────────
  describe("add to vocab button", () => {
    afterEach(() => {
      setVocabCallback(() => {});
    });

    it("shows an Add to Vocab button in the definition card when callback is registered", () => {
      setVocabCallback(() => {});
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();

      const btn = shadow.querySelector(".hg-add-vocab-btn") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain("Vocab");
    });

    it("calls the registered vocab callback with word data on click", () => {
      const cb = vi.fn();
      setVocabCallback(cb);
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();

      const btn = shadow.querySelector(".hg-add-vocab-btn") as HTMLButtonElement;
      btn.click();

      expect(cb).toHaveBeenCalledWith({
        chars: "好",
        pinyin: "hǎo",
        definition: "good",
      });
    });

    it("disables the button and shows Added state after click", () => {
      setVocabCallback(() => {});
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );
      updateOverlay(
        [{ chars: "好", pinyin: "hǎo", definition: "good" }],
        "Good.",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();

      const btn = shadow.querySelector(".hg-add-vocab-btn") as HTMLButtonElement;
      btn.click();

      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Added");
      expect(btn.classList.contains("hg-added")).toBe(true);
    });

    it("does not show the button when no definition is present (Phase 1)", () => {
      setVocabCallback(() => {});
      showOverlay(
        [{ chars: "好", pinyin: "hǎo" }],
        makeDOMRect(100, 200, 100, 20),
        "light",
      );

      const host = document.getElementById("hg-extension-root");
      const shadow = host!.shadowRoot!;
      const word = shadow.querySelector(".hg-word") as HTMLElement;
      word.click();

      expect(shadow.querySelector(".hg-add-vocab-btn")).toBeNull();
    });
  });
});

// ─── Test helpers ────────────────────────────────────────────────

/** Creates a DOMRect-like object for positioning tests. */
function makeDOMRect(
  top: number,
  left: number,
  width: number,
  height: number,
): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}
