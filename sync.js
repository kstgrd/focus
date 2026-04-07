// --- Sync via Firebase ---
// Firebase is the single source of truth. No localStorage.
// 1. On sign-in: fetch Firebase state, apply to app, reveal UI
// 2. If no Firebase data: first-ever sync, seed with app defaults
// 3. On local change: fetch Firebase, compare lastUpdate, only write if local is newer
// 4. onSnapshot: apply remote changes in real-time
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyB_IwLOF83V4KAwbZCobLNuL9vLfWmh88c",
    authDomain: "focus-timer-92d75.firebaseapp.com",
    projectId: "focus-timer-92d75",
    storageBucket: "focus-timer-92d75.firebasestorage.app",
    messagingSenderId: "7929797079",
    appId: "1:7929797079:web:0d37d445d4214648e25392"
  };

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  let unsubscribe = null;
  let docPath = '';
  let senderId = 'pomo-' + Math.random().toString(36).slice(2, 10);
  let applying = false;
  let ready = false;

  // DOM
  const $modal = document.getElementById('sync-modal');
  const $syncBtn = document.getElementById('sync-btn');
  const $closeBtn = document.getElementById('sync-close');
  const $status = document.getElementById('sync-status');
  const $indicator = document.getElementById('sync-indicator');
  const $backdrop = $modal.querySelector('.modal-backdrop');
  const $signInBtn = document.getElementById('sync-signin');
  const $signOutBtn = document.getElementById('sync-signout');
  const $syncDesc = document.getElementById('sync-desc');

  // Events
  $syncBtn.addEventListener('click', () => {
    $modal.classList.remove('hidden');
    updateAuthUI();
  });
  $closeBtn.addEventListener('click', () => $modal.classList.add('hidden'));
  $backdrop.addEventListener('click', () => $modal.classList.add('hidden'));
  $signInBtn.addEventListener('click', signIn);
  $signOutBtn.addEventListener('click', signOut);

  // On every LOCAL state change -> debounced push (only when ready)
  let pushTimeout = null;
  window.app.onStateChange(() => {
    if (applying || !ready) return;
    clearTimeout(pushTimeout);
    pushTimeout = setTimeout(syncPush, 2000);
  });

  async function signIn() {
    try {
      $signInBtn.disabled = true;
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setStatus('Sign-in failed: ' + err.message, 'error');
      }
    } finally {
      $signInBtn.disabled = false;
    }
  }

  async function signOut() {
    cleanup();
    docPath = '';
    ready = false;
    await auth.signOut();
    setIndicator('');
    $indicator.classList.add('hidden');
    setStatus('');
    updateAuthUI();
  }

  function updateAuthUI() {
    const user = auth.currentUser;
    if (user) {
      $signInBtn.classList.add('hidden');
      $signOutBtn.classList.remove('hidden');
      $syncDesc.textContent = 'Signed in as ' + (user.displayName || user.email) + '. Your devices sync automatically.';
    } else {
      $signInBtn.classList.remove('hidden');
      $signOutBtn.classList.add('hidden');
      $syncDesc.textContent = 'Sign in with Google to sync across devices.';
    }
  }

  function startSync(user) {
    cleanup();
    ready = false;
    docPath = 'sync/' + user.uid;
    setStatus('Connecting...', '');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');

    const docRef = db.doc(docPath);

    // Fetch from server, init app with that state
    docRef.get({ source: 'server' }).then(snapshot => {
      initApp(snapshot);
      subscribe(docRef);
    }).catch(() => {
      // Offline — use cache
      docRef.get({ source: 'cache' }).then(snapshot => {
        initApp(snapshot);
        subscribe(docRef);
        setStatus('Offline — using cached data', 'connected');
      }).catch(() => {
        // No cache either — init with defaults
        window.app.initWithState(null);
        subscribe(docRef);
        setStatus('Offline — using defaults', '');
      });
    });
  }

  function initApp(snapshot) {
    if (snapshot.exists && snapshot.data().state) {
      window.app.initWithState(snapshot.data().state);
    } else {
      // First-ever sync — init with defaults, then seed Firebase
      window.app.initWithState(null);
      forcePush(window.app.getState());
    }
  }

  function subscribe(docRef) {
    ready = true;
    setStatus('Connected — syncing', 'connected');
    setIndicator('connected');

    unsubscribe = docRef.onSnapshot(snapshot => {
      if (!snapshot.exists || !snapshot.data().state) return;
      const data = snapshot.data();
      if (data._sender === senderId) return;
      applying = true;
      window.app.applyRemoteState(data.state);
      applying = false;
    }, err => {
      setStatus('Sync error: ' + err.message, 'error');
      setIndicator('error');
    });
  }

  // Fetch Firebase, compare timestamps, write only if local is newer
  function syncPush() {
    if (!docPath || !auth.currentUser) return;
    const docRef = db.doc(docPath);

    docRef.get({ source: 'server' }).then(snapshot => {
      const localState = window.app.getState();
      if (snapshot.exists && snapshot.data().state) {
        const remoteLastUpdate = snapshot.data().state.lastUpdate || 0;
        const localLastUpdate = localState.lastUpdate || 0;

        if (remoteLastUpdate > localLastUpdate) {
          // Firebase is newer — apply locally
          applying = true;
          window.app.applyRemoteState(snapshot.data().state);
          applying = false;
          return;
        }
      }
      forcePush(localState);
    }).catch(() => {
      // Offline — write anyway, Firestore will sync when back online
      forcePush(window.app.getState());
    });
  }

  function forcePush(stateSnapshot) {
    if (!docPath || !auth.currentUser) return;
    db.doc(docPath).set({
      _sender: senderId,
      state: stateSnapshot,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  }

  function cleanup() {
    clearTimeout(pushTimeout);
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function setStatus(text, cls) {
    $status.textContent = text;
    $status.className = 'sync-status' + (cls ? ' ' + cls : '');
  }

  function setIndicator(state) {
    $indicator.classList.remove('hidden', 'connected', 'connecting', 'error');
    if (state) $indicator.classList.add(state);
  }

  // Auth state listener
  auth.onAuthStateChanged(user => {
    updateAuthUI();
    if (user) {
      startSync(user);
    } else {
      // Not signed in — load from local IndexedDB
      cleanup();
      docPath = '';
      ready = false;
      $indicator.classList.add('hidden');
      window.app.loadLocal().then(data => {
        window.app.initWithState(data);
      });
    }
  });

  // On wake: fetch Firebase, apply if newer, push if local is newer
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ready && docPath && auth.currentUser) {
      syncPush();
    }
  });
})();
