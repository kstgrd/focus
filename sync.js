// --- Sync via ntfy.sh ---
// - On connect: pull latest from topic (12h), merge logs, apply if newer, push back merged state
// - On every local state change: push to topic
// - WebSocket: receive live updates from other peers
(function () {
  const SYNC_KEY_STORAGE = 'pomodoro-sync-key';
  const NTFY_BASE = 'https://ntfy.sh';
  const TOPIC_PREFIX = 'pomodoro-timer-';

  let ws = null;
  let topic = '';
  let senderId = '';
  let reconnectTimeout = null;
  let applying = false; // prevent push during remote apply

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

  // On every LOCAL state change → debounced push to topic
  let pushTimeout = null;
  window.app.onStateChange(stateSnapshot => {
    if (applying) return;
    clearTimeout(pushTimeout);
    pushTimeout = setTimeout(() => push(window.app.getState()), 2000);
  });

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

  async function startSync(hash) {
    cleanup();
    topic = TOPIC_PREFIX + hash;
    senderId = 'pomo-' + Math.random().toString(36).slice(2, 10);

    setStatus('Connecting...');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');
    $connectBtn.disabled = true;

    // Initial sync: pull, merge, push
    await initialSync();

    // Subscribe via WebSocket for live updates
    const wsUrl = NTFY_BASE.replace('https:', 'wss:').replace('http:', 'ws:')
      + '/' + topic + '/ws';

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus('Connected — syncing', 'connected');
      setIndicator('connected');
      showConnected();
    };

    ws.onmessage = (e) => {
      try {
        const ntfyMsg = JSON.parse(e.data);
        if (ntfyMsg.event !== 'message') return;
        const msg = JSON.parse(ntfyMsg.message);
        if (msg._sender === senderId) return;
        if (msg.data) {
          applying = true;
          window.app.applyRemoteState(msg.data);
          applying = false;
          // Push merged state back (log may have grown)
          push(window.app.getState());
        }
      } catch (err) { applying = false; }
    };

    ws.onclose = () => {
      if (topic) {
        setStatus('Reconnecting...', '');
        setIndicator('connecting');
        reconnectTimeout = setTimeout(() => startSync(hash), 3000);
      }
    };

    ws.onerror = () => {
      setStatus('Connection error', 'error');
      setIndicator('error');
    };
  }

  // Pull latest from topic, merge, push back merged state
  async function initialSync() {
    try {
      const remote = await pullLatest();
      if (remote) {
        applying = true;
        window.app.applyRemoteState(remote);
        applying = false;
      }
      // Always push after initial sync — either our state or the merged result
      await push(window.app.getState());
    } catch (err) {
      applying = false;
      // Network error — push local state as fallback
      try { await push(window.app.getState()); } catch (e) {}
    }
  }

  // Pull the latest message from the topic (12h cache)
  async function pullLatest() {
    const url = NTFY_BASE + '/' + topic + '/json?poll=1&since=12h';
    const res = await fetch(url);
    const text = await res.text();
    if (!text.trim()) return null;

    // ntfy returns one JSON object per line — take the last one
    const lines = text.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ntfyMsg = JSON.parse(lines[i]);
        if (ntfyMsg.message) {
          const msg = JSON.parse(ntfyMsg.message);
          if (msg.data) return msg.data;
        }
      } catch (e) {}
    }
    return null;
  }

  // Push state to the topic
  function push(stateSnapshot) {
    if (!topic) return;
    const body = JSON.stringify({
      _sender: senderId,
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

  // Reconnect on wake / network restored
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && topic) {
      const hash = localStorage.getItem(SYNC_KEY_STORAGE);
      if (hash && (!ws || ws.readyState !== WebSocket.OPEN)) startSync(hash);
      else initialSync(); // re-sync even if WS is open
    }
  });
  window.addEventListener('online', () => {
    const hash = localStorage.getItem(SYNC_KEY_STORAGE);
    if (hash) startSync(hash);
  });
})();