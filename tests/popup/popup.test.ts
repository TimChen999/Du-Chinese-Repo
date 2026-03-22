/**
 * Tests for the popup settings UI (Step 8).
 *
 * Verifies settings loading from chrome.storage.sync, provider switching
 * behavior (auto-fill base URL, model list, API key visibility), save
 * validation (API key length, base URL format), and interactive UI
 * elements (API key toggle, font size slider label).
 *
 * Each test builds a minimal DOM matching popup.html's element IDs,
 * then calls initPopup() directly (bypassing DOMContentLoaded).
 *
 * See: IMPLEMENTATION_GUIDE.md Step 8 "Test file: tests/popup/popup.test.ts".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROVIDER_PRESETS, DEFAULT_SETTINGS } from "../../src/shared/constants";

// ─── DOM scaffold ────────────────────────────────────────────────────

/** Injects the minimal DOM elements that popup.ts querySelector expects. */
function buildPopupDOM(): void {
  document.body.innerHTML = `
    <select id="provider">
      <option value="openai">OpenAI</option>
      <option value="gemini">Google Gemini</option>
      <option value="ollama">Ollama (local)</option>
      <option value="custom">Custom</option>
    </select>

    <div id="api-key-group">
      <div class="input-row">
        <input type="password" id="api-key" />
        <button id="toggle-key">Show</button>
      </div>
    </div>

    <input type="text" id="base-url" />

    <select id="model"></select>
    <input type="text" id="custom-model" class="hidden" />

    <label><input type="radio" name="pinyin-style" value="toneMarks" /></label>
    <label><input type="radio" name="pinyin-style" value="toneNumbers" /></label>
    <label><input type="radio" name="pinyin-style" value="none" /></label>

    <input type="range" id="font-size" min="12" max="24" step="1" />
    <span id="font-size-label">16</span>

    <select id="theme">
      <option value="auto">Auto</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>

    <input type="checkbox" id="llm-enabled" />

    <button id="save-btn">Save Settings</button>
    <div id="status"></div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const el = {
  get provider() { return document.getElementById("provider") as HTMLSelectElement; },
  get apiKey() { return document.getElementById("api-key") as HTMLInputElement; },
  get apiKeyGroup() { return document.getElementById("api-key-group") as HTMLDivElement; },
  get toggleKey() { return document.getElementById("toggle-key") as HTMLButtonElement; },
  get baseUrl() { return document.getElementById("base-url") as HTMLInputElement; },
  get model() { return document.getElementById("model") as HTMLSelectElement; },
  get customModel() { return document.getElementById("custom-model") as HTMLInputElement; },
  get fontSize() { return document.getElementById("font-size") as HTMLInputElement; },
  get fontSizeLabel() { return document.getElementById("font-size-label") as HTMLSpanElement; },
  get theme() { return document.getElementById("theme") as HTMLSelectElement; },
  get llmEnabled() { return document.getElementById("llm-enabled") as HTMLInputElement; },
  get saveBtn() { return document.getElementById("save-btn") as HTMLButtonElement; },
  get status() { return document.getElementById("status") as HTMLDivElement; },
  pinyinRadio(value: string) {
    return document.querySelector<HTMLInputElement>(`input[name="pinyin-style"][value="${value}"]`)!;
  },
};

async function loadPopup() {
  vi.resetModules();
  const mod = await import("../../src/popup/popup");
  await mod.initPopup();
  return mod;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("popup settings", () => {
  beforeEach(() => {
    buildPopupDOM();
    chrome.storage.sync.get.mockImplementation(() => Promise.resolve({}));
    chrome.storage.sync.set.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // ─── Loading settings ──────────────────────────────────────────

  describe("loading settings", () => {
    it("populates form fields from chrome.storage.sync", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({
          provider: "gemini",
          apiKey: "my-gemini-key-12345",
          baseUrl: "https://generativelanguage.googleapis.com",
          model: "gemini-2.0-flash",
          pinyinStyle: "toneNumbers",
          fontSize: 20,
          theme: "dark",
          llmEnabled: false,
        }),
      );

      await loadPopup();

      expect(el.provider.value).toBe("gemini");
      expect(el.apiKey.value).toBe("my-gemini-key-12345");
      expect(el.baseUrl.value).toBe("https://generativelanguage.googleapis.com");
      expect(el.model.value).toBe("gemini-2.0-flash");
      expect(el.pinyinRadio("toneNumbers").checked).toBe(true);
      expect(el.fontSize.value).toBe("20");
      expect(el.fontSizeLabel.textContent).toBe("20");
      expect(el.theme.value).toBe("dark");
      expect(el.llmEnabled.checked).toBe(false);
    });

    it("uses DEFAULT_SETTINGS when storage is empty", async () => {
      await loadPopup();

      expect(el.provider.value).toBe("openai");
      expect(el.apiKey.value).toBe("");
      expect(el.baseUrl.value).toBe(DEFAULT_SETTINGS.baseUrl);
      expect(el.pinyinRadio("toneMarks").checked).toBe(true);
      expect(el.fontSize.value).toBe("16");
      expect(el.theme.value).toBe("auto");
      expect(el.llmEnabled.checked).toBe(true);
    });

    it("populates model dropdown from provider preset", async () => {
      await loadPopup();

      const options = Array.from(el.model.options).map((o) => o.value);
      expect(options).toContain("gpt-4o-mini");
      expect(options).toContain("gpt-4o");
      expect(options).toContain("__custom__");
    });
  });

  // ─── Provider switching ────────────────────────────────────────

  describe("provider switching", () => {
    it("auto-fills base URL when provider changes to Gemini", async () => {
      await loadPopup();

      el.provider.value = "gemini";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.baseUrl.value).toBe(PROVIDER_PRESETS.gemini.baseUrl);
      const modelOptions = Array.from(el.model.options).map((o) => o.value);
      expect(modelOptions).toContain("gemini-2.0-flash");
    });

    it("auto-fills base URL when provider changes to Ollama", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.baseUrl.value).toBe("http://localhost:11434/v1");
      const modelOptions = Array.from(el.model.options).map((o) => o.value);
      expect(modelOptions).toContain("qwen2.5:7b");
    });

    it("hides API key field when provider is Ollama", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.apiKeyGroup.classList.contains("hidden")).toBe(true);
    });

    it("shows API key field when provider is OpenAI", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));
      el.provider.value = "openai";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.apiKeyGroup.classList.contains("hidden")).toBe(false);
    });

    it("shows empty fields when provider is Custom", async () => {
      await loadPopup();

      el.provider.value = "custom";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.baseUrl.value).toBe("");
      const presetModels = Array.from(el.model.options)
        .map((o) => o.value)
        .filter((v) => v !== "__custom__");
      expect(presetModels).toEqual([]);
    });
  });

  // ─── Saving settings ──────────────────────────────────────────

  describe("saving settings", () => {
    it("writes form values including provider to chrome.storage.sync", async () => {
      await loadPopup();

      el.provider.value = "gemini";
      el.provider.dispatchEvent(new Event("change"));
      el.apiKey.value = "AIza-test-key-valid-length";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );

      const saved = chrome.storage.sync.set.mock.calls[0][0];
      expect(saved.provider).toBe("gemini");
      expect(saved.apiKey).toBe("AIza-test-key-valid-length");
    });

    it("shows success message after save", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));
      el.baseUrl.value = "http://localhost:11434/v1";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(el.status.textContent).toBe("Settings saved."),
      );
      expect(el.status.className).toBe("success");
    });

    it("validates API key when provider requires it", async () => {
      await loadPopup();

      el.apiKey.value = "abc";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(el.status.textContent).toContain("API key must be"),
      );
      expect(el.status.className).toBe("error");
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("skips API key validation when provider does not require it", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));
      el.apiKey.value = "";
      el.baseUrl.value = "http://localhost:11434/v1";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );
    });

    it("validates base URL format", async () => {
      await loadPopup();

      el.apiKey.value = "sk-valid-test-key-123";
      el.baseUrl.value = "not-a-url";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(el.status.textContent).toContain("Base URL must start with"),
      );
      expect(el.status.className).toBe("error");
    });

    it("accepts valid base URL with http", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));
      el.baseUrl.value = "http://localhost:11434/v1";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );
    });
  });

  // ─── UI interactions ──────────────────────────────────────────

  describe("UI interactions", () => {
    it("toggles API key visibility", async () => {
      await loadPopup();

      expect(el.apiKey.type).toBe("password");

      el.toggleKey.click();
      expect(el.apiKey.type).toBe("text");
      expect(el.toggleKey.textContent).toBe("Hide");

      el.toggleKey.click();
      expect(el.apiKey.type).toBe("password");
      expect(el.toggleKey.textContent).toBe("Show");
    });

    it("updates font size label when slider changes", async () => {
      await loadPopup();

      el.fontSize.value = "20";
      el.fontSize.dispatchEvent(new Event("input"));

      expect(el.fontSizeLabel.textContent).toBe("20");
    });

    it("shows custom model input when Custom is selected in model dropdown", async () => {
      await loadPopup();

      el.model.value = "__custom__";
      el.model.dispatchEvent(new Event("change"));

      expect(el.customModel.classList.contains("hidden")).toBe(false);
    });

    it("hides custom model input when a preset model is selected", async () => {
      await loadPopup();

      el.model.value = "__custom__";
      el.model.dispatchEvent(new Event("change"));

      el.model.value = "gpt-4o-mini";
      el.model.dispatchEvent(new Event("change"));

      expect(el.customModel.classList.contains("hidden")).toBe(true);
    });
  });
});
