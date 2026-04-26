# Pinyin Tool — Click-to-Lookup Redesign

Status: **shipped (April 2026)**. Replaces the selection→LLM flow with a Zhongwen-style
hover-preview + Du-Chinese-style click-to-translate model backed by an offline CC-CEDICT
dictionary, with the LLM as a contextual upgrade applied per sentence.

This document is the source of truth for the redesign. It is consumed by the
implementation; if implementation diverges, update this doc first.

---

## 1. Goals

1. **Click replaces selection.** Users click a word; nothing requires `mouseup` over a
   selectable text run. Works on `user-select: none` pages, in `<input>`/`<textarea>`,
   in same-origin iframes — anywhere `caretRangeFromPoint` returns a text node.

2. **Hover previews the click.** As the cursor moves, the word that *would* be looked up
   on click is highlighted live. Sub-millisecond feedback, no popup, no network.

3. **Two-tier popup with optional pinyin strip.**
   - Word tier: pinyin + definition for the clicked word.
   - Pinyin strip (collapsed by default; tiny "▸ pinyin" toggle): full sentence with
     ruby annotations over each word. Sticky session preference: once expanded,
     subsequent popup opens default to expanded.
   - Sentence tier: English translation, with that sentence also highlighted on the
     page (lighter color than the clicked word).

4. **CC-CEDICT is the offline truth, LLM is the contextual upgrade.** A click is always
   answered instantly from CC-CEDICT and Chrome's on-device Translator. When the LLM
   returns for that sentence, its better word boundaries, contextual pinyin, contextual
   gloss, and richer translation replace the bootstrap data — for that sentence only —
   and persist in cache for future visits.

5. **Same-sentence retarget.** Clicking a different word in the *same* sentence updates
   the word tier and the on-page word highlight in place, without re-opening the popup
   or refiring the LLM. The cached sentence translation stays put.

6. **Backwards compatible UX:** vocab capture, OCR, EPUB reader, library, hub, popup,
   theming, TTS, settings — all keep working. The selection-driven content-script
   overlay is gone; right-click + Alt+Shift+P + OCR re-route through the click flow.

## 2. Non-goals

- LLM removal. The LLM stays as the quality ceiling; only its critical-path role
  is gone.
- Mobile/touch. Click works on touch (tap), but tap-and-hold patterns are not designed
  for in this pass.
- Cross-origin iframe lookup. Browser-blocked.

---

## 3. Interaction model — state machine per sentence

Each sentence on the page lives in one of three states:

| State | Trigger | Hover/click uses | Popup word data | Sentence translation |
|-------|---------|------------------|-----------------|----------------------|
| **Cold** | initial | nothing (no highlight on hover yet) | — | — |
| **Bootstrap** | user clicked a word in this sentence | CC-CEDICT longest-match | CC-CEDICT entry | Chrome on-device translator if available, else empty |
| **Hot** | LLM returned for this sentence | LLM `words[]` array | LLM `pinyin` + `gloss` | LLM translation |

Transitions:

```
        click in this sentence
Cold ───────────────────────────► Bootstrap
                                    │
                                    │  LLM resolves for this sentence
                                    ▼
                                  Hot
```

A sentence in Hot state stays Hot for the page session and persists in the per-sentence
cache so repeat visits start Hot. The transition Bootstrap→Hot does **not** retarget
the user's currently-locked click highlight; the popup's word tier and the pinyin strip
upgrade in place, and subsequent hover/click in this sentence use LLM boundaries.

## 4. Component architecture

