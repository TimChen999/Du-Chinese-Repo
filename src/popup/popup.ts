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
import type {
  DisplayScript,
  ExtensionSettings,
  LLMProvider,
} from "../shared/types";
import { getAllVocab, removeWord } from "../background/vocab-store";
import type { VocabEntry } from "../shared/types";
import {
  ensureDictionaryLoaded,
  toDisplayScript,
} from "../shared/cedict-lookup";

/**
 * Mirror of hub.ts's currentDisplayScript. Updated whenever the popup
 * loads its settings (each open is a fresh popup context, so a single
 * read at load time is enough — no live listener needed). Reading is
 * via the local display() helper at every Chinese-glyph render site.
 */
let popupDisplayScript: DisplayScript = "simplified";
function display(chars: string): string {
  return toDisplayScript(chars, popupDisplayScript);
}
import { resolveSharedTheme } from "../shared/theme";
import { syncRangeFill } from "../shared/range-slider";

// ─── DOM References ─────────────────────────────────────────────────

function getElements() {
  return {
    provider: document.getElementById("provider") as HTMLSelectElement,
    apiKey: document.getElementById("api-key") as HTMLInputElement,
    apiKeyGroup: document.getElementById("api-key-group") as HTMLDivElement,
    apiKeyWarning: document.getElementById("api-key-warning") as HTMLParagraphElement,
    toggleKey: document.getElementById("toggle-key") as HTMLButtonElement,
    baseUrl: document.getElementById("base-url") as HTMLInputElement,
    model: document.getElementById("model") as HTMLSelectElement,
    customModel: document.getElementById("custom-model") as HTMLInputElement,
    pinyinRadios: document.querySelectorAll<HTMLInputElement>(
      'input[name="pinyin-style"]',
    ),
    displayScriptRadios: document.querySelectorAll<HTMLInputElement>(
      'input[name="display-script"]',
    ),
    fontSize: document.getElementById("font-size") as HTMLInputElement,
    fontSizeLabel: document.getElementById("font-size-label") as HTMLSpanElement,
    theme: document.getElementById("theme") as HTMLSelectElement,
    llmEnabled: document.getElementById("llm-enabled") as HTMLInputElement,
    ttsEnabled: document.getElementById("tts-enabled") as HTMLInputElement,
    overlayEnabled: document.getElementById("overlay-enabled") as HTMLInputElement,
    aiConfigFields: document.getElementById("ai-config-fields") as HTMLDivElement,
    aiInfoBtn: document.getElementById("ai-info-btn") as HTMLButtonElement,
    aiInfoPopover: document.getElementById("ai-info-popover") as HTMLDivElement,
    saveBtn: document.getElementById("save-btn") as HTMLButtonElement,
    status: document.getElementById("status") as HTMLDivElement,
    tabButtons: document.querySelectorAll<HTMLButtonElement>(".tab-btn"),
    tabSettings: document.getElementById("tab-settings") as HTMLDivElement,
    tabVocab: document.getElementById("tab-vocab") as HTMLDivElement,
    vocabList: document.getElementById("vocab-list") as HTMLDivElement,
    refreshModels: document.getElementById("refresh-models") as HTMLButtonElement,
    ocrBtn: document.getElementById("ocr-btn") as HTMLButtonElement,
    libraryBtn: document.getElementById("library-btn") as HTMLButtonElement,
  };
}

// ─── Settings I/O ───────────────────────────────────────────────────

/** Reads stored settings and merges with defaults for missing keys. */
async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Theme ──────────────────────────────────────────────────────────

/**
 * Writes the resolved theme onto body[data-theme] so popup.css's
 * theme selectors apply. Used on init, after Save, and whenever the
 * user changes the Theme dropdown so the preview is immediate.
 *
 * Uses resolveSharedTheme() from src/shared/theme.ts so the popup,
 * library, hub, overlay, and reader all collapse "auto" the same
 * way and tolerate legacy sepia values left over in the shared key
 * by earlier builds.
 */
function applyTheme(theme: string): void {
  document.body.setAttribute("data-theme", resolveSharedTheme(theme));
}

// ─── Ollama Model Fetching ───────────────────────────────────────────

/**
 * Queries the Ollama OpenAI-compatible /models endpoint for installed
 * models. Returns a sorted list of model IDs, or null if unreachable.
 */
export async function fetchOllamaModels(baseUrl: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;

    const data = await response.json() as { data?: Array<{ id: string }> };
    if (!Array.isArray(data.data)) return null;

    return data.data.map((m) => m.id).sort();
  } catch {
    return null;
  }
}

// ─── Model Dropdown ─────────────────────────────────────────────────

