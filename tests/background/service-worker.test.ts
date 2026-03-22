import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/constants";
import type { PinyinRequest, PinyinResponseLocal } from "../../src/shared/types";

/**
 * vitest-chrome-mv3 does not include chrome.commands in its generated
 * mocks. We patch it in before each test so the service worker's
 * chrome.commands.onCommand.addListener call doesn't throw.
 */
function ensureCommandsMock() {
  if (!(chrome as any).commands) {
    (chrome as any).commands = {};
  }
  if (!(chrome as any).commands.onCommand) {
    const listeners = new Set<Function>();
    (chrome as any).commands.onCommand = {
      addListener: vi.fn((fn: Function) => listeners.add(fn)),
      removeListener: vi.fn((fn: Function) => listeners.delete(fn)),
      hasListener: vi.fn((fn: Function) => listeners.has(fn)),
      hasListeners: vi.fn(() => listeners.size > 0),
      callListeners: vi.fn((...args: unknown[]) => {
        listeners.forEach((fn) => fn(...args));
      }),
      clearListeners: vi.fn(() => listeners.clear()),
    };
  }
}

/**
 * Loads (or re-loads) the service worker module so its top-level
 * addListener calls run against the current set of chrome mocks.
 * Uses vi.resetModules() to bust the module cache.
 */
async function loadServiceWorker() {
  vi.resetModules();
  return import("../../src/background/service-worker");
}

const SAMPLE_REQUEST: PinyinRequest = {
  type: "PINYIN_REQUEST",
  text: "你好",
  context: "朋友说你好",
  selectionRect: { top: 0, left: 0, bottom: 20, right: 50, width: 50, height: 20 },
};

describe("service-worker", () => {
  beforeEach(() => {
    ensureCommandsMock();
    // Mock chrome.storage.sync.get to return empty (=> DEFAULT_SETTINGS)
    chrome.storage.sync.get.mockImplementation(() => Promise.resolve({}));
    // Mock chrome.contextMenus.create to be a no-op
    chrome.contextMenus.create.mockImplementation(() => 1);
  });

  describe("message handling", () => {
    it("responds to PINYIN_REQUEST with PINYIN_RESPONSE_LOCAL", async () => {
      await loadServiceWorker();

      const sendResponse = vi.fn();

      chrome.runtime.onMessage.callListeners(
        SAMPLE_REQUEST,
        { tab: { id: 1 } },
        sendResponse,
      );

      // sendResponse is called asynchronously after getSettings() resolves
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const response: PinyinResponseLocal = sendResponse.mock.calls[0][0];
      expect(response.type).toBe("PINYIN_RESPONSE_LOCAL");
      expect(response.words.length).toBeGreaterThan(0);
      expect(response.words.some((w) => w.chars.includes("你"))).toBe(true);
    });

    it("ignores messages with unknown type", async () => {
      await loadServiceWorker();

      const sendResponse = vi.fn();

      const result = chrome.runtime.onMessage.callListeners(
        { type: "UNKNOWN" },
        { tab: { id: 1 } },
        sendResponse,
      );

      // Give any async work a tick to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("returns words with correct pinyin style from settings", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ pinyinStyle: "toneNumbers" }),
      );

      await loadServiceWorker();

      const sendResponse = vi.fn();

      chrome.runtime.onMessage.callListeners(
        SAMPLE_REQUEST,
        { tab: { id: 1 } },
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

      const response: PinyinResponseLocal = sendResponse.mock.calls[0][0];
      const allPinyin = response.words.map((w) => w.pinyin).join(" ");
      expect(allPinyin).toMatch(/[1-4]/);
    });
  });

  describe("context menu", () => {
    it("creates context menu item on install", async () => {
      await loadServiceWorker();

      chrome.runtime.onInstalled.callListeners({ reason: "install" });

      expect(chrome.contextMenus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "show-pinyin",
          title: "Show Pinyin & Translation",
          contexts: ["selection"],
        }),
      );
    });

    it("sends CONTEXT_MENU_TRIGGER when context menu is clicked", async () => {
      await loadServiceWorker();

      chrome.contextMenus.onClicked.callListeners(
        { menuItemId: "show-pinyin", selectionText: "你好世界" },
        { id: 42 },
      );

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: "CONTEXT_MENU_TRIGGER",
        text: "你好世界",
      });
    });
  });

  describe("keyboard command", () => {
    it("sends COMMAND_TRIGGER on show-pinyin command", async () => {
      await loadServiceWorker();

      (chrome as any).commands.onCommand.callListeners("show-pinyin", {
        id: 7,
      });

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
        type: "COMMAND_TRIGGER",
      });
    });
  });

  describe("getSettings", () => {
    it("returns DEFAULT_SETTINGS when storage is empty", async () => {
      chrome.storage.sync.get.mockImplementation(() => Promise.resolve({}));

      const { getSettings } = await loadServiceWorker();
      const settings = await getSettings();

      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it("merges stored settings with defaults", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ pinyinStyle: "none", fontSize: 20 }),
      );

      const { getSettings } = await loadServiceWorker();
      const settings = await getSettings();

      expect(settings.pinyinStyle).toBe("none");
      expect(settings.fontSize).toBe(20);
      // Non-overridden fields remain at defaults
      expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
      expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    });
  });
});
