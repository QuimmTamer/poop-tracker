'use strict';

// ── Database ──────────────────────────────────────────────────────────────────

const DB = (() => {
  const NAME = 'PoopTrackerDB', VER = 1, STORE = 'entries';
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('datetime', 'datetime');
        }
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror = e => rej(e.target.error);
    });
  }

  function tx(mode) {
    return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
  }

  return {
    add: entry => tx('readwrite').then(s => new Promise((res, rej) => {
      const req = s.add(entry);
      req.onsuccess = () => res();
      req.onerror = e => rej(e.target.error);
    })),

    getAll: () => tx('readonly').then(s => new Promise((res, rej) => {
      const req = s.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = e => rej(e.target.error);
    })),

    delete: id => tx('readwrite').then(s => new Promise((res, rej) => {
      const req = s.delete(id);
      req.onsuccess = () => res();
      req.onerror = e => rej(e.target.error);
    })),

    clear: () => tx('readwrite').then(s => new Promise((res, rej) => {
      const req = s.clear();
      req.onsuccess = () => res();
      req.onerror = e => rej(e.target.error);
    }))
  };
})();

// ── Bristol Scale ─────────────────────────────────────────────────────────────

const BRISTOL = [
  { n: 1, emoji: '🪨', label: 'Hard lumps', desc: 'Separate hard lumps like nuts' },
  { n: 2, emoji: '🌑', label: 'Lumpy', desc: 'Sausage-shaped but lumpy' },
  { n: 3, emoji: '🌛', label: 'Cracked', desc: 'Like a sausage with cracks' },
  { n: 4, emoji: '🍌', label: 'Smooth', desc: 'Smooth & soft sausage' },
  { n: 5, emoji: '🫘', label: 'Soft blobs', desc: 'Soft blobs with clear edges' },
  { n: 6, emoji: '🌊', label: 'Fluffy', desc: 'Fluffy pieces, ragged edges' },
  { n: 7, emoji: '💧', label: 'Watery', desc: 'Entirely liquid' },
];

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  activeTab: 'log',
  darkMode: localStorage.getItem('darkMode') === 'true',
  entries: [],
  historyFilter: 'all',

  // GPS
  gpsCoords: null,
  gpsStatus: 'idle',  // idle | loading | got | error

  // Form
  selectedBristol: null,
  selectedWipes: null,
  selectedDuration: null,
  selectedComfort: null,
  notes: '',

  // Motion tracking
  motionEnabled: false,
  motionPermission: 'unknown',
  motionSamples: [],
  motionActivity: 0,
  motionState: 'unknown',     // unknown | moving | still
  motionStateTimer: null,
  stillSince: null,
  lastMoveTime: null,
  wasMovingBefore: false,
  pendingPrediction: null,    // { time, coords }

  // Motion settings
  moveThreshold: 0.8,         // avg delta m/s² to be "moving"
  stillMinutes: 2,            // minutes still to trigger prediction
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso) {
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function $ (sel) { return document.querySelector(sel); }
function $$ (sel) { return [...document.querySelectorAll(sel)]; }

// ── Dark Mode ─────────────────────────────────────────────────────────────────

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light');
  const chk = document.getElementById('darkModeToggle');
  if (chk) chk.checked = state.darkMode;

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = state.darkMode ? '#2a1e10' : '#8B4513';
}

function toggleDarkMode(val) {
  state.darkMode = val;
  localStorage.setItem('darkMode', val);
  applyTheme();
}

// ── GPS ───────────────────────────────────────────────────────────────────────

function getGPSCoords(timeoutMs = 6000) {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      pos => {
        clearTimeout(timer);
        resolve({
          lat: pos.coords.latitude.toFixed(6),
          lon: pos.coords.longitude.toFixed(6),
          accuracy: Math.round(pos.coords.accuracy),
        });
      },
      () => { clearTimeout(timer); resolve(null); },
      { timeout: timeoutMs, enableHighAccuracy: false }
    );
  });
}

function renderGPSStatus(status, msg) {
  const dot = document.getElementById('gpsDot');
  const text = document.getElementById('gpsText');
  if (!dot) return;
  dot.className = 'gps-dot ' + status;
  if (text) text.textContent = msg;
}

// ── Motion Tracking ───────────────────────────────────────────────────────────

