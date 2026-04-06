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
- **Critical**: PeerJS `disconnected` event = signaling server drop, NOT data channel drop. On disconnect:
  1. Immediately call `peer.reconnect()` to restore signaling (needed for ICE negotiation)
  2. Schedule a fallback (8s) that only does full teardown if BOTH signaling and data channels are down
  3. Never tear down active data channels just because signaling dropped
- **Critical**: Do NOT override PeerJS's default ICE servers with STUN-only. PeerJS defaults include a TURN relay which is required for same-LAN PCs (where STUN fails because both peers share the same NAT-reflected IP and Chrome's mDNS candidates don't resolve cross-machine)

## State Management (`app.js`)
- Timer state stored in `localStorage` under key `pomodoro-state`
- Settings stored under `pomodoro-settings`
- `window.app` exposes `getState()`, `applyRemoteState()`, `onStateChange()` for sync
- `applyRemoteState` uses `lastUpdate` timestamp to resolve conflicts (latest wins)
