// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_CODE = readFileSync(resolve(__dirname, 'sync.js'), 'utf8');

// --- Helpers ---

const tick = () => vi.advanceTimersByTimeAsync(0);
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await tick(); };

function state(overrides = {}) {
  return {
    isFocus: true, isRunning: false, startedAt: null,
    remainingAtStart: 1500, completedPomodoros: 0, completedBreaks: 0,
    date: '2026-04-08',
    settings: { goal: 8, focusMin: 25, breakMin: 5, autoFocus: false, autoBreak: false },
    log: {},
    ...overrides
  };
}

function runningTimer(overrides = {}) {
  return state({ isRunning: true, startedAt: Date.now(), remainingAtStart: 1200, ...overrides });
}

function createDOM() {
  document.body.innerHTML = '';
  const ids = [
    'sync-modal', 'sync-btn', 'sync-close', 'sync-status', 'sync-indicator',
    'sync-signin', 'sync-signout', 'sync-desc', 'conflict-modal', 'conflict-local',
    'conflict-cloud', 'conflict-local-detail', 'conflict-cloud-detail', 'sync-spin'
  ];
  for (const id of ids) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  // sync-modal needs .modal-backdrop child
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  document.getElementById('sync-modal').appendChild(backdrop);
  // Start hidden
  document.getElementById('conflict-modal').classList.add('hidden');
  document.getElementById('sync-spin').classList.add('hidden');
  document.getElementById('sync-indicator').classList.add('hidden');
}

// --- Test environment factory ---

function setup() {
  createDOM();

  let stateChangeCbs = [];
  let appState = state();
  let authCb = null;
  let snapshotCb = null;
  let cloudDoc = null;
  const txWrites = [];

  // window.app (normally set up by app.js)
  window.app = {
    onStateChange: vi.fn(cb => stateChangeCbs.push(cb)),
    getState: vi.fn(() => JSON.parse(JSON.stringify(appState))),
    applyRemoteState: vi.fn(),
    initWithState: vi.fn(),
    onWake: vi.fn(),
    loadLocal: vi.fn(() => Promise.resolve(null)),
    showToast: vi.fn()
  };

  // Firebase mocks
  const mockTx = {
    get: vi.fn(() => Promise.resolve({
      exists: !!cloudDoc,
      data: () => cloudDoc ? JSON.parse(JSON.stringify(cloudDoc)) : null
    })),
    set: vi.fn((_, data) => txWrites.push(data))
  };

  const mockDocRef = {
    get: vi.fn(() => Promise.resolve({
      exists: !!cloudDoc,
      data: () => cloudDoc ? JSON.parse(JSON.stringify(cloudDoc)) : null
    })),
    onSnapshot: vi.fn((cb, _err) => { snapshotCb = cb; return vi.fn(); })
  };

  const mockDb = {
    enablePersistence: vi.fn(() => Promise.resolve()),
    doc: vi.fn(() => mockDocRef),
    runTransaction: vi.fn(async fn => fn(mockTx))
  };

  const mockAuth = {
    onAuthStateChanged: vi.fn(cb => { authCb = cb; }),
    currentUser: null,
    signOut: vi.fn(() => Promise.resolve())
  };

  window.firebase = {
    initializeApp: vi.fn(),
    auth: Object.assign(vi.fn(() => mockAuth), { GoogleAuthProvider: vi.fn() }),
    firestore: Object.assign(vi.fn(() => mockDb), {
      FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TS') }
    })
  };

  // Execute sync.js IIFE
  eval(SYNC_CODE);

  const env = {
    app: window.app,
    auth: mockAuth,
    db: mockDb,
    docRef: mockDocRef,
    tx: mockTx,
    writes() { return txWrites; },

    setCloud(doc) { cloudDoc = doc; },
    setState(s) { appState = s; },

    signIn(uid = 'u1') {
      mockAuth.currentUser = { uid, displayName: 'Test', email: 't@t.com' };
      authCb({ uid });
    },

    snapshot(data) {
      if (snapshotCb) snapshotCb({ exists: !!data, data: () => data });
    },

    fireStateChange() {
      stateChangeCbs.forEach(cb => cb(appState));
    },

    setVisibility(value) {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    },

    clearMocks() {
      txWrites.length = 0;
      mockTx.set.mockClear();
      mockTx.get.mockClear();
      mockDb.runTransaction.mockClear();
      mockDocRef.get.mockClear();
      window.app.applyRemoteState.mockClear();
      window.app.initWithState.mockClear();
      window.app.onWake.mockClear();
    }
  };

  return env;
}