let _lastMotionTs = 0;
const MOTION_INTERVAL_MS = 1000; // sample at max 1Hz to save battery

function calcMagnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function processMotionSample(mag) {
  const MAX_SAMPLES = 50;
  if (state.motionSamples.length >= MAX_SAMPLES) state.motionSamples.shift();

  const prev = state.motionSamples[state.motionSamples.length - 1] ?? mag;
  const delta = Math.abs(mag - prev);
  state.motionSamples.push(mag);

  // Rolling average of deltas
  const deltas = [];
  for (let i = 1; i < state.motionSamples.length; i++) {
    deltas.push(Math.abs(state.motionSamples[i] - state.motionSamples[i - 1]));
  }
  state.motionActivity = deltas.length
    ? deltas.reduce((a, b) => a + b) / deltas.length
    : 0;

  const now = Date.now();
  const isMoving = state.motionActivity > state.moveThreshold;

  if (isMoving) {
    if (state.motionState !== 'moving') {
      state.motionState = 'moving';
      state.lastMoveTime = now;
      state.wasMovingBefore = true;
      state.stillSince = null;
    }
    state.lastMoveTime = now;
  } else {
    if (state.motionState === 'moving') {
      state.stillSince = now;
      state.motionState = 'still';
    } else if (state.motionState !== 'still') {
      if (!state.stillSince) state.stillSince = now;
      state.motionState = 'still';
    }

    if (state.stillSince && state.wasMovingBefore) {
      const stillMs = now - state.stillSince;
      const threshMs = state.stillMinutes * 60 * 1000;
      if (stillMs >= threshMs && !state.pendingPrediction) {
        triggerPrediction(new Date(state.stillSince).toISOString());
        state.wasMovingBefore = false;
      }
    }
  }

  updateMotionUI();
}

function triggerPrediction(time) {
  state.pendingPrediction = {
    time,
    coords: state.gpsCoords ? { ...state.gpsCoords } : null,
  };
  renderPredictionAlert();
  showToast('🚽 Possible toilet visit detected!', 4000);
}

function handleMotionEvent(e) {
  const now = Date.now();
  if (now - _lastMotionTs < MOTION_INTERVAL_MS) return;
  _lastMotionTs = now;
  const acc = e.accelerationIncludingGravity;
  if (!acc) return;
  const mag = calcMagnitude(acc.x || 0, acc.y || 0, acc.z || 0);
  processMotionSample(mag);
}

async function enableMotion() {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== 'granted') {
        showToast('Motion permission denied');
        return false;
      }
    } catch {
      showToast('Could not request motion permission');
      return false;
    }
  }

  window.addEventListener('devicemotion', handleMotionEvent);
  state.motionEnabled = true;
  state.motionState = 'unknown';
  state.motionSamples = [];
  state.stillSince = null;
  state.wasMovingBefore = false;
  state.pendingPrediction = null;
  updateMotionUI();
  showToast('Motion tracking enabled');
  return true;
}

function disableMotion() {
  window.removeEventListener('devicemotion', handleMotionEvent);
  state.motionEnabled = false;
  state.motionState = 'unknown';
  state.motionSamples = [];
  state.pendingPrediction = null;
  updateMotionUI();
  renderPredictionAlert();
  showToast('Motion tracking disabled');
}

function updateMotionUI() {
  const ring = document.getElementById('motionRing');
  const label = document.getElementById('motionLabel');
  const sub = document.getElementById('motionSub');
  if (!ring) return;

  if (!state.motionEnabled) {
    ring.className = 'motion-ring disabled';
    ring.textContent = '📵';
    if (label) label.textContent = 'Tracking Off';
    if (sub) sub.textContent = 'Enable motion tracking below';
    return;
  }

  if (state.motionState === 'moving') {
    ring.className = 'motion-ring moving';
    ring.textContent = '🚶';
    if (label) label.textContent = 'Moving';
    if (sub) sub.textContent = `Activity: ${state.motionActivity.toFixed(2)} m/s²`;
  } else if (state.motionState === 'still') {
    const sec = state.stillSince ? Math.floor((Date.now() - state.stillSince) / 1000) : 0;
    const needed = state.stillMinutes * 60;
    ring.className = 'motion-ring still';
    ring.textContent = '🪑';
    if (label) label.textContent = 'Stationary';
    if (sub) {
      if (sec < needed && state.wasMovingBefore) {
        sub.textContent = `Still for ${sec}s / ${needed}s to trigger`;
      } else {
        sub.textContent = `Still for ${sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm'}`;
      }
    }
  } else {
    ring.className = 'motion-ring disabled';
    ring.textContent = '📡';
    if (label) label.textContent = 'Listening…';
    if (sub) sub.textContent = 'Calibrating motion sensor';
  }
}

