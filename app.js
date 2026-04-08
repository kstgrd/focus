// --- Constants ---
const DEFAULT_FOCUS = 25;
const DEFAULT_BREAK = 5;

// --- Settings ---
let settings = { goal: 8, focusMin: DEFAULT_FOCUS, breakMin: DEFAULT_BREAK, autoFocus: false, autoBreak: false };
const ROW_SIZE = 24;
let builtFocusSlots = 0;

// --- Daily log: { "2026-04-07": { completed: 5, goal: 8 }, ... } ---
let log = {};

// --- State ---
let timerInterval = null;
let completionTimeout = null;
let stateChangeCallbacks = [];

let state = {
  isFocus: true,
  isRunning: false,
  startedAt: null,
  remainingAtStart: DEFAULT_FOCUS * 60,
  completedPomodoros: 0,
  completedBreaks: 0,
  date: todayStr()
};

// --- DOM ---
const $time = document.getElementById('time');
const $phase = document.getElementById('phase');
const $startBtn = document.getElementById('start-btn');
const $startLabel = document.getElementById('start-label');
const $controlsDefault = document.getElementById('controls-default');
const $controlsConfirm = document.getElementById('controls-confirm');
const $confirmQuestion = document.getElementById('confirm-question');
const $confirmYes = document.getElementById('confirm-yes');
const $confirmNo = document.getElementById('confirm-no');
const $restartBtn = document.getElementById('restart-btn');
const $skipBtn = document.getElementById('skip-btn');
const $progressBar = document.getElementById('progress-bar');
const $progressLabel = document.getElementById('progress-label');
const $progressTime = document.getElementById('progress-time');
const $playIcon = $startBtn.querySelector('.play-icon');
const $pauseIcon = $startBtn.querySelector('.pause-icon');

// Settings modal
const $settingsBtn = document.getElementById('settings-btn');
const $settingsModal = document.getElementById('settings-modal');
const $goalInput = document.getElementById('goal-input');
const $focusInput = document.getElementById('focus-input');
const $breakInput = document.getElementById('break-input');
const $goalNum = document.getElementById('goal-num');
const $focusNum = document.getElementById('focus-num');
const $breakNum = document.getElementById('break-num');
const $autoFocusInput = document.getElementById('auto-focus-input');
const $autoBreakInput = document.getElementById('auto-break-input');
const $settingsSave = document.getElementById('settings-save');
const $settingsClose = document.getElementById('settings-close');
const $settingsBackdrop = $settingsModal.querySelector('.modal-backdrop');

// --- Sync API (used by sync.js) ---
window.app = {
  onStateChange: function(cb) { stateChangeCallbacks.push(cb); },
  applyRemoteState: applyRemoteState,
  showToast: showToast,
  getState: function() { return { ...state, settings: { ...settings }, log: { ...log } }; },
  getLog: function() { return log; },
  loadLocal: function() { return localDB.load(); },
  // Called by sync.js once Firebase state is loaded (or defaults if first-ever sync)
  initWithState: function(remoteState) {
    if (remoteState) {
      doApplyRemoteState(remoteState);
      if (remoteState.settings) {
        const s = remoteState.settings;
        if (s.goal >= 1 && s.goal <= 20) settings.goal = s.goal;
        if (s.focusMin >= 1 && s.focusMin <= 120) settings.focusMin = s.focusMin;
        if (s.breakMin >= 1 && s.breakMin <= 30) settings.breakMin = s.breakMin;
        if (typeof s.autoFocus === 'boolean') settings.autoFocus = s.autoFocus;
        if (typeof s.autoBreak === 'boolean') settings.autoBreak = s.autoBreak;

      }
      if (remoteState.log) mergeLog(remoteState.log);
    }
    buildSegments();
    reconstructTimer();
    updateUI();
    saveLocal();
    document.documentElement.style.visibility = '';
  }
};

// --- Init (minimal — full init happens in initWithState) ---
registerSW();

// --- Events ---
window.addEventListener('resize', positionGoalMarker);

$startBtn.addEventListener('click', () => {
  if (state.isRunning) pauseTimer();
  else startTimer();
});

let pendingAction = null;

