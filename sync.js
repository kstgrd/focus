// --- P2P Sync via PeerJS ---
(function () {
  const PEER_PREFIX = 'pomodorotimer-';
  let peer = null;
  let connections = [];
  let isHost = false;
  let secretKey = '';
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
  $syncBtn.addEventListener('click', openModal);
  $closeBtn.addEventListener('click', closeModal);
  $backdrop.addEventListener('click', closeModal);
  $connectBtn.addEventListener('click', connect);
  $disconnectBtn.addEventListener('click', disconnect);
  $syncKey.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

  // Listen for local state changes to broadcast
  window.app.onStateChange(broadcastToAll);

  function openModal() {
    $modal.classList.remove('hidden');
    $syncKey.focus();
  }

  function closeModal() {
    $modal.classList.add('hidden');
  }

  function connect() {
    const key = $syncKey.value.trim();
    if (!key) {
      setStatus('Enter a secret key', 'error');
      return;
    }
    secretKey = key;
    const hostId = PEER_PREFIX + hashKey(key);

    setStatus('Connecting...');
    $connectBtn.disabled = true;
    tryAsHost(hostId);
  }

  function tryAsHost(hostId) {
    cleanup();

    peer = new Peer(hostId, { debug: 0 });

    peer.on('open', () => {
      isHost = true;
      setStatus('Connected as host. Waiting for peers...', 'connected');
      showConnected();
      peer.on('connection', handleIncoming);
    });

    peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        peer.destroy();
        tryAsClient(hostId);
      } else {
        setStatus('Error: ' + err.message, 'error');
        $connectBtn.disabled = false;
      }
    });

    peer.on('disconnected', () => {
      if (secretKey) scheduleReconnect();
    });
  }

  function tryAsClient(hostId) {
    const clientId = hostId + '-' + Math.random().toString(36).slice(2, 8);
    peer = new Peer(clientId, { debug: 0 });

    peer.on('open', () => {
      isHost = false;
      setStatus('Connecting to host...', '');
      const conn = peer.connect(hostId, { reliable: true });

      conn.on('open', () => {
        setupConnection(conn);
        setStatus('Connected to host', 'connected');
        showConnected();
      });

      conn.on('error', err => {
        setStatus('Connection failed: ' + err.message, 'error');
        $connectBtn.disabled = false;
      });
    });

    peer.on('error', err => {
      if (err.type === 'peer-unavailable') {
        setStatus('Host left, becoming host...', '');
        peer.destroy();
        tryAsHost(PEER_PREFIX + hashKey(secretKey));
      } else {
        setStatus('Error: ' + err.message, 'error');
        $connectBtn.disabled = false;
      }
    });

    peer.on('disconnected', () => {
      if (secretKey) scheduleReconnect();
    });

    peer.on('connection', handleIncoming);
  }

  function handleIncoming(conn) {
    conn.on('open', () => {
      setupConnection(conn);
      conn.send({ type: 'state', data: window.app.getState() });
    });
  }

  function setupConnection(conn) {
    connections.push(conn);

    conn.on('data', msg => {
      if (msg.type === 'state') {
        window.app.applyRemoteState(msg.data);
        if (isHost) {
          connections.forEach(c => {
            if (c !== conn && c.open) c.send(msg);
          });
        }
      }
    });

    conn.on('close', () => {
      connections = connections.filter(c => c !== conn);
      updateConnectionStatus();
    });

    conn.on('error', () => {
      connections = connections.filter(c => c !== conn);
      updateConnectionStatus();
    });

    updateConnectionStatus();
  }

  function broadcastToAll(stateSnapshot) {
    const msg = { type: 'state', data: stateSnapshot };
    connections.forEach(c => { if (c.open) c.send(msg); });
  }

  function disconnect() {
    secretKey = '';
    cleanup();
    setStatus('Disconnected');
    $indicator.classList.add('hidden');
    $connectBtn.classList.remove('hidden');
    $disconnectBtn.classList.add('hidden');
    $connectBtn.disabled = false;
  }

  function cleanup() {
    clearTimeout(reconnectTimeout);
    connections.forEach(c => { try { c.close(); } catch (e) {} });
    connections = [];
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    isHost = false;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
      if (secretKey) {
        setStatus('Reconnecting...');
        tryAsHost(PEER_PREFIX + hashKey(secretKey));
      }
    }, 3000);
  }

  function showConnected() {
    $indicator.classList.remove('hidden');
    $connectBtn.classList.add('hidden');
    $disconnectBtn.classList.remove('hidden');
    $connectBtn.disabled = false;
  }

  function updateConnectionStatus() {
    const active = connections.filter(c => c.open).length;
    if (peer && peer.open) {
      if (isHost) {
        setStatus(`Host \u2014 ${active} peer${active !== 1 ? 's' : ''} connected`, 'connected');
      } else {
        setStatus(active > 0 ? 'Connected to host' : 'Connecting...', active > 0 ? 'connected' : '');
      }
      $indicator.classList.remove('hidden');
    } else {
      $indicator.classList.add('hidden');
    }
  }

  function setStatus(text, cls) {
    $status.textContent = text;
    $status.className = 'sync-status' + (cls ? ' ' + cls : '');
  }

  function hashKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
})();