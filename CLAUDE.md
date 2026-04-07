# Focus (Pomodoro Timer)

## Architecture
- Static single-page app: `index.html`, `app.js`, `style.css`, `sync.js`
- PWA with service worker (`sw.js`)
- Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`

## Firebase Sync (`sync.js`)
- Uses Firebase Auth (Google sign-in) + Firestore for real-time state sync
- IndexedDB offline persistence enabled via Firestore
- User email hashed to Firestore document path: `sync/{hash(email)}`
- No manual sync key — sign in with Google and all your devices sync automatically
- `onSnapshot` provides real-time updates; `senderId` prevents processing own writes
- Firestore security rules require authentication (`request.auth != null`)

## State Management (`app.js`)
- Timer state stored in `localStorage` under key `pomodoro-state`
- Settings stored under `pomodoro-settings`
- `window.app` exposes `getState()`, `applyRemoteState()`, `onStateChange()` for sync
- `applyRemoteState` uses `lastUpdate` timestamp to resolve conflicts (latest wins)
