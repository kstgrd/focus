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
    console.log('[sync] tryAsHost', hostId);

    peer = new Peer(hostId, { debug: 0 });

    peer.on('open', id => {
      console.log('[sync] host open, id=', id);
      isHost = true;
      setStatus('Connected as host. Waiting for peers...', 'connected');
      showConnected();
      peer.on('connection', handleIncoming);
    });

    peer.on('error', err => {
      console.log('[sync] host error', err.type, err.message);
      if (err.type === 'unavailable-id') {
        peer.destroy();
        tryAsClient(hostId);
      } else {
        setStatus('Error: ' + err.message, 'error');
        $connectBtn.disabled = false;
      }
    });

    peer.on('disconnected', () => {
      console.log('[sync] host peer disconnected from signaling');
      if (secretKey) scheduleReconnect();
    });
  }

  function tryAsClient(hostId) {
    const clientId = hostId + '-' + Math.random().toString(36).slice(2, 8);
    console.log('[sync] tryAsClient', clientId, '-> host', hostId);
    peer = new Peer(clientId, { debug: 0 });

    peer.on('open', id => {
      console.log('[sync] client open, id=', id);
      isHost = false;
      setStatus('Connecting to host...', '');
      const conn = peer.connect(hostId, { reliable: true });

      conn.on('open', () => {
        console.log('[sync] client data channel OPEN to host');
        setupConnection(conn);
        setStatus('Connected to host', 'connected');
        showConnected();
      });

      conn.on('error', err => {
        console.log('[sync] client conn error', err);
        setStatus('Connection failed: ' + err.message, 'error');
        $connectBtn.disabled = false;
      });
    });

    peer.on('error', err => {
      console.log('[sync] client peer error', err.type, err.message);
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
      console.log('[sync] client peer disconnected from signaling');
      if (secretKey) scheduleReconnect();
    });

    peer.on('connection', handleIncoming);
  }

  function handleIncoming(conn) {
    console.log('[sync] handleIncoming from', conn.peer, 'open=', conn.open);
    conn.on('open', () => {
      console.log('[sync] incoming data channel OPEN from', conn.peer);
      setupConnection(conn);
      conn.send({ type: 'state', data: window.app.getState() });
    });
  }

  function setupConnection(conn) {
    connections.push(conn);
    console.log('[sync] setupConnection, peer=', conn.peer, 'open=', conn.open, 'total=', connections.length);

    conn.on('data', msg => {
      if (msg.type === 'state') {
        console.log('[sync] received state', JSON.stringify(msg.data).slice(0, 120));
        window.app.applyRemoteState(msg.data);
        if (isHost) {
          connections.forEach(c => {
            if (c !== conn && c.open) c.send(msg);
          });
        }
      }
    });

    conn.on('close', () => {
      console.log('[sync] conn closed', conn.peer);
      connections = connections.filter(c => c !== conn);
      updateConnectionStatus();
    });

    conn.on('error', err => {
      console.log('[sync] conn error', conn.peer, err);
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
      if (!secretKey) return;
      const activeConns = connections.filter(c => c.open).length;
      console.log('[sync] scheduleReconnect, activeConns=', activeConns);
      if (peer && activeConns > 0) {
        console.log('[sync] reconnecting signaling only (data channels alive)');
        try { peer.reconnect(); } catch (e) {}
        return;
      }
      console.log('[sync] full reconnect');
      setStatus('Reconnecting...');
      tryAsHost(PEER_PREFIX + hashKey(secretKey));
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