/**
 * Rebuilds the model <select> from a list of model names.
 * Uses fetchedModels when provided (dynamic Ollama), otherwise
 * falls back to the provider preset's static list.
 * Appends a "Custom..." sentinel. If currentModel matches a listed
 * option, selects it; otherwise selects "Custom..." and reveals the
 * custom-model text input.
 */
function populateModels(
  modelSelect: HTMLSelectElement,
  customModelInput: HTMLInputElement,
  provider: LLMProvider,
  currentModel: string,
  fetchedModels?: string[],
): void {
  const models = fetchedModels ?? PROVIDER_PRESETS[provider].models;
  modelSelect.innerHTML = "";

  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    modelSelect.appendChild(opt);
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom\u2026";
  modelSelect.appendChild(customOpt);

  if (models.includes(currentModel)) {
    modelSelect.value = currentModel;
    customModelInput.classList.add("hidden");
  } else {
    modelSelect.value = "__custom__";
    customModelInput.value = currentModel;
    customModelInput.classList.remove("hidden");
  }
}

/**
 * For Ollama: fetch live models, populate dropdown, and show a warning
 * if the fetch fails. For other providers: use static preset list.
 */
async function refreshModels(
  els: ReturnType<typeof getElements>,
  provider: LLMProvider,
  currentModel: string,
): Promise<void> {
  const refreshBtn = els.refreshModels;

  if (provider !== "ollama") {
    refreshBtn.classList.add("hidden");
    populateModels(els.model, els.customModel, provider, currentModel);
    return;
  }

  refreshBtn.classList.remove("hidden");

  els.model.innerHTML = "";
  const loadingOpt = document.createElement("option");
  loadingOpt.disabled = true;
  loadingOpt.selected = true;
  loadingOpt.textContent = "Loading models\u2026";
  els.model.appendChild(loadingOpt);

  const baseUrl = els.baseUrl.value.trim() || PROVIDER_PRESETS.ollama.baseUrl;
  const models = await fetchOllamaModels(baseUrl);

  if (models && models.length > 0) {
    populateModels(els.model, els.customModel, provider, currentModel, models);
  } else {
    populateModels(els.model, els.customModel, provider, currentModel);
    if (models !== null && models.length === 0) {
      showStatus(els.status, "Ollama is running but has no models installed.", "error");
    } else {
      showStatus(els.status, "Could not reach Ollama \u2014 showing default models.", "error");
    }
  }
}

// ─── Provider Switch ────────────────────────────────────────────────

/**
 * When the user picks a new provider, auto-fill the base URL and
 * model list from PROVIDER_PRESETS (or live-fetch for Ollama), and
 * show/hide the API key field based on requiresApiKey. Also
 * re-evaluates the inline API-key warning since requiresApiKey
 * varies between providers.
 */
async function onProviderChange(els: ReturnType<typeof getElements>): Promise<void> {
  const provider = els.provider.value as LLMProvider;
  const preset = PROVIDER_PRESETS[provider];

  els.baseUrl.value = preset.baseUrl;
  els.baseUrl.placeholder = preset.baseUrl || "https://...";

  if (preset.requiresApiKey) {
    els.apiKeyGroup.classList.remove("hidden");
  } else {
    els.apiKeyGroup.classList.add("hidden");
  }

  updateApiKeyWarning(els);

  await refreshModels(els, provider, preset.defaultModel);
}

// ─── AI Translations toggle group ─────────────────────────────

/**
 * Shows the inline "API key required" warning only when AI
 * Translations is on, the selected provider needs a key, and the
 * key field is empty. Called on init, on apiKey input, on
 * provider change, and when the toggle flips.
 */
function updateApiKeyWarning(els: ReturnType<typeof getElements>): void {
  const provider = els.provider.value as LLMProvider;
  const needs = PROVIDER_PRESETS[provider].requiresApiKey;
  const empty = els.apiKey.value.trim().length === 0;
  const show = els.llmEnabled.checked && needs && empty;
  els.apiKeyWarning.classList.toggle("hidden", !show);
}

/**
 * Collapses or expands the AI config fields container based on
 * the toggle's checked state. Field values are intentionally not
 * cleared so flipping the toggle off and back on preserves them.
 */
function applyLlmToggleState(els: ReturnType<typeof getElements>): void {
  els.aiConfigFields.classList.toggle("hidden", !els.llmEnabled.checked);
  updateApiKeyWarning(els);
}

/**
 * Toggles the (i) info popover next to the AI Translations
 * header. Mirrors visibility into aria-expanded for screen
 * readers.
 */
