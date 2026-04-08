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
- **Writes use Firestore transactions** (`db.runTransaction`): atomic read-merge-write prevents stale overwrites
- **Logs are append-only**: merged on every write/read, keeping highest count per day
- **Transaction guards progress**: if cloud has more completedPomodoros, skip write and apply cloud locally
- **Wake behavior**: sync.js owns `visibilitychange` — fetches cloud via `initWithState` before any local timer logic runs, then pushes back if timer completed during init
- **Conflict modal**: only shown on initial sync when both sides have meaningful work; fresh/reset state is never a conflict
- **`completePhase` is idempotent**: checks `isRunning` before mutating, safe if multiple devices race

## State Management (`app.js`)
- No localStorage — Firestore is the single source of truth
- `window.app` exposes `getState()`, `applyRemoteState()`, `onStateChange()`, `initWithState()`, `onWake()`, `showToast()` for sync
- `initWithState()` is the full-init path: applies state, rebuilds segments, reconstructs timer, saves locally
- `applyRemoteState()` is the incremental path: merges logs, applies state, updates UI
- `onWake()` catches up the timer when not signed in (calls `reconstructTimer` + `updateUI`)
