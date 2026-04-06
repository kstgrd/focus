# Focus (Pomodoro Timer)

## Architecture
- Static single-page app: `index.html`, `app.js`, `style.css`, `sync.js`
- PWA with service worker (`sw.js`)
- Deployed to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`

## P2P Sync (`sync.js`)
- Uses PeerJS (WebRTC) for peer-to-peer state sync
- First peer to connect with a key becomes host; subsequent peers become clients
- Host relays state changes to all connected peers
- **Critical**: All PeerJS data connections must wait for `conn.on('open')` before calling `setupConnection()` — both in `handleIncoming` (host side) and `tryAsClient` (client side)
- PeerJS `disconnected` event = signaling server drop, NOT data channel drop. Don't tear down active WebRTC connections on signaling disconnect.

## State Management (`app.js`)
- Timer state stored in `localStorage` under key `pomodoro-state`
- Settings stored under `pomodoro-settings`
- `window.app` exposes `getState()`, `applyRemoteState()`, `onStateChange()` for sync
- `applyRemoteState` uses `lastUpdate` timestamp to resolve conflicts (latest wins)