function setInfoPopoverOpen(
  els: ReturnType<typeof getElements>,
  open: boolean,
): void {
  els.aiInfoPopover.classList.toggle("hidden", !open);
  els.aiInfoBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Returns a warning string if the AI-translation-related inputs look
 * unusable, or null if everything checks out. The result is advisory
 * only -- Save persists settings unconditionally so unrelated fields
 * (overlay, TTS, theme, etc.) aren't held hostage by an in-progress
 * API key or URL. A partial key/URL is no worse than the existing
 * empty-key path; the LLM call will simply fail with a clear runtime
 * error until the user finishes typing.
 */
function validateInputs(els: ReturnType<typeof getElements>): string | null {
  const provider = els.provider.value as LLMProvider;
  const preset = PROVIDER_PRESETS[provider];

  if (
    els.llmEnabled.checked &&
    preset.requiresApiKey &&
    els.apiKey.value.trim().length < 10
  ) {
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

  let displayScript = DEFAULT_SETTINGS.displayScript;
  els.displayScriptRadios.forEach((r) => {
    if (r.checked) displayScript = r.value as ExtensionSettings["displayScript"];
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
    displayScript,
    fontSize: parseInt(els.fontSize.value, 10),
    theme: els.theme.value as ExtensionSettings["theme"],
    llmEnabled: els.llmEnabled.checked,
    ttsEnabled: els.ttsEnabled.checked,
    overlayEnabled: els.overlayEnabled.checked,
  };
}

/** Shows a timed status message (green success, red error, amber warning). */
function showStatus(
  el: HTMLDivElement,
  message: string,
  type: "success" | "error" | "warning",
): void {
  el.textContent = message;
  el.className = type;
  // Warnings stay longer so users have time to read the explanation
  // of why the AI portion of the save was incomplete.
  const ms = type === "warning" ? 4500 : 2000;
  setTimeout(() => {
    el.textContent = "";
    el.className = "";
  }, ms);
}

// ─── Vocab Card ─────────────────────────────────────────────────────

function dismissVocabCard(): void {
  document.querySelector(".vocab-card-overlay")?.remove();
}

function showVocabCard(
  entry: VocabEntry,
  els: ReturnType<typeof getElements>,
): void {
  dismissVocabCard();

  const overlay = document.createElement("div");
  overlay.className = "vocab-card-overlay";

  const card = document.createElement("div");
  card.className = "vocab-card";

  const closeBtn = document.createElement("button");
  closeBtn.className = "vocab-card-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", dismissVocabCard);

  const chars = document.createElement("div");
  chars.className = "vocab-card-chars";
  chars.textContent = display(entry.chars);

  const pinyin = document.createElement("div");
  pinyin.className = "vocab-card-pinyin";
  pinyin.textContent = entry.pinyin;

  const def = document.createElement("div");
  def.className = "vocab-card-def";
  def.textContent = entry.definition;

  const meta = document.createElement("div");
  meta.className = "vocab-card-meta";
  const seen = new Date(entry.lastSeen).toLocaleDateString();
  meta.textContent = `Seen ${entry.count} time${entry.count !== 1 ? "s" : ""} \u00b7 Last: ${seen}`;

  const actions = document.createElement("div");
  actions.className = "vocab-card-actions";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "vocab-card-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    await removeWord(entry.chars);
    dismissVocabCard();
    renderVocabList(els);
  });

  actions.appendChild(deleteBtn);
  card.append(closeBtn, chars, pinyin, def, meta, actions);
  overlay.appendChild(card);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissVocabCard();
  });

  document.body.appendChild(overlay);
}

// ─── Vocab List ─────────────────────────────────────────────────────

const POPUP_VOCAB_LIMIT = 50;

async function renderVocabList(els: ReturnType<typeof getElements>): Promise<void> {
  const entries = await getAllVocab();
  entries.sort((a, b) => b.lastSeen - a.lastSeen);

  const displayed = entries.slice(0, POPUP_VOCAB_LIMIT);
  els.vocabList.innerHTML = "";

  if (displayed.length === 0) {
    els.vocabList.innerHTML =
      '<div class="vocab-empty">No words recorded yet. Select Chinese text on any page to start building your list.</div>';
    return;
  }

  for (const entry of displayed) {
    const row = document.createElement("div");
    row.className = "vocab-row";
    row.style.cursor = "pointer";
    row.innerHTML =
      `<span class="vocab-chars">${display(entry.chars)}</span>` +
      `<span class="vocab-pinyin">${entry.pinyin}</span>` +
      `<span class="vocab-def">${entry.definition}</span>`;
    row.addEventListener("click", () => showVocabCard(entry, els));
    els.vocabList.appendChild(row);
  }

  if (entries.length > POPUP_VOCAB_LIMIT) {
    const note = document.createElement("div");
    note.className = "vocab-empty";
    note.textContent = `Showing ${POPUP_VOCAB_LIMIT} of ${entries.length} words \u2014 open Library for the full list.`;
    els.vocabList.appendChild(note);
  }
}

