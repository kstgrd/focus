// --- Sync via Firebase ---
// Firebase is the single source of truth when online.
// Every write increments _version; stale devices detect divergence on reconnect.
// Conflict dialog only when both local and cloud changed while disconnected.
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

  // Sync state
  let applying = false;    // true while applying remote state — suppresses dirty marking
  let ready = false;       // true once sync is established — gates outgoing pushes
  let dirty = false;       // true when local state changed since last successful sync
  let knownVersion = 0;    // last cloud _version this device saw

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

  // --- Mark dirty on local changes, schedule push ---
  let pushTimeout = null;
  window.app.onStateChange(() => {
    if (applying) return;
    dirty = true;
    if (!ready) return;
    clearTimeout(pushTimeout);
    pushTimeout = setTimeout(() => {
      if (!ready) return;  // resync may have started — don't push stale state
      pushState(window.app.getState());
    }, 2000);
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
    dirty = false;
    knownVersion = 0;
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
    dirty = false;
    knownVersion = 0;
    docPath = 'sync/' + user.uid;
    setStatus('Connecting...', '');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');

    window.app.loadLocal().then(localData => {
      const docRef = db.doc(docPath);

      docRef.get({ source: 'server' }).then(snapshot => {
        resolveInitialSync(localData, snapshot, docRef, true);
      }).catch(() => {
        docRef.get({ source: 'cache' }).then(snapshot => {
          resolveInitialSync(localData, snapshot, docRef, false);
          setStatus('Offline — using cached data', 'connected');
        }).catch(() => {
          // Both server and cache unavailable — use local
          applying = true;
          window.app.initWithState(localData);
          applying = false;
          if (localData && (localData.completedPomodoros > 0 || localData.isRunning)) {
            dirty = true;
          }
          subscribe(docRef);
          setStatus('Offline — using local data', '');
        });
      });
    });
  }

  function resolveInitialSync(localData, snapshot, docRef, fromServer) {
    const doc = snapshot.exists ? snapshot.data() : null;
    const cloudState = (doc && doc.state) ? doc.state : null;
    const cloudVersion = (doc && doc._version) ? doc._version : 0;

    if (!cloudState && !localData) {
      // First ever use — init with defaults and create cloud doc
      applying = true;
      window.app.initWithState(null);
      applying = false;
      pushState(window.app.getState());
      subscribe(docRef);
      return;
    }

    if (!cloudState) {
      // No cloud doc — init with local data
      applying = true;
      window.app.initWithState(localData);
      applying = false;
      if (fromServer) {
        // Server confirmed no doc exists — safe to create it
        pushState(window.app.getState());
      } else {
        // Cache miss — cloud doc might exist, push when online
        dirty = true;
      }
      subscribe(docRef);
      return;
    }

    if (!localData || !hasConflict(localData, cloudState)) {
      // No conflict — cloud wins
      applying = true;
      window.app.initWithState(cloudState);
      applying = false;
      knownVersion = cloudVersion;
      subscribe(docRef);
      pushIfChanged(cloudState);
      return;
    }

    // Real conflict — prompt user
    applying = true;
    window.app.initWithState(localData);
    applying = false;
    showConflictModal(localData, cloudState, choice => {
      if (choice === 'local') {
        knownVersion = cloudVersion;
        pushState(window.app.getState());
      } else {
        applying = true;
        window.app.initWithState(cloudState);
        applying = false;
        knownVersion = cloudVersion;
        dirty = false;
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
    return false;
  }

  // Push back if state changed from what cloud had (e.g. timer completed during reconstruction)
  function pushIfChanged(cloudState) {
    const current = window.app.getState();
    if (current.completedPomodoros !== cloudState.completedPomodoros ||
        current.isRunning !== cloudState.isRunning ||
        current.isFocus !== cloudState.isFocus) {
      pushState(current);
    }
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
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    ready = true;
    setStatus('Connected — syncing', 'connected');
    setIndicator('connected');

    unsubscribe = docRef.onSnapshot(snapshot => {
      if (!snapshot.exists || !snapshot.data().state) return;
      const data = snapshot.data();
      const cloudVer = data._version || 0;

      if (data._sender === senderId) {
        // Our own write echoed back — just track version
        knownVersion = cloudVer;
        return;
      }

      // Remote update — cancel any pending local push, accept cloud as truth
      clearTimeout(pushTimeout);
      pushTimeout = null;

      applying = true;
      window.app.applyRemoteState(data.state);
      applying = false;

      knownVersion = cloudVer;
      dirty = false;
    }, err => {
      setStatus('Sync error: ' + err.message, 'error');
      setIndicator('error');
    });
  }

  // --- Write: Firestore transaction with version increment ---
  // Reads cloud first. If cloud version is ahead of knownVersion, this device
  // missed updates — abort the write and apply cloud locally instead.
  // This is the ultimate safety net: even if a stale debounce timer fires,
  // the transaction detects the staleness and refuses to overwrite.
  function pushState(stateSnapshot) {
    if (!docPath || !auth.currentUser) return;
    const docRef = db.doc(docPath);

    db.runTransaction(tx => {
      return tx.get(docRef).then(snapshot => {
        const doc = snapshot.exists ? snapshot.data() : null;
        const cloudVersion = (doc && doc._version) ? doc._version : 0;
        const cloudState = (doc && doc.state) ? doc.state : null;

        // Guard: cloud advanced past what we know — this push is stale
        if (cloudVersion > knownVersion && cloudState) {
          return { stale: true, cloudState: cloudState, cloudVersion: cloudVersion };
        }

        // Merge logs — always keep highest count per day
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

        const newVersion = cloudVersion + 1;
        tx.set(docRef, {
          _sender: senderId,
          _version: newVersion,
          state: stateSnapshot,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return { stale: false, newVersion: newVersion };
      });
    }).then(result => {
      if (result.stale) {
        // Cloud was ahead — apply it locally instead of writing
        applying = true;
        window.app.applyRemoteState(result.cloudState);
        applying = false;
        knownVersion = result.cloudVersion;
        dirty = false;
      } else {
        knownVersion = result.newVersion;
        dirty = false;
      }
    }).catch(() => {});
  }

  // --- Resync: fetch cloud on wake/reconnect ---
  // Prevents stale local state from overwriting newer cloud data.
  // Re-subscribes onSnapshot in case it died while sleeping/offline.
  function resync() {
    if (!docPath || !auth.currentUser) {
      window.app.onWake();
      return;
    }

    if (!ready) return; // already syncing

    ready = false;
    clearTimeout(pushTimeout);
    pushTimeout = null;
    const $spin = document.getElementById('sync-spin');
    $spin.classList.remove('hidden');

    const docRef = db.doc(docPath);
    docRef.get({ source: 'server' }).then(snapshot => {
      $spin.classList.add('hidden');

      if (!snapshot.exists || !snapshot.data().state) {
        // No cloud doc — push local if dirty
        subscribe(docRef);
        if (dirty) pushState(window.app.getState());
        else window.app.onWake();
        return;
      }

      const cloudVersion = snapshot.data()._version || 0;
      const cloudState = snapshot.data().state;

      if (cloudVersion === knownVersion) {
        // Cloud unchanged since we last saw it
        subscribe(docRef);
        if (dirty) {
          // We changed while away — safe to push (no conflict)
          pushState(window.app.getState());
        } else {
          // Nothing changed on either side — just catch up timer
          window.app.onWake();
        }
        return;
      }

      // Cloud changed (newer version than what we know)
      if (!dirty) {
        // We didn't change — accept cloud
        applying = true;
        window.app.initWithState(cloudState);
        applying = false;
        knownVersion = cloudVersion;
        subscribe(docRef);
        // Push back if timer completed during reconstruction
        pushIfChanged(cloudState);
        return;
      }

      // CONFLICT: both sides changed while disconnected
      showConflictModal(window.app.getState(), cloudState, choice => {
        if (choice === 'local') {
          knownVersion = cloudVersion;
          pushState(window.app.getState());
        } else {
          applying = true;
          window.app.initWithState(cloudState);
          applying = false;
          knownVersion = cloudVersion;
          dirty = false;
        }
        subscribe(docRef);
      });
    }).catch(() => {
      $spin.classList.add('hidden');

      if (!dirty) {
        // No local changes — try cache for display only
        docRef.get({ source: 'cache' }).then(snapshot => {
          if (snapshot.exists && snapshot.data().state) {
            applying = true;
            window.app.initWithState(snapshot.data().state);
            applying = false;
            // Don't update knownVersion from cache — it may be stale
          }
          subscribe(docRef);
        }).catch(() => {
          ready = true;
          window.app.onWake();
        });
      } else {
        // Has local changes — keep them, just re-subscribe and wait for network
        subscribe(docRef);
        window.app.onWake();
      }
    });
  }

  // --- Cleanup ---
  function cleanup() {
    clearTimeout(pushTimeout);
    pushTimeout = null;
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
      dirty = false;
      knownVersion = 0;
      $indicator.classList.add('hidden');
      window.app.loadLocal().then(data => {
        window.app.initWithState(data);
      });
    }
  });

  // Re-sync on tab wake and network reconnect.
  // Clear pending pushes on hide — prevents frozen timeouts from firing stale writes on wake.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(pushTimeout);
      pushTimeout = null;
    } else {
      resync();
    }
  });
  window.addEventListener('online', resync);
})();
