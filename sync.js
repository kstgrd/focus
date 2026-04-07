// --- Sync via Firebase ---
// Rules:
// 1. Firebase is the source of truth — always
// 2. If Firebase has no data (first-ever sync) — upload local state, then Firebase is source of truth
// 3. On connect: overwrite local state with Firebase data
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
  let ready = false; // true only after we've confirmed Firebase state

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

  // On every LOCAL state change -> debounced push (only after initial sync done)
  let pushTimeout = null;
  window.app.onStateChange(() => {
    if (applying || !ready) return;
    clearTimeout(pushTimeout);
    pushTimeout = setTimeout(() => push(window.app.getState()), 2000);
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

    // Step 1: Fetch server state (bypasses cache)
    const docRef = db.doc(docPath);
    docRef.get({ source: 'server' }).then(snapshot => {
      if (snapshot.exists && snapshot.data().state) {
        // Firebase has data — overwrite local state
        applying = true;
        window.app.applyRemoteState(snapshot.data().state);
        applying = false;
      } else {
        // No data in Firebase — seed with local state
        push(window.app.getState());
      }

      // Step 2: Now ready — allow local pushes and listen for live updates
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
    }).catch(err => {
      // Server unreachable — try cache as fallback
      docRef.get({ source: 'cache' }).then(snapshot => {
        if (snapshot.exists && snapshot.data().state) {
          applying = true;
          window.app.applyRemoteState(snapshot.data().state);
          applying = false;
        }
        ready = true;
        setStatus('Offline — using cached data', 'connected');
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
      }).catch(() => {
        setStatus('Connection failed', 'error');
        setIndicator('error');
      });
    });
  }

  function push(stateSnapshot) {
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
      cleanup();
      docPath = '';
      ready = false;
      $indicator.classList.add('hidden');
    }
  });

  // Re-push on wake / network restored (only if ready)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ready && docPath && auth.currentUser) {
      push(window.app.getState());
    }
  });
})();
