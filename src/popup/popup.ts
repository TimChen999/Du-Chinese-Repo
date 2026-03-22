/**
 * Popup settings panel logic -- loads, validates, and persists user settings.
 *
 * On DOMContentLoaded, reads ExtensionSettings from chrome.storage.sync
 * (merged with DEFAULT_SETTINGS for missing keys) and populates every
 * form field. Provider switching auto-fills the base URL, model list,
 * and API key visibility from PROVIDER_PRESETS. Save validates inputs
 * before writing back to storage.
 *
 * Exports initPopup() so the popup can be tested without a real
 * DOMContentLoaded event.
 *
 * See: SPEC.md Section 2.5 "Settings and Configuration",
 *      IMPLEMENTATION_GUIDE.md Step 8b.
 */

import { DEFAULT_SETTINGS, PROVIDER_PRESETS } from "../shared/constants";
import type { ExtensionSettings, LLMProvider } from "../shared/types";

// ─── DOM References ─────────────────────────────────────────────────

function getElements() {
  return {
    provider: document.getElementById("provider") as HTMLSelectElement,
    apiKey: document.getElementById("api-key") as HTMLInputElement,
    apiKeyGroup: document.getElementById("api-key-group") as HTMLDivElement,
    toggleKey: document.getElementById("toggle-key") as HTMLButtonElement,
    baseUrl: document.getElementById("base-url") as HTMLInputElement,
    model: document.getElementById("model") as HTMLSelectElement,
    customModel: document.getElementById("custom-model") as HTMLInputElement,
    pinyinRadios: document.querySelectorAll<HTMLInputElement>(
      'input[name="pinyin-style"]',
    ),
    fontSize: document.getElementById("font-size") as HTMLInputElement,
    fontSizeLabel: document.getElementById("font-size-label") as HTMLSpanElement,
    theme: document.getElementById("theme") as HTMLSelectElement,
    llmEnabled: document.getElementById("llm-enabled") as HTMLInputElement,
    saveBtn: document.getElementById("save-btn") as HTMLButtonElement,
    status: document.getElementById("status") as HTMLDivElement,
  };
}

// ─── Settings I/O ───────────────────────────────────────────────────

/** Reads stored settings and merges with defaults for missing keys. */
async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Model Dropdown ─────────────────────────────────────────────────

/**
 * Rebuilds the model <select> from the provider preset's models array.
 * Appends a "Custom..." sentinel. If currentModel matches a listed
 * option, selects it; otherwise selects "Custom..." and reveals the
 * custom-model text input.
 */