$restartBtn.addEventListener('click', () => showConfirm('Restart current timer?', restartTimer));
$skipBtn.addEventListener('click', () => showConfirm('Skip to next phase?', skipPhase));
$confirmYes.addEventListener('click', () => { const action = pendingAction; hideConfirm(); if (action) action(); });
$confirmNo.addEventListener('click', hideConfirm);

function showConfirm(question, action) {
  pendingAction = action;
  $confirmQuestion.textContent = question;
  $controlsDefault.classList.add('hidden');
  $controlsConfirm.classList.remove('hidden');
}

function hideConfirm() {
  pendingAction = null;
  $controlsConfirm.classList.add('hidden');
  $controlsDefault.classList.remove('hidden');
}

function getMaxGoal() {
  const f = parseInt($focusInput.value, 10) || 1;
  const b = parseInt($breakInput.value, 10) || 1;
  return Math.max(1, Math.floor(24 * 60 / (f + b)));
}

function updateSettingsUI(source) {
  // Sync slider ↔ number input
  if (source !== 'num') {
    $focusNum.value = $focusInput.value;
    $breakNum.value = $breakInput.value;
    $goalNum.value = $goalInput.value;
  }
  const max = getMaxGoal();
  $goalInput.max = max;
  $goalNum.max = max;
  if (parseInt($goalInput.value, 10) > max) {
    $goalInput.value = max;
    $goalNum.value = max;
  }
  if (parseInt($goalNum.value, 10) > max) {
    $goalNum.value = max;
    $goalInput.value = max;
  }
}

function syncFromSlider() { updateSettingsUI('slider'); }
function syncFromNum() {
  // Clamp and copy number → slider
  $focusInput.value = $focusNum.value = clamp($focusNum.value, 1, 120);
  $breakInput.value = $breakNum.value = clamp($breakNum.value, 1, 30);
  const max = getMaxGoal();
  $goalInput.value = $goalNum.value = clamp($goalNum.value, 1, max);
  updateSettingsUI('num');
}

function clamp(val, min, max) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

$focusInput.addEventListener('input', syncFromSlider);
$breakInput.addEventListener('input', syncFromSlider);
$goalInput.addEventListener('input', syncFromSlider);
$focusNum.addEventListener('input', syncFromNum);
$breakNum.addEventListener('input', syncFromNum);
$goalNum.addEventListener('input', syncFromNum);

$settingsBtn.addEventListener('click', () => {
  $focusInput.value = $focusNum.value = settings.focusMin;
  $breakInput.value = $breakNum.value = settings.breakMin;
  $goalInput.value = $goalNum.value = settings.goal;
  $autoFocusInput.checked = settings.autoFocus;
  $autoBreakInput.checked = settings.autoBreak;
  updateSettingsUI();
  $settingsModal.classList.remove('hidden');
});
$settingsClose.addEventListener('click', () => $settingsModal.classList.add('hidden'));
$settingsBackdrop.addEventListener('click', () => $settingsModal.classList.add('hidden'));
document.getElementById('reset-day-btn').addEventListener('click', () => showConfirm('Reset today\'s progress?', resetDay));

function resetDay() {
  stopTicking();
  state.isFocus = true;
  state.isRunning = false;
  state.startedAt = null;
  state.remainingAtStart = settings.focusMin * 60;
  state.completedPomodoros = 0;
  state.completedBreaks = 0;

  updateLogEntry();
  buildSegments();
  broadcastState();
}

$settingsSave.addEventListener('click', () => {
  const goal = parseInt($goalInput.value, 10);
  const focus = parseInt($focusInput.value, 10);
  const brk = parseInt($breakInput.value, 10);

  if (focus >= 1 && focus <= 120) settings.focusMin = focus;
  if (brk >= 1 && brk <= 30) settings.breakMin = brk;
  const max = getMaxGoal();
  settings.goal = Math.min(Math.max(1, goal), max);
  settings.autoFocus = $autoFocusInput.checked;
  settings.autoBreak = $autoBreakInput.checked;


  if (!state.isRunning) {
    state.remainingAtStart = getTotalTime();
  }
  buildSegments();
  broadcastState();
  $settingsModal.classList.add('hidden');
});