// ─── Initialization ─────────────────────────────────────────────────

/**
 * Main entry point. Exported so tests can call it directly after
 * setting up a DOM with the expected element IDs.
 */
export async function initPopup(): Promise<void> {
  const els = getElements();
  const settings = await loadSettings();

  // Cache the display-script preference so the vocab list / vocab card
  // render in the user's chosen script. Kick off CC-CEDICT load so
  // toDisplayScript() has data to convert against; until it lands we
  // fall through to simplified (cheap, correct, just won't flip yet).
  popupDisplayScript = settings.displayScript;
  void ensureDictionaryLoaded().catch(() => {
    /* dict load failure already surfaced elsewhere */
  });

  // Populate form from stored settings
  els.provider.value = settings.provider;
  els.apiKey.value = settings.apiKey;
  els.baseUrl.value = settings.baseUrl;
  els.fontSize.value = String(settings.fontSize);
  els.fontSizeLabel.textContent = String(settings.fontSize);
  syncRangeFill(els.fontSize);
  els.theme.value = settings.theme;
  applyTheme(settings.theme);
  els.llmEnabled.checked = settings.llmEnabled;
  els.ttsEnabled.checked = settings.ttsEnabled;
  els.overlayEnabled.checked = settings.overlayEnabled;

  els.pinyinRadios.forEach((r) => {
    r.checked = r.value === settings.pinyinStyle;
  });

  els.displayScriptRadios.forEach((r) => {
    r.checked = r.value === settings.displayScript;
  });

  const preset = PROVIDER_PRESETS[settings.provider];
  if (preset.requiresApiKey) {
    els.apiKeyGroup.classList.remove("hidden");
  } else {
    els.apiKeyGroup.classList.add("hidden");
  }

  applyLlmToggleState(els);

  await refreshModels(els, settings.provider, settings.model);

  // ─── OCR trigger ─────────────────────────────────────────────

  els.ocrBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OCR_START" });
    window.close();
  });

  els.libraryBtn.addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/library/library.html"),
    });
    window.close();
  });

  // ─── Event listeners ──────────────────────────────────────────

  els.provider.addEventListener("change", () => onProviderChange(els));

  els.refreshModels.addEventListener("click", () => {
    const currentModel = els.model.value === "__custom__"
      ? els.customModel.value.trim()
      : els.model.value;
    refreshModels(els, els.provider.value as LLMProvider, currentModel);
  });

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
    syncRangeFill(els.fontSize);
  });

  els.theme.addEventListener("change", () => applyTheme(els.theme.value));

  // When the user has "Auto" selected, follow live OS theme flips
  // while the popup is open. The listener is harmless under explicit
  // "light"/"dark" because resolveTheme ignores the OS in those cases.
  if (typeof window.matchMedia === "function") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applyTheme(els.theme.value));
  }

  // ─── AI Translations toggle + warning + info popover ─────────

  els.llmEnabled.addEventListener("change", () => applyLlmToggleState(els));

  els.apiKey.addEventListener("input", () => updateApiKeyWarning(els));

  els.aiInfoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = els.aiInfoPopover.classList.contains("hidden");
    setInfoPopoverOpen(els, open);
  });

  document.addEventListener("click", (e) => {
    if (els.aiInfoPopover.classList.contains("hidden")) return;
    const target = e.target as Node | null;
    if (
      target &&
      !els.aiInfoPopover.contains(target) &&
      target !== els.aiInfoBtn
    ) {
      setInfoPopoverOpen(els, false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.aiInfoPopover.classList.contains("hidden")) {
      setInfoPopoverOpen(els, false);
      els.aiInfoBtn.focus();
    }
  });

  els.saveBtn.addEventListener("click", async () => {
    // Validation is advisory: a malformed API key or base URL only
    // breaks AI Translations, so we still persist every field so
    // unrelated settings (overlay, TTS, theme, font size, pinyin
    // style) aren't blocked by an in-progress LLM config.
    const warning = validateInputs(els);
    const values = readFormValues(els);
    await chrome.storage.sync.set(values);
    applyTheme(values.theme);
    if (warning) {
      showStatus(
        els.status,
        `Settings saved. AI Translations won’t work until fixed: ${warning}`,
        "warning",
      );
    } else {
      showStatus(els.status, "Settings saved.", "success");
    }
  });

  // ─── Tab switching ───────────────────────────────────────────

  els.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const tab = btn.dataset.tab;
      els.tabSettings.classList.toggle("hidden", tab !== "settings");
      els.tabVocab.classList.toggle("hidden", tab !== "vocab");

      if (tab === "vocab") {
        renderVocabList(els);
      }
    });
  });

}

// ─── Auto-init when loaded as a popup ───────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initPopup();
});