setInterval(() => {
  if (state.motionEnabled && state.motionState === 'still') updateMotionUI();
}, 3000);

// ── Render Prediction Alert ───────────────────────────────────────────────────

function renderPredictionAlert() {
  const container = document.getElementById('predictionContainer');
  if (!container) return;

  if (!state.pendingPrediction) {
    container.innerHTML = '';
    return;
  }

  const p = state.pendingPrediction;
  container.innerHTML = `
    <div class="prediction-alert">
      <h3>🚽 Possible Toilet Visit Detected</h3>
      <p>You were stationary for ${state.stillMinutes}+ minutes after moving at ${formatDateTime(p.time)}.
         Was this a bathroom visit?</p>
      <div class="prediction-actions">
        <button class="btn btn-success btn-sm" onclick="confirmPrediction()">✓ Yes, log it</button>
        <button class="btn btn-secondary btn-sm" onclick="dismissPrediction()">✗ No</button>
      </div>
    </div>`;
}

function confirmPrediction() {
  if (!state.pendingPrediction) return;
  const entry = {
    id: Date.now(),
    datetime: state.pendingPrediction.time,
    bristolType: null,
    notes: 'Auto-detected visit (unconfirmed type)',
    coords: state.pendingPrediction.coords,
    predicted: true,
  };
  DB.add(entry).then(() => {
    state.pendingPrediction = null;
    renderPredictionAlert();
    loadHistory();
    showToast('Predicted visit logged!');
  });
}

function dismissPrediction() {
  state.pendingPrediction = null;
  renderPredictionAlert();
}

// ── Log Form ──────────────────────────────────────────────────────────────────

function renderBristolGrid() {
  const grid = document.getElementById('bristolGrid');
  if (!grid) return;
  grid.innerHTML = BRISTOL.map(b => `
    <button class="bristol-btn${state.selectedBristol === b.n ? ' selected' : ''}"
            onclick="selectBristol(${b.n})" title="${b.desc}">
      <span class="b-num">${b.n}</span>
      <span class="b-emoji">${b.emoji}</span>
      <span class="b-label">${b.label}</span>
    </button>`).join('');
}

function selectBristol(n) {
  state.selectedBristol = n;
  renderBristolGrid();
  const info = document.getElementById('bristolInfo');
  if (info) {
    const b = BRISTOL.find(x => x.n === n);
    info.textContent = b ? `Type ${b.n}: ${b.desc}` : '';
  }
  updateLogSummary();
}

// ── Wipe Count ────────────────────────────────────────────────────────────────

const WIPE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, '10+'];

const WIPE_FEEDBACK = [
  { max: 2,   emoji: '🧻',  text: 'Nice and clean' },
  { max: 4,   emoji: '🧻🧻', text: 'A few wipes' },
  { max: 6,   emoji: '😅',  text: 'Getting there' },
  { max: 9,   emoji: '😰',  text: 'Quite a few' },
  { max: Infinity, emoji: '💀', text: 'Many wipes!' },
];

function getWipeFeedback(val) {
  const n = val === '10+' ? 11 : val;
  return WIPE_FEEDBACK.find(f => n <= f.max) || WIPE_FEEDBACK.at(-1);
}

function renderWipeButtons() {
  const row = document.getElementById('wipeButtons');
  if (!row) return;
  row.innerHTML = WIPE_OPTIONS.map(v => `
    <button class="wipe-btn${state.selectedWipes === v ? ' selected' : ''}"
            onclick="selectWipes(${typeof v === 'string' ? '"' + v + '"' : v})">${v}</button>`
  ).join('');
}

function selectWipes(v) {
  state.selectedWipes = v;
  renderWipeButtons();
  const fb = getWipeFeedback(v);
  const emoji = document.getElementById('wipeEmoji');
  const text = document.getElementById('wipeCountText');
  if (emoji) emoji.textContent = fb.emoji;
  if (text) { text.textContent = `${v} wipe${v === 1 ? '' : 's'} — ${fb.text}`; text.style.color = 'var(--text)'; }
  updateLogSummary();
}

