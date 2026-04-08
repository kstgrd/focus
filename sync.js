// --- Sync via Firebase ---
// Firestore is the single source of truth. IndexedDB for offline/anonymous.
// Writes use transactions (atomic read-merge-write) to prevent stale overwrites.
// onSnapshot provides real-time updates. Conflict modal only on initial sync.
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
  let applying = false;  // true while applying remote state, suppresses push echo
  let ready = false;     // true once initial sync completes, gates outgoing pushes

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

  // Events
  $syncBtn.addEventListener('click', () => {
    $modal.classList.remove('hidden');
    updateAuthUI();
  });
  $closeBtn.addEventListener('click', () => $modal.classList.add('hidden'));
  $backdrop.addEventListener('click', () => $modal.classList.add('hidden'));
  $signInBtn.addEventListener('click', signIn);
  $signOutBtn.addEventListener('click', signOut);

  // --- Debounced push: local state change → transaction write ---
  let pushTimeout = null;
  window.app.onStateChange(() => {
    if (applying || !ready) return;
    clearTimeout(pushTimeout);
    pushTimeout = setTimeout(() => pushState(window.app.getState()), 2000);
  });

  // --- Auth ---
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

  // --- Initial sync (on sign-in / page load) ---
  function startSync(user) {
    cleanup();
    ready = false;
    docPath = 'sync/' + user.uid;
    setStatus('Connecting...', '');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');

    window.app.loadLocal().then(localData => {
      const docRef = db.doc(docPath);

      docRef.get({ source: 'server' }).then(snapshot => {
        resolveInitialSync(localData, snapshot, docRef);
      }).catch(() => {
        docRef.get({ source: 'cache' }).then(snapshot => {
          resolveInitialSync(localData, snapshot, docRef);
          setStatus('Offline — using cached data', 'connected');
        }).catch(() => {
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
      window.app.initWithState(null);
      pushState(window.app.getState());
      subscribe(docRef);
      return;
    }

    if (!cloudState) {
      window.app.initWithState(localData);
      pushState(window.app.getState());
      subscribe(docRef);
      return;
    }

    if (!localData || !hasConflict(localData, cloudState)) {
      window.app.initWithState(cloudState);
      subscribe(docRef);
      return;
    }

    // Real conflict — prompt user
    window.app.initWithState(localData);
    showConflictModal(localData, cloudState, choice => {
      if (choice === 'local') {
        pushState(window.app.getState());
      } else {
        window.app.initWithState(cloudState);
      }
      subscribe(docRef);
    });
  }

  function hasConflict(local, cloud) {
    // Fresh local state is never a conflict
    if (local.completedPomodoros === 0 && local.completedBreaks === 0) return false;
    if (local.date !== cloud.date) return true;
    if (local.completedPomodoros !== cloud.completedPomodoros) return true;
    if (local.isFocus !== cloud.isFocus) return true;
    if (local.isRunning !== cloud.isRunning) return true;
    return false;
  }

  // --- Conflict modal ---
  function stateDescription(s) {
    const phase = s.isFocus ? 'Focus' : 'Break';
    const running = s.isRunning ? 'running' : 'paused';
    const date = s.date || '—';
    const pomos = s.completedPomodoros || 0;
    return date + ' · ' + pomos + ' sessions · ' + phase + ' (' + running + ')';
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

  // --- Real-time listener ---
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

  // --- Write: Firestore transaction (atomic read-merge-write) ---
  // Reads cloud first, merges logs, skips write if cloud is ahead.
  function pushState(stateSnapshot) {
    if (!docPath || !auth.currentUser) return;
    const docRef = db.doc(docPath);

    db.runTransaction(async tx => {
      const snapshot = await tx.get(docRef);
      const cloudState = (snapshot.exists && snapshot.data().state) ? snapshot.data().state : null;

      // Merge logs — always keep the highest count per day
      if (cloudState && cloudState.log) {
        if (!stateSnapshot.log) stateSnapshot.log = {};
        for (const [date, entry] of Object.entries(cloudState.log)) {
          if (!stateSnapshot.log[date]) {
            stateSnapshot.log[date] = entry;
          } else if (entry.completed > stateSnapshot.log[date].completed) {
            stateSnapshot.log[date].completed = entry.completed;
          }
        }
      }

      // If cloud has more progress on the same day, don't overwrite
      if (cloudState &&
          cloudState.date === stateSnapshot.date &&
          cloudState.completedPomodoros > stateSnapshot.completedPomodoros) {
        return cloudState;
      }

      tx.set(docRef, {
        _sender: senderId,
        state: stateSnapshot,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return null;
    }).then(cloudState => {
      if (cloudState) {
        applying = true;
        window.app.applyRemoteState(cloudState);
        applying = false;
      }
    }).catch(() => {});
  }

  // --- Cleanup ---
  function cleanup() {
    clearTimeout(pushTimeout);
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  // --- UI helpers ---
  function setStatus(text, cls) {
    $status.textContent = text;
    $status.className = 'sync-status' + (cls ? ' ' + cls : '');
  }

  function setIndicator(state) {
    $indicator.classList.remove('hidden', 'connected', 'connecting', 'error');
    if (state) $indicator.classList.add(state);
  }

  // --- Auth state listener ---
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

  // --- Wake handler (sync.js owns all visibility change behavior) ---
  // On wake: fetch fresh cloud state before any local timer logic runs.
  // This prevents stale local state from overwriting newer cloud data.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    if (!docPath || !auth.currentUser) {
      // Not signed in — just catch up the local timer
      window.app.onWake();
      return;
    }

    if (!ready) return; // Already syncing

    ready = false;
    clearTimeout(pushTimeout);
    const $spin = document.getElementById('sync-spin');
    $spin.classList.remove('hidden');

    const docRef = db.doc(docPath);
    docRef.get({ source: 'server' }).then(snapshot => {
      $spin.classList.add('hidden');
      if (!snapshot.exists || !snapshot.data().state) {
        ready = true;
        window.app.onWake();
        return;
      }

      // Apply cloud state via full init (rebuilds segments, reconstructs timer)
      applying = true;
      window.app.initWithState(snapshot.data().state);
      applying = false;
      ready = true;

      // Push back in case timer completed during init (transaction prevents stale overwrite)
      pushState(window.app.getState());
    }).catch(() => {
      $spin.classList.add('hidden');
      ready = true;
      window.app.onWake();
    });
  });
})();
