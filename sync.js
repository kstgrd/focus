// --- Sync via MQTT over WebSocket ---
(function () {
  const SYNC_KEY_STORAGE = 'pomodoro-sync-key';
  const BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';
  const TOPIC_PREFIX = 'pomodoro-timer/';

  let client = null;
  let topic = '';
  let clientId = '';
  let ignoreNext = false;

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
    if (!client) $syncKey.focus();
  });
  $closeBtn.addEventListener('click', () => $modal.classList.add('hidden'));
  $backdrop.addEventListener('click', () => $modal.classList.add('hidden'));
  $connectBtn.addEventListener('click', connect);
  $disconnectBtn.addEventListener('click', disconnect);
  $syncKey.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

  // Listen for local state changes
  window.app.onStateChange(broadcast);

  function connect() {
    const key = $syncKey.value.trim();
    if (!key) {
      setStatus('Enter a secret key', 'error');
      return;
    }

    const hash = hashKey(key);
    localStorage.setItem(SYNC_KEY_STORAGE, hash);
    topic = TOPIC_PREFIX + hash;
    clientId = 'pomo-' + Math.random().toString(36).slice(2, 10);

    setStatus('Connecting...');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');
    $connectBtn.disabled = true;
    startMqtt();
  }

  function onMessage(t, payload) {
    if (t !== topic) return;
    try {
      const msg = JSON.parse(payload.toString());
      if (msg._sender === clientId) return;
      if (msg.data) {
        window.app.applyRemoteState(msg.data);
      }
    } catch (e) {}
  }

  function broadcast(stateSnapshot) {
    if (!client || !client.connected) return;
    const msg = JSON.stringify({
      _sender: clientId,
      data: stateSnapshot
    });
    client.publish(topic, msg, { retain: true });
  }

  function disconnect() {
    if (client) {
      // Clear retained message
      client.publish(topic, '', { retain: true });
      client.end();
      client = null;
    }
    localStorage.removeItem(SYNC_KEY_STORAGE);
    topic = '';
    setStatus('Disconnected');
    $indicator.classList.add('hidden');
    $connectBtn.classList.remove('hidden');
    $disconnectBtn.classList.add('hidden');
    $connectBtn.disabled = false;
  }

  function showConnected() {
    $indicator.classList.remove('hidden');
    setIndicator('connected');
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

  // Auto-connect on load using stored hash
  const savedHash = localStorage.getItem(SYNC_KEY_STORAGE);
  if (savedHash) {
    topic = TOPIC_PREFIX + savedHash;
    clientId = 'pomo-' + Math.random().toString(36).slice(2, 10);

    setStatus('Connecting...');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');
    $connectBtn.disabled = true;
    startMqtt();
  }

  function startMqtt() {
    client = mqtt.connect(BROKER_URL, {
      clientId: clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000
    });

    client.on('connect', () => {
      setStatus('Connected — syncing', 'connected');
      showConnected();
      client.subscribe(topic);
      broadcast(window.app.getState());
    });

    client.on('message', onMessage);
    client.on('error', err => { setStatus('Error: ' + err.message, 'error'); setIndicator('error'); });
    client.on('reconnect', () => { setStatus('Reconnecting...', ''); setIndicator('connecting'); });
    client.on('offline', () => { setStatus('Offline', 'error'); setIndicator('error'); });
  }
})();