// ── Duration ──────────────────────────────────────────────────────────────────

const DURATION_OPTIONS = ['1 min', '2 min', '3 min', '5 min', '10 min', '15 min', '20 min', '30+ min'];

function renderDurationButtons() {
  const row = document.getElementById('durationButtons');
  if (!row) return;
  row.innerHTML = DURATION_OPTIONS.map(v => `
    <button class="pill-btn${state.selectedDuration === v ? ' selected' : ''}"
            onclick="selectDuration('${v}')">${v}</button>`
  ).join('');
}

function selectDuration(v) {
  state.selectedDuration = v;
  renderDurationButtons();
  updateLogSummary();
}

// ── Comfort / Experience ──────────────────────────────────────────────────────

const COMFORT_OPTIONS = [
  { v: 1, emoji: '😖', label: 'Painful' },
  { v: 2, emoji: '😕', label: 'Hard' },
  { v: 3, emoji: '😐', label: 'Normal' },
  { v: 4, emoji: '🙂', label: 'Easy' },
  { v: 5, emoji: '😊', label: 'Smooth' },
];

function renderComfortButtons() {
  const row = document.getElementById('comfortButtons');
  if (!row) return;
  row.innerHTML = COMFORT_OPTIONS.map(c => `
    <button class="comfort-btn${state.selectedComfort === c.v ? ' selected' : ''}"
            onclick="selectComfort(${c.v})">
      <span class="c-emoji">${c.emoji}</span>
      <span class="c-label">${c.label}</span>
    </button>`
  ).join('');
}

function selectComfort(v) {
  state.selectedComfort = v;
  renderComfortButtons();
  const c = COMFORT_OPTIONS.find(x => x.v === v);
  const lbl = document.getElementById('comfortLabel');
  if (lbl && c) lbl.textContent = `${c.emoji} ${c.label}`;
  updateLogSummary();
}

// ── Log Summary Strip ─────────────────────────────────────────────────────────

function updateLogSummary() {
  const el = document.getElementById('logSummary');
  if (!el) return;

  const chips = [];

  if (state.selectedBristol) {
    const b = BRISTOL.find(x => x.n === state.selectedBristol);
    if (b) chips.push({ icon: b.emoji, text: `Type ${b.n}`, filled: true });
  } else {
    chips.push({ icon: '💩', text: 'No type', filled: false });
  }

  if (state.selectedWipes !== null) {
    chips.push({ icon: '🧻', text: `${state.selectedWipes} wipe${state.selectedWipes === 1 ? '' : 's'}`, filled: true });
  }

  if (state.selectedDuration) {
    chips.push({ icon: '⏱', text: state.selectedDuration, filled: true });
  }

  if (state.selectedComfort) {
    const c = COMFORT_OPTIONS.find(x => x.v === state.selectedComfort);
    if (c) chips.push({ icon: c.emoji, text: c.label, filled: true });
  }

  el.innerHTML = chips.map(c =>
    `<div class="summary-chip${c.filled ? ' filled' : ''}">
       <span>${c.icon}</span><span>${c.text}</span>
     </div>`
  ).join('');
}

function setLogTime() {
  const el = document.getElementById('logDatetime');
  if (!el) return;
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  el.value = now.toISOString().slice(0, 16);
}