// --- Derived helpers ---
function getTimeRemaining() {
  if (!state.isRunning) return state.remainingAtStart;
  const elapsed = (Date.now() - state.startedAt) / 1000;
  return Math.max(0, state.remainingAtStart - elapsed);
}

function getTotalTime() {
  return state.isFocus ? settings.focusMin * 60 : settings.breakMin * 60;
}

// --- Timer ---
function startTimer() {
  if (state.isRunning) return;
  requestNotificationPermission();
  state.isRunning = true;
  state.startedAt = Date.now();

  startTicking();
  playStartSound();
  broadcastState();
}

function pauseTimer() {
  if (!state.isRunning) return;
  state.remainingAtStart = getTimeRemaining();
  state.isRunning = false;
  state.startedAt = null;

  stopTicking();
  broadcastState();
}

function restartTimer() {
  stopTicking();
  state.isRunning = false;
  state.startedAt = null;
  state.remainingAtStart = getTotalTime();

  broadcastState();
  updateUI();
}

function skipPhase() {
  stopTicking();
  state.isRunning = false;
  state.startedAt = null;

  if (state.isFocus) {
    state.completedPomodoros++;
  } else {
    state.completedBreaks++;
  }

  state.isFocus = !state.isFocus;
  state.remainingAtStart = getTotalTime();

  updateLogEntry();
  broadcastState();
  updateUI();
}


function startTicking() {
  stopTicking();
  timerInterval = setInterval(tick, 250);
  scheduleCompletion();
}

function stopTicking() {
  clearInterval(timerInterval);
  timerInterval = null;
  clearTimeout(completionTimeout);
  completionTimeout = null;
}

// Schedule a precise setTimeout for when the timer should complete.
// This fires even if setInterval is throttled, with better precision
// than a throttled interval (browsers throttle setTimeout less
// aggressively for one-shot timers with known delay).
function scheduleCompletion() {
  clearTimeout(completionTimeout);
  if (!state.isRunning) return;
  const ms = getTimeRemaining() * 1000;
  if (ms <= 0 && !window.syncing) {
    completePhase();
    return;
  }
  completionTimeout = setTimeout(() => {
    if (state.isRunning && !window.syncing) completePhase();
  }, ms);
}

function tick() {
  if (getTimeRemaining() <= 0.5) {
    completePhase();
    return;
  }
  updateUI();
}

// Catch up immediately when tab becomes visible again
// (skipped while sync.js is fetching fresh cloud state)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.isRunning && !window.syncing) {
    tick();
  }
});

function completePhase() {
  stopTicking();
  state.isRunning = false;
  state.startedAt = null;

  const wasBeforeGoal = state.completedPomodoros < settings.goal;

  if (state.isFocus) {
    state.completedPomodoros++;
  } else {
    state.completedBreaks++;
  }

  state.isFocus = !state.isFocus;
  state.remainingAtStart = getTotalTime();


  playRingSound();
  showNotification(state.isFocus
    ? 'Break is over, time to focus'
    : 'Focus time is over, time to rest');
  updateLogEntry();
  broadcastState();
  updateUI();

  if (wasBeforeGoal && state.completedPomodoros >= settings.goal) {
    celebrate();
  }

  // Auto-start next phase
  if (state.isFocus && settings.autoFocus) {
    startTimer();
  } else if (!state.isFocus && settings.autoBreak) {
    startTimer();
  }
}

function reconstructTimer() {
  checkDayReset();
  if (!state.isRunning) return;

  if (getTimeRemaining() <= 0) {
    completePhase();
  } else {
    startTicking();
  }
}

// --- Build progress segments ---

function getNeededFocusSlots() {
  return Math.max(settings.goal, state.completedPomodoros + 1);
}

