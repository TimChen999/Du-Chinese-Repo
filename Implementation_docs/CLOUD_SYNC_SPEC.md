# Vocab Cloud Sync — Feature Specification

Adds automatic cloud persistence for the vocabulary store so that saved words survive extension reinstalls, browser resets, and are available across any device where the user is signed into Chrome. The sync layer uses Firebase (Firestore + Firebase Auth) with silent Google authentication via `chrome.identity`, requiring no account creation or login screens.

This feature builds on the vocabulary storage described in [VOCAB_SPEC.md](VOCAB_SPEC.md) Section 4 "Storage Design" and the flashcard fields added in [VOCAB_HUB_SPEC.md](VOCAB_HUB_SPEC.md) Section 2 "Data Model Changes".

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Background: Persistence Options Considered](#2-background-persistence-options-considered)
3. [Architecture](#3-architecture)
4. [Data Model](#4-data-model)
5. [Sync Logic](#5-sync-logic)
6. [Manifest and Permission Changes](#6-manifest-and-permission-changes)
7. [Offline Behavior](#7-offline-behavior)
8. [File Change Summary](#8-file-change-summary)
9. [Future Considerations](#9-future-considerations)

---

## 1. Feature Overview

### What It Does

Every vocab write — adding a word, recording a flashcard result, deleting a word — is automatically mirrored to a Firebase Firestore database tied to the user's Google account. When the extension starts (on browser launch, after an update, or after a fresh install on a new device), it pulls any remote entries that are newer than the local store and merges them in. The user never interacts with the sync system directly; it runs silently in the service worker.

The local `chrome.storage.local` store remains the primary read/write layer. Firestore acts as a durable remote backup that the local store synchronizes against. All existing UI — the popup vocab tab, the hub vocab list, flashcards — continues to read from local storage with no changes.

### What It Does Not Do

- **No user-facing sync UI** — there is no "Sync now" button, no progress indicator, no sync status badge. Sync is invisible and automatic.
- **No cross-browser support** — sync relies on `chrome.identity`, which is Chrome-specific. Firefox or Safari users would need a different auth mechanism (out of scope).
- **No real-time multi-device push** — if a user adds a word on device A, device B picks it up on next startup or periodic sync, not instantly via a live listener. Real-time listeners may be added as a future enhancement.
- **No server-side business logic** — there is no custom backend. All logic runs in the extension; Firestore is accessed directly via its client SDK with security rules enforcing per-user isolation.

### Who It's For

The same target users defined in [SPEC.md](SPEC.md) Section 1 "Target Users" — learners who have been building a vocabulary list over weeks or months and would lose that progress if they reinstall the extension, reset Chrome, or switch to a new computer.

---

## 2. Background: Persistence Options Considered

Before choosing Firebase, the following alternatives were evaluated:

### chrome.storage.local (Current)

The vocab store already uses `chrome.storage.local` (see [VOCAB_SPEC.md](VOCAB_SPEC.md) Section 4). This storage persists across packed extension updates — Chrome does not wipe `chrome.storage.local` when an extension is updated via the Web Store or `chrome.runtime.reload()`. However, it is deleted on full uninstall (or uninstall-then-reinstall in developer mode). Data is local to a single Chrome profile on a single machine.

**Verdict:** Adequate for day-to-day use, but a single uninstall destroys everything.

### chrome.storage.sync

`chrome.storage.sync` synchronizes data across all Chrome profiles signed into the same Google account. However, it has strict quotas: 100 KB total, 8 KB per key, 512 items maximum. The vocab store can hold up to 10,000 entries (`MAX_VOCAB_ENTRIES` in `src/shared/constants.ts`). A single `VocabEntry` serialized to JSON is roughly 150–250 bytes, putting the theoretical maximum well over 1 MB — far exceeding `chrome.storage.sync`'s capacity.

**Verdict:** Quota is too small for the full vocab store. Only viable for a small pinned subset.

### JSON Export/Import (Manual Backup)

A user-triggered export button would serialize `getAllVocab()` to a JSON file download; an import button would parse a file and merge entries via `recordWords()`. This requires no infrastructure and works offline.

**Verdict:** Useful as a manual backup, but relies on the user remembering to export before a destructive event. See [Section 9](#9-future-considerations) for plans to add this as a complementary feature.

### Custom Backend (Self-Hosted API)

A Node/Express or FastAPI server with a database (PostgreSQL, SQLite, etc.) would give full control over sync logic, rate limiting, and analytics. However, it requires ongoing hosting, deployment, SSL certificates, auth token validation, and database maintenance — a significant operational burden for a personal or small-audience extension.

**Verdict:** Maximum flexibility, disproportionate maintenance cost.

### Firebase (Firestore + Firebase Auth)

Firebase provides a managed Firestore database with a client SDK that runs directly in the extension's service worker. Authentication piggybacks on Chrome's built-in Google identity: `chrome.identity.getAuthToken()` silently retrieves an OAuth token for the Google account the user is already signed into Chrome with, and Firebase Auth exchanges it for a Firebase credential. No server code, no hosting, no account creation flow. The free Spark plan allows 1 GB storage, 50,000 reads/day, and 20,000 writes/day — well within the needs of a vocabulary tracker.

**Verdict:** Minimal implementation effort, zero operational overhead, free for personal use.

### Decision

Firebase was chosen because it eliminates both the infrastructure burden of a custom backend and the data-loss risk of local-only storage, while requiring no changes to the user experience (no login screens, no sync buttons).

---

## 3. Architecture

### Authentication Flow

The extension uses `chrome.identity` to leverage the Google account the user is already signed into Chrome with. No separate login is required.

```
Browser start / extension install
        │
        ▼
  Service Worker: initSync()
        │
        ▼
  chrome.identity.getAuthToken({ interactive: false })
        │
        ├── Token returned ──► GoogleAuthProvider.credential(null, token)
        │                              │
        │                              ▼
        │                     signInWithCredential(auth, credential)
        │                              │
        │                              ▼
        │                     Firebase Auth session established
        │                     (uid available for Firestore paths)
        │
        └── Token rejected ──► chrome.identity.getAuthToken({ interactive: true })
                                       │
                                       ▼
                               Google OAuth consent screen (one time only)
                                       │
                                       ▼
                               Retry signInWithCredential()
```

The `interactive: false` path succeeds silently in the vast majority of cases — whenever the user is signed into Chrome. The `interactive: true` fallback shows a standard Google OAuth consent screen once, after which Chrome caches the grant and subsequent calls succeed silently.

### Sync Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Service Worker                                                 │
│                                                                 │
│  vocab-store.ts                  sync-client.ts                 │
│  ┌──────────────────┐            ┌──────────────────┐           │
│  │ recordWords()    │───push───► │ pushEntries()    │──────┐    │
│  │ removeWord()     │───push───► │ pushDelete()     │──┐   │    │
│  │ updateFlashcard  │───push───► │ pushEntries()    │  │   │    │
│  │ Result()         │            │                  │  │   │    │
│  │                  │◄──merge──  │ pullSince(ts)    │  │   │    │
│  │ getAllVocab()    │            │                  │  │   │    │
│  └──────────────────┘            └──────────────────┘  │   │    │
│         │                                │             │   │    │
│    chrome.storage.local              Firebase Auth     │   │    │
│    (fast local reads)                    │              │   │    │
│                                          ▼             │   │    │
└──────────────────────────────────────────│─────────────│───│────┘
                                           │             │   │
                                           ▼             ▼   ▼
                                    ┌─────────────────────────┐
                                    │  Firestore              │
                                    │  users/{uid}/vocab/     │
                                    │    {chars} → VocabDoc   │
                                    └─────────────────────────┘
```

The key principle: **local-first, remote-backup**. Every read goes to `chrome.storage.local`. Every write goes to local first, then asynchronously to Firestore. The UI never waits on a network call.

### Sync Triggers

| Trigger | Action |
|---|---|
| Service worker starts (browser launch, extension update, wake from idle) | `pullSince(lastSyncTimestamp)` — fetch remote entries newer than last sync, merge into local |
| `recordWords()` completes | `pushEntries(newOrUpdatedEntries)` — fire-and-forget write to Firestore |
| `updateFlashcardResult()` completes | `pushEntries([updatedEntry])` — fire-and-forget write to Firestore |
| `removeWord()` completes | `pushDelete(chars)` — fire-and-forget delete from Firestore |
| `clearVocab()` completes | `pushClear()` — fire-and-forget batch delete of all user docs in Firestore |

---

## 4. Data Model

### Firestore Collection Structure

Each user's vocab lives in a subcollection under their Firebase UID:

```
users/
  {uid}/
    vocab/
      {chars}/        ← document ID is the Chinese characters
        chars: string
        pinyin: string
        definition: string
        count: number
        firstSeen: number
        lastSeen: number
        wrongStreak: number
        totalReviews: number
        totalCorrect: number
        updatedAt: number     ← server timestamp for sync ordering
        deleted: boolean      ← soft-delete flag for sync
```

- **`{chars}`** as the document ID mirrors the local store's key strategy (see [VOCAB_SPEC.md](VOCAB_SPEC.md) Section 4 "Storage Shape"). Because Firestore document IDs can contain Unicode, Chinese characters work directly as IDs.
- **`updatedAt`** is a Unix timestamp (ms) set on every write. This field does not exist in the local `VocabEntry` type — it is Firestore-only and used exclusively by the sync pull query (`where("updatedAt", ">", lastSyncTimestamp)`).
- **`deleted`** is a soft-delete flag. When the user calls `removeWord()`, the Firestore document is not physically deleted; instead, `deleted` is set to `true` and `updatedAt` is refreshed. This ensures that a pull on another device sees the deletion. Documents with `deleted: true` are cleaned up by a periodic sweep (see [Section 5](#5-sync-logic)).

### Relationship to Local VocabEntry

The Firestore document fields are a superset of the local `VocabEntry` interface in `src/shared/types.ts`:

```typescript
// Local (unchanged)
interface VocabEntry {
  chars: string;
  pinyin: string;
  definition: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  wrongStreak: number;
  totalReviews: number;
  totalCorrect: number;
}

// Firestore document (superset)
interface VocabDoc extends VocabEntry {
  updatedAt: number;
  deleted: boolean;
}
```

The `VocabDoc` type is internal to the sync module and not exported to the rest of the extension.

### Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/vocab/{word} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Each user can only read and write documents under their own `users/{uid}/` path. No admin access, no cross-user queries.

---

## 5. Sync Logic

### Write Path (Push)

When any write function in `vocab-store.ts` completes its local `chrome.storage.local.set()`, it calls the corresponding sync function:

```typescript
async function recordWords(words: Required<WordData>[]): Promise<void> {
  // ... existing local write logic (unchanged) ...

  await chrome.storage.local.set({ [STORAGE_KEY]: store });

  // New: push changed entries to Firestore (fire-and-forget)
  const changed = words
    .filter((w) => !VOCAB_STOP_WORDS.has(w.chars))
    .map((w) => store[w.chars])
    .filter(Boolean);
  syncClient.pushEntries(changed).catch(logSyncError);
}
```

`pushEntries()` writes each entry as a Firestore document under `users/{uid}/vocab/{chars}`, adding `updatedAt: Date.now()` and `deleted: false`. The write uses `setDoc` with `{ merge: true }` so partial updates do not overwrite unrelated fields.

The `.catch(logSyncError)` ensures that a Firestore failure never breaks the local write path. If the push fails (network down, auth expired), the entry is still safely in local storage and will be reconciled on the next pull.

### Read Path (Pull)

On service worker startup, after Firebase Auth is initialized:

```typescript
async function pullSync(): Promise<void> {
  const lastSync = await getLastSyncTimestamp();
  const remoteDocs = await syncClient.pullSince(lastSync);

  const result = await chrome.storage.local.get(STORAGE_KEY);
  const store: VocabRecord = result[STORAGE_KEY] ?? {};

  for (const doc of remoteDocs) {
    if (doc.deleted) {
      delete store[doc.chars];
      continue;
    }
    const local = store[doc.chars];
    if (local) {
      store[doc.chars] = mergeEntries(local, doc);
    } else {
      store[doc.chars] = toVocabEntry(doc);
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: store });
  await setLastSyncTimestamp(Date.now());
}
```

`pullSince(timestamp)` runs a Firestore query: `collection("users", uid, "vocab").where("updatedAt", ">", timestamp).orderBy("updatedAt")`. This returns only entries that changed since the last sync, keeping reads minimal.

### Conflict Resolution

When both local and remote have the same `chars` entry, `mergeEntries()` reconciles them:

```typescript
function mergeEntries(local: VocabEntry, remote: VocabDoc): VocabEntry {
  return {
    chars: local.chars,
    pinyin: remote.lastSeen > local.lastSeen ? remote.pinyin : local.pinyin,
    definition: remote.lastSeen > local.lastSeen ? remote.definition : local.definition,
    count: Math.max(local.count, remote.count),
    firstSeen: Math.min(local.firstSeen, remote.firstSeen),
    lastSeen: Math.max(local.lastSeen, remote.lastSeen),
    wrongStreak: remote.lastSeen > local.lastSeen ? remote.wrongStreak : local.wrongStreak,
    totalReviews: Math.max(local.totalReviews, remote.totalReviews),
    totalCorrect: Math.max(local.totalCorrect, remote.totalCorrect),
  };
}
```

The merge strategy per field:

| Field | Strategy | Rationale |
|---|---|---|
| `chars` | Same on both sides (it's the key) | — |
| `pinyin` | Take from whichever side has the later `lastSeen` | Most recent LLM output is most contextually accurate |
| `definition` | Take from whichever side has the later `lastSeen` | Same rationale as pinyin |
| `count` | `Math.max` | Both sides independently increment; max is the best approximation without a CRDT |
| `firstSeen` | `Math.min` | Earliest encounter across all devices |
| `lastSeen` | `Math.max` | Most recent encounter across all devices |
| `wrongStreak` | Take from whichever side has the later `lastSeen` | Reflects the most recent flashcard activity |
| `totalReviews` | `Math.max` | Both sides independently increment |
| `totalCorrect` | `Math.max` | Both sides independently increment |

### Sync Timestamp Persistence

`lastSyncTimestamp` is stored in `chrome.storage.local` under a dedicated key (`syncLastPull`), separate from the vocab store:

```typescript
const SYNC_TS_KEY = "syncLastPull";

async function getLastSyncTimestamp(): Promise<number> {
  const result = await chrome.storage.local.get(SYNC_TS_KEY);
  return result[SYNC_TS_KEY] ?? 0;
}

async function setLastSyncTimestamp(ts: number): Promise<void> {
  await chrome.storage.local.set({ [SYNC_TS_KEY]: ts });
}
```

A value of `0` means "never synced" — the first pull fetches all remote entries.

### Soft-Delete Cleanup

Documents with `deleted: true` accumulate over time. A cleanup function runs during pull sync and removes Firestore documents that have been soft-deleted for longer than 30 days:

```typescript
const DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function cleanupDeletedDocs(uid: string): Promise<void> {
  const cutoff = Date.now() - DELETE_RETENTION_MS;
  const snapshot = await getDocs(
    query(
      collection(db, "users", uid, "vocab"),
      where("deleted", "==", true),
      where("updatedAt", "<", cutoff),
    ),
  );
  const batch = writeBatch(db);
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}
```

This runs once per pull sync, after the merge completes. The 30-day window ensures that any device that has been offline for up to a month still sees the deletion.

---

## 6. Manifest and Permission Changes

### New Permission: identity

`chrome.identity` is required for `getAuthToken()`:

```json
{
  "permissions": [
    "activeTab",
    "storage",
    "contextMenus",
    "identity"
  ]
}
```

### New Key: oauth2

The manifest must declare an `oauth2` section with the extension's Google Cloud client ID and the scopes requested:

```json
{
  "oauth2": {
    "client_id": "<Google Cloud OAuth 2.0 client ID>.apps.googleusercontent.com",
    "scopes": [
      "https://www.googleapis.com/auth/userinfo.email"
    ]
  }
}
```

The `userinfo.email` scope is the minimum needed for Firebase Auth to identify the user. No access to Gmail, Drive, or other Google services is requested.

### Google Cloud Project Setup

Before this feature can work, a one-time setup is required in the Google Cloud Console:

1. Create a project (or reuse an existing one).
2. Enable the **Chrome Identity API**.
3. Create an **OAuth 2.0 Client ID** of type "Chrome Extension" with the extension's public key.
4. Copy the client ID into the `oauth2.client_id` field in `manifest.json`.

### Firebase Project Setup

1. Create a Firebase project linked to the same Google Cloud project.
2. Enable **Firebase Authentication** with the Google sign-in provider.
3. Create a **Firestore** database in the project's preferred region.
4. Deploy the security rules from [Section 4](#4-data-model).

### New npm Dependency: firebase

The Firebase client SDK is added as a project dependency:

```
npm install firebase
```

Only the `firebase/auth` and `firebase/firestore` modules are imported. Tree-shaking in the Vite build ensures unused Firebase modules are not bundled.

### Firebase Config

A `src/shared/firebase-config.ts` file holds the Firebase project configuration:

```typescript
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

These values are non-secret — they identify the Firebase project but do not grant access. Access is controlled by the security rules and the authenticated user's UID.

---

## 7. Offline Behavior

### No Degradation

When the device has no internet connection, the extension works identically to today:

- All reads go to `chrome.storage.local` — no network dependency.
- All writes go to `chrome.storage.local` first — the local write always succeeds.
- The async push to Firestore fails silently (caught by `.catch(logSyncError)`).

### Reconciliation on Reconnect

When connectivity returns and the service worker next runs `pullSync()` (on wake or browser restart), the pull query fetches everything newer than `lastSyncTimestamp`. Any entries that were written locally while offline will have been pushed to Firestore individually on each write attempt; for entries where the push failed, they will be pushed on the next successful sync cycle.

To handle entries that were written locally but never pushed (e.g., the browser was closed while offline), `pullSync()` also does a reverse check: after merging remote entries into local, it scans for local entries whose `lastSeen` is newer than `lastSyncTimestamp` and pushes them to Firestore. This ensures nothing is lost.

### No Firebase Offline Persistence

The Firebase SDK's built-in offline persistence (`enablePersistence()`) is **not used**. The extension already has `chrome.storage.local` as its offline store — adding IndexedDB-based Firebase persistence would duplicate data and add complexity. The sync module treats Firestore as a remote-only store.

---

## 8. File Change Summary

| Area | File | Change |
|---|---|---|
| New: Firebase Config | `src/shared/firebase-config.ts` | Firebase project configuration object |
| New: Sync Client | `src/background/sync-client.ts` | `initSync()`, `pushEntries()`, `pushDelete()`, `pushClear()`, `pullSince()`, `mergeEntries()`, cleanup logic, timestamp persistence |
| New: Sync Types | `src/shared/sync-types.ts` | `VocabDoc` interface (extends `VocabEntry` with `updatedAt` and `deleted`) |
| Vocab Store | `src/background/vocab-store.ts` | After each local write, call corresponding sync function (`pushEntries`, `pushDelete`, `pushClear`) |
| Service Worker | `src/background/service-worker.ts` | Call `initSync()` on startup to authenticate and run initial pull |
| Manifest | `manifest.json` | Add `"identity"` permission, add `oauth2` section |
| Dependencies | `package.json` | Add `firebase` package |
| New: Security Rules | `firestore.rules` | Per-user read/write rules for `users/{uid}/vocab/{word}` |

---

## 9. Future Considerations

### JSON Export/Import (Recommended Next)

Even with cloud sync, a manual JSON export/import feature is valuable as a "panic button" backup:

- **Export:** serialize `getAllVocab()` to a JSON file download from the Vocab Hub. Gives the user a portable snapshot they own and control, independent of Google, Firebase, or any cloud service.
- **Import:** file picker in the Vocab Hub that parses a JSON file and merges entries via `recordWords()`. The existing merge logic in `recordWords()` handles deduplication naturally.

This complements cloud sync rather than competing with it. Cloud sync handles the "I forgot to backup" case; JSON export handles the "I want my data in a file I control" case.

### Anki Deck Export

Language learners frequently use Anki for spaced repetition. A one-click export to `.apkg` format (using a library like `anki-apkg-export`) would give the vocab list a life outside the extension entirely, bridging it into the user's existing study workflow.

### Real-Time Sync via Firestore Listeners

The current design uses poll-on-startup sync. A future enhancement could use Firestore's `onSnapshot` listeners for real-time cross-device push — if the user adds a word on their laptop, it appears on their desktop within seconds. This adds complexity (managing listener lifecycle in a service worker that may be suspended) but significantly improves the multi-device experience.

### Sync Status Indicator

A subtle sync icon in the Vocab Hub header (e.g., a cloud with a checkmark when synced, a spinner when syncing, an X when offline) would give power users visibility into sync state without cluttering the UI for casual users.