async function submitLog() {
  const notesEl = document.getElementById('logNotes');
  const wipeNotesEl = document.getElementById('wipeNotes');
  const datetimeEl = document.getElementById('logDatetime');

  const datetime = datetimeEl?.value
    ? new Date(datetimeEl.value).toISOString()
    : new Date().toISOString();

  // Auto-capture GPS silently
  renderGPSStatus('loading', '📡 Getting location…');
  const coords = await getGPSCoords(6000);
  if (coords) {
    renderGPSStatus('got', `📍 ${coords.lat}, ${coords.lon} (±${coords.accuracy}m)`);
  } else {
    renderGPSStatus('idle', '📍 Captured automatically on save');
  }

  const entry = {
    id: Date.now(),
    datetime,
    bristolType: state.selectedBristol,
    wipes: state.selectedWipes,
    wipeNotes: wipeNotesEl?.value?.trim() || '',
    duration: state.selectedDuration,
    comfort: state.selectedComfort,
    notes: notesEl?.value?.trim() || '',
    coords: coords,
    predicted: false,
  };

  await DB.add(entry);
  showToast('Entry logged! 💩');

  // Reset form
  state.selectedBristol = null;
  state.selectedWipes = null;
  state.selectedDuration = null;
  state.selectedComfort = null;
  if (notesEl) notesEl.value = '';
  if (wipeNotesEl) wipeNotesEl.value = '';

  renderBristolGrid();
  renderWipeButtons();
  renderDurationButtons();
  renderComfortButtons();
  setLogTime();
  renderGPSStatus('idle', '📍 Captured automatically on save');
  updateLogSummary();

  const infoEl = document.getElementById('bristolInfo');
  if (infoEl) infoEl.textContent = '';
  const wipeEmoji = document.getElementById('wipeEmoji');
  const wipeText = document.getElementById('wipeCountText');
  if (wipeEmoji) wipeEmoji.textContent = '🧻';
  if (wipeText) { wipeText.textContent = 'Select amount'; wipeText.style.color = 'var(--text-muted)'; }
  const comfortLabel = document.getElementById('comfortLabel');
  if (comfortLabel) comfortLabel.textContent = '';

  loadHistory();
  updateStats();
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory() {
  state.entries = await DB.getAll();
  state.entries.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  renderHistory();
  updateStats();
}

function getFilteredEntries() {
  if (state.historyFilter === 'all') return state.entries;
  if (state.historyFilter === 'predicted') return state.entries.filter(e => e.predicted);
  if (state.historyFilter === 'gps') return state.entries.filter(e => e.coords);
  const type = parseInt(state.historyFilter);
  return state.entries.filter(e => e.bristolType === type);
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;

  const filtered = getFilteredEntries();

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <div class="emoji">💩</div>
      <p>${state.entries.length === 0 ? 'No entries yet. Log your first visit!' : 'No entries match this filter.'}</p>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(e => {
    const b = BRISTOL.find(x => x.n === e.bristolType);
    const emoji = b ? b.emoji : '💩';
    const typeLabel = b ? `Type ${b.n}` : 'Unknown type';
    const comfort = COMFORT_OPTIONS.find(x => x.v === e.comfort);
    const pills = [
      e.wipes != null    ? `🧻 ${e.wipes} wipe${e.wipes === 1 ? '' : 's'}` : null,
      e.duration         ? `⏱ ${e.duration}` : null,
      comfort            ? `${comfort.emoji} ${comfort.label}` : null,
    ].filter(Boolean);
    const allNotes = [e.notes, e.wipeNotes].filter(Boolean).join(' · ');
    return `
    <div class="history-entry" id="entry-${e.id}">
      <div class="entry-type">${emoji}</div>
      <div class="entry-body">
        <div class="entry-header">
          <div class="entry-datetime">${formatDateTime(e.datetime)}</div>
          <div style="display:flex;gap:4px;align-items:center">
            ${e.predicted ? '<span class="entry-badge badge-predicted">Auto</span>' : ''}
            <button class="btn-icon" onclick="deleteEntry(${e.id})" title="Delete" style="color:var(--danger);font-size:16px;">🗑</button>
          </div>
        </div>
        <div class="entry-notes">${typeLabel}${allNotes ? ' · ' + escHtml(allNotes) : ''}</div>
        ${pills.length ? `<div class="entry-meta">${pills.map(p => `<span class="entry-pill">${p}</span>`).join('')}</div>` : ''}
        ${e.coords ? `<div class="entry-gps">📍 ${e.coords.lat}, ${e.coords.lon} ±${e.coords.accuracy}m</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setHistoryFilter(f) {
  state.historyFilter = f;
  $$('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
  renderHistory();
}

async function deleteEntry(id) {
  await DB.delete(id);
  loadHistory();
  showToast('Entry deleted');
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateStats() {
  const total = document.getElementById('statTotal');
  const today = document.getElementById('statToday');
  const week = document.getElementById('statWeek');
  const common = document.getElementById('statCommon');
  if (!total) return;

  const now = new Date();
  const todayStr = now.toDateString();
  const weekAgo = new Date(now - 7 * 86400000);

  total.textContent = state.entries.length;

  today.textContent = state.entries.filter(e => new Date(e.datetime).toDateString() === todayStr).length;

  week.textContent = state.entries.filter(e => new Date(e.datetime) >= weekAgo).length;

  const typeCounts = {};
  state.entries.forEach(e => {
    if (e.bristolType) typeCounts[e.bristolType] = (typeCounts[e.bristolType] || 0) + 1;
  });
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  common.textContent = topType ? `Type ${topType[0]}` : '—';
}

// ── Export CSV ────────────────────────────────────────────────────────────────

async function exportCSV() {
  const entries = await DB.getAll();
  if (entries.length === 0) { showToast('No entries to export'); return; }

  const headers = ['Date', 'Time', 'Bristol Type', 'Description', 'Wipe Count', 'Wipe Notes', 'Duration', 'Experience', 'Notes', 'Latitude', 'Longitude', 'GPS Accuracy (m)', 'Auto-Detected'];
  const rows = entries
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
    .map(e => {
      const d = new Date(e.datetime);
      const b = BRISTOL.find(x => x.n === e.bristolType);
      const comfort = COMFORT_OPTIONS.find(x => x.v === e.comfort);
      return [
        d.toLocaleDateString('en-US'),
        d.toLocaleTimeString('en-US'),
        e.bristolType ?? '',
        b ? b.desc : '',
        e.wipes ?? '',
        (e.wipeNotes || '').replace(/"/g, '""'),
        e.duration ?? '',
        comfort ? comfort.label : '',
        (e.notes || '').replace(/"/g, '""'),
        e.coords?.lat ?? '',
        e.coords?.lon ?? '',
        e.coords?.accuracy ?? '',
        e.predicted ? 'Yes' : 'No',
      ].map(v => `"${v}"`).join(',');
    });

  const csv = [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `poop-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${entries.length} entries`);
}

// ── Clear Data ────────────────────────────────────────────────────────────────

function clearAllData() {
  if (!confirm('Delete ALL entries? This cannot be undone.')) return;
  DB.clear().then(() => {
    state.entries = [];
    renderHistory();
    updateStats();
    showToast('All data cleared');
  });
}

// ── Tab Navigation ────────────────────────────────────────────────────────────

function switchTab(tab) {
  state.activeTab = tab;
  $$('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  if (tab === 'log') setLogTime();
  if (tab === 'history') loadHistory();
  if (tab === 'tracker') { renderPredictionAlert(); updateMotionUI(); }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  applyTheme();
  renderBristolGrid();
  renderWipeButtons();
  renderDurationButtons();
  renderComfortButtons();
  updateLogSummary();
  setLogTime();
  loadHistory();

  // Dark mode toggle
  const dmToggle = document.getElementById('darkModeToggle');
  if (dmToggle) {
    dmToggle.checked = state.darkMode;
    dmToggle.addEventListener('change', () => toggleDarkMode(dmToggle.checked));
  }

  renderGPSStatus('idle', '📍 Captured automatically on save');

  // Motion toggle
  const motionToggle = document.getElementById('motionToggle');
  if (motionToggle) {
    motionToggle.addEventListener('change', async () => {
      if (motionToggle.checked) {
        const ok = await enableMotion();
        if (!ok) motionToggle.checked = false;
      } else {
        disableMotion();
      }
    });
  }

  // Filter chips
  $$('.filter-chip').forEach(c => {
    c.addEventListener('click', () => setHistoryFilter(c.dataset.filter));
  });

  // Pause motion when screen is off / app backgrounded
  document.addEventListener('visibilitychange', () => {
    if (!state.motionEnabled) return;
    if (document.hidden) {
      window.removeEventListener('devicemotion', handleMotionEvent);
    } else {
      window.addEventListener('devicemotion', handleMotionEvent);
    }
  });

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

// Expose globals for inline handlers
window.selectBristol = selectBristol;
window.selectWipes = selectWipes;
window.selectDuration = selectDuration;
window.selectComfort = selectComfort;
window.submitLog = submitLog;
window.exportCSV = exportCSV;
window.clearAllData = clearAllData;
window.deleteEntry = deleteEntry;
window.setHistoryFilter = setHistoryFilter;
window.switchTab = switchTab;
window.confirmPrediction = confirmPrediction;
window.dismissPrediction = dismissPrediction;