function buildSegments() {
  const totalFocus = getNeededFocusSlots();
  builtFocusSlots = totalFocus;

  $progressBar.innerHTML = '';
  const goal = settings.goal;
  let currentRow = createRow();

  for (let i = 0; i < totalFocus; i++) {
    // Start new row every ROW_SIZE sessions
    if (i > 0 && i % ROW_SIZE === 0) {
      currentRow = createRow();
    }

    const fSeg = document.createElement('div');
    fSeg.className = 'segment focus-seg';
    fSeg.dataset.type = 'focus';
    fSeg.dataset.index = i;

    const fFill = document.createElement('div');
    fFill.className = 'segment-fill';
    fSeg.appendChild(fFill);

    const fLabel = document.createElement('div');
    fLabel.className = 'segment-label';
    fLabel.textContent = i + 1;
    fSeg.appendChild(fLabel);

    currentRow.appendChild(fSeg);

    // Break between focus segments
    if (i < totalFocus - 1) {
      const bSeg = document.createElement('div');
      bSeg.className = 'segment break-seg';
      bSeg.dataset.type = 'break';
      bSeg.dataset.index = i;

      const bFill = document.createElement('div');
      bFill.className = 'segment-fill';
      bSeg.appendChild(bFill);

      currentRow.appendChild(bSeg);
    }
  }

  // Goal marker
  if (totalFocus > goal) {
    // Find which row the goal marker belongs to
    const rowIndex = Math.floor((goal - 1) / ROW_SIZE);
    const row = $progressBar.children[rowIndex];
    if (row) {
      const marker = document.createElement('div');
      marker.className = 'goal-marker';
      marker.id = 'goal-marker';
      marker.innerHTML = '<span>goal</span>';
      row.appendChild(marker);
      requestAnimationFrame(() => positionGoalMarker());
    }
  }
}

function createRow() {
  const row = document.createElement('div');
  row.className = 'progress-row';
  $progressBar.appendChild(row);
  return row;
}

function positionGoalMarker() {
  const marker = document.getElementById('goal-marker');
  if (!marker) return;
  const goal = settings.goal;
  const allFocusSegs = $progressBar.querySelectorAll('.segment.focus-seg');
  const lastGoalSeg = allFocusSegs[goal - 1];
  if (!lastGoalSeg) return;
  const row = lastGoalSeg.closest('.progress-row');
  const rowRect = row.getBoundingClientRect();
  const segRect = lastGoalSeg.getBoundingClientRect();
  const next = lastGoalSeg.nextElementSibling;
  let left;
  if (next && next.dataset.type) {
    const nextRect = next.getBoundingClientRect();
    left = (segRect.right + nextRect.left) / 2 - rowRect.left;
  } else {
    left = segRect.right - rowRect.left;
  }
  marker.style.left = left + 'px';
}