/** Sign in and complete initial sync at given version. Clears mocks after. */
async function synced(env, version = 1, cloudState = state()) {
  env.setCloud({ _version: version, state: cloudState });
  env.setState(cloudState); // match local to cloud so pushIfChanged is a no-op
  env.signIn();
  await flush();
  env.clearMocks();
}

// =============================================================================
// Tests
// =============================================================================

describe('sync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete window.firebase;
    delete window.app;
  });

  // ---------------------------------------------------------------------------
  // pushState version guard (the main safety net)
  // ---------------------------------------------------------------------------
  describe('pushState version guard', () => {
    it('blocks write when cloud version is ahead of known version', async () => {
      const env = setup();
      await synced(env, 3);

      // Cloud advanced to v7 while device was out of sync
      env.setCloud({ _version: 7, state: runningTimer() });

      // Local change triggers debounced push
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      // Transaction ran but did NOT write — version guard blocked it
      expect(env.db.runTransaction).toHaveBeenCalled();
      expect(env.tx.set).not.toHaveBeenCalled();
    });

    it('applies cloud state locally when stale push is blocked', async () => {
      const env = setup();
      await synced(env, 3);

      const cloud = runningTimer({ completedPomodoros: 2 });
      env.setCloud({ _version: 7, state: cloud });

      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.app.applyRemoteState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true, completedPomodoros: 2 })
      );
    });

    it('allows write when cloud version matches known version', async () => {
      const env = setup();
      await synced(env, 3);

      // Cloud still at v3 — same as knownVersion
      env.setCloud({ _version: 3, state: state() });

      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).toHaveBeenCalled();
      const written = env.writes().pop();
      expect(written._version).toBe(4);
    });

    it('merges logs during write', async () => {
      const env = setup();
      await synced(env, 1);

      // Cloud has a log entry the local doesn't
      env.setCloud({
        _version: 1,
        state: state({ log: { '2026-04-07': { completed: 5, goal: 8 } } })
      });

      // Local also has a log entry
      env.setState(state({ log: { '2026-04-08': { completed: 3, goal: 8 } } }));
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).toHaveBeenCalled();
      const written = env.writes().pop();
      expect(written.state.log['2026-04-07'].completed).toBe(5); // from cloud
      expect(written.state.log['2026-04-08'].completed).toBe(3); // from local
    });
  });

  // ---------------------------------------------------------------------------
  // Dirty flag
  // ---------------------------------------------------------------------------
  describe('dirty flag', () => {
    it('is not set during remote state application (no echo push)', async () => {
      const env = setup();
      await synced(env, 1);

      // Remote update via onSnapshot
      env.snapshot({ _sender: 'device-b', _version: 2, state: runningTimer() });

      // Wait well past debounce — should NOT trigger a push
      await vi.advanceTimersByTimeAsync(5000);
      await flush();

      expect(env.db.runTransaction).not.toHaveBeenCalled();
    });

    it('is set on local state change and triggers debounced push', async () => {
      const env = setup();
      await synced(env, 1);

      env.setCloud({ _version: 1, state: state() });
      env.fireStateChange();

      // Push should NOT happen before 2s
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(env.db.runTransaction).not.toHaveBeenCalled();

      // Push happens at 2s
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(env.db.runTransaction).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Visibility change — kill stale timeouts
  // ---------------------------------------------------------------------------
  describe('visibility change', () => {
    it('clears pending push timeout when page goes to background', async () => {
      const env = setup();
      await synced(env, 1);

      env.setCloud({ _version: 1, state: state() });
      env.fireStateChange(); // schedules push in 2s

      // Lock screen / go to background before push fires
      env.setVisibility('hidden');

      // Advance well past debounce
      await vi.advanceTimersByTimeAsync(5000);
      await flush();

      // Push should NOT have fired — timeout was cleared
      expect(env.db.runTransaction).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // onSnapshot
  // ---------------------------------------------------------------------------
  describe('onSnapshot', () => {
    it('cancels pending push and applies remote state', async () => {
      const env = setup();
      await synced(env, 1);

      // Local change → push scheduled
      env.fireStateChange();

      // Before 2s, remote update arrives
      env.snapshot({ _sender: 'device-b', _version: 2, state: runningTimer() });

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(3000);
      await flush();

      // Push was cancelled — transaction never ran
      expect(env.db.runTransaction).not.toHaveBeenCalled();

      // Remote state was applied
      expect(env.app.applyRemoteState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Resync (wake / reconnect)
  // ---------------------------------------------------------------------------
  describe('resync', () => {
    it('accepts cloud when local is clean and cloud changed', async () => {
      const env = setup();
      await synced(env, 3);

      // Cloud advanced while device slept
      env.setCloud({ _version: 5, state: runningTimer({ completedPomodoros: 2 }) });

      env.setVisibility('hidden');
      env.setVisibility('visible');
      await flush();

      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true, completedPomodoros: 2 })
      );
    });

    it('pushes local when cloud is unchanged and local is dirty', async () => {
      const env = setup();
      await synced(env, 3);

      // Cloud still at v3
      env.setCloud({ _version: 3, state: state() });

      // User made local changes
      env.fireStateChange(); // dirty = true

      // Go to background (kills timeout), come back (triggers resync)
      env.setVisibility('hidden');
      env.setVisibility('visible');
      await flush();

      // Should push local changes
      expect(env.db.runTransaction).toHaveBeenCalled();
      expect(env.tx.set).toHaveBeenCalled();
    });

    it('shows conflict dialog when both sides changed', async () => {
      const env = setup();
      await synced(env, 3);

      // User made local changes
      env.fireStateChange(); // dirty = true

      // Cloud also advanced
      env.setCloud({ _version: 5, state: runningTimer() });

      env.setVisibility('hidden');
      env.setVisibility('visible');
      await flush();

      const modal = document.getElementById('conflict-modal');
      expect(modal.classList.contains('hidden')).toBe(false);
    });

    it('calls onWake when nothing changed on either side', async () => {
      const env = setup();
      await synced(env, 3);

      // Cloud unchanged
      env.setCloud({ _version: 3, state: state() });

      env.setVisibility('hidden');
      env.setVisibility('visible');
      await flush();

      expect(env.db.runTransaction).not.toHaveBeenCalled();
      expect(env.app.onWake).toHaveBeenCalled();
    });

    it('uses cache when server is unreachable and local is clean', async () => {
      const env = setup();
      await synced(env, 3);

      // Server will fail, cache returns data
      const cached = runningTimer();
      env.docRef.get
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ exists: true, data: () => ({ _version: 4, state: cached }) });

      env.setVisibility('hidden');
      env.setVisibility('visible');
      await flush();

      // Should apply cache for display
      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true })
      );
      // Should NOT push (cache might be stale)
      expect(env.tx.set).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Initial sync
  // ---------------------------------------------------------------------------
  describe('initial sync', () => {
    it('does not force-push when cloud state comes from cache', async () => {
      const env = setup();

      // Server unreachable, cache also empty
      env.docRef.get
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ exists: false, data: () => null });

      env.app.loadLocal.mockResolvedValue(state({ completedPomodoros: 3 }));
      env.signIn();
      await flush();

      // Should init with local data
      expect(env.app.initWithState).toHaveBeenCalled();
      // Should NOT push (cache miss — cloud doc might exist)
      expect(env.tx.set).not.toHaveBeenCalled();
    });

    it('pushes local when server confirms no cloud doc exists', async () => {
      const env = setup();
      env.setCloud(null);
      env.app.loadLocal.mockResolvedValue(state({ completedPomodoros: 3 }));
      env.signIn();
      await flush();

      expect(env.app.initWithState).toHaveBeenCalled();
      expect(env.db.runTransaction).toHaveBeenCalled();
    });

    it('applies cloud state when no conflict with local', async () => {
      const env = setup();
      const cloud = runningTimer({ completedPomodoros: 4 });
      env.setCloud({ _version: 5, state: cloud });
      env.app.loadLocal.mockResolvedValue(state()); // fresh local
      env.signIn();
      await flush();

      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 4, isRunning: true })
      );
      // No conflict dialog
      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Conflict detection
  // ---------------------------------------------------------------------------
  describe('conflict detection', () => {
    it('fresh local (0 pomodoros) is never a conflict', async () => {
      const env = setup();
      env.setCloud({ _version: 1, state: runningTimer({ completedPomodoros: 5 }) });
      env.app.loadLocal.mockResolvedValue(state({ completedPomodoros: 0 }));
      env.signIn();
      await flush();

      // Cloud should be applied directly — no conflict dialog
      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 5 })
      );
      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(true);
    });

    it('different completedPomodoros with progress is a conflict', async () => {
      const env = setup();
      env.setCloud({ _version: 1, state: state({ completedPomodoros: 3 }) });
      env.app.loadLocal.mockResolvedValue(state({ completedPomodoros: 5 }));
      env.signIn();
      await flush();

      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(false);
    });

    it('different dates is a conflict', async () => {
      const env = setup();
      env.setCloud({ _version: 1, state: state({ date: '2026-04-07', completedPomodoros: 2 }) });
      env.app.loadLocal.mockResolvedValue(state({ date: '2026-04-08', completedPomodoros: 2 }));
      env.signIn();
      await flush();

      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(false);
    });
  });

  // ===========================================================================
  // Multi-peer scenarios
  // ===========================================================================
  describe('multi-peer scenarios', () => {

    // -------------------------------------------------------------------------
    // The original bug that caused data loss
    // -------------------------------------------------------------------------
    it('the original bug: stale phone push is blocked after desktop starts timer', async () => {
      // Phone syncs at v1 (stopped timer, 25min, 0 pomodoros)
      const env = setup();
      await synced(env, 1, state());

      // Phone user pauses or interacts → state change → push scheduled (2s)
      env.fireStateChange();

      // Phone goes to background immediately — timeout cleared by visibility handler
      env.setVisibility('hidden');

      // Desktop starts a 25-min timer → pushes v2 to Firebase
      // Phone's onSnapshot listener is dead (sleeping), so phone never receives v2
      env.setCloud({ _version: 2, state: runningTimer({ remainingAtStart: 1200 }) });

      // Phone wakes up — resync fires
      env.setVisibility('visible');
      await flush();

      // Phone's stale stopped-timer state must NOT reach Firebase
      // Check: any tx.set that happened should NOT contain the stale stopped state
      const staleWrites = env.writes().filter(w => w.state && w.state.isRunning === false);
      expect(staleWrites).toHaveLength(0);
    });

    it('the original bug: even if stale push fires, version guard blocks it', async () => {
      // This tests the safety net: if somehow a stale push reaches the transaction
      const env = setup();
      await synced(env, 1, state());

      // Desktop pushed v2 with running timer (phone missed the snapshot)
      env.setCloud({ _version: 2, state: runningTimer() });

      // Force a state change and let debounce fire (simulates frozen timeout edge case)
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      // Version guard: cloud v2 > knownVersion v1 → write blocked
      expect(env.tx.set).not.toHaveBeenCalled();
      // Cloud state applied locally — phone now shows the running timer
      expect(env.app.applyRemoteState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true })
      );
    });

    // -------------------------------------------------------------------------
    // Sequential updates from multiple devices
    // -------------------------------------------------------------------------
    it('snapshots from 3 different devices: version tracks to the latest', async () => {
      const env = setup();
      await synced(env, 1, state());

      // Device B starts timer → v2
      env.snapshot({ _sender: 'B', _version: 2, state: runningTimer() });
      // Device C completes first pomodoro → v3
      env.snapshot({ _sender: 'C', _version: 3, state: state({ completedPomodoros: 1 }) });
      // Device D starts break → v4
      env.snapshot({ _sender: 'D', _version: 4, state: state({ isFocus: false, completedPomodoros: 1 }) });

      // Now local push should write at v5
      env.setCloud({ _version: 4, state: state({ isFocus: false, completedPomodoros: 1 }) });
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).toHaveBeenCalled();
      const written = env.writes().pop();
      expect(written._version).toBe(5);
    });

    it('3 snapshots in sequence: each applied, no spurious pushes', async () => {
      const env = setup();
      await synced(env, 1, state());

      env.snapshot({ _sender: 'B', _version: 2, state: runningTimer() });
      env.snapshot({ _sender: 'C', _version: 3, state: state({ completedPomodoros: 1 }) });
      env.snapshot({ _sender: 'D', _version: 4, state: state({ completedPomodoros: 2 }) });

      // Wait — no push should happen (all changes are remote)
      await vi.advanceTimersByTimeAsync(5000);
      await flush();

      expect(env.db.runTransaction).not.toHaveBeenCalled();
      // All 3 remote states were applied in order
      expect(env.app.applyRemoteState).toHaveBeenCalledTimes(3);
      const lastCall = env.app.applyRemoteState.mock.calls[2][0];
      expect(lastCall.completedPomodoros).toBe(2);
    });

    // -------------------------------------------------------------------------
    // Concurrent push races
    // -------------------------------------------------------------------------
    it('concurrent push: other device writes between local change and push firing', async () => {
      const env = setup();
      await synced(env, 5, state({ completedPomodoros: 2 }));

      // Cloud matches what we know (v5)
      env.setCloud({ _version: 5, state: state({ completedPomodoros: 2 }) });

      // Local change → push scheduled for 2s
      env.fireStateChange();

      // At ~1s, another device pushes v6 (we don't receive snapshot — listener lag)
      await vi.advanceTimersByTimeAsync(1000);
      env.setCloud({ _version: 6, state: state({ completedPomodoros: 3 }) });

      // At 2s, our push fires → tx.get reads v6 > knownVersion(5) → blocked!
      await vi.advanceTimersByTimeAsync(1000);
      await flush();

      expect(env.tx.set).not.toHaveBeenCalled();
      expect(env.app.applyRemoteState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 3 })
      );
    });

    it('concurrent push from 2 peers: only the first write succeeds', async () => {
      // Simulates: A and B both at v5, both make changes
      // A's push fires first → writes v6
      // B's push fires second → tx.get sees v6 > knownVersion(5) → blocked
      // We test from B's perspective
      const env = setup();
      await synced(env, 5);

      // Both A and B make changes. A pushes first → cloud now v6
      env.setCloud({ _version: 6, state: runningTimer({ completedPomodoros: 1 }) });

      // B (us) tries to push
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      // B's write blocked
      expect(env.tx.set).not.toHaveBeenCalled();
      // B gets A's state
      expect(env.app.applyRemoteState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true, completedPomodoros: 1 })
      );
    });

    // -------------------------------------------------------------------------
    // Recovery after blocked push
    // -------------------------------------------------------------------------
    it('after stale push is blocked, next legitimate push succeeds', async () => {
      const env = setup();
      await synced(env, 3);

      // Cloud advances to v7 (missed updates)
      env.setCloud({ _version: 7, state: runningTimer({ completedPomodoros: 2 }) });

      // Stale push fires → blocked, cloud applied, knownVersion updated to 7
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).not.toHaveBeenCalled();
      env.clearMocks();

      // Cloud still at v7 (no one else wrote)
      env.setCloud({ _version: 7, state: runningTimer({ completedPomodoros: 2 }) });

      // New legitimate local change → push should succeed at v8
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).toHaveBeenCalled();
      expect(env.writes().pop()._version).toBe(8);
    });

    it('two consecutive blocked pushes, then successful push', async () => {
      const env = setup();
      await synced(env, 1);

      // First blocked push: cloud at v3
      env.setCloud({ _version: 3, state: state({ completedPomodoros: 1 }) });
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(env.tx.set).not.toHaveBeenCalled();
      env.clearMocks();

      // Second blocked push: cloud advanced to v5
      env.setCloud({ _version: 5, state: state({ completedPomodoros: 2 }) });
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(env.tx.set).not.toHaveBeenCalled();
      env.clearMocks();

      // Now cloud stable at v5, our push goes through at v6
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(env.tx.set).toHaveBeenCalled();
      expect(env.writes().pop()._version).toBe(6);
    });

    // -------------------------------------------------------------------------
    // Background / wake lifecycle with other peers
    // -------------------------------------------------------------------------
    it('background with pending change, peer writes, wake triggers conflict', async () => {
      const env = setup();
      await synced(env, 3, state({ completedPomodoros: 2 }));

      // User changes state (e.g. pauses timer)
      env.setState(state({ completedPomodoros: 2, isRunning: false }));
      env.fireStateChange(); // dirty = true

      // Phone goes to background — timeout killed but dirty stays true
      env.setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(5000);
      expect(env.db.runTransaction).not.toHaveBeenCalled();

      // Meanwhile, another device completes a session and pushes v5
      env.setCloud({ _version: 5, state: state({ completedPomodoros: 3 }) });

      // Phone wakes → resync: dirty=true + cloud v5 > knownVersion v3 → CONFLICT
      env.setVisibility('visible');
      await flush();

      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(false);
    });

    it('background clean, peer writes multiple times, wake accepts latest', async () => {
      const env = setup();
      await synced(env, 2);

      // No local changes — go to background
      env.setVisibility('hidden');

      // Other devices push v3, v4, v5, v6 while we sleep
      // We only see the final state on wake
      env.setCloud({ _version: 6, state: state({ completedPomodoros: 4, isFocus: false }) });

      env.setVisibility('visible');
      await flush();

      // Should silently accept cloud — no conflict (local clean)
      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(true);
      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 4, isFocus: false })
      );
    });

    // -------------------------------------------------------------------------
    // Snapshot interleaved with local changes
    // -------------------------------------------------------------------------
    it('snapshot cancels pending push, new local change re-schedules and succeeds', async () => {
      const env = setup();
      await synced(env, 1);

      // Round 1: local change → push scheduled
      env.setCloud({ _version: 1, state: state() });
      env.fireStateChange();

      // Snapshot from peer arrives at 1s → cancels our push
      await vi.advanceTimersByTimeAsync(1000);
      env.snapshot({ _sender: 'B', _version: 2, state: state({ completedPomodoros: 1 }) });

      // Our cancelled push should not fire
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(env.db.runTransaction).not.toHaveBeenCalled();
      env.clearMocks();

      // Round 2: new local change after accepting B's state
      env.setCloud({ _version: 2, state: state({ completedPomodoros: 1 }) });
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      // This time push succeeds at v3
      expect(env.tx.set).toHaveBeenCalled();
      expect(env.writes().pop()._version).toBe(3);
    });

    it('3 interleaved: change → snapshot → change → snapshot → change → push', async () => {
      const env = setup();
      await synced(env, 1);

      // Change 1
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(500);

      // Snapshot 1 from B (v2) — cancels pending push
      env.snapshot({ _sender: 'B', _version: 2, state: state({ completedPomodoros: 1 }) });

      // Change 2
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(500);

      // Snapshot 2 from C (v3) — cancels pending push again
      env.snapshot({ _sender: 'C', _version: 3, state: state({ completedPomodoros: 2 }) });

      // Change 3
      env.setCloud({ _version: 3, state: state({ completedPomodoros: 2 }) });
      env.fireStateChange();

      // This time no more snapshots — push fires at 2s
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).toHaveBeenCalled();
      expect(env.writes().pop()._version).toBe(4);
    });

    // -------------------------------------------------------------------------
    // Rapid-fire state changes (debounce coalescing)
    // -------------------------------------------------------------------------
    it('5 rapid local changes within 2s result in exactly 1 push', async () => {
      const env = setup();
      await synced(env, 1);

      env.setCloud({ _version: 1, state: state() });

      // 5 changes in rapid succession — each resets the 2s timer
      for (let i = 0; i < 5; i++) {
        env.fireStateChange();
        await vi.advanceTimersByTimeAsync(300);
      }

      // Only 1.5s since last change — no push yet
      await flush();
      expect(env.db.runTransaction).not.toHaveBeenCalled();

      // Advance remaining time for debounce
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      // Exactly 1 push
      expect(env.db.runTransaction).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // Log merging across peers
    // -------------------------------------------------------------------------
    it('logs from 3 devices merge correctly through snapshots and pushes', async () => {
      const env = setup();
      // Start with device A's log
      await synced(env, 1, state({ log: { '2026-04-06': { completed: 3, goal: 8 } } }));

      // Device B sends snapshot with B's log
      env.snapshot({
        _sender: 'B', _version: 2,
        state: state({ log: {
          '2026-04-06': { completed: 3, goal: 8 },
          '2026-04-07': { completed: 6, goal: 8 }
        }})
      });

      // Now local device pushes with its own log entry for today
      // Cloud includes logs from A and B
      env.setCloud({
        _version: 2,
        state: state({ log: {
          '2026-04-06': { completed: 3, goal: 8 },
          '2026-04-07': { completed: 6, goal: 8 }
        }})
      });
      env.setState(state({ log: { '2026-04-08': { completed: 2, goal: 8 } } }));
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(env.tx.set).toHaveBeenCalled();
      const written = env.writes().pop();
      // All 3 days present
      expect(written.state.log['2026-04-06'].completed).toBe(3);
      expect(written.state.log['2026-04-07'].completed).toBe(6);
      expect(written.state.log['2026-04-08'].completed).toBe(2);
    });

    it('log merge keeps higher count when devices have different values', async () => {
      const env = setup();
      await synced(env, 1);

      // Cloud has 5 sessions for today, local has 3
      env.setCloud({
        _version: 1,
        state: state({ log: { '2026-04-08': { completed: 5, goal: 8 } } })
      });
      env.setState(state({ log: { '2026-04-08': { completed: 3, goal: 8 } } }));
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      const written = env.writes().pop();
      expect(written.state.log['2026-04-08'].completed).toBe(5); // higher count wins
    });

    // -------------------------------------------------------------------------
    // Resync edge cases with multiple peers
    // -------------------------------------------------------------------------
    it('double wake: second resync is rejected while first is in progress', async () => {
      const env = setup();
      await synced(env, 3);

      // Make first docRef.get return a pending Promise (slow server)
      let resolveGet;
      env.docRef.get.mockReturnValueOnce(new Promise(r => { resolveGet = r; }));

      // First wake → resync starts, waiting on server
      env.setVisibility('hidden');
      env.setVisibility('visible');

      // Second wake while first is still in-flight → rejected by !ready guard
      env.setVisibility('hidden');
      env.setVisibility('visible');

      // Only one server fetch was made
      expect(env.docRef.get).toHaveBeenCalledTimes(1);

      // Resolve the pending get → first resync completes
      resolveGet({
        exists: true,
        data: () => ({ _version: 5, state: runningTimer() })
      });
      await flush();

      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ isRunning: true })
      );
    });

    it('resync while server is down, then online event triggers successful resync', async () => {
      const env = setup();
      await synced(env, 3);

      // First wake: server unreachable
      env.docRef.get
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ exists: false, data: () => null });

      env.setVisibility('hidden');
      env.setVisibility('visible');
      await flush();

      // Should not crash, should recover
      env.clearMocks();

      // Now network comes back with cloud at v5
      env.setCloud({ _version: 5, state: runningTimer({ completedPomodoros: 2 }) });

      // online event triggers resync
      window.dispatchEvent(new Event('online'));
      await flush();

      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 2, isRunning: true })
      );
    });

    // -------------------------------------------------------------------------
    // End-to-end multi-step sequences
    // -------------------------------------------------------------------------
    it('full session: start → sync → sleep → peer writes → wake → accept → work → push', async () => {
      const env = setup();

      // Step 1: Initial sync at v1
      await synced(env, 1, state());

      // Step 2: Receive snapshot from peer B who started timer
      env.snapshot({ _sender: 'B', _version: 2, state: runningTimer() });
      expect(env.app.applyRemoteState).toHaveBeenCalledTimes(1);
      env.clearMocks();

      // Step 3: Go to sleep
      env.setVisibility('hidden');

      // Step 4: Peer B completes a pomodoro while we sleep → v3
      env.setCloud({ _version: 3, state: state({ completedPomodoros: 1 }) });

      // Step 5: Wake up → resync, local is clean → accept cloud
      env.setVisibility('visible');
      await flush();

      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 1 })
      );
      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(true);
      env.clearMocks();

      // Step 6: Now we start a new focus session → local change → push
      env.setState(state({ completedPomodoros: 1, isRunning: true, startedAt: Date.now() }));
      env.setCloud({ _version: 3, state: state({ completedPomodoros: 1 }) });
      env.fireStateChange();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      // Push succeeds at v4
      expect(env.tx.set).toHaveBeenCalled();
      expect(env.writes().pop()._version).toBe(4);
    });

    it('full session: 3-device day with conflict resolution', async () => {
      const env = setup();

      // Step 1: All 3 devices start at v1
      await synced(env, 1, state());

      // Step 2: Device B pushes timer start → v2 (we get snapshot)
      env.snapshot({ _sender: 'B', _version: 2, state: runningTimer() });
      env.clearMocks();

      // Step 3: Device C completes the pomodoro → v3 (we get snapshot)
      env.snapshot({
        _sender: 'C', _version: 3,
        state: state({ completedPomodoros: 1, isFocus: false })
      });
      env.clearMocks();

      // Step 4: We go offline and start a new focus session
      env.setState(state({ completedPomodoros: 1, isRunning: true }));
      env.fireStateChange(); // dirty = true
      env.setVisibility('hidden');

      // Step 5: While we're offline, device B does another pomodoro → v5
      env.setCloud({
        _version: 5,
        state: state({ completedPomodoros: 2, isFocus: false })
      });

      // Step 6: We wake → dirty + cloud v5 > knownVersion v3 → CONFLICT
      env.setVisibility('visible');
      await flush();

      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(false);

      // Step 7: User picks cloud
      document.getElementById('conflict-cloud').click();
      await flush();

      // Conflict resolved — cloud applied
      expect(env.app.initWithState).toHaveBeenCalledWith(
        expect.objectContaining({ completedPomodoros: 2 })
      );
      expect(document.getElementById('conflict-modal').classList.contains('hidden')).toBe(true);
    });
  });
});
