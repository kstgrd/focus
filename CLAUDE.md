# Focus (Pomodoro Timer)

## Architecture
- Static single-page app: `index.html`, `app.js`, `style.css`, `sync.js`
- PWA with service worker (`sw.js`)
- Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`

## Firebase Sync (`sync.js`)
- Uses Firebase Auth (Google sign-in) + Firestore for real-time state sync
- IndexedDB offline persistence enabled via Firestore
- Document path: `sync/{user.uid}`
- No manual sync key — sign in with Google and all your devices sync automatically
- `onSnapshot` provides real-time updates; `senderId` prevents processing own writes
- Firestore security rules require authentication (`request.auth != null`)

## Sync Strategy
- **Version counter** (`_version`): every Firestore write increments `_version`; devices track `knownVersion` to detect divergence
- **Dirty flag**: `dirty` is set when local state changes (suppressed during cloud-apply via `applying` flag); only dirty devices attempt pushes
- **Firebase is truth when online**: `onSnapshot` updates are applied immediately, cancelling any pending local push
- **Writes use Firestore transactions** (`db.runTransaction`): atomic read-merge-write with version increment
- **Logs are append-only**: merged on every write/read, keeping highest count per day
- **Wake/reconnect (`resync`)**: fetches cloud from server, compares `_version` vs `knownVersion`:
  - Cloud unchanged + dirty → push local (no conflict)
  - Cloud changed + not dirty → accept cloud
  - Cloud changed + dirty → **conflict dialog** (only case it appears)
  - Server unreachable + not dirty → apply cache for display, don't push
  - Server unreachable + dirty → keep local changes, wait for network
- **Initial sync**: `fromServer` flag distinguishes server vs cache snapshots — only creates cloud doc when server confirms it doesn't exist (prevents stale cache-miss from force-pushing)
- **Conflict modal**: only shown when both local and cloud diverged while offline; fresh/reset state is never a conflict
- **`completePhase` is idempotent**: checks `isRunning` before mutating, safe if multiple devices race

## State Management (`app.js`)
- No localStorage — Firestore is the single source of truth
- `window.app` exposes `getState()`, `applyRemoteState()`, `onStateChange()`, `initWithState()`, `onWake()`, `showToast()` for sync
- `initWithState()` is the full-init path: applies state, rebuilds segments, reconstructs timer, saves locally
- `applyRemoteState()` is the incremental path: merges logs, applies state, updates UI
- `onWake()` catches up the timer when not signed in (calls `reconstructTimer` + `updateUI`)