// --- UI ---
function updateUI() {
  checkDayReset();

  const remaining = getTimeRemaining();
  const secs = Math.ceil(remaining);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  $time.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  $phase.textContent = state.isFocus ? 'FOCUS' : 'BREAK';
  $phase.className = 'phase-label ' + (state.isFocus ? 'focus' : 'break');

  $startLabel.textContent = state.isRunning ? 'Pause' : 'Start';
  $playIcon.classList.toggle('hidden', state.isRunning);
  $pauseIcon.classList.toggle('hidden', !state.isRunning);
  $startBtn.style.setProperty('--phase-color', state.isFocus ? 'var(--focus)' : 'var(--break)');

  updateProgress(remaining);

  document.title = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${state.isFocus ? 'Focus' : 'Break'} | Focus`;
}

function updateProgress(remaining) {
  // Rebuild segments if more slots are needed
  if (getNeededFocusSlots() !== builtFocusSlots) {
    buildSegments();
  }

  const totalTime = getTotalTime();
  const segments = $progressBar.querySelectorAll('.segment');
  let focusIdx = 0;
  let breakIdx = 0;

  for (const seg of segments) {

    const fill = seg.querySelector('.segment-fill');
    seg.classList.remove('done', 'active');

    if (seg.dataset.type === 'focus') {
      if (focusIdx < state.completedPomodoros) {
        seg.classList.add('done');
        fill.style.width = '100%';
      } else if (focusIdx === state.completedPomodoros && state.isFocus) {
        seg.classList.add('active');
        const elapsed = totalTime - remaining;
        fill.style.width = (elapsed / totalTime) * 100 + '%';
      } else {
        fill.style.width = '0%';
      }
      focusIdx++;
    } else {
      if (breakIdx < state.completedBreaks) {
        seg.classList.add('done');
        fill.style.width = '100%';
      } else if (breakIdx === state.completedBreaks && !state.isFocus) {
        seg.classList.add('active');
        const elapsed = totalTime - remaining;
        fill.style.width = (elapsed / totalTime) * 100 + '%';
      } else {
        fill.style.width = '0%';
      }
      breakIdx++;
    }
  }

  // Label
  const goal = settings.goal;
  const extra = state.completedPomodoros - goal;
  if (extra > 0) {
    $progressLabel.textContent = `${goal} / ${goal} + ${extra} sessions`;
  } else {
    $progressLabel.textContent = `${state.completedPomodoros} / ${goal} sessions`;
  }

  const focusMinutes = state.completedPomodoros * settings.focusMin;
  const h = Math.floor(focusMinutes / 60);
  const mins = focusMinutes % 60;
  $progressTime.textContent = `${h}h ${mins}m focused`;
}

// --- Sound ---
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playStartSound() {
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;
    [523.25, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, t + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.2);
      osc.start(t + i * 0.1);
      osc.stop(t + i * 0.1 + 0.2);
    });
  } catch (e) {}
}

function playRingSound() {
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime;
    for (let rep = 0; rep < 2; rep++) {
      const offset = rep * 0.8;
      [784, 988, 1175].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = t + offset + i * 0.15;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
        osc.start(start);
        osc.stop(start + 0.6);
      });
    }
  } catch (e) {}
}

// --- Local persistence (IndexedDB) ---
// Always saves locally. Firebase overrides when signed in.
const localDB = (function () {
  const DB_NAME = 'pomodoro';
  const STORE = 'state';
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  return {
    save(data) {
      open().then(db => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(data, 'current');
      }).catch(() => {});
    },
    load() {
      return open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get('current');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      })).catch(() => null);
    }
  };
})();

function saveLocal() {
  localDB.save(window.app.getState());
}

function updateLogEntry() {
  const today = todayStr();
  if (log[today]) {
    log[today].completed = state.completedPomodoros;
  } else {
    log[today] = {
      completed: state.completedPomodoros,
      goal: settings.goal
    };
  }
}

function broadcastState() {
  const snapshot = { ...state, settings: { ...settings }, log: { ...log } };
  stateChangeCallbacks.forEach(cb => cb(snapshot));
  saveLocal();
  updateUI();
}

function checkDayReset() {
  const today = todayStr();
  if (state.date !== today) {
    // Preserve yesterday's log before resetting
    updateLogEntry();
    stopTicking();
    state.date = today;
    state.completedPomodoros = 0;
    state.completedBreaks = 0;
    state.isFocus = true;
    state.isRunning = false;
    state.startedAt = null;
    state.remainingAtStart = settings.focusMin * 60;
  
    updateLogEntry(); // create today's entry
  }
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// --- Celebration ---
function celebrate() {
  showToast();
  fireConfetti();
}

function showToast(message) {
  const $toast = document.getElementById('toast');
  if (message) $toast.textContent = message;
  $toast.classList.remove('hidden');
  // Force reflow so transition triggers
  $toast.offsetHeight;
  $toast.classList.add('show');
  setTimeout(() => {
    $toast.classList.remove('show');
    setTimeout(() => $toast.classList.add('hidden'), 500);
  }, 3000);
}

function fireConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#d63031', '#00897b', '#fdcb6e', '#6c5ce7', '#e17055', '#00b894', '#fd79a8', '#0984e3'];
  const particles = [];
  const PARTICLE_COUNT = 80;

  // Spawn from both bottom corners
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const fromLeft = i < PARTICLE_COUNT / 2;
    particles.push({
      x: fromLeft ? 0 : canvas.width,
      y: canvas.height,
      vx: (fromLeft ? 1 : -1) * (Math.random() * 8 + 4),
      vy: -(Math.random() * 16 + 10),
      gravity: 0.25,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: Math.random() * 8 + 4,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 12,
      opacity: 1,
      decay: 0.008 + Math.random() * 0.008,
      shape: Math.random() > 0.5 ? 'rect' : 'circle'
    });
  }

  let animId;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    for (const p of particles) {
      if (p.opacity <= 0) continue;
      alive = true;

      p.x += p.vx;
      p.vy += p.gravity;
      p.y += p.vy;
      p.rotation += p.rotationSpeed;
      p.opacity -= p.decay;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation * Math.PI / 180);
      ctx.globalAlpha = Math.max(0, p.opacity);
      ctx.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    if (alive) {
      animId = requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  animate();
}

// --- Log modal & chart ---
const $logBtn = document.getElementById('log-btn');
const $logModal = document.getElementById('log-modal');
const $logClose = document.getElementById('log-close');
const $logBackdrop = $logModal.querySelector('.modal-backdrop');
const $logChart = document.getElementById('log-chart');
const $logSummary = document.getElementById('log-summary');
const $logTabs = $logModal.querySelectorAll('.log-tab');
const $logPrev = document.getElementById('log-prev');
const $logNext = document.getElementById('log-next');
const $logPeriodLabel = document.getElementById('log-period-label');
let currentRange = 'week';
let periodOffset = 0; // 0 = current period, -1 = previous, etc.

$logBtn.addEventListener('click', () => {
  periodOffset = 0;
  $logModal.classList.remove('hidden');
  drawChart(currentRange);
});
$logClose.addEventListener('click', () => $logModal.classList.add('hidden'));
$logBackdrop.addEventListener('click', () => $logModal.classList.add('hidden'));

$logTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    $logTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentRange = tab.dataset.range;
    periodOffset = 0;
    drawChart(currentRange);
  });
});

$logPrev.addEventListener('click', () => { periodOffset--; drawChart(currentRange); });
$logNext.addEventListener('click', () => { periodOffset++; drawChart(currentRange); });

function drawChart(range) {
  const canvas = $logChart;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  let data;
  let periodLabel;
  if (range === 'year') {
    const result = getYearData(periodOffset);
    data = result.data;
    periodLabel = result.label;
  } else {
    const result = getDaysData(range, periodOffset);
    data = result.data;
    periodLabel = result.label;
  }
  $logPeriodLabel.textContent = periodLabel;

  if (data.length === 0) return;

  const maxVal = Math.max(1, ...data.map(d => Math.max(d.completed, d.goal)));
  const padTop = 20;
  const padBottom = 30;
  const padLeft = 30;
  const padRight = 10;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;
  const barW = Math.max(4, (chartW / data.length) * 0.6);
  const gap = chartW / data.length;

  // Y axis labels
  ctx.fillStyle = '#a7a9be';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  const ySteps = Math.min(maxVal, 5);
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round(maxVal * i / ySteps);
    const y = padTop + chartH - (chartH * i / ySteps);
    ctx.fillText(val, padLeft - 6, y + 3);
    // grid line
    ctx.strokeStyle = '#1a193220';
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(W - padRight, y);
    ctx.stroke();
  }

  // Bars and goal line
  const goalPoints = [];

  data.forEach((d, i) => {
    const x = padLeft + i * gap + gap / 2;
    const barH = (d.completed / maxVal) * chartH;
    const y = padTop + chartH - barH;

    // Bar
    const met = d.completed >= d.goal && d.goal > 0;
    ctx.fillStyle = met ? '#00897b' : '#d63031';
    ctx.beginPath();
    roundedRect(ctx, x - barW / 2, y, barW, barH, 3);
    ctx.fill();

    // Goal dot for line
    const goalY = padTop + chartH - (d.goal / maxVal) * chartH;
    goalPoints.push({ x, y: goalY });

    // X label
    ctx.fillStyle = '#a7a9be';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(d.label, x, H - padBottom + 14);
  });

  // Goal line
  if (goalPoints.length > 1) {
    ctx.strokeStyle = '#a7a9be88';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    goalPoints.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Summary
  const totalCompleted = data.reduce((s, d) => s + d.completed, 0);
  const totalGoal = data.reduce((s, d) => s + d.goal, 0);
  const daysWithData = data.filter(d => d.completed > 0).length;
  $logSummary.textContent = `${totalCompleted} sessions across ${daysWithData} day${daysWithData !== 1 ? 's' : ''}`;
}

function getDaysData(range, offset) {
  const data = [];
  const today = new Date();
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let start, count, label;

  if (range === 'week') {
    start = new Date(today);
    start.setDate(start.getDate() - start.getDay() + offset * 7);
    count = 7;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    label = monthNames[start.getMonth()] + ' ' + start.getDate() + ' – ' + monthNames[end.getMonth()] + ' ' + end.getDate();
  } else {
    const m = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    start = m;
    count = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    label = monthNames[m.getMonth()] + ' ' + m.getFullYear();
  }

  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const entry = log[key] || { completed: 0, goal: settings.goal };
    const dayLabel = range === 'week' ? dayNames[d.getDay()] : String(d.getDate());
    data.push({ label: dayLabel, completed: entry.completed, goal: entry.goal });
  }
  return { data, label };
}

function getYearData(offset) {
  const data = [];
  const today = new Date();
  const year = today.getFullYear() + offset;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  for (let i = 0; i < 12; i++) {
    const month = i;
    let totalCompleted = 0;
    let totalGoal = 0;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let daysWithEntries = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (log[key]) {
        totalCompleted += log[key].completed;
        totalGoal += log[key].goal;
        daysWithEntries++;
      }
    }

    data.push({
      label: monthNames[month],
      completed: daysWithEntries > 0 ? Math.round(totalCompleted / daysWithEntries) : 0,
      goal: daysWithEntries > 0 ? Math.round(totalGoal / daysWithEntries) : 0
    });
  }
  return { data, label: String(year) };
}

function roundedRect(ctx, x, y, w, h, r) {
  if (h < 1) { ctx.rect(x, y, w, h); return; }
  r = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// --- Notifications ---
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  // Prefer SW-based notification (survives screen off on mobile)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'notification',
      title: 'Focus',
      body: body
    });
  } else {
    new Notification('Focus', { body: body, icon: 'icon.svg' });
  }
}

// --- PWA ---
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// --- Sync ---
function applyRemoteState(remote) {
  mergeLog(remote.log);
  doApplyRemoteState(remote);
}

// Merge remote log into local. Returns true if local had entries remote was missing.
function mergeLog(remoteLog) {
  if (!remoteLog) return false;
  let localHadExtra = false;

  // Check if we have entries remote doesn't
  for (const date of Object.keys(log)) {
    if (!remoteLog[date]) {
      localHadExtra = true;
      break;
    }
    if (log[date].completed > (remoteLog[date]?.completed || 0)) {
      localHadExtra = true;
      break;
    }
  }

  // Merge remote into local
  for (const [date, entry] of Object.entries(remoteLog)) {
    if (!log[date]) {
      log[date] = entry;
    } else if (entry.completed > log[date].completed) {
      log[date].completed = entry.completed;
    }
  }

  return localHadExtra;
}

function doApplyRemoteState(remote) {
  const wasRunning = state.isRunning;

  state.isFocus = remote.isFocus;
  state.isRunning = remote.isRunning;
  state.startedAt = remote.startedAt;
  state.remainingAtStart = remote.remainingAtStart;
  state.completedPomodoros = remote.completedPomodoros;
  state.completedBreaks = remote.completedBreaks;
  state.date = remote.date;

  // Apply settings if included
  if (remote.settings) {
    const s = remote.settings;
    if (s.goal >= 1 && s.goal <= 20) settings.goal = s.goal;
    if (s.focusMin >= 1 && s.focusMin <= 120) settings.focusMin = s.focusMin;
    if (s.breakMin >= 1 && s.breakMin <= 30) settings.breakMin = s.breakMin;
    if (typeof s.autoFocus === 'boolean') settings.autoFocus = s.autoFocus;
    if (typeof s.autoBreak === 'boolean') settings.autoBreak = s.autoBreak;
    buildSegments();
  }

  if (state.isRunning && !wasRunning) {
    startTicking();
  } else if (!state.isRunning && wasRunning) {
    stopTicking();
  }

  updateLogEntry();
  updateUI();
}