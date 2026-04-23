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

vi.mock("../../src/background/vocab-store", () => ({
  getAllVocab: vi.fn().mockResolvedValue([]),
  clearVocab: vi.fn().mockResolvedValue(undefined),
}));

// ─── DOM scaffold ────────────────────────────────────────────────────

/** Injects the minimal DOM elements that popup.ts querySelector expects. */
function buildPopupDOM(): void {
  document.body.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="settings">Settings</button>
      <button class="tab-btn" data-tab="vocab">Vocab</button>
    </div>

    <div id="tab-settings">
      <div class="ai-section">
        <div class="ai-section-header">
          <label class="switch-label" for="llm-enabled">
            <input type="checkbox" id="llm-enabled" class="switch-input" />
            <span class="switch-track"><span class="switch-thumb"></span></span>
            <span class="switch-text">AI Translations</span>
          </label>
          <button type="button" id="ai-info-btn" class="info-btn"
                  aria-label="About AI Translations" aria-expanded="false">i</button>
          <div id="ai-info-popover" class="info-popover hidden" role="tooltip">
            AI translations use an LLM (e.g. Gemini, OpenAI) to provide context-aware
            translations of selected text. Requires your own API key.
          </div>
        </div>

        <div id="ai-config-fields">
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

          <div class="input-row">
            <select id="model"></select>
            <button type="button" id="refresh-models" class="hidden">&#x21bb;</button>
          </div>
          <input type="text" id="custom-model" class="hidden" />

          <p id="api-key-warning" class="inline-warning hidden">API key required</p>
        </div>
      </div>

      <div class="lookup-behavior">
        <input type="checkbox" id="overlay-enabled" />
        <input type="checkbox" id="tts-enabled" />
      </div>

      <hr class="section-divider" />

      <label><input type="radio" name="pinyin-style" value="toneMarks" /></label>
      <label><input type="radio" name="pinyin-style" value="toneNumbers" /></label>
      <label><input type="radio" name="pinyin-style" value="none" /></label>

      <input type="range" id="font-size" min="12" max="24" step="1" />
      <span id="font-size-label">16</span>

      <select id="theme">
        <option value="auto">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="sepia">Sepia</option>
      </select>

      <button id="save-btn">Save Settings</button>
      <div id="status"></div>
    </div>

    <button id="ocr-btn">Select text from image</button>
    <button id="library-btn">Open Library</button>

    <div id="tab-vocab" class="hidden">
      <div id="vocab-list"></div>
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const el = {
  get provider() { return document.getElementById("provider") as HTMLSelectElement; },
  get apiKey() { return document.getElementById("api-key") as HTMLInputElement; },
  get apiKeyGroup() { return document.getElementById("api-key-group") as HTMLDivElement; },
  get apiKeyWarning() { return document.getElementById("api-key-warning") as HTMLParagraphElement; },
  get toggleKey() { return document.getElementById("toggle-key") as HTMLButtonElement; },
  get baseUrl() { return document.getElementById("base-url") as HTMLInputElement; },
  get model() { return document.getElementById("model") as HTMLSelectElement; },
  get customModel() { return document.getElementById("custom-model") as HTMLInputElement; },
  get fontSize() { return document.getElementById("font-size") as HTMLInputElement; },
  get fontSizeLabel() { return document.getElementById("font-size-label") as HTMLSpanElement; },
  get theme() { return document.getElementById("theme") as HTMLSelectElement; },
  get llmEnabled() { return document.getElementById("llm-enabled") as HTMLInputElement; },
  get overlayEnabled() { return document.getElementById("overlay-enabled") as HTMLInputElement; },
  get aiConfigFields() { return document.getElementById("ai-config-fields") as HTMLDivElement; },
  get aiInfoBtn() { return document.getElementById("ai-info-btn") as HTMLButtonElement; },
  get aiInfoPopover() { return document.getElementById("ai-info-popover") as HTMLDivElement; },
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

/** Helper: builds a successful Ollama /models fetch mock response. */
function ollamaModelsResponse(models: string[]) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: models.map((id) => ({ id })) }),
  });
}

