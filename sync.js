// --- Sync via Firebase ---
// - Google sign-in for auth
// - Firestore doc keyed by user email for real-time state sync
// - IndexedDB offline persistence via Firestore
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyB_IwLOF83V4KAwbZCobLNuL9vLfWmh88c",
    authDomain: "focus-timer-92d75.firebaseapp.com",
    projectId: "focus-timer-92d75",
    storageBucket: "focus-timer-92d75.firebasestorage.app",
    messagingSenderId: "7929797079",
    appId: "1:7929797079:web:0d37d445d4214648e25392"
  };

  // Init Firebase
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  let unsubscribe = null;
  let docPath = '';
  let senderId = 'pomo-' + Math.random().toString(36).slice(2, 10);
  let applying = false;

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

  // On every LOCAL state change -> debounced push
  let pushTimeout = null;
  window.app.onStateChange(() => {
    if (applying) return;
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
    docPath = 'sync/' + user.uid;
    setStatus('Connecting...', '');
    setIndicator('connecting');
    $indicator.classList.remove('hidden');

    // Push current state first
    push(window.app.getState());

    // Subscribe to Firestore document
    const docRef = db.doc(docPath);
    unsubscribe = docRef.onSnapshot(snapshot => {
      setStatus('Connected — syncing', 'connected');
      setIndicator('connected');

      if (!snapshot.exists) return;

      const data = snapshot.data();
      if (data._sender === senderId) return;
      if (data.state) {
        applying = true;
        window.app.applyRemoteState(data.state);
        applying = false;
      }
    }, err => {
      setStatus('Sync error: ' + err.message, 'error');
      setIndicator('error');
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

  function hashKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  // Auth state listener — auto-start sync on sign-in
  auth.onAuthStateChanged(user => {
    updateAuthUI();
    if (user) {
      startSync(user);
    } else {
      cleanup();
      docPath = '';
      $indicator.classList.add('hidden');
    }
  });

  // Re-push on wake / network restored
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && docPath && auth.currentUser) {
      push(window.app.getState());
    }
  });
})();