function populateModels(
  modelSelect: HTMLSelectElement,
  customModelInput: HTMLInputElement,
  provider: LLMProvider,
  currentModel: string,
): void {
  const preset = PROVIDER_PRESETS[provider];
  modelSelect.innerHTML = "";

  for (const m of preset.models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    modelSelect.appendChild(opt);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom\u2026";
  modelSelect.appendChild(customOpt);

  if (preset.models.includes(currentModel)) {
    modelSelect.value = currentModel;
    customModelInput.classList.add("hidden");
  } else {
    modelSelect.value = "__custom__";
    customModelInput.value = currentModel;
    customModelInput.classList.remove("hidden");
  }
}

// ─── Provider Switch ────────────────────────────────────────────────

/**
 * When the user picks a new provider, auto-fill the base URL and
 * model list from PROVIDER_PRESETS, and show/hide the API key field
 * based on requiresApiKey. (SPEC.md Section 2.5)
 */
function onProviderChange(els: ReturnType<typeof getElements>): void {
  const provider = els.provider.value as LLMProvider;
  const preset = PROVIDER_PRESETS[provider];

  els.baseUrl.value = preset.baseUrl;
  els.baseUrl.placeholder = preset.baseUrl || "https://...";

  if (preset.requiresApiKey) {
    els.apiKeyGroup.classList.remove("hidden");
  } else {
    els.apiKeyGroup.classList.add("hidden");
  }

  populateModels(els.model, els.customModel, provider, preset.defaultModel);
}

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Returns an error string if inputs are invalid, or null if everything
 * checks out. Validates API key length for providers that require one,
 * and base URL prefix.
 */
function validateInputs(els: ReturnType<typeof getElements>): string | null {
  const provider = els.provider.value as LLMProvider;
  const preset = PROVIDER_PRESETS[provider];

  if (preset.requiresApiKey && els.apiKey.value.trim().length < 10) {
    return "API key must be at least 10 characters for this provider.";
  }

  const url = els.baseUrl.value.trim();
  if (url && !url.startsWith("http://") && !url.startsWith("https://")) {
    return "Base URL must start with http:// or https://.";
  }

  return null;
}

// ─── Save ───────────────────────────────────────────────────────────

/** Reads all form values into an ExtensionSettings object. */
function readFormValues(els: ReturnType<typeof getElements>): ExtensionSettings {
  let pinyinStyle = DEFAULT_SETTINGS.pinyinStyle;
  els.pinyinRadios.forEach((r) => {
    if (r.checked) pinyinStyle = r.value as ExtensionSettings["pinyinStyle"];
  });

  const modelValue =
    els.model.value === "__custom__"
      ? els.customModel.value.trim()
      : els.model.value;

  return {
    provider: els.provider.value as LLMProvider,
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim(),
    model: modelValue,
    pinyinStyle,
    fontSize: parseInt(els.fontSize.value, 10),
    theme: els.theme.value as ExtensionSettings["theme"],
    llmEnabled: els.llmEnabled.checked,
  };
}

/** Shows a timed status message (green success or red error). */
function showStatus(
  el: HTMLDivElement,
  message: string,
  type: "success" | "error",
): void {
  el.textContent = message;
  el.className = type;
  setTimeout(() => {
    el.textContent = "";
    el.className = "";
  }, 2000);
}

// ─── Initialization ─────────────────────────────────────────────────

/**
 * Main entry point. Exported so tests can call it directly after
 * setting up a DOM with the expected element IDs.
 */
export async function initPopup(): Promise<void> {
  const els = getElements();
  const settings = await loadSettings();

  // Populate form from stored settings
  els.provider.value = settings.provider;
  els.apiKey.value = settings.apiKey;
  els.baseUrl.value = settings.baseUrl;
  els.fontSize.value = String(settings.fontSize);
  els.fontSizeLabel.textContent = String(settings.fontSize);
  els.theme.value = settings.theme;
  els.llmEnabled.checked = settings.llmEnabled;

  els.pinyinRadios.forEach((r) => {
    r.checked = r.value === settings.pinyinStyle;
  });

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey) {
    els.apiKeyGroup.classList.remove("hidden");
  } else {
    els.apiKeyGroup.classList.add("hidden");
  }

  populateModels(els.model, els.customModel, settings.provider, settings.model);

  // ─── Event listeners ──────────────────────────────────────────

  els.provider.addEventListener("change", () => onProviderChange(els));

  els.model.addEventListener("change", () => {
    if (els.model.value === "__custom__") {
      els.customModel.classList.remove("hidden");
    } else {
      els.customModel.classList.add("hidden");
    }
  });

  els.toggleKey.addEventListener("click", () => {
    const isPassword = els.apiKey.type === "password";
    els.apiKey.type = isPassword ? "text" : "password";
    els.toggleKey.textContent = isPassword ? "Hide" : "Show";
  });

  els.fontSize.addEventListener("input", () => {
    els.fontSizeLabel.textContent = els.fontSize.value;
  });

  els.saveBtn.addEventListener("click", async () => {
    const error = validateInputs(els);
    if (error) {
      showStatus(els.status, error, "error");
      return;
    }

    const values = readFormValues(els);
    await chrome.storage.sync.set(values);
    showStatus(els.status, "Settings saved.", "success");
  });
}

// ─── Auto-init when loaded as a popup ───────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initPopup();
});
