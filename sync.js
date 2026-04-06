// --- Sync via ntfy.sh (WebSocket subscribe + HTTP publish) ---
(function () {
  const SYNC_KEY_STORAGE = 'pomodoro-sync-key';
  const NTFY_BASE = 'https://ntfy.sh';
  const TOPIC_PREFIX = 'pomodoro-timer-';

  let ws = null;
  let topic = '';
  let senderId = '';
  let connectedSince = 0;
  let reconnectTimeout = null;

  // DOM
  const $modal = document.getElementById('sync-modal');
  const $syncBtn = document.getElementById('sync-btn');
  const $syncKey = document.getElementById('sync-key');
  const $connectBtn = document.getElementById('sync-connect');
  const $disconnectBtn = document.getElementById('sync-disconnect');
  const $closeBtn = document.getElementById('sync-close');
  const $status = document.getElementById('sync-status');
  const $indicator = document.getElementById('sync-indicator');
  const $backdrop = $modal.querySelector('.modal-backdrop');

  // Events
  $syncBtn.addEventListener('click', () => {
    $modal.classList.remove('hidden');
    if (!ws) $syncKey.focus();
  });
  $closeBtn.addEventListener('click', () => $modal.classList.add('hidden'));
  $backdrop.addEventListener('click', () => $modal.classList.add('hidden'));
  $connectBtn.addEventListener('click', connect);
  $disconnectBtn.addEventListener('click', disconnect);
  $syncKey.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

  window.app.onStateChange(broadcast);

  function connect() {
    const key = $syncKey.value.trim();
    if (!key) {
      setStatus('Enter a secret key', 'error');
      return;
    }

    const hash = hashKey(key);
    localStorage.setItem(SYNC_KEY_STORAGE, hash);
    startSync(hash);
  }

  function startSync(hash) {
    cleanup();
    topic = TOPIC_PREFIX + hash;
    senderId = 'pomo-' + Math.random().toString(36).slice(2, 10);
    connectedSince = Date.now();

    setStatus('Connecting...');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');
    $connectBtn.disabled = true;

    // Subscribe via WebSocket — since=10s catches recent live messages, avoids stale replays
    const wsUrl = NTFY_BASE.replace('https:', 'wss:').replace('http:', 'ws:')
      + '/' + topic + '/ws?since=10s';

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus('Connected — syncing', 'connected');
      setIndicator('connected');
      showConnected();
      broadcast(window.app.getState());
    };

    ws.onmessage = (e) => {
      try {
        const ntfyMsg = JSON.parse(e.data);
        if (ntfyMsg.event !== 'message') return;
        const msg = JSON.parse(ntfyMsg.message);
        if (msg._sender === senderId) return;
        if (!msg.data) return;

        // Sender connected before us → they're the authority, force-apply
        if (msg._connectedSince && msg._connectedSince < connectedSince) {
          window.app.forceApplyRemoteState(msg.data);
        } else {
          // Sender connected after us → only apply if lastUpdate is newer
          window.app.applyRemoteState(msg.data);
        }
      } catch (err) {}
    };

    ws.onclose = () => {
      if (topic) {
        setStatus('Disconnected — reconnecting...', '');
        setIndicator('connecting');
        reconnectTimeout = setTimeout(() => startSync(hash), 3000);
      }
    };

    ws.onerror = () => {
      setStatus('Connection error', 'error');
      setIndicator('error');
    };
  }

  function broadcast(stateSnapshot) {
    if (!topic) return;
    const body = JSON.stringify({
      _sender: senderId,
      _connectedSince: connectedSince,
      data: stateSnapshot
    });
    fetch(NTFY_BASE + '/' + topic, {
      method: 'POST',
      body: body
    }).catch(() => {});
  }

  function disconnect() {
    cleanup();
    localStorage.removeItem(SYNC_KEY_STORAGE);
    topic = '';
    setStatus('Disconnected');
    $indicator.classList.add('hidden');
    $connectBtn.classList.remove('hidden');
    $disconnectBtn.classList.add('hidden');
    $connectBtn.disabled = false;
  }

  function cleanup() {
    clearTimeout(reconnectTimeout);
    if (ws) {
      const old = ws;
      ws = null;
      old.onclose = null;
      old.close();
    }
  }

  function showConnected() {
    $connectBtn.classList.add('hidden');
    $disconnectBtn.classList.remove('hidden');
    $connectBtn.disabled = false;
  }

  function setStatus(text, cls) {
    $status.textContent = text;
    $status.className = 'sync-status' + (cls ? ' ' + cls : '');
  }

  function setIndicator(state) {
    $indicator.classList.remove('hidden', 'connected', 'connecting', 'error');
    if (state) $indicator.classList.add(state);
  }

  function hashKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // Auto-connect on load
  const savedHash = localStorage.getItem(SYNC_KEY_STORAGE);
  if (savedHash) {
    startSync(savedHash);
  }

  // Reconnect on wake (phone screen on) or network restored
  function checkConnection() {
    if (!topic) return;
    const hash = localStorage.getItem(SYNC_KEY_STORAGE);
    if (!hash) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[sync] stale connection, reconnecting');
      startSync(hash);
    } else {
      // Connection alive — re-broadcast state so peers know we're back
      broadcast(window.app.getState());
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkConnection();
  });
  window.addEventListener('online', checkConnection);
})();