describe("popup settings", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    buildPopupDOM();
    chrome.storage.sync.get.mockImplementation(() => Promise.resolve({}));
    chrome.storage.sync.set.mockImplementation(() => Promise.resolve());
    fetchSpy = vi.fn().mockRejectedValue(new Error("fetch not mocked"));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  // ─── Loading settings ──────────────────────────────────────────

  describe("loading settings", () => {
    it("populates form fields from chrome.storage.sync", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({
          provider: "gemini",
          apiKey: "my-gemini-key-12345",
          baseUrl: "https://generativelanguage.googleapis.com",
          model: "gemini-2.5-flash",
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
      expect(el.model.value).toBe("gemini-2.5-flash");
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
      expect(el.overlayEnabled.checked).toBe(true);
    });

    it("loads overlayEnabled=false from storage", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ overlayEnabled: false }),
      );

      await loadPopup();

      expect(el.overlayEnabled.checked).toBe(false);
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
      expect(modelOptions).toContain("gemini-2.5-flash");
    });

    it("auto-fills base URL when provider changes to Ollama", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.baseUrl.value).toBe("http://localhost:11434/v1");
      await vi.waitFor(() => {
        const modelOptions = Array.from(el.model.options).map((o) => o.value);
        expect(modelOptions).toContain("qwen2.5:7b");
      });
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
      await vi.waitFor(() => {
        expect(el.model.options.length).toBeGreaterThan(1);
      });

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

    it("persists overlayEnabled when toggled off", async () => {
      await loadPopup();

      el.apiKey.value = "sk-valid-test-key-123";
      el.overlayEnabled.checked = false;
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );

      const saved = chrome.storage.sync.set.mock.calls[0][0];
      expect(saved.overlayEnabled).toBe(false);
    });

    it("persists overlayEnabled=true after a load+save round-trip", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ overlayEnabled: false, apiKey: "sk-valid-test-key-123" }),
      );
      await loadPopup();

      // User flips it back on.
      el.overlayEnabled.checked = true;
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );

      const saved = chrome.storage.sync.set.mock.calls[0][0];
      expect(saved.overlayEnabled).toBe(true);
    });

    it("shows success message after save", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));
      await vi.waitFor(() => {
        expect(el.model.options.length).toBeGreaterThan(1);
      });
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
      await vi.waitFor(() => {
        expect(el.model.options.length).toBeGreaterThan(1);
      });
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
      await vi.waitFor(() => {
        expect(el.model.options.length).toBeGreaterThan(1);
      });
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

  // ─── Dynamic Ollama model fetching ──────────────────────────────

  describe("dynamic Ollama model fetching", () => {
    it("populates dropdown with fetched models when Ollama is reachable", async () => {
      fetchSpy.mockImplementation(() =>
        ollamaModelsResponse(["deepseek-r1:8b", "qwen2.5:7b", "llama3:8b"]),
      );

      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const modelOptions = Array.from(el.model.options).map((o) => o.value);
        expect(modelOptions).toContain("deepseek-r1:8b");
        expect(modelOptions).toContain("qwen2.5:7b");
        expect(modelOptions).toContain("llama3:8b");
      });
    });

    it("falls back to hardcoded preset models when Ollama is unreachable", async () => {
      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const modelOptions = Array.from(el.model.options).map((o) => o.value);
        expect(modelOptions).toContain("qwen2.5:7b");
        expect(modelOptions).toContain("__custom__");
      });
      expect(el.status.textContent).toContain("Could not reach Ollama");
    });

    it("fetches models on initial load when provider is Ollama", async () => {
      fetchSpy.mockImplementation(() =>
        ollamaModelsResponse(["phi3:mini", "gemma2:9b"]),
      );
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          model: "phi3:mini",
        }),
      );

      await loadPopup();

      const modelOptions = Array.from(el.model.options).map((o) => o.value);
      expect(modelOptions).toContain("phi3:mini");
      expect(modelOptions).toContain("gemma2:9b");
      expect(el.model.value).toBe("phi3:mini");
    });

    it("shows refresh button only for Ollama provider", async () => {
      fetchSpy.mockImplementation(() =>
        ollamaModelsResponse(["qwen2.5:7b"]),
      );

      await loadPopup();
      const refreshBtn = document.getElementById("refresh-models") as HTMLButtonElement;

      expect(refreshBtn.classList.contains("hidden")).toBe(true);

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));
      await vi.waitFor(() => {
        expect(refreshBtn.classList.contains("hidden")).toBe(false);
      });

      el.provider.value = "openai";
      el.provider.dispatchEvent(new Event("change"));
      expect(refreshBtn.classList.contains("hidden")).toBe(true);
    });

    it("sorts fetched models alphabetically", async () => {
      fetchSpy.mockImplementation(() =>
        ollamaModelsResponse(["zephyr:7b", "alpha:3b", "mistral:7b"]),
      );

      await loadPopup();

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const modelOptions = Array.from(el.model.options)
          .map((o) => o.value)
          .filter((v) => v !== "__custom__");
        expect(modelOptions).toEqual(["alpha:3b", "mistral:7b", "zephyr:7b"]);
      });
    });
  });

  // ─── AI Translations toggle group ──────────────────────────────

  describe("AI Translations toggle group", () => {
    it("collapses #ai-config-fields on init when stored llmEnabled is false", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ llmEnabled: false }),
      );

      await loadPopup();

      expect(el.llmEnabled.checked).toBe(false);
      expect(el.aiConfigFields.classList.contains("hidden")).toBe(true);
    });

    it("expands #ai-config-fields on init when stored llmEnabled is true", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ llmEnabled: true }),
      );

      await loadPopup();

      expect(el.aiConfigFields.classList.contains("hidden")).toBe(false);
    });

    it("expands fields when toggle flips on", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ llmEnabled: false }),
      );

      await loadPopup();
      expect(el.aiConfigFields.classList.contains("hidden")).toBe(true);

      el.llmEnabled.checked = true;
      el.llmEnabled.dispatchEvent(new Event("change"));

      expect(el.aiConfigFields.classList.contains("hidden")).toBe(false);
    });

    it("preserves field values when toggled off then on (no clearing)", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({
          provider: "gemini",
          apiKey: "AIza-preserved-key-12345",
          baseUrl: "https://generativelanguage.googleapis.com",
          model: "gemini-2.5-flash",
          llmEnabled: true,
        }),
      );

      await loadPopup();

      const beforeApiKey = el.apiKey.value;
      const beforeBaseUrl = el.baseUrl.value;
      const beforeModel = el.model.value;
      const beforeProvider = el.provider.value;

      el.llmEnabled.checked = false;
      el.llmEnabled.dispatchEvent(new Event("change"));
      expect(el.aiConfigFields.classList.contains("hidden")).toBe(true);

      el.llmEnabled.checked = true;
      el.llmEnabled.dispatchEvent(new Event("change"));

      expect(el.apiKey.value).toBe(beforeApiKey);
      expect(el.baseUrl.value).toBe(beforeBaseUrl);
      expect(el.model.value).toBe(beforeModel);
      expect(el.provider.value).toBe(beforeProvider);
    });

    it("shows API key warning when toggle is ON, provider needs key, and key is empty", async () => {
      await loadPopup();

      // Default settings: llmEnabled true, provider openai (requires key), key empty.
      expect(el.apiKey.value).toBe("");
      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(false);
    });

    it("hides API key warning when key is typed", async () => {
      await loadPopup();
      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(false);

      el.apiKey.value = "sk-some-key-value";
      el.apiKey.dispatchEvent(new Event("input"));

      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(true);
    });

    it("hides API key warning when toggle is off, even with empty key", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ llmEnabled: false, apiKey: "" }),
      );

      await loadPopup();

      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(true);
    });

    it("hides API key warning when provider switches to one that does not need a key", async () => {
      await loadPopup();
      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(false);

      el.provider.value = "ollama";
      el.provider.dispatchEvent(new Event("change"));

      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(true);
    });

    it("re-shows API key warning when toggling back on while key is still empty", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ llmEnabled: false, apiKey: "" }),
      );

      await loadPopup();
      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(true);

      el.llmEnabled.checked = true;
      el.llmEnabled.dispatchEvent(new Event("change"));

      expect(el.apiKeyWarning.classList.contains("hidden")).toBe(false);
    });

    it("saves successfully with empty API key when toggle is off (validation skipped)", async () => {
      await loadPopup();

      el.llmEnabled.checked = false;
      el.llmEnabled.dispatchEvent(new Event("change"));
      el.apiKey.value = "";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );

      const saved = chrome.storage.sync.set.mock.calls[0][0];
      expect(saved.llmEnabled).toBe(false);
      expect(el.status.textContent).toBe("Settings saved.");
    });

    it("still validates API key when toggle is on (existing behavior preserved)", async () => {
      await loadPopup();

      // llmEnabled defaults to true; provider openai requires a key.
      el.apiKey.value = "abc";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(el.status.textContent).toContain("API key must be"),
      );
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it("info popover toggles open/closed on info button click", async () => {
      await loadPopup();

      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(true);
      expect(el.aiInfoBtn.getAttribute("aria-expanded")).toBe("false");

      el.aiInfoBtn.click();
      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(false);
      expect(el.aiInfoBtn.getAttribute("aria-expanded")).toBe("true");

      el.aiInfoBtn.click();
      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(true);
      expect(el.aiInfoBtn.getAttribute("aria-expanded")).toBe("false");
    });

    it("info popover closes on outside click", async () => {
      await loadPopup();
      el.aiInfoBtn.click();
      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(false);

      document.body.click();

      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(true);
      expect(el.aiInfoBtn.getAttribute("aria-expanded")).toBe("false");
    });

    it("info popover stays open when clicking inside it", async () => {
      await loadPopup();
      el.aiInfoBtn.click();
      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(false);

      el.aiInfoPopover.click();

      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(false);
    });

    it("info popover closes on Escape key", async () => {
      await loadPopup();
      el.aiInfoBtn.click();
      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(false);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(el.aiInfoPopover.classList.contains("hidden")).toBe(true);
    });
  });

  // ─── Theme application ─────────────────────────────────────────
  //
  // The popup body now carries data-theme so popup.css's
  // `body[data-theme="dark"]` rules apply when the user picks Dark
  // or when Auto resolves to dark via prefers-color-scheme. These
  // tests guard against regressing back to a popup that ignores
  // the user's Theme setting.

  describe("theme application", () => {
    it("writes data-theme=light on body when stored theme is 'light'", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "light" }),
      );

      await loadPopup();

      expect(document.body.getAttribute("data-theme")).toBe("light");
    });

    it("writes data-theme=dark on body when stored theme is 'dark'", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "dark" }),
      );

      await loadPopup();

      expect(document.body.getAttribute("data-theme")).toBe("dark");
    });

    it("writes data-theme=sepia on body when stored theme is 'sepia'", async () => {
      // Sepia is now a selectable shared theme, not just a reader-
      // only override, so the popup must paint itself sepia too.
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "sepia" }),
      );

      await loadPopup();

      expect(document.body.getAttribute("data-theme")).toBe("sepia");
      expect(el.theme.value).toBe("sepia");
    });

    it("persists Sepia from the popup dropdown to the shared theme key", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "light", apiKey: "sk-valid-test-key-123" }),
      );

      await loadPopup();
      expect(document.body.getAttribute("data-theme")).toBe("light");

      el.theme.value = "sepia";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );
      const saved = chrome.storage.sync.set.mock.calls[0][0];
      expect(saved.theme).toBe("sepia");
      expect(document.body.getAttribute("data-theme")).toBe("sepia");
    });

    it("resolves auto to light when matchMedia is unavailable", async () => {
      // jsdom omits matchMedia by default; popup.ts must fall back
      // to "light" without throwing.
      await loadPopup();

      expect(document.body.getAttribute("data-theme")).toBe("light");
    });

    it("resolves auto to dark when prefers-color-scheme reports dark", async () => {
      const matchMediaSpy = vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })) as unknown as typeof window.matchMedia;
      vi.stubGlobal("matchMedia", matchMediaSpy);

      await loadPopup();

      expect(document.body.getAttribute("data-theme")).toBe("dark");
    });

    it("updates body[data-theme] live when the user changes the dropdown", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "light" }),
      );

      await loadPopup();
      expect(document.body.getAttribute("data-theme")).toBe("light");

      el.theme.value = "dark";
      el.theme.dispatchEvent(new Event("change"));

      expect(document.body.getAttribute("data-theme")).toBe("dark");
    });

    it("re-applies theme after Save so the popup matches the saved value", async () => {
      chrome.storage.sync.get.mockImplementation(() =>
        Promise.resolve({ theme: "light", apiKey: "sk-valid-test-key-123" }),
      );

      await loadPopup();
      expect(document.body.getAttribute("data-theme")).toBe("light");

      el.theme.value = "dark";
      el.saveBtn.click();

      await vi.waitFor(() =>
        expect(chrome.storage.sync.set).toHaveBeenCalled(),
      );
      expect(document.body.getAttribute("data-theme")).toBe("dark");
    });
  });
});