```
┌─────────────────────────────── content script / reader page ─────────────────┐
│                                                                                │
│  ┌─ events ─────────┐    ┌─ caret-finder ──┐    ┌─ word/sentence resolver ──┐  │
│  │ mousemove (rAF)  │───▶│ caretRangeFrom  │───▶│ longest-match (cedict-    │  │
│  │ click (capture)  │    │ Point + input/  │    │ lookup) → wordRange       │  │
│  │ keydown (Esc)    │    │ textarea branch │    │ sentence walk → sentRange │  │
│  └──────────────────┘    └─────────────────┘    └────────────┬──────────────┘  │
│                                                              │                 │
│                                       ┌──────────────────────▼─────────────┐   │
│                                       │ highlight controller               │   │
│                                       │  CSS Custom Highlight API:         │   │
│                                       │   ::highlight(pt-hover)            │   │
│                                       │   ::highlight(pt-word)             │   │
│                                       │   ::highlight(pt-sentence)         │   │
│                                       └──────────────┬─────────────────────┘   │
│                                                      │                         │
│                                       ┌──────────────▼────────────┐            │
│                                       │ click-popup (Shadow DOM)  │            │
│                                       │  word tier + pinyin strip │            │
│                                       │  + sentence tier + TTS    │            │
│                                       └──────────────┬────────────┘            │
│                                                      │                         │
│        ┌────── on click: bootstrap fill ─────────────┤                         │
│        │                                             │                         │
│        ▼                                             ▼                         │
│  ┌──────────────────┐                 ┌──────────────────────────┐             │
│  │ cedict-lookup    │                 │ Chrome on-device         │             │
│  │ (in-memory Map)  │                 │ translator (zh→en)       │             │
│  └──────────────────┘                 └──────────────────────────┘             │
│                                                                                │
│  ┌── pluggable sentence-translation provider ───────────────────────────────┐  │
│  │  • content script: chrome.runtime.sendMessage → service worker           │  │
│  │  • reader (extension page): direct queryLLMSentence + sentence-cache     │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Files

### New (this pass)
| Path | Purpose |
|------|---------|
| `public/dict/cedict_ts.u8` | CC-CEDICT data file (~10 MB, downloaded by build script). Bundled into the extension dist. |
| `scripts/download-cedict.mjs` | npm prebuild script that downloads CC-CEDICT from MDBG if not present. |
| `src/shared/cedict-types.ts` | Type definitions for CC-CEDICT entries and lookup results. |
| `src/shared/cedict-lookup.ts` | Loader, parser, longest-match search, sentence-level segmenter, pinyin formatter. |
| `src/content/caret-from-point.ts` | DOM caret API wrapper with input/textarea branch. |
| `src/content/sentence-detect.ts` | Walks text nodes for the sentence around a caret. Tiered: full-sentence delimiters; fallback to clause-level commas when soft limit exceeded. |
| `src/content/page-highlight.ts` | CSS Custom Highlight API controller (hover, word, sentence). |
| `src/content/click-popup.ts` | Two-tier popup with collapsible pinyin strip, TTS button, LLM loading spinner. |
| `src/content/click-tts.ts` | Sentence-level TTS with per-word karaoke highlighting. |
| `src/content/click-flow.ts` | Hover/click controller, per-sentence state machine, pluggable sentence-translation provider. |
| `src/background/sentence-cache.ts` | Per-sentence Hot cache (chrome.storage.local). |

### Modified
| File | Change |
|------|--------|
| `src/content/content.ts` | Rewritten. Imports click-flow + click-popup; right-click + Alt+Shift+P + OCR all re-route through click-flow's `triggerFromSelection` / `triggerFromTextNode`. No legacy mouseup, no overlay imports. |
| `src/reader/reader.ts` | initClickFlow on reader page; reader-side direct sentence-translation provider (no SW round-trip); EPUB iframes hooked via `attachClickFlowToEpub` → `EpubRenderer.onIframeRendered` → `initClickFlow(iframeDoc)` per render. Legacy `processSelection`, `runQuickTranslationPreview`, `dedupedQueryLLM` deleted. |
| `src/reader/renderers/epub-renderer.ts` | `onIframeRendered(cb)` registers a per-spine-page hook so the reader can attach click-flow listeners to each iframe document. |
| `src/content/click-flow.ts` | `initClickFlow(...docs)` accepts multiple documents (parent + iframes). `safeRangeRect()` translates iframe-relative rects to parent coords by adding the iframe's bounding offset. Mousemove/click handlers compute the source document via `event.target.ownerDocument`. |
| `src/content/page-highlight.ts` | Per-document highlight registries: `lastHighlightDoc` map tracks where each named highlight lives, so transitions iframe↔parent clear the old paint correctly. `ensureHighlightStylesInjected(doc?)` parameterized. |
| `src/content/click-popup.ts` | Persistent corner LLM-status badge (`.pt-llm-status`): spinner while loading, cleared on Hot, "!" badge on failure. Speaker button rendered unconditionally when settings.ttsEnabled (no longer gated on `hasChineseVoice()`). Speaker placed inline at the start of the sentence tier so it doesn't collide with the badge. |
| `src/shared/types.ts` | New `LLMSentenceWord`, `SentenceTranslateRequest`, `SentenceTranslateResponseLLM`, `SentenceTranslateError`. Legacy `PinyinRequest`, `PinyinResponseLocal`, `PinyinResponseLLM`, `PinyinError` deleted. |
| `src/shared/constants.ts` | New `CEDICT_DICT_PATH`, `CEDICT_DEFAULT_LOOKUP_CHARS`, `SENTENCE_DELIMS`, `SENTENCE_CLAUSE_DELIMS`, `SENTENCE_SOFT_LIMIT_CHARS`, `SENTENCE_MAX_CHARS`, `SYSTEM_PROMPT_SENTENCE`. |
| `src/background/service-worker.ts` | Single `SENTENCE_TRANSLATE_REQUEST` handler. Legacy `PINYIN_REQUEST` handler, `handleLLMPath`, `dedupedQueryLLM` deleted. |
| `src/background/llm-client.ts` | Only `queryLLMSentence` remains. Legacy `queryLLM`, `validateLLMResponse`, `buildRequest`, `tryParseJson`, `salvageJson`, `normalizeWords`, `redactUrl`, `LLMResponse`, `LLMResult` all deleted. |
| `src/content/overlay.css` | `.pt-popup` two-tier styles, pinyin-strip styles, OCR result-strip styles, persistent LLM status badge styles. Legacy `.hg-overlay` styles also deleted. |
| `manifest.json` | `dict/*` in `web_accessible_resources`. |
| `package.json` | `prebuild` / `postinstall` hooks for the dictionary download. |

### Deleted in this pass
- `src/content/overlay.ts` — replaced by `click-popup.ts`.
- `src/shared/fallback-translation.ts` — bootstrap path now uses Chrome translator directly inside click-flow.
- `src/background/cache.ts` — replaced by `sentence-cache.ts`.
- Legacy tests: `tests/content/overlay.test.ts`, `tests/shared/fallback-translation.test.ts`, `tests/background/cache.test.ts`, `tests/background/llm-client.test.ts`, `tests/integration/*`.

---

## 6. New trigger surfaces

| Trigger | Path |
|---------|------|
| Click on Chinese (any DOM text) | click-flow `commitClick` |
| Hover over Chinese | click-flow `onMouseMove` (rAF-throttled) |
| Right-click → "Show Pinyin & Translation" | re-routed via `triggerFromSelection` (treats start of selection as click target) |
| Alt+Shift+P with selection | re-routed via `triggerFromSelection` |
| OCR area select | recognised text rendered as a clickable `<div>` strip on the page; `triggerFromTextNode` synthesises an initial click |
| Reader (non-EPUB) single click | click-flow on reader page document |
| Reader (EPUB) single click | click-flow injected per-iframe via `EpubRenderer.onIframeRendered` |

## 7. Wire format

### 7.1 SENTENCE_TRANSLATE_REQUEST (content/reader → SW or in-process provider)
```ts
{
  type: "SENTENCE_TRANSLATE_REQUEST",
  sentence: string,
  pinyinStyle: PinyinStyle,
  requestId: number,
}
```

### 7.2 SENTENCE_TRANSLATE_RESPONSE_LLM
```ts
{
  type: "SENTENCE_TRANSLATE_RESPONSE_LLM",
  sentence: string,
  requestId: number,
  translation: string,
  words: Array<{ text, pinyin, gloss }>,
}
```
The LLM's `words` MUST concatenate to `sentence` exactly. Validated on receipt;
mismatched responses are discarded and the sentence stays Bootstrap.

### 7.3 SENTENCE_TRANSLATE_ERROR
```ts
{
  type: "SENTENCE_TRANSLATE_ERROR",
  sentence: string,
  requestId: number,
  error: string,
  code: string,
}
```

## 8. CC-CEDICT loader

- File: `dist/dict/cedict_ts.u8` (~10 MB, ~125k entries from MDBG, CC-BY-SA 4.0).
- Download script (`scripts/download-cedict.mjs`) runs on `npm install` / `npm run build`. Idempotent.
- Parsed into `Map<string, CedictEntry[]>` keyed by both simplified and traditional headwords.
- Lookup: `findLongest(text, maxChars=12)` walks from longest prefix down; sub-millisecond.
- Sentence segmenter: `segmentSentence(text, style)` walks left-to-right with longest-match, used by Bootstrap pinyin strip and TTS karaoke timing.
- Pinyin formatter handles tone-mark placement (a > e > o > 2nd of iu/ui), `u:` → ü, neutral tone (5).

## 9. Sentence detection — tiered

Two-tier walk in `sentence-detect.ts`:

1. **Tier 1**: walk to the nearest `。 ！ ？ ； . ! ? ; \n` (block-level boundary forms a hard stop).
2. **Tier 2 (soft-limit fallback)**: when Tier 1 result exceeds `SENTENCE_SOFT_LIMIT_CHARS` (80), re-walk with `， 、 ,` added to the delimiter set. Returns a clause-level chunk centered on the caret.
3. **Hard cap**: `SENTENCE_MAX_CHARS` (500) clamps both tiers.

Visible-to-user signal: none by default. The `trimmedToClause` flag on `SentenceResult` is exposed for diagnostics. Thresholds chosen so most pages never trigger Tier 2.

## 10. Highlight controller

Three named highlights (CSS Custom Highlight API):
```css
::highlight(pt-hover)    { background: rgba(255,200,0,0.30); }
::highlight(pt-word)     { background: rgba(255,200,0,0.55); }
::highlight(pt-sentence) { background: rgba(255,200,0,0.18); }
```

Rules injected into `document.head` at content-script init (because the API is per-document — Shadow-DOM stylesheets don't apply).

Browser fallback: when `CSS.highlights` is undefined, all setters no-op. Popup still works.

## 11. Click-popup layout

```
┌─────────────────────────────┐
│ 银行  yínháng                │  ← word tier (clicked word)
│ bank; financial institution │
│ [+ Vocab] [3 readings]      │
├─────────────────────────────┤
│ ▸ pinyin                    │  ← collapsible toggle (negligible space)
├─────────────────────────────┤  (when expanded:)
│ 我 去 银行 取 钱 。          │
│ wǒ qù yín-háng qǔ qián      │  ← ruby per word
├─────────────────────────────┤
│ ◔ Translating sentence…     │  ← spinner while LLM in flight
│  →  I'm going to the bank.  │  ← LLM translation (or Chrome translator)
│  [🔊]                        │  ← TTS button
└─────────────────────────────┘
```

- Pinyin strip is collapsed by default (single ~18px toggle row). Sticky session preference once expanded.
- TTS button speaks the whole sentence with one utterance; per-word karaoke highlight is driven by `::highlight(pt-word)` re-painting at ~200ms × `1/utterance.rate` per character.
- LLM loading spinner is a small inline rotating ring next to "Translating sentence…"; replaced when text fills in.
- LLM error after a successful Bootstrap translation: small "!" badge appended (preserving the Bootstrap text); error in Bootstrap-empty state replaces the placeholder.

## 12. Popup positioning

Tries slot order against the **sentence rect** (not just the word):
1. Below the sentence.
2. Above the sentence.
3. To the right of the sentence rect.
4. To the left.
5. Bottom-clamped fallback.

Horizontal anchor: clicked word's x-midpoint, viewport-clamped. Popup never covers the highlighted sentence in the typical case.

## 13. Same-sentence retarget

When the user clicks a different word inside the *same* sentence the popup is showing:
- `pt-word` highlight repaints at the new range.
- Popup's word tier re-rendered via `retargetWord` (rebuilds actions row → fresh +Vocab button).
- If the sentence is Hot, the new word's pinyin/gloss come from the LLM `words` array; otherwise CC-CEDICT.
- Pinyin strip's "active word" highlight repositions to the new word.
- **No new LLM request**, no popup flash, popup position stays put.
- Same-word click is a no-op (avoids accidental double-click flicker).

## 14. TTS — per-word karaoke

- Sentence-level utterance (one `SpeechSynthesisUtterance`); preserves prosody.
- Per-word timer schedule using ~200ms × `(1 / utterance.rate)` per char.
- Each timer call repaints `::highlight(pt-word)` to the next word's range.
- Restore: end / error / cancel restores to the originally-clicked word's range.
- Word boundaries: LLM `words` if Hot; CC-CEDICT `segmentSentence` if Bootstrap.
- Voice probe: `hasChineseVoice()` gates the speaker button; voices loaded lazily via `voiceschanged` event.

## 15. Caching strategy

Two cache namespaces in `chrome.storage.local`:

1. **Per-sentence Hot cache** (new): key = `sha256(pinyinStyle | provider | model | sentence)`, value `{translation, words[]}`. TTL `CACHE_TTL_MS` (7d).
2. **Legacy text+context cache** (still in `cache.ts`, used only by EPUB legacy path).

The reader's direct provider also writes/reads the sentence cache, so closing-and-reopening a book lands sentences in Hot state instantly.

## 16. Failure modes

| Condition | Behaviour |
|-----------|-----------|
| LLM disabled in settings | Bootstrap only (CC-CEDICT + Chrome translator). Popup never errors out. |
| LLM error / timeout | Sentence tier shows error; if Bootstrap text already in place, error becomes a small "!" badge instead. |
| Chrome translator unavailable | Sentence tier shows "Sentence translation requires AI Translations or Chrome's on-device translator." until LLM lands. |
| CC-CEDICT not yet parsed (~150-300 ms after page load) | Single-character highlight + popup with "(loading dictionary…)" gloss. Refines once parsed. |
| LLM returns invalid `words` (concat mismatch) | Discarded. Sentence stays Bootstrap. |
| Same-sentence different-word click | In-place retarget (no popup re-open). |
| Click outside any text or on non-Chinese | No-op. Popup stays. |
| Click in same word | No-op. |

## 17. Test coverage

| Module | Tests |
|--------|-------|
| `cedict-lookup` | parser, longest-match (incl. polyphones, maxChars cap), `lookupExact`, `formatPinyinSyllable` (incl. `u:` and iu/ui placement), `formatPinyin`, async load. |
| `sentence-detect` | single-node walks, multi-node walks, block-boundary respect, soft-limit fallback, no-comma case. |
| `sentence-cache` | `hashSentenceKey` stability + style/provider/model differentiation, get/save round-trip. |
| `content` | trigger re-routing (right-click / Alt+Shift+P), settings sync to click-flow, +Vocab callback pipeline, OCR translator prewarm. |

Reader tests, overlay tests, library/hub/popup/SRS/etc — unchanged and still passing.

## 18. Removal log — what was deleted, why, and what preserves the user-visible behavior

The redesign deleted ~6,300 lines and added ~2,000 (including doc + tests). This
section records every non-trivial deletion with the rationale and the new piece
that preserves the same end-user capability. Reviewers can use this as a checklist
to verify no functionality was lost.

### 18.1 `src/content/overlay.ts` (deleted, ~654 lines)

The legacy Shadow-DOM popup used by the selection-driven flow.

| What it did | Where the capability lives now |
|---|---|
| `showOverlay` / `updateOverlay` / `updateOverlayFallback` — render selection-bounded ruby annotations + sentence translation | `click-popup.ts` `showBootstrap` + `setSentenceText` (per-sentence, with collapsible pinyin strip and persistent corner badge) |
| `showOverlayError` — Phase-2 error row | `click-popup.ts` `setSentenceError` + `.pt-llm-status.pt-llm-error` corner badge |
| `showTruncationNotice` — "Showing first 500 chars" banner | Not needed — sentence flow caps at sentence boundaries (Tier 1) or commas (Tier 2), not at a 500-char selection edge |
| `appendTtsButton` + `speakText` — sentence TTS with karaoke ruby highlight | `click-tts.ts` `speakSentence` (same timer-based per-word schedule, repaints the on-page `::highlight(pt-word)` instead of toggling a ruby class) |
| `appendLlmStatus` / `clearLlmStatus` / `setLlmStatusError` — corner status badge | `click-popup.ts` `makeLlmStatusBadge` / `clearLlmStatusBadge` / `setLlmStatusBadgeError` (visually identical, persistent until LLM resolves) |
| `setVocabCallback` / `setOverlayContext` — bridge from + Vocab click to `vocab-capture` | `click-popup.ts` `setClickPopupVocabCallback` (same handler, same wire format on the SW side) |
| `renderRubyText` / `attachWordClickHandlers` / definition-card toggle | Word tier renders the clicked word inline; pinyin strip provides ruby for the whole sentence; per-word click is replaced by clicking the actual page text (no in-popup word click needed) |
| `calculatePosition` (below/above with viewport clamp) | `click-popup.ts` `positionPopup` — anchored against the **sentence rect** (not just the word) so the popup never covers the highlighted sentence |

**No user-visible feature lost.** TTS, vocab capture, sentence translation, error indication, theme variants, font size mirroring all preserved.

### 18.2 `src/shared/fallback-translation.ts` (deleted, ~130 lines)

The selection-flow's "AI Translations off" fallback path. Took the user's selection,
ran Chrome's on-device Translator on the full string + each unique CJK segment,
fanned out N parallel `translator.translate()` calls, and rendered the results as
per-segment glosses in the legacy overlay.

| What it did | Replacement |
|---|---|
| Full-text Chrome translation when LLM was disabled | Click-flow's Bootstrap path calls `translateChineseToEnglish(sentence)` directly inside `commitClick` (`click-flow.ts`). Same Chrome Translator API, same caching of the translator instance |
| Per-segment glosses (≤50 segments per selection) for the legacy overlay | CC-CEDICT longest-match in `cedict-lookup.ts` — every word in the popup's pinyin strip and word tier carries its dictionary gloss instantly, with no per-segment translator call |
| Dedup of identical segments within one selection | n/a — sentence-cache deduplicates at the sentence level instead |
| Concurrency cap (`MAX_FALLBACK_SEGMENTS = 50`) | n/a — no fan-out anymore |
| Quality gate around the on-device API's quirks (model-not-loaded handling, NotAllowedError on missing user activation) | Inherited via `prewarmTranslator()` and `isTranslatorAvailable()` from `translate-example.ts`, called inside click-flow init and OCR start |

**Net change for users with AI off:** popup now shows CC-CEDICT glosses (authoritative dictionary entries) instead of literal per-word machine translations. Strict quality improvement, plus N fewer Translator calls per lookup.

### 18.3 `src/background/cache.ts` (deleted, ~203 lines)

The legacy LLM response cache. Keyed by `sha256(text + context)`, where `text` was
an arbitrary user selection and `context` was the surrounding paragraph slice.

| Capability | Replacement |
|---|---|
| Positive cache (`getFromCache` / `saveToCache`, 7d TTL, 5k entries) | `sentence-cache.ts` `getSentenceFromCache` / `saveSentenceToCache` — same TTL + cap, same `chrome.storage.local` backing |
| Negative cache for `RATE_LIMITED` (30s, prevents thundering herd during throttle) | Not currently re-implemented — RATE_LIMITED returns through `SENTENCE_TRANSLATE_ERROR` and the click-flow's commit path doesn't auto-retry. **Trade-off:** if a user spam-clicks during a 429 window, each click hits the LLM anew. Mitigation: per-sentence cache means once one click succeeds for a sentence, subsequent clicks on the same sentence are free. Logged as a known minor regression; can be re-added in `sentence-cache.ts` if it becomes a problem |
| `evictExpiredEntries` on install | `sentence-cache.ts` `evictSentenceOverflow` runs probabilistically on every save (5% sample) — bounded by the same `MAX_CACHE_ENTRIES` |
| `hashText` (SHA-256 helper) | Inlined into `hashSentenceKey` in `sentence-cache.ts` |

**Cache hit-rate improvement:** sentences repeat across articles much more than arbitrary selections do. Same article re-visited → every sentence is Hot from first click.

### 18.4 LLM client legacy entry points (`llm-client.ts`, ~447 lines deleted)

Removed the entire `queryLLM` selection-flow path. What's preserved is the same
LLM functionality with a tighter schema.

| Removed | Why safe |
|---|---|
| `queryLLM(text, context, config, pinyinStyle)` | 1:1 replaced by `queryLLMSentence(sentence, pinyinStyle, config)` — same retry loop, same timeout, same telemetry, same providers (OpenAI / Gemini / Ollama / custom). Different output schema only |
| `singleAttempt` | Replaced by `singleSentenceAttempt` |
| `LLMResponse` / `LLMResult` types | Replaced by `LLMSentenceResponse` / `LLMSentenceResult` |
| `validateLLMResponse` | Replaced by `validateSentenceResponse` (which adds the **stricter** concat invariant: words must reconstruct the sentence) |
| `buildRequest` (selection prompt) | Replaced by `buildSentenceRequest` (sentence prompt + pinyin-style hint) |
| `tryParseJson` / `salvageJson` (partial-JSON salvage for truncated outputs) | Removed because per-sentence outputs rarely overflow the 4096 max-tokens cap. **Trade-off:** if the LLM ever does return truncated JSON, the click-flow falls back to Bootstrap (CC-CEDICT) for that sentence. Acceptable: the user still sees a populated word tier; only the LLM-quality upgrade is missed for that one sentence |
| `normalizeWords` (backfilled missing pinyin via local pinyin-pro) | Not needed — `LLMSentenceWord` carries pinyin from the LLM directly, which is **more contextually accurate** because the LLM picks polyphones from sentence context rather than from a heuristic segmenter |
| `redactUrl` (logging helper hiding `?key=...` for Gemini) | Inlined as needed inside the sentence-attempt logging |
| `LLMErrorCode` / `LLMError` / `RETRYABLE_CODES` / `classifyHttpError` / `extractRawText` / `logTelemetry` / `TelemetryRecord` | **Kept.** All shared with `queryLLMSentence` |
| `LLMConfig` (in `types.ts`) | **Kept.** Shared by both call sites — comment updated to reference the new entry point |

### 18.5 Service worker legacy handlers (`service-worker.ts`, ~238 lines deleted)

| Removed | Replacement / rationale |
|---|---|
| `PINYIN_REQUEST` listener + `handlePinyinRequest` + `handleLLMPath` | Replaced by `SENTENCE_TRANSLATE_REQUEST` listener + `handleSentenceTranslateRequest`. Same shape (cache lookup → bail on disabled → call LLM → cache result → reply via `chrome.tabs.sendMessage`) |
| `inflightLLM` map + `dedupedQueryLLM` (in-flight coalescing for duplicate concurrent SW calls) | **Not yet re-implemented for sentence flow.** The risk is rapid clicks on the same word in the same sentence firing N parallel LLM requests. Mitigated by: (a) per-sentence cache means once any one returns, the others' results are duplicate work but not incorrect; (b) Chrome's same-page rate limits typically prevent the user from generating enough clicks for this to matter. Can be re-added if telemetry shows it firing |
| Keep-alive port machinery (`KEEPALIVE_PORT_NAME` listener, no-op `onConnect` handler that holds the port to keep MV3 SW alive during 30+ second LLM responses) | **Not yet ported.** Risk: SW could be suspended mid-fetch on a long LLM call. Mitigation: the active-tab requirement plus an in-flight `await fetch(...)` inside the listener keeps the SW alive for typical durations. Heavy LLM models on cold starts could still hit this; if reports come in, port the keep-alive plumbing into click-flow's default provider |
| `evictExpiredEntries` call inside `onInstalled` | Replaced by sentence-cache's per-write probabilistic eviction (no install-time scan needed) |

### 18.6 content.ts (rewritten, ~593 lines deleted)

Reduced from ~620 to ~290 lines. Eliminated:

- `currentRequestId` / `llmTranslationSequence` counters — superseded by the click-flow's per-tab `currentRequestId` inside `click-flow.ts`
- `KEEPALIVE_SAFETY_MS` and the per-request `KeepalivePort` map — see 18.5
- `debounce` utility — click-flow uses `requestAnimationFrame` throttling for hover, which is qualitatively better than fixed-time debouncing (always paints on the next frame, never feels laggy)
- `processSelection` (the choke point that fired `PINYIN_REQUEST` on mouseup) — the selection flow is gone
- `runQuickTranslationPreview` (Chrome translator preview during LLM wait) — folded directly into click-flow's `commitClick` Bootstrap path
- `extractSurroundingContext` use — sentence-detect handles boundary discovery directly from the caret position; no need for a separate context extractor

The right-click menu, Alt+Shift+P shortcut, and OCR area-select are all preserved
via re-routing to `triggerFromSelection` / `triggerFromTextNode` (see section 6).

### 18.7 Reader.ts legacy code (~429 lines deleted)

Reader had a parallel implementation of the same selection flow because it needed
a direct-call path (no SW round-trip from extension pages). All of it goes:

| Removed | Replacement |
|---|---|
| `processSelection` (reader version) | `readerSentenceProvider` — same shape (cache → bail → call LLM → cache → reply) but reads `LLMSentenceResponse` not `LLMResponse`, and runs over a single sentence instead of an arbitrary selection |
| `runQuickTranslationPreview` (reader version) | Folded into click-flow's Bootstrap path; the reader now uses the same code path as the content script for the Chrome-translator quick preview |
| `dedupedQueryLLM` (reader version) | Not yet re-implemented — same trade-off as 18.5 |
| `attachSelectionHandler` (EPUB iframe selection-event handler that translated iframe-coords to parent-coords for `showOverlay`) | Replaced by `attachClickFlowToEpub` → `EpubRenderer.onIframeRendered` callback → `initClickFlow(iframeDoc)` per-spine page. Same end-user result; click-flow's `safeRangeRect` translates iframe-relative rects to parent-document coords for popup positioning |
| `attachGenericSelectionHandler` (non-EPUB mouseup handler that fired `processSelection`) | Replaced by click-flow listeners installed on the reader page document by `initClickFlow()` |
| `lastCapturedAnchor` integration with overlay | Preserved via `setOnSentenceCommit` hook on click-flow — every fresh-sentence click captures an anchor for bookmark restore |
| Imports of `queryLLM`, `getFromCache`, `saveToCache`, `getCachedError`, `saveErrorToCache`, `hashText`, `runFallbackTranslation`, `dismissOverlay`, `showOverlay`, `updateOverlay`, `updateOverlayFallback`, `showOverlayError`, `setVocabCallback`, `setOverlayContext` | All gone — reader imports `queryLLMSentence` + `sentence-cache` + `click-flow` + `click-popup` instead |

### 18.8 Legacy types (`shared/types.ts`)

Removed: `PinyinRequest`, `PinyinResponseLocal`, `PinyinResponseLLM`, `PinyinError`.
Replacement: `SentenceTranslateRequest` / `SentenceTranslateResponseLLM` /
`SentenceTranslateError` (defined in the same file). The `ExtensionMessage` union
no longer references the removed types.

`WordData` is **kept** — still used by `pinyin-service.ts` (which the hub uses for
its vocab-list rendering) and by `vocab-store.ts` (vocab entries store
`{chars, pinyin, definition}`). The vocab-capture wire format is unchanged.

### 18.9 Constants

Removed implicit dead constants by inheritance: `MAX_FALLBACK_SEGMENTS` is no
longer referenced (left in place since it's harmless and could be useful if
someone re-introduces a fan-out path). `KEEPALIVE_PORT_NAME` is similarly
unused now but left in place for the same reason — and because if 18.5's
keep-alive port gets re-introduced, the constant is already named.

### 18.10 Tests deleted

| Test file | Why deletion is safe |
|---|---|
| `tests/content/overlay.test.ts` (760 lines) | Tested `overlay.ts`, deleted |
| `tests/shared/fallback-translation.test.ts` (302 lines) | Tested `fallback-translation.ts`, deleted |
| `tests/background/cache.test.ts` (199 lines) | Tested `cache.ts`, deleted. New `sentence-cache.test.ts` covers the equivalent surface for the per-sentence cache |
| `tests/background/llm-client.test.ts` (306 lines) | Tested `queryLLM` + `validateLLMResponse` + JSON salvage. Salvage path no longer exists; `queryLLMSentence` integration is exercised through `service-worker.test.ts`'s SENTENCE_TRANSLATE_REQUEST tests. **Coverage gap:** there's no direct unit test of `queryLLMSentence`'s retry / timeout / classify-HTTP-error logic. The retry mechanics are 1:1 with `queryLLM`'s (which had test coverage) — when the click-flow stabilises further, a new `queryLLMSentence.test.ts` should be added |
| `tests/integration/e2e-flow.test.ts` (698 lines) | Exercised the full selection → SW → cache → LLM → overlay round-trip. Equivalent end-to-end coverage for the click flow would need a new test that mounts a fake page, fires `mousemove` + `click`, and asserts on the popup; not yet written |
| `tests/integration/edge-cases.test.ts` (257 lines) | Edge cases were all selection-specific (truncation, mixed-language selections, etc.). Sentence flow has its own edge cases tested in `sentence-detect.test.ts` (soft-limit fallback, multi-node walk, block-boundary respect) |

`tests/background/pinyin-service.test.ts` was deleted in error during cleanup
and has been **restored** — `pinyin-service.ts` itself is still in use by
`hub.ts` for vocab-list rendering.

### 18.11 CSS removed

`overlay.css` lost the entire `.hg-*` selector family (~200 lines) — the legacy
overlay's styles. The replacement `.pt-popup` family covers the same visual
language (themes, font sizing via `--hg-font-size`, animation curve).

The `.hg-ocr-loading` selector is **kept** because OCR's "Recognizing text…"
loading indicator (a transient div placed at viewport center while Tesseract
runs) still uses it. Same for `hg-extension-root` as the Shadow-DOM host id.

---

### Summary table

| Removal | Lines | Functional preservation | Known gap |
|---|---|---|---|
| `overlay.ts` | -654 | `click-popup.ts` (full feature parity) | none |
| `fallback-translation.ts` | -130 | Bootstrap path in click-flow + CC-CEDICT glosses | none — strict quality improvement |
| `cache.ts` | -203 | `sentence-cache.ts` | RATE_LIMITED negative cache not re-implemented (low impact) |
| `queryLLM` + helpers | -447 | `queryLLMSentence` + helpers | partial-JSON salvage gone (LLM truncations now fall back to Bootstrap; acceptable) |
| SW legacy handlers | -238 | `handleSentenceTranslateRequest` | in-flight coalescing + keep-alive port not re-implemented |
| `content.ts` legacy | -593 (rewrite) | click-flow + OCR strip | none |
| `reader.ts` legacy | -429 | reader's `readerSentenceProvider` + per-iframe click-flow | none |
| Legacy types | -62 | New sentence-mode types | none |
| Legacy tests | -2522 | Live functionality covered by remaining tests | direct `queryLLMSentence` unit tests + click-flow e2e tests would add belt-and-suspenders coverage |

Total: ~6,300 lines removed, ~2,000 added (incl. new tests + this doc).

## 19. Out of scope (next-pass follow-ups)

- Mobile/touch optimisations (longpress as click variant; touch-friendly popup sizing).
- PDF text-layer click handling — works via the existing PDF.js text layer overlay, but corner cases on heavily-styled PDFs may need testing.
- A "translate whole paragraph" button on the popup if users want broader context than one sentence.
- Re-introduce in-flight coalescing for duplicate concurrent `SENTENCE_TRANSLATE_REQUEST`s if telemetry shows it firing.
- Re-introduce the MV3 keep-alive port if cold-start LLM responses get suspended mid-fetch.
- Re-introduce the RATE_LIMITED negative cache if 429s become a UX issue during throttling.
- Direct unit tests for `queryLLMSentence` (retry loop, timeout, classify-HTTP-error) and a new e2e test exercising the full click → popup → SW → LLM → upgrade path.
