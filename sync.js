// --- Sync via Firebase ---
// Firebase is the single source of truth. IndexedDB for anonymous/offline.
// On conflict (local vs cloud differ): prompt user to choose.
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

  // Conflict modal DOM
  const $conflictModal = document.getElementById('conflict-modal');
  const $conflictLocal = document.getElementById('conflict-local');
  const $conflictCloud = document.getElementById('conflict-cloud');
  const $conflictLocalDetail = document.getElementById('conflict-local-detail');
  const $conflictCloudDetail = document.getElementById('conflict-cloud-detail');
  const $conflictBackdrop = $conflictModal.querySelector('.modal-backdrop');

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
    pushTimeout = setTimeout(() => forcePush(window.app.getState()), 2000);
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

    // Load local IndexedDB data first, then fetch cloud
    window.app.loadLocal().then(localData => {
      const docRef = db.doc(docPath);

      docRef.get({ source: 'server' }).then(snapshot => {
        resolveInitialSync(localData, snapshot, docRef);
      }).catch(() => {
        docRef.get({ source: 'cache' }).then(snapshot => {
          resolveInitialSync(localData, snapshot, docRef);
          setStatus('Offline — using cached data', 'connected');
        }).catch(() => {
          // No cloud at all — use local or defaults
          window.app.initWithState(localData);
          subscribe(docRef);
          setStatus('Offline — using local data', '');
        });
      });
    });
  }

  function resolveInitialSync(localData, snapshot, docRef) {
    const cloudState = (snapshot.exists && snapshot.data().state) ? snapshot.data().state : null;

    if (!cloudState && !localData) {
      // Both empty — init defaults, seed cloud
      window.app.initWithState(null);
      forcePush(window.app.getState());
      subscribe(docRef);
      return;
    }

    if (!cloudState) {
      // No cloud — use local, seed cloud
      window.app.initWithState(localData);
      forcePush(window.app.getState());
      subscribe(docRef);
      return;
    }

    if (!localData || !hasConflict(localData, cloudState)) {
      // No local or no conflict — use cloud
      window.app.initWithState(cloudState);
      subscribe(docRef);
      return;
    }

    // Conflict — show page with local data, prompt user
    window.app.initWithState(localData);
    showConflictModal(localData, cloudState, choice => {
      if (choice === 'local') {
        forcePush(window.app.getState());
      } else {
        window.app.initWithState(cloudState);
      }
      subscribe(docRef);
    });
  }

  function hasConflict(local, cloud) {
    if (local.version === 0 && local.completedPomodoros === 0) return false;
    if (local.date !== cloud.date) return true;
    if (local.completedPomodoros !== cloud.completedPomodoros) return true;
    if (local.isFocus !== cloud.isFocus) return true;
    if (local.isRunning !== cloud.isRunning) return true;
    return false;
  }

  function stateDescription(s) {
    const phase = s.isFocus ? 'Focus' : 'Break';
    const running = s.isRunning ? 'running' : 'paused';
    const date = s.date || '—';
    const pomos = s.completedPomodoros || 0;
    const updated = s.lastUpdate ? new Date(s.lastUpdate).toLocaleString() : '—';
    return date + ' · ' + pomos + ' sessions · ' + phase + ' (' + running + ')\nUpdated: ' + updated;
  }

  function showConflictModal(localState, cloudState, callback) {
    $conflictLocalDetail.textContent = stateDescription(localState);
    $conflictCloudDetail.textContent = stateDescription(cloudState);
    $conflictModal.classList.remove('hidden');

    function choose(choice) {
      $conflictModal.classList.add('hidden');
      $conflictLocal.removeEventListener('click', onLocal);
      $conflictCloud.removeEventListener('click', onCloud);
      callback(choice);
    }

    function onLocal() { choose('local'); }
    function onCloud() { choose('cloud'); }

    $conflictLocal.addEventListener('click', onLocal);
    $conflictCloud.addEventListener('click', onCloud);
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
      cleanup();
      docPath = '';
      ready = false;
      $indicator.classList.add('hidden');
      window.app.loadLocal().then(data => {
        window.app.initWithState(data);
      });
    }
  });

  // On wake: re-sync with Firebase
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ready && docPath && auth.currentUser) {
      const docRef = db.doc(docPath);
      docRef.get({ source: 'server' }).then(snapshot => {
        if (!snapshot.exists || !snapshot.data().state) return;
        const cloudState = snapshot.data().state;
        const localState = window.app.getState();

        if (!hasConflict(localState, cloudState)) {
          if ((cloudState.lastUpdate || 0) > (localState.lastUpdate || 0)) {
            applying = true;
            window.app.applyRemoteState(cloudState);
            applying = false;
          }
          return;
        }

        showConflictModal(localState, cloudState, choice => {
          if (choice === 'local') {
            forcePush(window.app.getState());
          } else {
            window.app.initWithState(cloudState);
          }
        });
      }).catch(() => {});
    }
  });
})();
