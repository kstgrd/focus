// --- P2P Sync via PeerJS ---
(function () {
  const PEER_PREFIX = 'pomodorotimer-';
  const SYNC_STORAGE_KEY = 'pomodoro-sync-key';

  // Chrome hides local IPs behind mDNS (.local) for privacy.
  // Remote peers can't resolve these, so same-LAN WebRTC fails
  // without a TURN relay fallback.
  const PEER_CONFIG = {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turns:openrelay.metered.ca:443'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    }
  };

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
  const $inputGroup = document.getElementById('sync-input-group');
  const $desc = document.getElementById('sync-desc');
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
    if (!secretKey) $syncKey.focus();
  }

  function closeModal() {
    $modal.classList.add('hidden');
  }

  function connect(keyOrHash, isHash) {
    let hash;
    if (isHash) {
      hash = keyOrHash;
    } else {
      const key = (keyOrHash && typeof keyOrHash === 'string') ? keyOrHash : $syncKey.value.trim();
      if (!key) {
        setStatus('Enter a secret key', 'error');
        return;
      }
      hash = hashKey(key);
    }
    secretKey = hash;
    localStorage.setItem(SYNC_STORAGE_KEY, hash);
    const hostId = PEER_PREFIX + hash;

    setStatus('Connecting...');
    setIndicator('connecting');
    $connectBtn.disabled = true;
    tryAsHost(hostId);
  }

  function tryAsHost(hostId) {
    cleanup();
    console.log('[sync] tryAsHost', hostId);

    peer = new Peer(hostId, PEER_CONFIG);

    peer.on('open', id => {
      console.log('[sync] host open, id=', id);
      isHost = true;
      setStatus('Connected as host. Waiting for peers...', 'connected');
      setIndicator('host');
      showConnected();
      peer.on('connection', handleIncoming);
    });

    peer.on('error', err => {
      console.log('[sync] host error', err.type, err.message);
      if (err.type === 'unavailable-id') {
        tryAsClient(hostId);
      } else {
        setStatus('Error: ' + err.message, 'error');
        setIndicator('error');
        $connectBtn.disabled = false;
      }
    });

    peer.on('disconnected', () => {
      console.log('[sync] host peer disconnected from signaling');
      if (!secretKey) return;
      // Immediately try to restore signaling so incoming connections still work
      if (peer && !peer.destroyed) {
        console.log('[sync] host: attempting immediate signaling reconnect');
        try { peer.reconnect(); } catch (e) { }
      }
      scheduleReconnect();
    });
  }

  function tryAsClient(hostId) {
    cleanup();
    const clientId = hostId + '-' + Math.random().toString(36).slice(2, 8);
    console.log('[sync] tryAsClient', clientId, '-> host', hostId);
    peer = new Peer(clientId, PEER_CONFIG);

    peer.on('open', id => {
      console.log('[sync] client open, id=', id);
      isHost = false;
      setStatus('Connecting to host...', '');
      const conn = peer.connect(hostId, { reliable: true });

      conn.on('open', () => {
        console.log('[sync] client data channel OPEN to host');
        setupConnection(conn);
        conn.send({ type: 'request-state' });
        setStatus('Connected to host', 'connected');
        setIndicator('peer');
        showConnected();
      });

      conn.on('error', err => {
        console.log('[sync] client conn error', err);
        setStatus('Connection failed: ' + err.message, 'error');
        setIndicator('error');
        $connectBtn.disabled = false;
      });
    });

    peer.on('error', err => {
      console.log('[sync] client peer error', err.type, err.message);
      if (err.type === 'peer-unavailable') {
        setStatus('Host left, becoming host...', '');
        tryAsHost(PEER_PREFIX + secretKey);
      } else {
        setStatus('Error: ' + err.message, 'error');
        setIndicator('error');
        $connectBtn.disabled = false;
      }
    });

    peer.on('disconnected', () => {
      console.log('[sync] client peer disconnected from signaling');
      if (!secretKey) return;
      // Immediately try to restore signaling so ICE negotiation can continue
      if (peer && !peer.destroyed) {
        console.log('[sync] client: attempting immediate signaling reconnect');
        try { peer.reconnect(); } catch (e) { }
      }
      scheduleReconnect();
    });

    peer.on('connection', handleIncoming);
  }

  function handleIncoming(conn) {
    console.log('[sync] handleIncoming from', conn.peer, 'open=', conn.open);

    // ICE diagnostics: monitor why connection might fail
    const iceCheck = setInterval(() => {
      const pc = conn.peerConnection;
      if (!pc) return;
      clearInterval(iceCheck);
      console.log('[sync] ICE initial:', pc.iceConnectionState, 'gathering:', pc.iceGatheringState);
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log('[sync] ICE:', pc.iceConnectionState);
      });
      pc.addEventListener('icecandidate', e => {
        if (e.candidate) {
          console.log('[sync] ICE candidate:', e.candidate.type, e.candidate.protocol, e.candidate.address);
        } else {
          console.log('[sync] ICE gathering complete');
        }
      });
    }, 50);

    conn.on('open', () => {
      clearInterval(iceCheck);
      console.log('[sync] incoming data channel OPEN from', conn.peer);
      setupConnection(conn);
      conn.send({ type: 'full-sync', data: window.app.getState() });
    });

    conn.on('error', err => {
      clearInterval(iceCheck);
      console.log('[sync] incoming conn error:', err);
    });
  }

  function setupConnection(conn) {
    connections.push(conn);
    console.log('[sync] setupConnection, peer=', conn.peer, 'open=', conn.open, 'total=', connections.length);

    // Monitor ICE state to detect dead connections (e.g. host page refresh)
    const pc = conn.peerConnection;
    if (pc) {
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        console.log('[sync] ICE state:', s, conn.peer);
        if (s === 'disconnected' || s === 'failed' || s === 'closed') {
          removeConnection(conn);
        }
      };
    }

    conn.on('data', msg => {
      if (msg.type === 'full-sync') {
        console.log('[sync] received full-sync', JSON.stringify(msg.data).slice(0, 120));
        window.app.forceApplyRemoteState(msg.data);
      } else if (msg.type === 'request-state' && isHost) {
        console.log('[sync] peer requested state, sending full-sync');
        conn.send({ type: 'full-sync', data: window.app.getState() });
      } else if (msg.type === 'state') {
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
      removeConnection(conn);
    });

    conn.on('error', err => {
      console.log('[sync] conn error', conn.peer, err);
      removeConnection(conn);
    });

    updateConnectionStatus();
  }

  function removeConnection(conn) {
    const had = connections.length;
    connections = connections.filter(c => c !== conn);
    if (connections.length === had) return; // already removed
    try { conn.close(); } catch (e) { }
    updateConnectionStatus();
    handleConnectionLost();
  }

  function broadcastToAll(stateSnapshot) {
    const msg = { type: 'state', data: stateSnapshot };
    connections.forEach(c => { if (c.open) c.send(msg); });
  }

  function disconnect() {
    secretKey = '';
    localStorage.removeItem(SYNC_STORAGE_KEY);
    cleanup();
    setStatus('Disconnected');
    setIndicator(null);
    // Restore input UI
    $inputGroup.classList.remove('hidden');
    $desc.classList.remove('hidden');
    $syncKey.value = '';
    $connectBtn.classList.remove('hidden');
    $disconnectBtn.classList.add('hidden');
    $connectBtn.disabled = false;
  }

  function cleanup() {
    clearTimeout(reconnectTimeout);
    connections.forEach(c => { try { c.close(); } catch (e) { } });
    connections = [];
    if (peer) { try { peer.destroy(); } catch (e) { } peer = null; }
    isHost = false;
  }

  function handleConnectionLost() {
    if (isHost || connections.length > 0 || !secretKey) return;
    console.log('[sync] lost all connections, reconnecting in 2s...');
    setStatus('Host disconnected. Reconnecting...', '');
    setIndicator('connecting');
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
      if (!secretKey) return;
      console.log('[sync] reconnecting after host loss');
      tryAsHost(PEER_PREFIX + secretKey);
    }, 2000);
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimeout);
    // Give enough time for the immediate reconnect + ICE negotiation to work
    reconnectTimeout = setTimeout(() => {
      if (!secretKey) return;
      // If signaling reconnected successfully, nothing to do
      if (peer && peer.open) {
        console.log('[sync] scheduleReconnect: signaling already restored, no action');
        return;
      }
      const activeConns = connections.filter(c => c.open).length;
      if (activeConns > 0) {
        console.log('[sync] scheduleReconnect: data channels alive, skipping teardown');
        return;
      }
      console.log('[sync] scheduleReconnect: full reconnect (signaling + data both down)');
      setStatus('Reconnecting...');
      setIndicator('connecting');
      tryAsHost(PEER_PREFIX + secretKey);
    }, 8000);
  }

  function showConnected() {
    // Hide input, show only disconnect
    $inputGroup.classList.add('hidden');
    $desc.classList.add('hidden');
    $connectBtn.classList.add('hidden');
    $disconnectBtn.classList.remove('hidden');
    $connectBtn.disabled = false;
  }

  function updateConnectionStatus() {
    const active = connections.filter(c => c.open).length;
    if (peer && peer.open) {
      if (isHost) {
        setStatus(`Host \u2014 ${active} peer${active !== 1 ? 's' : ''} connected`, 'connected');
        setIndicator('host');
      } else {
        setStatus(active > 0 ? 'Connected to host' : 'Connecting...', active > 0 ? 'connected' : '');
        setIndicator(active > 0 ? 'peer' : 'connecting');
      }
    }
  }

  function setStatus(text, cls) {
    $status.textContent = text;
    $status.className = 'sync-status' + (cls ? ' ' + cls : '');
  }

  function setIndicator(type) {
    $indicator.className = 'sync-indicator' + (type ? ' ' + type : ' hidden');
  }

  function hashKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // Auto-connect on load if a hash was previously stored
  const savedHash = localStorage.getItem(SYNC_STORAGE_KEY);
  if (savedHash) {
    console.log('[sync] auto-connecting with stored hash');
    connect(savedHash, true);
  }
})();