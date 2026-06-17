const socket = typeof io === 'function' ? io() : null;
const TIERS = ['ordinaire', 'semi', 'rare', 'legendaire'];
const CLIENT_ID_KEY = 'bingo-client-id';
const SESSION_ROOM_KEY = 'bingo-room-code';
const SESSION_NAME_KEY = 'bingo-player-name';
const MY_GRIDS_KEY = 'bingo-my-grids';
const TIER_NAMES = {
  ordinaire: 'Ordinaire',
  semi: 'Semi-Ordinaire',
  rare: 'Rare',
  legendaire: 'Légendaire',
};

let myGrid = null;
let myChecked = emptyChecked();
let myOccurrences = emptyOccurrences();
let myBonuses = emptyBonuses();
let roomCode = null;
let playerName = null;
let myId = null;
const clientId = getOrCreateClientId();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function emptyChecked() {
  return TIERS.reduce((acc, tier) => {
    acc[tier] = [];
    return acc;
  }, {});
}

function emptyOccurrences() {
  return TIERS.reduce((acc, tier) => {
    acc[tier] = {};
    return acc;
  }, {});
}

function emptyBonuses() {
  return TIERS.reduce((acc, tier) => {
    acc[tier] = 0;
    return acc;
  }, { joker: 0 });
}

function getOrCreateClientId() {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const generated = window.crypto?.randomUUID?.() || `cid_${Math.random().toString(36).slice(2)}${Date.now()}`;
    window.localStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return window.crypto?.randomUUID?.() || `cid_${Math.random().toString(36).slice(2)}${Date.now()}`;
  }
}

function getStoredSessionValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredSessionValue(key, value) {
  try {
    if (value === null || value === undefined || value === '') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {}
}

// Grilles publiées depuis cette machine : { CODE: { token, name, subject } }.
// Permet de ré-éditer ses grilles sans le lien secret tant que le cache n'est pas effacé.
function getMyGrids() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MY_GRIDS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function rememberMyGrid(grid) {
  if (!grid?.code || !grid?.editToken) return;
  try {
    const all = getMyGrids();
    all[grid.code] = {
      token: grid.editToken,
      name: grid.name || '',
      subject: grid.subject || '',
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(MY_GRIDS_KEY, JSON.stringify(all));
  } catch {}
}

function forgetMyGrid(code) {
  try {
    const all = getMyGrids();
    if (all[code]) {
      delete all[code];
      window.localStorage.setItem(MY_GRIDS_KEY, JSON.stringify(all));
    }
  } catch {}
}

const screenHome = $('#screen-home');
const screenGame = $('#screen-game');
const screenGridEditor = $('#screen-grid-editor');
const inputName = $('#player-name');
const inputCode = $('#room-code');
const btnCreate = $('#btn-create');
const btnJoin = $('#btn-join');
const btnInfo = $('#btn-info');
const btnOpenGridEditor = $('#btn-open-grid-editor');
const btnOpenCustomGrids = $('#btn-open-custom-grids');
const btnEditorBack = $('#btn-editor-back');
const btnRefreshCustomGrids = $('#btn-refresh-custom-grids');
const btnCloseCustomGrids = $('#btn-close-custom-grids');
const customGridPanel = $('#custom-grid-panel');
const customGridPanelBackdrop = $('#custom-grid-panel-backdrop');
const customGridsList = $('#custom-grids-list');
const customGridEditor = $('#custom-grid-editor');
const gridNameInput = $('#grid-name');
const gridSubjectInput = $('#grid-subject');
const gridPublicInput = $('#grid-public');
const btnSaveCustomGrid = $('#btn-save-custom-grid');
const editorResult = $('#editor-result');
const errorMsg = $('#error-msg');
const displayCode = $('#display-code');
const playerCount = $('#player-count');
const btnPlayers = $('#btn-players');
const btnShare = $('#btn-share');
const btnJoker = $('#btn-joker');
const btnBackHome = $('#btn-back-home');
const playersPanel = $('#players-panel');
const panelBackdrop = $('#panel-backdrop');
const playersList = $('#players-list');
const btnClosePanel = $('#btn-close-panel');
const winOverlay = $('#win-overlay');
const winContent = document.querySelector('.win-content');
const winDrawing = $('#win-drawing');
const winTitle = $('#win-title');
const winDetail = $('#win-detail');
const btnNewGame = $('#btn-new-game');
const btnNewGame2 = $('#btn-new-game-2');
const btnContinueHard = $('#btn-continue-hard');
const modeBanner = $('#mode-banner');
const toastEl = $('#toast');
const bonusFlash = $('#bonus-flash');
const bonusChoiceOverlay = $('#bonus-choice-overlay');
const bonusChoiceDrawing = $('#bonus-choice-drawing');
const bonusChoiceDetail = $('#bonus-choice-detail');
const btnBonusReroll = $('#btn-bonus-reroll');
const activityNotice = $('#activity-notice');
const jokerCountEl = $('#joker-count');

let pendingBonusCategory = null;
let rerollRemaining = 0;
let freeCheckCategory = null;
let bonusRerollCount = 3;
let jokerRerollActive = false;
let tiersToWin = 1;
let pendingLegendaryConfirm = null;
let pendingLegendaryConfirmTimeout = null;
let editingGridCode = null;
let editingGridToken = null;
let pendingJoinFallback = null;

const CUSTOM_LABEL_MAX = 38;
const CUSTOM_GRID_COUNTS = { ordinaire: 12, semi: 6, rare: 2, legendaire: 1 };

function updateModeBanner() {
  if (modeBanner) modeBanner.hidden = tiersToWin <= 1;
}
const btnBonusFreecheck = $('#btn-bonus-freecheck');

function showScreen(screen) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

let toastTimeout;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function showError(msg) {
  errorMsg.textContent = msg;
  setTimeout(() => { if (errorMsg.textContent === msg) errorMsg.textContent = ''; }, 4000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function resetGameState() {
  roomCode = null;
  myGrid = null;
  myChecked = emptyChecked();
  myOccurrences = emptyOccurrences();
  myBonuses = emptyBonuses();
  rerollRemaining = 0;
  bonusRerollCount = 3;
  jokerRerollActive = false;
  freeCheckCategory = null;
  pendingBonusCategory = null;
  tiersToWin = 1;
  clearLegendaryConfirm();
  updateModeBanner();
  closeBonusChoice();
  closePanel();
  updateJokerSlot();
  setStoredSessionValue(SESSION_ROOM_KEY, null);
  setStoredSessionValue(SESSION_NAME_KEY, null);
}

let activityNoticeTimeout;
function showActivityNotice(msg) {
  if (!activityNotice) return;
  activityNotice.textContent = msg;
  activityNotice.classList.add('show');
  window.clearTimeout(activityNoticeTimeout);
  activityNoticeTimeout = window.setTimeout(() => activityNotice.classList.remove('show'), 2200);
}

function applyLocalToggle(category, index) {
  const checked = myChecked[category] || [];
  const wasChecked = checked.includes(index);

  myChecked = {
    ...myChecked,
    [category]: wasChecked ? checked.filter(i => i !== index) : [...checked, index],
  };

  const nextOccurrences = { ...(myOccurrences[category] || {}) };
  if (wasChecked) {
    delete nextOccurrences[index];
  } else {
    nextOccurrences[index] = 1;
  }

  myOccurrences = {
    ...myOccurrences,
    [category]: nextOccurrences,
  };

  return wasChecked;
}

function clearLegendaryConfirm() {
  pendingLegendaryConfirm = null;
  window.clearTimeout(pendingLegendaryConfirmTimeout);
  pendingLegendaryConfirmTimeout = null;
  document.querySelectorAll('.legendary-confirm').forEach(cell => cell.classList.remove('legendary-confirm'));
}

function requestLegendaryConfirm(cell, index) {
  clearLegendaryConfirm();
  pendingLegendaryConfirm = index;
  cell.classList.add('legendary-confirm');
  showToast('Légendaire : retape pour confirmer');
  pendingLegendaryConfirmTimeout = window.setTimeout(clearLegendaryConfirm, 3500);
}

function updateJokerSlot() {
  if (!btnJoker || !jokerCountEl) return;
  const count = myBonuses.joker || 0;
  const bonusRerollActive = rerollRemaining > 0 && !jokerRerollActive;
  jokerCountEl.textContent = count;
  btnJoker.classList.toggle('has-bonus', count > 0 || jokerRerollActive || bonusRerollActive);
  btnJoker.disabled = count <= 0 && !jokerRerollActive && !bonusRerollActive;
  const label = jokerRerollActive ? 'Annuler le joker' : bonusRerollActive ? 'Annuler le reroll' : (count > 0 ? `Joker disponible x${count}` : 'Aucun joker disponible');
  btnJoker.title = label;
  btnJoker.setAttribute('aria-label', label);
}

function applyPendingBonusState(pendingBonus) {
  pendingBonusCategory = null;
  freeCheckCategory = null;
  rerollRemaining = 0;
  bonusRerollCount = 3;
  jokerRerollActive = false;
  closeBonusChoice();

  if (!pendingBonus) return;

  if (pendingBonus.type === 'bonus-choice') {
    pendingBonusCategory = pendingBonus.category;
    bonusRerollCount = pendingBonus.rerollCount || 3;
    bonusChoiceDrawing.textContent = '🎰';
    bonusChoiceDetail.textContent = `Catégorie : ${TIER_NAMES[pendingBonus.category]}`;
    btnBonusReroll.textContent = `Rejouer ${bonusRerollCount} cases`;
    bonusChoiceOverlay.classList.add('active');
  } else if (pendingBonus.type === 'free-check') {
    freeCheckCategory = pendingBonus.category || '*';
  } else if (pendingBonus.type === 'reroll-picks') {
    rerollRemaining = pendingBonus.remaining || 0;
    jokerRerollActive = pendingBonus.source === 'joker';
  }
}

function showWinnerState(winner, { playEffects = true } = {}) {
  if (!winner) return;
  winOverlay.className = 'overlay active win-tier-' + winner.category;
  winDrawing.textContent = categoryEmoji({ id: winner.category, label: TIER_NAMES[winner.category] || winner.category });
  winTitle.textContent = winner.name === playerName ? 'Tu as gagné !' : `${winner.name} a gagné !`;
  winDetail.textContent = winner.category === 'legendaire'
    ? 'Case légendaire cochée : victoire instantanée'
    : winner.hard
      ? '2 grilles complétées en mode hardcore !'
      : `Grille "${TIER_NAMES[winner.category] || winner.category}" complétée`;
  btnNewGame.style.display = 'block';
  if (playEffects) {
    playWinCasinoSound(winner.category);
    restartWinBurst();
    const winAnims = { ordinaire: winAnimOrdinaire, semi: winAnimSemi, rare: winAnimRare, legendaire: winAnimLegendaire };
    (winAnims[winner.category] || winAnimOrdinaire)();
  }
}

function restartWinBurst() {
  [winContent, winDrawing, winTitle].forEach(el => {
    if (!el) return;
    el.classList.remove('win-burst');
    void el.offsetWidth;
    el.classList.add('win-burst');
  });
  window.clearTimeout(restartWinBurst.timeout);
  restartWinBurst.timeout = window.setTimeout(() => {
    [winContent, winDrawing, winTitle].forEach(el => el && el.classList.remove('win-burst'));
  }, 750);
}

let bgMusic = null;
function startBgMusic() {
  if (bgMusic) return;
  bgMusic = new Audio('/sociolobingo.mp3');
  bgMusic.loop = false;
  bgMusic.volume = 0.8;
  bgMusic.play().catch(() => {});
}

function playSocioloIntro() {
  if (!bgMusic) {
    startBgMusic();
    return;
  }
  bgMusic.currentTime = 0;
  bgMusic.play().catch(() => {});
}

const SFX_VOLUME = 0.8;
const sfxCache = {};
const SFX_FILES = [
  '/ordinaire.mp3', '/semi-ordinaire.mp3', '/rare.mp3', '/legendaire.mp3',
  '/bonus.mp3', '/bonusSound.mp3', '/jokersound.mp3', '/multipick.mp3', '/sociolobingo.mp3',
  '/win-ordinaire.mp3', '/win-semi.mp3', '/win-rare.mp3', '/win-legendaire.mp3',
];

function preloadSounds() {
  SFX_FILES.forEach(src => {
    const a = new Audio(src);
    a.preload = 'auto';
    a.volume = SFX_VOLUME;
    sfxCache[src] = a;
  });
}
preloadSounds();

function playSfx(src) {
  const cached = sfxCache[src];
  if (cached) {
    const clone = cached.cloneNode();
    clone.volume = SFX_VOLUME;
    clone.play().catch(() => {});
    return;
  }
  const sfx = new Audio(src);
  sfx.volume = SFX_VOLUME;
  sfx.play().catch(() => {});
}

function playTapSound(category, wasChecked) {
  if (wasChecked) return;
  playSfx('/semi-ordinaire.mp3');
}

function playWinCasinoSound(category) {
  const files = {
    ordinaire: '/win-ordinaire.mp3',
    semi: '/win-semi.mp3',
    rare: '/win-rare.mp3',
    legendaire: '/win-legendaire.mp3',
  };
  playSfx(files[category] || files.ordinaire);
}

function winAnimOrdinaire() {
  launchEmojiConfetti();
  setTimeout(() => launchEmojiConfetti(), 500);
  const content = document.querySelector('.win-content');
  if (content) {
    content.style.animation = 'slam 0.28s ease, winShake 0.2s ease 4';
    setTimeout(() => content.style.animation = 'slam 0.28s ease', 1200);
  }
  const overlay = document.querySelector('#win-overlay');
  if (overlay) {
    overlay.style.animation = 'winPulse 0.4s ease 3';
    setTimeout(() => overlay.style.animation = '', 1400);
  }
}

function winAnimSemi() {
  for (let i = 0; i < 3; i++) setTimeout(() => launchEmojiConfetti(), i * 350);
  const content = document.querySelector('.win-content');
  if (content) {
    content.style.animation = 'slam 0.28s ease, winShake 0.12s ease 10, winGlow 0.3s ease infinite alternate';
    setTimeout(() => content.style.animation = 'slam 0.28s ease', 2500);
  }
  const overlay = document.querySelector('#win-overlay');
  if (overlay) {
    overlay.style.animation = 'winPulse 0.3s ease 6';
    setTimeout(() => overlay.style.animation = '', 2000);
  }
  document.body.style.animation = 'screenShake 0.15s linear 6';
  setTimeout(() => document.body.style.animation = '', 1000);
}

function winAnimRare() {
  for (let i = 0; i < 4; i++) setTimeout(() => launchEmojiConfetti(), i * 300);
  const content = document.querySelector('.win-content');
  if (content) {
    content.style.animation = 'winShake 0.15s ease 8, winGlow 0.6s ease infinite alternate';
    setTimeout(() => content.style.animation = 'slam 0.28s ease', 2500);
  }
  const overlay = document.querySelector('#win-overlay');
  if (overlay) {
    overlay.style.animation = 'winPulse 0.3s ease 6';
    setTimeout(() => overlay.style.animation = '', 2000);
  }
}

function winAnimLegendaire() {
  if (prefersReducedMotion()) return;
  const chaos = document.createElement('div');
  chaos.id = 'legendaire-chaos';
  chaos.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none;overflow:hidden';
  document.body.appendChild(chaos);

  for (let i = 0; i < 8; i++) setTimeout(() => launchEmojiConfetti(), i * 250);

  const rainbow = document.createElement('div');
  rainbow.style.cssText = 'position:fixed;inset:0;z-index:9997;pointer-events:none;animation:rainbowFlash 0.15s linear infinite;mix-blend-mode:overlay;opacity:0.6';
  chaos.appendChild(rainbow);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const emojiRain = [];
  for (let i = 0; i < 30; i++) {
    const drop = document.createElement('span');
    drop.textContent = CONFETTI_EMOJIS[Math.floor(Math.random() * CONFETTI_EMOJIS.length)];
    const startX = Math.random() * w;
    drop.style.cssText = `position:absolute;left:0;top:0;font-size:${1.5 + Math.random() * 2}rem;opacity:0.85;will-change:transform;`;
    chaos.appendChild(drop);
    emojiRain.push({ el: drop, x: startX, y: -30 - Math.random() * h * 0.2, speed: 2 + Math.random() * 4, wobble: Math.random() * 3 - 1.5 });
  }

  document.body.style.animation = 'screenShake 0.08s linear infinite';

  let flip = false;
  const flipInterval = setInterval(() => {
    flip = !flip;
    document.body.style.transform = flip ? `rotate(${(Math.random() - 0.5) * 6}deg) scale(${0.97 + Math.random() * 0.06})` : '';
  }, 200);

  const content = document.querySelector('.win-content');
  if (content) {
    content.style.animation = 'legendSpin 0.5s ease infinite alternate, winGlow 0.2s ease infinite alternate';
  }

  const title = document.querySelector('#win-title');
  if (title) {
    title.style.animation = 'textGlitch 0.1s steps(2) infinite';
  }

  const startRain = performance.now();
  function rainTick(now) {
    if (now - startRain > 5000) return;
    emojiRain.forEach(d => {
      d.y += d.speed;
      d.x += d.wobble;
      if (d.y > h + 30) { d.y = -30; d.x = Math.random() * w; }
      d.el.style.transform = `translate(${d.x}px,${d.y}px)`;
    });
    requestAnimationFrame(rainTick);
  }
  requestAnimationFrame(rainTick);

  setTimeout(() => {
    clearInterval(flipInterval);
    document.body.style.animation = '';
    document.body.style.transform = '';
    if (content) content.style.animation = 'slam 0.28s ease';
    if (title) title.style.animation = '';
    chaos.remove();
  }, 5000);
}

function playBonusChoiceSound() {
  playSfx('/bonusSound.mp3');
}

function playJokerSound() {
  playSfx('/jokersound.mp3');
}

function playRerollSound() {
  playSfx('/bonus.mp3');
}

function playFreeCheckSound() {
  playRerollSound();
}

function playMultipickSound() {
  playSfx('/multipick.mp3');
}

const CONFETTI_EMOJIS = [
  '👴','🧥','🎩','🐩','🛒','👒','⚓','🎓','☮️','😤','📸','👶','📦','🧢','😎',
  '🔥','😾','😁','😢','📱','👔','🤪','🛵','🚕','🤝','👨‍🦲','🧔','🚲','👗','💋',
  '🛴','🏃','🧶','🍔','😂','👢','🏝️','🪣','🎸','🪖','🎧','🔊','🦯','🧒','🤓',
  '💇','🍺','🌿','🏋️','🤳','💃','⏰','📖','💏','🗣️','🛹','🎭','🥾','🚨','💀',
  '🧣','💔','🚬','🙏','🌈','😭','🎪','🚓','🥊','💦','💥','🦶','🤘','🪑','📲',
  '🤣','💒','📄','🎈','🐦','🦹','🫣','🦅','🫦','💩','👯','🪈','🦸','⚡','🎉',
];

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function launchEmojiConfetti() {
  if (prefersReducedMotion()) return;
  const count = 40;
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;overflow:hidden';
  document.body.appendChild(container);

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const particles = [];

  for (let i = 0; i < count; i++) {
    const el = document.createElement('span');
    el.textContent = CONFETTI_EMOJIS[Math.floor(Math.random() * CONFETTI_EMOJIS.length)];
    const angle = Math.random() * Math.PI * 2;
    const speed = 5 + Math.random() * 10;
    const size = 1.4 + Math.random() * 1.2;
    el.style.cssText = `position:absolute;font-size:${size}rem;left:0;top:0;will-change:transform;opacity:1;`;
    container.appendChild(el);
    particles.push({
      el,
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 5,
      rot: 0,
      vr: (Math.random() - 0.5) * 18,
    });
  }

  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    if (elapsed > 2000) { container.remove(); return; }
    const fade = elapsed > 1000 ? Math.max(0, 1 - (elapsed - 1000) / 1000) : 1;
    if (fade < 1) container.style.opacity = fade;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.3;
      p.rot += p.vr;
      p.el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function showBonusFlash(message) {
  bonusFlash.textContent = message;
  bonusFlash.classList.remove('show');
  window.requestAnimationFrame(() => bonusFlash.classList.add('show'));
  window.clearTimeout(showBonusFlash.timeout);
  showBonusFlash.timeout = window.setTimeout(() => bonusFlash.classList.remove('show'), 1500);
}

function showBonusChoice(category) {
  pendingBonusCategory = category;
  playBonusChoiceSound();
  launchEmojiConfetti();
  showBonusFlash('Bonus !');
  bonusChoiceDrawing.textContent = '🎰';
  bonusChoiceDetail.textContent = `Catégorie : ${TIER_NAMES[category]}`;
  btnBonusReroll.textContent = `Rejouer ${bonusRerollCount} cases`;
  bonusChoiceOverlay.classList.add('active');
}

function closeBonusChoice() {
  pendingBonusCategory = null;
  bonusChoiceOverlay.classList.remove('active');
}

function animateFreeCheckCell(cell) {
  if (!cell) return;
  cell.classList.remove('freecheck-hit');
  window.requestAnimationFrame(() => {
    cell.classList.add('freecheck-hit');
  });
  window.clearTimeout(animateFreeCheckCell.timeout);
  animateFreeCheckCell.timeout = window.setTimeout(() => {
    cell.classList.remove('freecheck-hit');
  }, 420);
}

function animateRerollCell(cell) {
  if (!cell) return;
  cell.classList.remove('reroll-hit');
  window.requestAnimationFrame(() => {
    cell.classList.add('reroll-hit');
  });
  window.clearTimeout(animateRerollCell.timeout);
  animateRerollCell.timeout = window.setTimeout(() => {
    cell.classList.remove('reroll-hit');
  }, 520);
}

function emitSocket(eventName, payload, ack) {
  if (!socket) {
    showError('Multijoueur indisponible : il faut lancer le serveur Node/Socket.IO.');
    return false;
  }
  const sessionEvents = new Set([
    'toggle-cell',
    'repeat-cell',
    'free-check-cell',
    'reroll-cell',
    'use-joker',
    'choose-bonus',
    'new-game',
  ]);
  const payloadWithSession = sessionEvents.has(eventName) && payload && typeof payload === 'object'
    ? { ...payload, roomCode, clientId }
    : payload;
  socket.emit(eventName, payloadWithSession, ack);
  return true;
}

function requestSessionResume() {
  if (!socket || !socket.connected) return;
  const storedRoomCode = roomCode || getStoredSessionValue(SESSION_ROOM_KEY);
  const storedPlayerName = playerName || getStoredSessionValue(SESSION_NAME_KEY);
  if (!storedRoomCode || !storedPlayerName) return;
  roomCode = storedRoomCode;
  playerName = storedPlayerName;
  socket.emit('resume-session', { roomCode: storedRoomCode, playerName: storedPlayerName, clientId });
}

if (!socket) {
  showError('GitHub Pages seul ne peut pas lancer les parties multijoueurs.');
  [btnCreate, btnJoin].forEach(btn => {
    btn.disabled = true;
    btn.title = 'Serveur temps réel requis';
  });
}

function emptyCustomCategories() {
  return TIERS.reduce((acc, tier) => {
    acc[tier] = Array.from({ length: CUSTOM_GRID_COUNTS[tier] }, () => ({ label: '', emojis: [''] }));
    return acc;
  }, {});
}

function customItemRow(tier, item = {}) {
  const row = document.createElement('div');
  row.className = 'custom-item-row';
  row.dataset.tier = tier;

  const emojiInput = document.createElement('input');
  emojiInput.type = 'text';
  emojiInput.className = 'custom-emoji-input';
  emojiInput.maxLength = 8;
  emojiInput.placeholder = '🎲';
  emojiInput.value = Array.isArray(item.emojis) ? item.emojis.join('') : '';
  emojiInput.addEventListener('input', () => {
    emojiInput.dataset.autoEmoji = '';
  });

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'custom-label-input';
  labelInput.maxLength = CUSTOM_LABEL_MAX;
  labelInput.placeholder = 'Texte de la case';
  labelInput.value = item.label || '';
  labelInput.addEventListener('input', () => {
    const currentEmoji = emojiInput.value.trim();
    if (currentEmoji && currentEmoji !== emojiInput.dataset.autoEmoji) return;
    const suggestedEmoji = suggestEmojiForText(labelInput.value);
    if (!suggestedEmoji) return;
    emojiInput.value = suggestedEmoji;
    emojiInput.dataset.autoEmoji = suggestedEmoji;
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-mini';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => row.remove());

  row.append(emojiInput, labelInput, removeBtn);
  return row;
}

function renderCustomGridEditor(categories = emptyCustomCategories()) {
  customGridEditor.innerHTML = '';
  TIERS.forEach(tier => {
    const section = document.createElement('section');
    section.className = `custom-editor-section ${tier}`;
    section.innerHTML = `
      <div class="custom-editor-header">
        <h2>${TIER_NAMES[tier]}</h2>
        <span>${CUSTOM_GRID_COUNTS[tier]} minimum</span>
      </div>
      <div class="custom-items" data-tier="${tier}"></div>
    `;
    const list = section.querySelector('.custom-items');
    const items = categories[tier]?.length ? categories[tier] : emptyCustomCategories()[tier];
    items.forEach(item => list.appendChild(customItemRow(tier, item)));

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary btn-add-row';
    addBtn.textContent = 'Ajouter une case';
    addBtn.addEventListener('click', () => list.appendChild(customItemRow(tier)));
    section.appendChild(addBtn);
    customGridEditor.appendChild(section);
  });
}

function collectCustomGridPayload() {
  const categories = emptyChecked();
  TIERS.forEach(tier => {
    categories[tier] = [...customGridEditor.querySelectorAll(`.custom-items[data-tier="${tier}"] .custom-item-row`)]
      .map(row => {
        const label = row.querySelector('.custom-label-input').value.trim();
        const emojis = Array.from(row.querySelector('.custom-emoji-input').value.trim()).slice(0, 2);
        return { label, emojis };
      })
      .filter(item => item.label);
  });

  return {
    name: gridNameInput.value.trim(),
    subject: gridSubjectInput.value.trim(),
    isPublic: gridPublicInput.checked,
    categories,
  };
}

function showEditorResult(grid) {
  const editUrl = `${window.location.origin}${window.location.pathname}?editGrid=${encodeURIComponent(grid.code)}&token=${encodeURIComponent(grid.editToken)}`;
  editorResult.hidden = false;
  editorResult.innerHTML = `
    <strong>Grille publiée</strong>
    <span>Code jeu : ${grid.code}</span>
    <span>Lien secret d’édition :</span>
    <button class="btn-mini" type="button" data-copy="${editUrl}">Copier le lien</button>
    <button class="btn-mini" type="button" data-play="${grid.code}">Jouer avec</button>
  `;
  editorResult.querySelector('[data-copy]').addEventListener('click', async () => {
    await navigator.clipboard?.writeText(editUrl);
    showToast('Lien d’édition copié');
  });
  editorResult.querySelector('[data-play]').addEventListener('click', () => {
    inputCode.value = grid.code;
    showScreen(screenHome);
    showToast(`Code grille ${grid.code} prêt`);
  });
}

async function saveCustomGrid() {
  const payload = collectCustomGridPayload();
  const url = editingGridCode && editingGridToken
    ? `/api/custom-grids/${encodeURIComponent(editingGridCode)}/edit/${encodeURIComponent(editingGridToken)}`
    : '/api/custom-grids';
  const response = await fetch(url, {
    method: editingGridCode ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, clientId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(data.error || 'Grille invalide');
    return;
  }
  editingGridCode = data.grid.code;
  editingGridToken = data.grid.editToken;
  rememberMyGrid(data.grid);
  btnSaveCustomGrid.textContent = 'Sauvegarder la grille';
  showEditorResult(data.grid);
  loadCustomGrids();
}

function openGridEditor(grid = null) {
  loadSemanticEmoji(); // warm up the vector table while the user fills the form
  editingGridCode = grid?.code || null;
  editingGridToken = grid?.editToken || null;
  gridNameInput.value = grid?.name || '';
  gridSubjectInput.value = grid?.subject || '';
  gridPublicInput.checked = grid?.isPublic !== false;
  editorResult.hidden = true;
  editorResult.innerHTML = '';
  btnSaveCustomGrid.textContent = editingGridCode ? 'Sauvegarder la grille' : 'Publier la grille';
  renderCustomGridEditor(grid?.categories || emptyCustomCategories());
  showScreen(screenGridEditor);
}

function selectGridToPlay(code) {
  inputCode.value = code;
  closeCustomGridPanel();
  showToast(`Grille ${code} sélectionnée`);
}

async function editMyGrid(code, token) {
  try {
    const response = await fetch(`/api/custom-grids/${encodeURIComponent(code)}/edit/${encodeURIComponent(token)}`);
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      rememberMyGrid(data.grid);
      closeCustomGridPanel();
      openGridEditor(data.grid);
    } else {
      forgetMyGrid(code);
      showToast('Cette grille n’existe plus');
      loadCustomGrids();
    }
  } catch {
    showToast('Connexion impossible');
  }
}

function renderMyGridsSection(mine) {
  const codes = Object.keys(mine).sort((a, b) => (mine[b].updatedAt || 0) - (mine[a].updatedAt || 0));
  if (!codes.length) return;
  const section = document.createElement('div');
  section.className = 'my-grids-section';
  const heading = document.createElement('p');
  heading.className = 'custom-grids-subtitle';
  heading.textContent = 'Mes grilles (cette machine)';
  section.appendChild(heading);
  codes.forEach(code => {
    const entry = mine[code];
    const card = document.createElement('article');
    card.className = 'custom-grid-card mine';
    card.innerHTML = `
      <div>
        <strong>${escapeHtml(entry.name || code)}</strong>
        <span>${entry.subject ? `${escapeHtml(entry.subject)} · ` : ''}${escapeHtml(code)}</span>
      </div>
      <div class="custom-grid-card-actions">
        <button class="btn-mini" type="button" data-edit>Éditer</button>
        <button class="btn-mini" type="button" data-play>Jouer</button>
      </div>
    `;
    card.querySelector('[data-edit]').addEventListener('click', () => editMyGrid(code, entry.token));
    card.querySelector('[data-play]').addEventListener('click', () => selectGridToPlay(code));
    section.appendChild(card);
  });
  customGridsList.appendChild(section);
}

async function loadCustomGrids() {
  if (!customGridsList) return;
  const mine = getMyGrids();
  customGridsList.innerHTML = '';
  renderMyGridsSection(mine);

  const publicWrap = document.createElement('div');
  publicWrap.className = 'public-grids-section';
  const heading = document.createElement('p');
  heading.className = 'custom-grids-subtitle';
  heading.textContent = 'Grilles publiques';
  publicWrap.appendChild(heading);
  const status = document.createElement('p');
  status.className = 'muted';
  status.textContent = 'Chargement...';
  publicWrap.appendChild(status);
  customGridsList.appendChild(publicWrap);

  try {
    const response = await fetch('/api/custom-grids');
    const data = await response.json();
    const grids = (data.grids || []).filter(grid => !mine[grid.code]);
    status.remove();
    if (!grids.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Aucune autre grille publique pour le moment.';
      publicWrap.appendChild(empty);
      return;
    }
    grids.forEach(grid => {
      const card = document.createElement('article');
      card.className = 'custom-grid-card';
      card.innerHTML = `
        <div>
          <strong>${escapeHtml(grid.name)}</strong>
          <span>${escapeHtml(grid.subject)} · ${escapeHtml(grid.code)}</span>
        </div>
        <button class="btn-mini" type="button">Jouer</button>
      `;
      card.querySelector('button').addEventListener('click', () => selectGridToPlay(grid.code));
      publicWrap.appendChild(card);
    });
  } catch {
    status.textContent = 'Impossible de charger les grilles.';
  }
}

async function openEditorFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('editGrid');
  const token = params.get('token');
  if (!code || !token) return;
  try {
    const response = await fetch(`/api/custom-grids/${encodeURIComponent(code.toUpperCase())}/edit/${encodeURIComponent(token)}`);
    const data = await response.json();
    if (response.ok) {
      rememberMyGrid(data.grid);
      openGridEditor(data.grid);
    }
  } catch {}
}

// --- HOME ACTIONS ---

btnCreate.addEventListener('click', () => {
  const name = inputName.value.trim();
  const customGridCode = inputCode.value.trim().toUpperCase();
  if (!name) { showError('Entre ton prénom !'); return; }
  playerName = name;
  setStoredSessionValue(SESSION_NAME_KEY, playerName);
  startBgMusic();
  emitSocket('create-room', { playerName: name, clientId, customGridCode });
});

btnJoin.addEventListener('click', () => {
  const name = inputName.value.trim();
  const code = inputCode.value.trim().toUpperCase();
  if (!name) { showError('Entre ton prénom !'); return; }
  if (!code || code.length < 4) { showError('Code à 4 caractères !'); return; }
  playerName = name;
  setStoredSessionValue(SESSION_NAME_KEY, playerName);
  startBgMusic();
  pendingJoinFallback = { playerName: name, customGridCode: code };
  emitSocket('join-room', { code, playerName: name, clientId });
});

btnInfo.addEventListener('click', () => {
  window.location.href = '/info.html';
});

btnOpenGridEditor.addEventListener('click', () => openGridEditor());
btnEditorBack.addEventListener('click', () => showScreen(screenHome));
btnRefreshCustomGrids.addEventListener('click', loadCustomGrids);
btnSaveCustomGrid.addEventListener('click', () => {
  saveCustomGrid().catch(() => showToast('Erreur de sauvegarde'));
});

inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (inputCode.value.trim().length >= 4) {
      btnJoin.click();
    } else {
      btnCreate.click();
    }
  }
});

inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

// --- SOCKET EVENTS ---

if (socket) {
  socket.on('connect', () => {
    myId = socket.id;
    requestSessionResume();
  });

  socket.on('connect_error', () => {
    showError('Connexion temps réel impossible : serveur Socket.IO requis.');
  });

  socket.on('room-created', ({ code, grid, tiersToWin: t }) => {
    pendingJoinFallback = null;
    roomCode = code;
    setStoredSessionValue(SESSION_ROOM_KEY, roomCode);
    myGrid = grid;
    gridBuilt = false;
    myChecked = emptyChecked();
    myOccurrences = emptyOccurrences();
    myBonuses = emptyBonuses();
    updateJokerSlot();
    rerollRemaining = 0;
    bonusRerollCount = 3;
    tiersToWin = t || 1;
    updateModeBanner();
    enterGame();
  });

  socket.on('room-joined', ({ code, grid, tiersToWin: t }) => {
    pendingJoinFallback = null;
    roomCode = code;
    setStoredSessionValue(SESSION_ROOM_KEY, roomCode);
    myGrid = grid;
    gridBuilt = false;
    myChecked = emptyChecked();
    myOccurrences = emptyOccurrences();
    myBonuses = emptyBonuses();
    updateJokerSlot();
    rerollRemaining = 0;
    bonusRerollCount = 3;
    tiersToWin = t || 1;
    updateModeBanner();
    enterGame();
  });

  socket.on('error-msg', (msg) => {
    if (msg === 'Salon introuvable !' && pendingJoinFallback) {
      const fallback = pendingJoinFallback;
      pendingJoinFallback = null;
      emitSocket('create-room', {
        playerName: fallback.playerName,
        clientId,
        customGridCode: fallback.customGridCode,
      });
      return;
    }
    pendingJoinFallback = null;
    showError(msg);
  });

  socket.on('grid-update', (checked) => {
    const state = checked.checked ? checked : { checked };
    myChecked = { ...emptyChecked(), ...state.checked };
    myOccurrences = { ...emptyOccurrences(), ...(state.occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(state.bonuses || {}) };
    updateJokerSlot();
    renderGrid();
  });

  socket.on('session-restored', (state) => {
    roomCode = state.code || roomCode;
    if (roomCode) setStoredSessionValue(SESSION_ROOM_KEY, roomCode);
    if (state.players?.length && playerName) setStoredSessionValue(SESSION_NAME_KEY, playerName);
    myGrid = state.grid || myGrid;
    gridBuilt = false;
    myChecked = { ...emptyChecked(), ...(state.checked || {}) };
    myOccurrences = { ...emptyOccurrences(), ...(state.occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(state.bonuses || {}) };
    updateJokerSlot();
    tiersToWin = state.tiersToWin || 1;
    updateModeBanner();
    applyPendingBonusState(state.pendingBonus);
    showScreen(screenGame);
    displayCode.textContent = roomCode;

    if (state.winner) {
      showWinnerState(state.winner, { playEffects: false });
    } else {
      winOverlay.className = 'overlay';
      btnNewGame.style.display = 'none';
    }

    renderGrid();
  });

  socket.on('session-resume-failed', ({ reason }) => {
    if (reason) showToast(reason);
    setStoredSessionValue(SESSION_ROOM_KEY, null);
    setStoredSessionValue(SESSION_NAME_KEY, null);
    roomCode = null;
    playerName = null;
    if (screenGame.classList.contains('active')) {
      showScreen(screenHome);
    }
  });

  socket.on('occurrence-update', ({ category, count, occurrences, bonuses }) => {
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || myOccurrences) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || myBonuses) };
    updateJokerSlot();
    showToast(`${TIER_NAMES[category]} x${count}`);
    renderGrid();
  });

  socket.on('bonus-choice-start', ({ category, rerollCount }) => {
    bonusRerollCount = rerollCount || 3;
    showBonusChoice(category);
    renderGrid();
  });

  socket.on('reroll-bonus-start', ({ remaining, source }) => {
    rerollRemaining = remaining;
    jokerRerollActive = source === 'joker';
    showToast(jokerRerollActive
      ? 'Choisis 1 case à rejouer (re-clique le joker pour annuler)'
      : `Choisis ${remaining} case${remaining > 1 ? 's' : ''} à rejouer ! (re-clique 🃏 pour annuler)`);
    updateJokerSlot();
    renderGrid();
  });

  socket.on('joker-cancelled', ({ count }) => {
    jokerRerollActive = false;
    rerollRemaining = 0;
    myBonuses = { ...myBonuses, joker: count };
    updateJokerSlot();
    showToast('Joker annulé, remis en stock');
    renderGrid();
  });

  socket.on('free-check-start', ({ category, source }) => {
    freeCheckCategory = category || '*';
    if (source === 'poesie') {
      playBonusChoiceSound();
      showBonusFlash('Poésie !');
      showToast(`Bonus poésie : coche une case en plus dans ${TIER_NAMES[category]} !`);
    } else {
      showToast(`Coche une case gratis dans ${TIER_NAMES[category]}`);
    }
    renderGrid();
  });

  socket.on('free-check-done', ({ category, index, checked, occurrences, bonuses }) => {
    freeCheckCategory = null;
    myChecked = { ...emptyChecked(), ...(checked || {}) };
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || {}) };
    updateJokerSlot();
    playFreeCheckSound();
    showToast('Case cochée gratis !');
    renderGrid();
    animateFreeCheckCell(document.querySelector(`#grid-${category} [data-idx="${index}"]`));
  });

  socket.on('joker-earned', ({ count }) => {
    myBonuses = { ...myBonuses, joker: count };
    updateJokerSlot();
    playJokerSound();
    showToast(count > 1 ? `Joker gagné x${count} !` : 'Joker gagné !');
    if (btnJoker) {
      btnJoker.classList.remove('joker-pop');
      void btnJoker.offsetWidth;
      btnJoker.classList.add('joker-pop');
      window.clearTimeout(updateJokerSlot.timeout);
      updateJokerSlot.timeout = window.setTimeout(() => btnJoker.classList.remove('joker-pop'), 600);
    }
  });

  socket.on('cell-activity', ({ playerId, name, category, index, label, checked }) => {
    if (playerId && playerId === myId) return;
    const action = checked ? 'a coché' : 'a décoché';
    const itemLabel = (label || `case ${index + 1}`).replace(/\s*\(ultra\)/gi, '');
    showActivityNotice(`${name} ${action} ${TIER_NAMES[category]} · ${itemLabel}`);
  });

  socket.on('reroll-update', ({ grid, checked, occurrences, bonuses, remaining, category, index }) => {
    myGrid = grid;
    gridBuilt = false;
    myChecked = { ...emptyChecked(), ...(checked || {}) };
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || {}) };
    updateJokerSlot();
    rerollRemaining = remaining || 0;
    if (rerollRemaining <= 0) jokerRerollActive = false;
    updateJokerSlot();
    playRerollSound();
    showToast(rerollRemaining > 0 ? `Encore ${rerollRemaining} à rejouer` : 'Rejeu terminé !');
    renderGrid();
    if (category !== undefined && index !== undefined) {
      animateRerollCell(document.querySelector(`#grid-${category} [data-idx="${index}"]`));
    }
  });

  socket.on('players-update', (players) => {
    playerCount.textContent = players.length;
    renderPlayersList(players);
  });

  socket.on('player-joined', (name) => {
    if (name !== playerName) showToast(`${name} a rejoint !`);
  });

  socket.on('player-left', (name) => {
    showToast(`${name} parti`);
  });

  socket.on('game-won', ({ name, category }) => {
    showWinnerState({ name, category }, { playEffects: true });
  });

  socket.on('new-game-started', ({ grid, tiersToWin: t }) => {
    myGrid = grid;
    gridBuilt = false;
    myChecked = emptyChecked();
    myOccurrences = emptyOccurrences();
    myBonuses = emptyBonuses();
    updateJokerSlot();
    rerollRemaining = 0;
    bonusRerollCount = 3;
    jokerRerollActive = false;
    freeCheckCategory = null;
    pendingBonusCategory = null;
    tiersToWin = t || 1;
    updateModeBanner();
    closeBonusChoice();
    winOverlay.className = 'overlay';
    btnNewGame.style.display = 'none';
    document.body.style.animation = '';
    document.body.style.transform = '';
    [winContent, winDrawing, winTitle].forEach(el => el && el.classList.remove('win-burst'));
    const oldChaos = document.getElementById('legendaire-chaos');
    if (oldChaos) oldChaos.remove();
    renderGrid();
    showToast(tiersToWin > 1 ? '🔥 Mode hardcore : 2 grilles à compléter !' : 'Nouvelle partie !');
  });

  socket.on('categories-updated', () => {
    showToast('Catégories mises à jour');
  });
}

// --- GAME ---

function enterGame() {
  displayCode.textContent = roomCode;
  showScreen(screenGame);
  updateJokerSlot();
  renderGrid();
}

const EMOJI_BY_ID = {
  'papi-et-mami': '👵👴', 'doudoune-sans-manche': '🥶🎽', 'femme-et-chien': '🧍‍♀️🐩',
  'vieille-bourgeoise': '👵💎', 'jean-charles-mariniere': '⚓👕', 'poussette': '👶🛒',
  'velo-cargo': '🚲📦', 'caillra': '😈💸', 'deux-amis': '👭', 'drague-de-rue': '😏👀',
  'rasta': '🧔🇯🇲', 'shopper': '🛍️', 'bonnet': '🎅', 'sac-banane': '👝🍌',
  'velo-a-main': '🚶‍♂️🚲', 'porte-un-bebe': '👩‍🍼', 'velo-pliant': '🚲🪗', 'fume-une-cigarette': '🚬',
  'habit-de-groupe-musique': '👕🎸', 'porte-un-maillot-d-une-equipe-de-sport': '👕⚽',
  'punk-a-chien': '🧷🐕', 'panama': '👒🌴', 'cheveux-jusqu-au-fesses': '💇‍♀️',
  'fouille-dans-l-horodateur': '🅿️🔍', 'il-elle-court': '🏃‍♀️', 'trebuche': '💥🤸',
  'jette-megot-par-terre': '🚬👇', 'pull-sur-les-epaules': '👔⛵', 'a-deux-sur-le-velo': '🚲👫',
  'enregistre-danse-tiktok': '📲💃', 'voiture-mariage': '💒🚗', 'vehicule-paris-dakar': '🏜️🏍️',
  'toutounette-actif': '🐕💩', 'on-se-croise-on-hesite': '🤷↔️', 'string-visible': '🍑🩲',
  'poil-de-carotte': '🧑‍🦰🥕', 'full-piercing': '💍🧷',
  'pantalon-vert': '👖🟢', 'chemise-dans-pantalon': '👔👖', 'coupe-afro': '🪮',
  'treilli': '🪖', 'marcel': '🎽', 'bide-a-biere': '🍺🫃', 'homme-et-chien': '🧍‍♂️🐕',
  'corbeau-solo': '🐦‍⬛', 'goeland-solo': '🦅', 'demarche-bizarre': '🚶‍♂️💫',
  'double-mami': '👵👵', 'double-papi': '👴👴',
  'sort-les-poubelles': '🗑️', 'suspect': '🕵️', 'malade': '🤒', 'tache-de-rousseur': '🧑‍🦰',
  'femme-enceinte': '🤰', 'antifa': '🏴', 'deprime': '😔', 'attache-lunette': '👓🪢',
  'gratte-bourse': '🥜', 'decrotte-le-nez': '👃',
};

const EMOJI_SUGGESTION_RULES = [
  { emoji: '💅🐩', all: ['caniche'], any: ['toilett', 'coiffe', 'groom'] },
  { emoji: '🐺', all: ['bataille'], any: ['chien', 'chiens', 'dog', 'clebs'] },
  { emoji: '🐕⚫', all: ['chien'], any: ['noir', 'black'] },
  { emoji: '🐕⚪', all: ['chien'], any: ['blanc', 'white'] },
  { emoji: '🐕🔵', all: ['chien'], any: ['bleu', 'blue'] },
  { emoji: '🧍‍♀️🐩', all: ['femme'], any: ['chien', 'dog', 'caniche'] },
  { emoji: '🧍‍♂️🐕', all: ['homme'], any: ['chien', 'dog', 'caniche'] },
  { emoji: '🐕💩', any: ['toutounette', 'crotte', 'dejection'] },
  { emoji: '🧷🐕', all: ['punk'], any: ['chien', 'dog'] },
  { emoji: '🐩', any: ['caniche'] },
  { emoji: '🐕', any: ['chien', 'chiot', 'toutou', 'clebs', 'dog'] },
  { emoji: '🐈', any: ['chat', 'cat'] },
  { emoji: '🐀', any: ['rat', 'souris'] },
  { emoji: '🕊️', all: ['pigeon'], any: ['solo', 'seul'] },
  { emoji: '🍞🐦', all: ['pigeon'], any: ['mange', 'nourrit', 'pain'] },
  { emoji: '🦅', any: ['goeland', 'mouette'] },
  { emoji: '🐦‍⬛', any: ['corbeau'] },

  { emoji: '👕🎸', all: ['groupe'], any: ['musique', 'concert', 'rock', 'metal', 'tshirt', 't-shirt', 'tee'] },
  { emoji: '⌨️', any: ['clavier', 'keyboard'] },
  { emoji: '🎸', any: ['guitare', 'bassiste', 'guitariste', 'instrument'] },
  { emoji: '🎤', any: ['chante', 'chantent', 'micro', 'karaoke'] },
  { emoji: '🎧', any: ['casque', 'dj'] },
  { emoji: '🔊', any: ['son a donf', 'enceinte', 'haut parleur', 'speaker'] },

  { emoji: '👓🪢', all: ['attache'], any: ['lunette', 'lunettes'] },
  { emoji: '🕶️', all: ['lunette'], any: ['tete', 'soleil'] },
  { emoji: '👓', any: ['lunette', 'lunettes', 'cataracte'] },
  { emoji: '🧢', any: ['casquette'] },
  { emoji: '👒', any: ['panama', 'chapeau'] },
  { emoji: '🥶', any: ['bonnet', 'doudoune', 'froid'] },
  { emoji: '👔', any: ['costard', 'chemise', 'cravate'] },
  { emoji: '👕🔵', all: ['tshirt'], any: ['bleu', 'blue'] },
  { emoji: '👕🔴', all: ['tshirt'], any: ['rouge', 'red'] },
  { emoji: '👕⚫', all: ['tshirt'], any: ['noir', 'black'] },
  { emoji: '👕⚪', all: ['tshirt'], any: ['blanc', 'white'] },
  { emoji: '👕', any: ['tshirt', 't-shirt', 'maillot'] },
  { emoji: '🩲', any: ['string', 'slip', 'calecon'] },
  { emoji: '👟', any: ['lacet', 'basket', 'chaussure'] },
  { emoji: '🛼', any: ['roller'] },
  { emoji: '🐊', any: ['crocs'] },

  { emoji: '🚲📦', all: ['velo'], any: ['cargo', 'cargot'] },
  { emoji: '🚶‍♂️🚲', all: ['velo'], any: ['main'] },
  { emoji: '🚴', all: ['velo'], any: ['deux', '2'] },
  { emoji: '🚵', all: ['velo'], any: ['debout'] },
  { emoji: '🚲', any: ['velo', 'bike', 'velib', 'bicyclette'] },
  { emoji: '🛴', any: ['trottinette', 'trotinette', 'scooter'] },
  { emoji: '🛵', any: ['deliveroo', 'uber eats', 'livreur'] },
  { emoji: '🚕', any: ['taxi'] },
  { emoji: '🚗🔵', all: ['voiture'], any: ['bleu', 'blue'] },
  { emoji: '🚗🔴', all: ['voiture'], any: ['rouge', 'red'] },
  { emoji: '🚗🟢', all: ['voiture'], any: ['vert', 'verte', 'green'] },
  { emoji: '🚗🟡', all: ['voiture'], any: ['jaune', 'yellow'] },
  { emoji: '🚗⚫', all: ['voiture'], any: ['noir', 'noire', 'black'] },
  { emoji: '🚗⚪', all: ['voiture'], any: ['blanc', 'blanche', 'white'] },
  { emoji: '🚗🟣', all: ['voiture'], any: ['violet', 'violette', 'purple'] },
  { emoji: '🚗🟠', all: ['voiture'], any: ['orange'] },
  { emoji: '🚗', any: ['voiture', 'auto ecole', 'creneau'] },
  { emoji: '🅿️', any: ['parking', 'horodateur', 'creneau'] },

  { emoji: '👵👴', any: ['papi et mami', 'papi mami', 'grand parents'] },
  { emoji: '🎩💎', any: ['bourgeois', 'bourgeoise', 'riche', 'mondain'] },
  { emoji: '🫃', any: ['gros', 'grosse', 'obese', 'obèse', 'corpulent', 'ventre'] },
  { emoji: '💪', any: ['muscle', 'musclé', 'musclee', 'stockos', 'baraque'] },
  { emoji: '👵', any: ['mami', 'mamie', 'vieille'] },
  { emoji: '👴', any: ['papi', 'vieux'] },
  { emoji: '👩‍🍼', all: ['porte'], any: ['bebe', 'bébé'] },
  { emoji: '👶', any: ['bebe', 'poussette'] },
  { emoji: '🤰', any: ['enceinte', 'grossesse'] },
  { emoji: '👨‍👦', any: ['pere et fils', 'père et fils'] },
  { emoji: '👩‍👧', any: ['mere et fille', 'mère et fille'] },
  { emoji: '👥', any: ['groupe de pote', 'groupe de potes', 'bande'] },
  { emoji: '👭', any: ['deux amis', 'deux copines'] },
  { emoji: '💑', any: ['couple', 'meuf par le cou'] },
  { emoji: '💔', any: ['embrouille couple', 'rupture'] },
  { emoji: '💏', any: ['embrasse', 'baiser', 'bisou'] },
  { emoji: '💋👠', any: ['pute', 'prostituee', 'prostituée', 'escort', 'tapin'] },
  { emoji: '😏👀', any: ['drague', 'dragueur', 'dragueuse', 'charo'] },

  { emoji: '🎓', any: ['etudiant', 'étudiant', 'fac', 'ecole'] },
  { emoji: '📸', any: ['touriste', 'photo', 'appareil photo'] },
  { emoji: '🛍️', any: ['shopping', 'shopper', 'sacs', 'sac'] },
  { emoji: '🎒', any: ['backpacker', 'sac a dos', 'sac à dos'] },
  { emoji: '💼', any: ['mallette', 'attaché case', 'attaché-case'] },
  { emoji: '🗑️', any: ['poubelle', 'poubelles'] },
  { emoji: '🦯', any: ['canne'] },
  { emoji: '🦮', any: ['aveugle'] },
  { emoji: '🩼', any: ['platre', 'béquille', 'bequille'] },

  { emoji: '🍺', any: ['ivre', 'biere', 'bourre', 'alcool'] },
  { emoji: '🚬', any: ['cigarette', 'clope', 'megot', 'pipe'] },
  { emoji: '💨', any: ['vape', 'vapote', 'vapot'] },
  { emoji: '🍔', any: ['mange', 'burger', 'fast food'] },
  { emoji: '🥖', any: ['baguette', 'pain'] },
  { emoji: '🥤', any: ['canette', 'soda'] },
  { emoji: '💩', any: ['merde', 'caca'] },
  { emoji: '🤮', any: ['vomi', 'vomit'] },

  { emoji: '😎', any: ['style', 'frais', 'cool'] },
  { emoji: '🤨', any: ['chelou', 'bizarre', 'suspect'] },
  { emoji: '🔪', any: ['psycho', 'flippant', 'tueur'] },
  { emoji: '😡', any: ['colere', 'énervé', 'enerve'] },
  { emoji: '😭', any: ['pleure', 'triste'] },
  { emoji: '😁', any: ['heureux', 'happy', 'sourire'] },
  { emoji: '🤣', any: ['fou rire', 'rigole'] },
  { emoji: '🥵', any: ['sueur', 'transpire', 'chaud'] },
  { emoji: '🤡', any: ['clown'] },
  { emoji: '🎭', any: ['deguise', 'déguisé', 'costume'] },
  { emoji: '🦸', any: ['cape', 'super hero', 'superhero'] },
  { emoji: '🖤', any: ['emo', 'dark', 'gothique'] },

  { emoji: '💇', any: ['cheveux', 'coiffure'] },
  { emoji: '💇🔵', all: ['cheveux'], any: ['bleu', 'blue'] },
  { emoji: '💇🟢', all: ['cheveux'], any: ['vert', 'green'] },
  { emoji: '💇🌸', all: ['cheveux'], any: ['rose', 'pink'] },
  { emoji: '🧑‍🦰', any: ['roux', 'rousseur', 'carotte'] },
  { emoji: '👨‍🦲', any: ['calvitie', 'chauve'] },
  { emoji: '🧔', any: ['barbe', 'hipster'] },
  { emoji: '🥸', any: ['moustache'] },
  { emoji: '💍', any: ['piercing'] },
  { emoji: '🐉', any: ['tatouage', 'tattoo'] },

  { emoji: '🏃', any: ['court', 'jogger', 'running'] },
  { emoji: '🛹', any: ['skate'] },
  { emoji: '🤸', any: ['trebuche', 'tombe'] },
  { emoji: '💃', any: ['danse'] },
  { emoji: '📲', any: ['tiktok', 'telephone', 'tel', 'portable'] },
  { emoji: '🗣️', any: ['parle tout seul'] },
  { emoji: '📖', any: ['livre', 'lecture'] },
  { emoji: '🔍', any: ['cherche', 'fouille'] },
  { emoji: '🏖️', any: ['plage', 'sable', 'serviette'] },
  { emoji: '🚉', any: ['gare', 'train', 'quai'] },
  { emoji: '🏙️', any: ['ville', 'quartier'] },
  { emoji: '🚪', any: ['ouvre les portes', 'porte'] },
  { emoji: '🫨', any: ['portiere', 'portière'] },
  { emoji: '⚰️', any: ['cercueil'] },
  { emoji: '🚑', any: ['malaise', 'dead', 'malade'] },
];

function normalizeEmojiText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMOJI_COLOR_MODIFIERS = [
  { emoji: '🔵', roots: ['bleu', 'azur', 'cyan'] },
  { emoji: '🔴', roots: ['rouge', 'red'] },
  { emoji: '🟢', roots: ['vert', 'green'] },
  { emoji: '🟡', roots: ['jaune', 'yellow'] },
  { emoji: '⚫', roots: ['noir', 'black'] },
  { emoji: '⚪', roots: ['blanc', 'white'] },
  { emoji: '🟣', roots: ['violet', 'mauve', 'purple'] },
  { emoji: '🟠', roots: ['orange'] },
  { emoji: '🌸', roots: ['rose', 'pink'] },
  { emoji: '🌈', roots: ['multicolore', 'arcenciel', 'rainbow'] },
];

const SEMANTIC_EMOJI_CONCEPTS = [
  { emoji: '🚗', kind: 'colorable', roots: ['voitur', 'auto', 'bagnol', 'caisse', 'vehicul', 'car'] },
  { emoji: '🚲', kind: 'colorable', roots: ['velo', 'bike', 'bicyclet', 'velib'] },
  { emoji: '🛴', kind: 'colorable', roots: ['trottinett', 'trotinett', 'scooter'] },
  { emoji: '🛵', kind: 'colorable', roots: ['moto', 'scooter', 'livreur', 'deliveroo'] },
  { emoji: '🚕', kind: 'colorable', roots: ['taxi', 'uber'] },
  { emoji: '🚉', roots: ['gare', 'train', 'metro', 'rer', 'quai'] },
  { emoji: '🏖️', roots: ['plage', 'sable', 'serviett', 'mer'] },
  { emoji: '🏙️', roots: ['ville', 'quartier', 'rue', 'place'] },

  { emoji: '🐕', kind: 'colorable', roots: ['chien', 'chiot', 'toutou', 'clebs', 'dog'] },
  { emoji: '🐩', kind: 'colorable', roots: ['canich', 'toilett'] },
  { emoji: '🐈', kind: 'colorable', roots: ['chat', 'cat'] },
  { emoji: '🐀', roots: ['rat', 'souris'] },
  { emoji: '🐦', roots: ['oiseau', 'piaf'] },
  { emoji: '🦅', roots: ['mouett', 'goeland'] },
  { emoji: '🕊️', roots: ['pigeon', 'colomb'] },

  { emoji: '⌨️', roots: ['clavier', 'keyboard'] },
  { emoji: '📱', roots: ['telephone', 'tel', 'portable', 'smartphon'] },
  { emoji: '💻', roots: ['ordinat', 'laptop', 'computer'] },
  { emoji: '🎧', roots: ['casqu', 'ecouteur', 'headphon'] },
  { emoji: '🎤', roots: ['micro', 'chant', 'karaok'] },
  { emoji: '🎸', roots: ['guitar', 'guitare', 'bass', 'instrument'] },
  { emoji: '🔊', roots: ['enceint', 'speaker', 'son', 'bruit'] },
  { emoji: '📸', roots: ['photo', 'camera', 'appareil'] },
  { emoji: '📖', roots: ['livr', 'lectur', 'bouquin'] },
  { emoji: '💼', roots: ['mallet', 'cartabl', 'briefcas'] },
  { emoji: '🛍️', roots: ['shopping', 'sac', 'shopper'] },

  { emoji: '👕', kind: 'colorable', roots: ['tshirt', 'tee', 'maillot', 'habit', 'vetement'] },
  { emoji: '👔', kind: 'colorable', roots: ['costard', 'chemise', 'cravate', 'suit'] },
  { emoji: '🧥', kind: 'colorable', roots: ['manteau', 'doudoun', 'vest', 'jacket'] },
  { emoji: '👗', kind: 'colorable', roots: ['robe', 'jupe'] },
  { emoji: '👟', kind: 'colorable', roots: ['chaussur', 'basket', 'lacet'] },
  { emoji: '👓', roots: ['lunett', 'glass'] },
  { emoji: '🧢', kind: 'colorable', roots: ['casquett', 'cap'] },
  { emoji: '👒', roots: ['chapeau', 'panama'] },

  { emoji: '🫃', roots: ['gros', 'gross', 'obes', 'corpulent', 'ventr', 'bide'] },
  { emoji: '💪', roots: ['muscl', 'baraqu', 'stockos', 'fort'] },
  { emoji: '🎩💎', roots: ['bourgeois', 'bourgeoisie', 'riche', 'mondain', 'chic'] },
  { emoji: '💋👠', roots: ['pute', 'prostitu', 'escort', 'tapin', 'sexy'] },
  { emoji: '😏👀', roots: ['dragu', 'charo', 'flirt'] },
  { emoji: '👶', roots: ['bebe', 'baby', 'poussett'] },
  { emoji: '🤰', roots: ['enceint', 'grossess'] },
  { emoji: '👵', roots: ['mamie', 'mami', 'vieill'] },
  { emoji: '👴', roots: ['papi', 'vieux'] },
  { emoji: '👨‍🦲', roots: ['chauv', 'calviti'] },
  { emoji: '🧔', roots: ['barb', 'hipster'] },
  { emoji: '💇', kind: 'colorable', roots: ['cheveu', 'coiffur'] },

  { emoji: '😎', roots: ['cool', 'styl', 'frais'] },
  { emoji: '🤨', roots: ['chelou', 'bizarre', 'suspect'] },
  { emoji: '🔪', roots: ['psycho', 'flipp', 'tueur', 'dangereux'] },
  { emoji: '😡', roots: ['coler', 'enerve', 'rage'] },
  { emoji: '😭', roots: ['pleur', 'trist'] },
  { emoji: '😁', roots: ['heureux', 'sourir', 'happy'] },
  { emoji: '🤣', roots: ['rire', 'rigol'] },
  { emoji: '🥵', roots: ['sueur', 'transpir', 'chaud'] },
  { emoji: '🤮', roots: ['vomi', 'vomit'] },
  { emoji: '💩', roots: ['merd', 'caca', 'crotte'] },

  { emoji: '🚬', roots: ['cigarett', 'clop', 'megot', 'smok'] },
  { emoji: '🍺', roots: ['biere', 'alcool', 'ivre', 'bourr'] },
  { emoji: '🍔', roots: ['mang', 'burger', 'food', 'sandwich'] },
  { emoji: '🥖', roots: ['pain', 'baguett'] },
  { emoji: '🥤', roots: ['canett', 'soda', 'boisson'] },

  { emoji: '🏃', roots: ['cour', 'jog', 'running'] },
  { emoji: '🛹', roots: ['skate'] },
  { emoji: '💃', roots: ['dans'] },
  { emoji: '🤸', roots: ['tomb', 'trebuch'] },
  { emoji: '🎭', roots: ['deguis', 'costum'] },
  { emoji: '🦸', roots: ['cape', 'superhero', 'superher'] },
  { emoji: '🗑️', roots: ['poubell', 'dechet'] },
  { emoji: '🚪', roots: ['porte'] },
  { emoji: '⚰️', roots: ['cercueil', 'mort'] },
  { emoji: '🚑', roots: ['malaise', 'malad', 'dead'] },
];

function emojiTokens(text) {
  return normalizeEmojiText(text)
    .split(' ')
    .filter(token => token.length > 1)
    .map(token => token.replace(/(es|s)$/g, ''));
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function semanticRootScore(token, root) {
  const normalizedRoot = normalizeEmojiText(root);
  if (token === normalizedRoot) return 12 + normalizedRoot.length;
  if (token.startsWith(normalizedRoot) || normalizedRoot.startsWith(token)) return 8 + Math.min(token.length, normalizedRoot.length);
  if (token.length >= 5 && normalizedRoot.length >= 5 && editDistance(token, normalizedRoot) <= 1) return 6;
  return 0;
}

function findSemanticColor(tokens) {
  let best = null;
  for (const color of EMOJI_COLOR_MODIFIERS) {
    const score = Math.max(...tokens.flatMap(token => color.roots.map(root => semanticRootScore(token, root))));
    if (score > 0 && (!best || score > best.score)) best = { ...color, score };
  }
  return best;
}

function suggestSemanticEmoji(label) {
  const tokens = emojiTokens(label);
  if (!tokens.length) return '';

  const color = findSemanticColor(tokens);
  let best = null;
  for (const concept of SEMANTIC_EMOJI_CONCEPTS) {
    const score = Math.max(...tokens.flatMap(token => concept.roots.map(root => semanticRootScore(token, root))));
    if (score > 0 && (!best || score > best.score)) best = { ...concept, score };
  }

  const hasRoot = (...roots) => tokens.some(token => roots.some(root => semanticRootScore(token, root) > 0));
  if (hasRoot('canich', 'chien') && hasRoot('toilett', 'coiff', 'groom')) return '💅🐩';
  if (hasRoot('lunett') && hasRoot('attach', 'cord', 'chain')) return '👓🪢';
  if (hasRoot('habit', 'vetement', 'tshirt', 'maillot') && hasRoot('groupe', 'music', 'concert', 'rock', 'metal')) return '👕🎸';
  if (hasRoot('bataill', 'bagarr') && hasRoot('chien', 'dog', 'clebs')) return '🐺';

  if (!best) return color?.emoji || '';
  if (color && best.kind === 'colorable') return `${best.emoji}${color.emoji}`;
  return best.emoji;
}

function phraseMatches(text, phrase) {
  return text.includes(normalizeEmojiText(phrase));
}

// --- Semantic (vector) emoji layer -----------------------------------------
// Precomputed word/emoji vectors (built offline by scripts/build-semantic-emoji.mjs).
// No model runs here: we only average int8 vectors and pick the nearest emoji
// by cosine similarity. Loaded lazily the first time the grid editor opens.
const EMOJI_STOPWORDS = new Set([
  'de', 'la', 'le', 'les', 'des', 'du', 'un', 'une', 'et', 'en', 'au', 'aux',
  'a', 'd', 'l', 's', 'ce', 'se', 'sa', 'son', 'ses', 'qui', 'que', 'pour',
  'par', 'sur', 'dans', 'avec', 'ou', 'ne', 'pas', 'il', 'elle', 'on', 'je',
  'tu', 'nous', 'vous', 'ils', 'elles', 'est', 'sont', 'plus', 'tres', 'tout',
]);

let semanticEmojiData = null;       // resolved table once loaded
let semanticEmojiPromise = null;    // in-flight load

function loadSemanticEmoji() {
  if (semanticEmojiPromise) return semanticEmojiPromise;
  semanticEmojiPromise = (async () => {
    try {
      const [manifest, wordsBuf, emojisBuf] = await Promise.all([
        fetch('/data/sem-manifest.json').then(r => r.json()),
        fetch('/data/sem-words.bin').then(r => r.arrayBuffer()),
        fetch('/data/sem-emojis.bin').then(r => r.arrayBuffer()),
      ]);
      const dims = manifest.dims;
      const words = new Int8Array(wordsBuf);
      const emojiVecs = new Int8Array(emojisBuf);
      const wordIndex = new Map();
      const prefixIndex = new Map(); // 4-char prefix -> first (most frequent) row
      manifest.words.forEach((w, i) => {
        wordIndex.set(w, i);
        if (w.length >= 4) {
          const p = w.slice(0, 4);
          if (!prefixIndex.has(p)) prefixIndex.set(p, i);
        }
      });
      // Precompute emoji vector norms for cosine.
      const emojiNorms = new Float32Array(manifest.emojis.length);
      for (let r = 0; r < manifest.emojis.length; r++) {
        let s = 0;
        const off = r * dims;
        for (let c = 0; c < dims; c++) s += emojiVecs[off + c] * emojiVecs[off + c];
        emojiNorms[r] = Math.sqrt(s) || 1;
      }
      semanticEmojiData = { dims, words, emojiVecs, emojiNorms, wordIndex, prefixIndex, emojiList: manifest.emojis };
      return semanticEmojiData;
    } catch (err) {
      console.warn('Semantic emoji data unavailable:', err);
      semanticEmojiData = null;
      return null;
    }
  })();
  return semanticEmojiPromise;
}

function semanticTextVector(data, label) {
  const { dims, words, wordIndex, prefixIndex } = data;
  const tokens = normalizeEmojiText(label)
    .split(' ')
    .filter(tok => tok.length >= 2 && !EMOJI_STOPWORDS.has(tok));
  if (!tokens.length) return null;

  const acc = new Float64Array(dims);
  let used = 0;
  for (const token of tokens) {
    let idx = wordIndex.get(token);
    if (idx === undefined && token.length >= 4) idx = prefixIndex.get(token.slice(0, 4)); // OOV backoff
    if (idx === undefined) continue;
    const off = idx * dims;
    let norm = 0;
    for (let c = 0; c < dims; c++) norm += words[off + c] * words[off + c];
    norm = Math.sqrt(norm) || 1;
    for (let c = 0; c < dims; c++) acc[c] += words[off + c] / norm;
    used += 1;
  }
  if (!used) return null;
  let mag = 0;
  for (let c = 0; c < dims; c++) mag += acc[c] * acc[c];
  mag = Math.sqrt(mag) || 1;
  for (let c = 0; c < dims; c++) acc[c] /= mag;
  return acc;
}

function suggestVectorEmoji(label) {
  const data = semanticEmojiData;
  if (!data) return '';
  const vec = semanticTextVector(data, label);
  if (!vec) return '';
  const { dims, emojiVecs, emojiNorms, emojiList } = data;
  let bestEmoji = '';
  let bestScore = -Infinity;
  for (let r = 0; r < emojiList.length; r++) {
    const off = r * dims;
    let dot = 0;
    for (let c = 0; c < dims; c++) dot += vec[c] * emojiVecs[off + c];
    const score = dot / emojiNorms[r];
    if (score > bestScore) {
      bestScore = score;
      bestEmoji = emojiList[r];
    }
  }
  return bestEmoji;
}

function suggestEmojiForText(label) {
  const text = normalizeEmojiText(label);
  if (text.length < 2) return '';

  const semanticEmoji = suggestSemanticEmoji(label);
  if (semanticEmoji) return semanticEmoji;

  let best = null;
  for (const rule of EMOJI_SUGGESTION_RULES) {
    const all = rule.all || [];
    const any = rule.any || [];
    const not = rule.not || [];
    if (not.some(phrase => phraseMatches(text, phrase))) continue;
    if (all.length && !all.every(phrase => phraseMatches(text, phrase))) continue;

    const anyMatches = any.filter(phrase => phraseMatches(text, phrase));
    if (any.length && anyMatches.length === 0) continue;

    const specificity = all.length * 8 + anyMatches.length * 4 + Math.max(...[...all, ...anyMatches].map(phrase => normalizeEmojiText(phrase).length), 0);
    if (!best || specificity > best.specificity) {
      best = { emoji: rule.emoji, specificity };
    }
  }
  if (best) return best.emoji;

  // Final safety net: nearest emoji by meaning. Guarantees a suggestion for any
  // recognizable word, even ones never hand-coded. Appends a colour square when
  // the label clearly mentions one (e.g. "berline noire" -> car + black).
  const vectorEmoji = suggestVectorEmoji(label);
  if (vectorEmoji) {
    const color = findSemanticColor(emojiTokens(label));
    if (color && color.score >= 12) return `${vectorEmoji}${color.emoji}`;
    return vectorEmoji;
  }
  return '';
}

function categoryEmoji(item) {
  if (Array.isArray(item?.emojis) && item.emojis.length) return item.emojis.slice(0, 2).join('');
  if (item && EMOJI_BY_ID[item.id]) return EMOJI_BY_ID[item.id];
  const key = `${item.id || ''} ${item.label || ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  if (key.includes('papi') && key.includes('mami')) return '👴';
  if (key.includes('doudoune')) return '🧥';
  if (key.includes('vieux bourgeois')) return '🎩';
  if (key.includes('bataille') && key.includes('chien')) return '🐺';
  if (key.includes('double') && key.includes('chien')) return '🐶';
  if (key.includes('traineau')) return '🛷';
  if (key.includes('chien') && !key.includes('accouplement')) return '🐩';
  if (key.includes('clodo')) return '🛒';
  if (key.includes('vieille bourgeoise')) return '👒';
  if (key.includes('mariniere') || key.includes('jean charles')) return '⚓';
  if (key.includes('etudiant')) return '🎓';
  if (key.includes('hippie')) return '☮️';
  if (key.includes('mechant')) return '😤';
  if (key.includes('touriste')) return '📸';
  if (key.includes('poussette')) return '👶';
  if (key.includes('velo') && key.includes('cargo')) return '📦';
  if (key.includes('casquette')) return '🧢';
  if (key.includes('style') || key.includes('frais')) return '😎';
  if (key.includes('caillra')) return '🔥';
  if (key.includes('gueule')) return '😾';
  if (key.includes('heureux')) return '😁';
  if (key.includes('triste')) return '😢';
  if (key.includes('scotche') || key.includes('tel')) return '📱';
  if (key.includes('costard')) return '👔';
  if (key.includes('shlagos')) return '🤪';
  if (key.includes('deliveroo')) return '🛵';
  if (key.includes('taxi')) return '🚕';
  if (key.includes('deux amis')) return '🤝';
  if (key.includes('calvitie')) return '👨‍🦲';
  if (key.includes('lesbien')) return '👩‍❤️‍👩';
  if (key.includes('couple gay')) return '👨‍❤️‍👨';
  if (key.includes('hipster')) return '🧔';
  if (key.includes('velib')) return '🚲';
  if (key.includes('zara')) return '👗';
  if (key.includes('drague')) return '💋';
  if (key.includes('creneau')) return '🅿️';
  if (key.includes('rasta') && !key.includes('blanc')) return '🟢';
  if (key.includes('trotinette') || key.includes('electrique')) return '🛴';
  if (key.includes('jogger') || key.includes('jogg')) return '🏃';
  if (key.includes('tricot')) return '🧶';
  if (key.includes('pigeon') && key.includes('mange')) return '🍞';
  if (key.includes('mange')) return '🍔';
  if (key.includes('rire') && !key.includes('fou')) return '😂';
  if (key.includes('dock') || key.includes('martins')) return '👢';

  if (key.includes('panama')) return '🏝️';
  if (key.includes('bob')) return '🤠';
  if (key.includes('air instrument')) return '🎷';
  if (key.includes('instrument')) return '🎸';
  if (key.includes('militaire')) return '🪖';
  if (key.includes('kit main libre')) return '🎙️';
  if (key.includes('son a donf')) return '🔊';
  if (key.includes('canne')) return '🦯';
  if (key.includes('enfant relou')) return '🧒';
  if (key.includes('pull') && key.includes('sans')) return '🐻';
  if (key.includes('shirt')) return '👾';
  if (key.includes('geek')) return '🤓';
  if (key.includes('cheveux') && key.includes('fesses')) return '💇';
  if (key.includes('cheveux') && (key.includes('bleu') || key.includes('vert'))) return '💙';
  if (key.includes('cheveux') && key.includes('rose')) return '🌸';
  if (key.includes('black') && key.includes('roux')) return '🦊';
  if (key.includes('mami') && key.includes('velo')) return '👵';
  if (key.includes('poivre')) return '🧂';
  if (key.includes('livre')) return '📖';
  if (key.includes('ivre')) return '🍺';
  if (key.includes('rasta blanc')) return '🌿';
  if (key.includes('decathlon')) return '🏋️';
  if (key.includes('selfie')) return '🤳';
  if (key.includes('danse') && !key.includes('tiktok')) return '💃';
  if (key.includes('horodateur')) return '⏰';
  if (key.includes('lit un livre')) return '📖';
  if (key.includes('embrass')) return '💏';
  if (key.includes('parle tout seul')) return '🗣️';
  if (key.includes('skate')) return '🛹';
  if (key.includes('court')) return '🦵';
  if (key.includes('trebuche')) return '🤸';
  if (key.includes('deguise')) return '🎭';
  if (key.includes('nordique') || key.includes('batons')) return '🥾';
  if (key.includes('controle') && key.includes('raciste')) return '🚨';
  if (key.includes('faf')) return '💀';
  if (key.includes('col roule')) return '🧣';
  if (key.includes('embrouille') && key.includes('couple')) return '💔';
  if (key.includes('megot')) return '🚬';

  if (key.includes('religieux')) return '🙏';
  if (key.includes('cheveux') && key.includes('multicolore')) return '🌈';
  if (key.includes('pleure')) return '😭';
  if (key.includes('monocycle')) return '🎪';
  if (key.includes('controle') && key.includes('police')) return '🚓';
  if (key.includes('bagarre')) return '🥊';
  if (key.includes('pipi')) return '💦';
  if (key.includes('accident')) return '💥';
  if (key.includes('pied') && key.includes('nus')) return '🦶';
  if (key.includes('crete') || key.includes('punk')) return '🤘';
  if (key.includes('meuble')) return '🪑';
  if (key.includes('tiktok')) return '📲';
  if (key.includes('fou rire')) return '🤣';
  if (key.includes('mariage')) return '💒';
  if (key.includes('flyers')) return '📄';
  if (key.includes('ballon') || key.includes('baudruche')) return '🎈';

  if (key.includes('oiseau') || key.includes('chier')) return '🐦';
  if (key.includes('vol de rue')) return '🦹';
  if (key.includes('nudite')) return '🫣';
  if (key.includes('mouette') || key.includes('sandwich')) return '🦅';
  if (key.includes('accouplement')) return '🫦';
  if (key.includes('merde')) return '💩';
  if (key.includes('jumeaux')) return '👯';
  if (key.includes('pipe') || key.includes('piple')) return '🚬';
  if (key.includes('cape')) return '🦸';
  if (key.includes('coupure') && key.includes('electricite')) return '⚡';
  if (key.includes('enterrement') && key.includes('garcon')) return '🎉';

  if (key.includes('chelou')) return '🤨';
  if (key.includes('mallette')) return '💼';
  if (key.includes('leche')) return '🪟';
  if (key.includes('shopping')) return '🛍️';
  if (key.includes('casque')) return '🎧';
  if (key.includes('canette')) return '🥤';
  if (key.includes('deux') && key.includes('velo')) return '🚴';
  if (key.includes('debout') && key.includes('velo')) return '🚵';
  if (key.includes('bonnet')) return '🥶';
  if (key.includes('banane')) return '👝';
  if (key.includes('beret')) return '🧑‍🎨';
  if (key.includes('baguette')) return '🥖';
  if (key.includes('flegmatique')) return '😐';
  if (key.includes('stockos')) return '💪';
  if (key.includes('cataracte')) return '🥽';
  if (key.includes('lunette') && key.includes('tete')) return '🕶️';
  if (key.includes('mal assortie')) return '🎨';
  if (key.includes('ecouteur')) return '🔌';
  if (key.includes('valise')) return '🧳';
  if (key.includes('roller')) return '🛼';
  if (key.includes('psycho')) return '🔪';
  if (key.includes('leopard')) return '🐆';
  if (key.includes('bouquet')) return '💐';
  if (key.includes('fast food')) return '🍟';
  if (key.includes('rase sur')) return '💈';
  if (key.includes('velo a main')) return '🦽';
  if (key.includes('traverse')) return '🚸';
  if (key.includes('tennis')) return '🎾';
  if (key.includes('porte bebe')) return '🍼';
  if (key.includes('chemise rose')) return '👚';
  if (key.includes('integrale')) return '👖';
  if (key.includes('thune')) return '🤲';
  if (key.includes('gaz')) return '⛽';
  if (key.includes('barbe') && key.includes('chauve')) return '🧔';
  if (key.includes('chauve')) return '🥚';
  if (key.includes('vitre')) return '🪞';
  if (key.includes('arrogant') || key.includes('prince')) return '🤴';
  if (key.includes('pliant')) return '🪗';
  if (key.includes('chantier')) return '👷';
  if (key.includes('sosie')) return '👤';
  if (key.includes('passee')) return '🔁';
  if (key.includes('detendu')) return '😌';
  if (key.includes('ciel')) return '☁️';
  if (key.includes('crache')) return '🦙';
  if (key.includes('sueur')) return '🥵';
  if (key.includes('auto ecole')) return '🚗';
  if (key.includes('dakar')) return '🏜️';
  if (key.includes('peluche')) return '🧸';
  if (key.includes('escarpin')) return '👠';
  if (key.includes('gilet jaune')) return '🦺';
  if (key.includes('vapot')) return '💨';
  if (key.includes('cherche')) return '🔍';
  if (key.includes('fier')) return '🦚';
  if (key.includes('plombier')) return '🍑';
  if (key.includes('bise')) return '😘';
  if (key.includes('capuche')) return '🥷';
  if (key.includes('malaise') || key.includes('dead')) return '🚑';
  if (key.includes('pressing')) return '🧺';
  if (key.includes('presse')) return '⏱️';
  if (key.includes('chantent') || key.includes('chante')) return '🎤';
  if (key.includes('visio')) return '📹';
  if (key.includes('corbillard')) return '🚐';
  if (key.includes('mousquetaire')) return '⚔️';
  if (key.includes('moustache')) return '🥸';
  if (key.includes('cercueil')) return '⚰️';
  if (key.includes('tresse')) return '🪢';
  if (key.includes('tatouage')) return '🐉';
  if (key.includes('mouche')) return '🤧';
  if (key.includes('caisse')) return '🚘';
  if (key.includes('chewing')) return '🫧';
  if (key.includes('je connais')) return '👋';
  if (key.includes('ramasse')) return '🫳';
  if (key.includes('gratter')) return '🎫';
  if (key.includes('wheeling')) return '🏍️';
  if (key.includes('sans les mains')) return '🙌';
  if (key.includes('circassien')) return '🤹';
  if (key.includes('beauf')) return '🛻';
  if (key.includes('tient la main')) return '👫';
  if (key.includes('meuf')) return '💑';
  if (key.includes('ouvre les portes')) return '🚪';
  if (key.includes('pere et fils')) return '👨‍👦';
  if (key.includes('mere et fille')) return '👩‍👧';
  if (key.includes('crocs')) return '🐊';
  if (key.includes('2 metres')) return '🦒';
  if (key.includes('caniche')) return '💅🐩';
  if (key.includes('platre')) return '🩼';
  if (key.includes('toutounette')) return '🐕';
  if (key.includes('pigeon solo')) return '🕊️';
  if (key.includes('doublage')) return '🏎️';
  if (key.includes('hesite')) return '🤷';
  if (key.includes('mono color')) return '⬛';
  if (key.includes('mains dans le dos')) return '🚶';
  if (key.includes('trop grand')) return '🦣';
  if (key.includes('meditatif')) return '🧘';
  if (key.includes('string')) return '🩲';
  if (key.includes('haut parleur')) return '📢';
  if (key.includes('emo dark')) return '🖤';
  if (key.includes('fleur')) return '🌺';
  if (key.includes('vomi')) return '🤮';
  if (key.includes('portiere')) return '🫨';
  if (key.includes('mains dans les poches')) return '🦘';
  if (key.includes('lacet')) return '👟';
  if (key.includes('pecheur')) return '🎣';
  if (key.includes('aveugle')) return '🦮';
  if (key.includes('chat des rues')) return '🐈';
  if (key.startsWith('rat ')) return '🐀';
  if (key.includes('groupe') && key.includes('pote')) return '👥';
  if (key.includes('groupe')) return '🎼';
  if (key.includes('maillot')) return '⚽';
  if (key.includes('chariot')) return '🛒';
  if (key.includes('pull')) return '⛵';
  if (key.includes('relation')) return '😻';
  if (key.includes('autre joueur')) return '🎯';
  if (key.includes('clown')) return '🤡';
  if (key.includes('colere')) return '😡';
  if (key.includes('salopette')) return '🧑‍🌾';
  if (key.includes('bandana')) return '🏴‍☠️';
  if (key.includes('backpacker')) return '🎒';
  if (key.includes('chirurgie') || key.includes('esthetique')) return '💉';
  if (key.includes('noeud') && key.includes('papillon')) return '🦋';
  if (key.includes('multiples sacs') || (key.includes('multiple') && key.includes('sac'))) return '🛍️';

  return '🎲';
}

let gridBuilt = false;

function buildGrid() {
  gridBuilt = true;
  TIERS.forEach(category => {
    const container = $(`#grid-${category}`);
    if (!container) return;
    container.innerHTML = '';
    const items = myGrid[category] || [];

    items.forEach((item, index) => {
      const cell = document.createElement('div');
      cell.className = `cell ${category}-cell`;
      cell.dataset.idx = index;

      const emojiSpan = document.createElement('span');
      emojiSpan.className = 'emoji';
      emojiSpan.textContent = categoryEmoji(item);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'label';
      labelSpan.textContent = item.label.replace(/\s*\(ultra\)/gi, '');

      cell.appendChild(emojiSpan);
      cell.appendChild(labelSpan);

      let longPressTimer = null;
      let didLongPress = false;

      // Appui long sur une case cochée = annuler (décocher).
      cell.addEventListener('pointerdown', () => {
        didLongPress = false;
        if (freeCheckCategory || rerollRemaining > 0) return;
        const checked = myChecked[category] || [];
        if (!checked.includes(index)) return;
        longPressTimer = window.setTimeout(() => {
          didLongPress = true;
          clearLegendaryConfirm();
          playTapSound(category, true);
          applyLocalToggle(category, index);
          renderGrid();
          cell.classList.add('long-pressing');
          window.setTimeout(() => cell.classList.remove('long-pressing'), 260);
          const sent = emitSocket('toggle-cell', { category, index }, ({ ok, reason }) => {
            if (ok) return;
            applyLocalToggle(category, index);
            renderGrid();
            if (reason) showToast(reason);
          });
          if (!sent) {
            applyLocalToggle(category, index);
            renderGrid();
          }
        }, 560);
      });

      ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
        cell.addEventListener(eventName, () => {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
        });
      });

      cell.addEventListener('pointerup', () => {
        if (didLongPress) {
          window.setTimeout(() => { didLongPress = false; }, 0);
          return;
        }
        const checked = myChecked[category] || [];
        if (freeCheckCategory) {
          if (freeCheckCategory !== '*' && category !== freeCheckCategory) {
            showToast(`Choisis dans ${TIER_NAMES[freeCheckCategory]}`);
            return;
          }
          if (checked.includes(index)) {
            showToast('Choisis une case non cochée');
            return;
          }
          animateFreeCheckCell(cell);
          emitSocket('free-check-cell', { category, index });
          return;
        }
        if (rerollRemaining > 0) {
          if (checked.includes(index)) {
            showToast('Choisis une case non cochée');
            return;
          }
          emitSocket('reroll-cell', { category, index });
          return;
        }
        // 2e tap sur une case déjà cochée = ajouter une répétition.
        if (checked.includes(index)) {
          clearLegendaryConfirm();
          playMultipickSound();
          emitSocket('repeat-cell', { category, index });
          cell.classList.add('long-pressing');
          window.setTimeout(() => cell.classList.remove('long-pressing'), 260);
          return;
        }
        // Case non cochée : on coche (la légendaire demande confirmation).
        if (category === 'legendaire') {
          if (pendingLegendaryConfirm !== index) {
            requestLegendaryConfirm(cell, index);
            return;
          }
          clearLegendaryConfirm();
        } else {
          clearLegendaryConfirm();
        }
        playTapSound(category, false);
        applyLocalToggle(category, index);
        renderGrid();
        const sent = emitSocket('toggle-cell', { category, index }, ({ ok, reason }) => {
          if (ok) return;
          applyLocalToggle(category, index);
          renderGrid();
          if (reason) showToast(reason);
        });
        if (!sent) {
          applyLocalToggle(category, index);
          renderGrid();
          return;
        }
        cell.classList.add('just-checked');
        setTimeout(() => cell.classList.remove('just-checked'), 250);
      });

      container.appendChild(cell);
    });
  });
}

function renderGrid() {
  if (!gridBuilt) buildGrid();

  TIERS.forEach(category => {
    const container = $(`#grid-${category}`);
    const section = $(`#section-${category}`);
    const items = myGrid[category] || [];
    const checked = myChecked[category] || [];
    const occurrences = myOccurrences[category] || {};
    const bonuses = myBonuses[category] || 0;
    if (!container || !section) return;

    const cells = container.children;
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      const isChecked = checked.includes(index);

      cell.classList.toggle('checked', isChecked);
      cell.classList.toggle('reroll-target', !isChecked && rerollRemaining > 0);
      cell.classList.toggle('freecheck-target', !isChecked && (freeCheckCategory === category || freeCheckCategory === '*'));

      const count = occurrences[index] || (isChecked ? 1 : 0);
      let badge = cell.querySelector('.occurrence-badge');
      if (count > 1) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'occurrence-badge';
          cell.appendChild(badge);
        }
        badge.textContent = `x${count}`;
      } else if (badge) {
        badge.remove();
      }
    }

    const progress = $(`#progress-${category}`);
    progress.textContent = `${checked.length}/${items.length}`;
    const bonus = $(`#bonus-${category}`);
    if (bonus) {
      bonus.textContent = rerollRemaining > 0 ? `rejouer x${rerollRemaining}` : ((freeCheckCategory === category || freeCheckCategory === '*') ? 'gratis !' : (bonuses > 0 ? `bonus x${bonuses}` : ''));
    }

    if (checked.length === items.length) {
      section.classList.add('complete');
    } else {
      section.classList.remove('complete');
    }
  });

  updateJokerSlot();
}

function renderPlayersList(players) {
  playersList.innerHTML = '';
  players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card';

    const isMe = p.id === myId;

    const nameDiv = document.createElement('div');
    nameDiv.className = `player-name ${isMe ? 'is-me' : ''}`;
    nameDiv.textContent = `${p.name}${isMe ? ' (toi)' : ''}`;
    card.appendChild(nameDiv);

    const barsDiv = document.createElement('div');
    barsDiv.className = 'player-progress-bars';

    TIERS.forEach(cat => {
      const prog = p.progress[cat];
      if (!prog) return;
      const pct = prog.total > 0 ? (prog.checked / prog.total) * 100 : 0;
      const isFull = prog.checked === prog.total;

      const row = document.createElement('div');
      row.className = 'progress-row';

      const label = document.createElement('span');
      label.className = 'progress-label';
      label.textContent = cat.charAt(0).toUpperCase();

      const bar = document.createElement('div');
      bar.className = `progress-bar ${cat} ${isFull ? 'full' : ''}`;
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);

      const text = document.createElement('span');
      text.className = 'progress-text';
      text.textContent = `${prog.checked}/${prog.total}`;

      row.appendChild(label);
      row.appendChild(bar);
      row.appendChild(text);
      barsDiv.appendChild(row);
    });

    card.appendChild(barsDiv);
    playersList.appendChild(card);
  });
}

// --- PANEL ---

btnPlayers.addEventListener('click', () => {
  playersPanel.classList.add('open');
  panelBackdrop.classList.add('active');
});

function closePanel() {
  playersPanel.classList.remove('open');
  panelBackdrop.classList.remove('active');
}

function openCustomGridPanel() {
  loadCustomGrids();
  customGridPanel.classList.add('open');
  customGridPanelBackdrop.classList.add('active');
}

function closeCustomGridPanel() {
  customGridPanel.classList.remove('open');
  customGridPanelBackdrop.classList.remove('active');
}

btnClosePanel.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);
btnOpenCustomGrids.addEventListener('click', openCustomGridPanel);
btnCloseCustomGrids.addEventListener('click', closeCustomGridPanel);
customGridPanelBackdrop.addEventListener('click', closeCustomGridPanel);

// --- SHARE ---

displayCode.addEventListener('click', () => {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(roomCode);
    showToast('Code copié !');
  }
});

btnShare.addEventListener('click', () => {
  const url = window.location.origin;
  const text = `Rejoins ma partie de Bingo Social ! Code : ${roomCode}\n${url}`;

  if (navigator.share) {
    navigator.share({ title: 'Bingo Social', text }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
    showToast('Lien copié !');
  }
});

btnJoker.addEventListener('click', () => {
  if (jokerRerollActive) {
    emitSocket('use-joker', {});
    return;
  }
  if (rerollRemaining > 0) {
    emitSocket('use-joker', {});
    return;
  }
  if ((myBonuses.joker || 0) <= 0) {
    showToast('Pas de joker disponible');
    return;
  }
  playJokerSound();
  emitSocket('use-joker', {});
});

btnBackHome.addEventListener('click', () => {
  if (socket) socket.emit('leave-room');
  resetGameState();
  showScreen(screenHome);
  showToast('Retour au menu');
});

window.addEventListener('pageshow', () => {
  if (socket && !socket.connected) socket.connect();
  requestSessionResume();
});

window.addEventListener('focus', () => {
  requestSessionResume();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (socket && !socket.connected) socket.connect();
    requestSessionResume();
  }
});

// --- NEW GAME ---

btnNewGame.addEventListener('click', () => {
  playSocioloIntro();
  emitSocket('new-game', { difficulty: 'normal' });
});
btnNewGame2.addEventListener('click', () => {
  playSocioloIntro();
  emitSocket('new-game', { difficulty: 'normal' });
});
if (btnContinueHard) btnContinueHard.addEventListener('click', () => {
  playSocioloIntro();
  emitSocket('new-game', { difficulty: 'hard' });
});

btnBonusFreecheck.addEventListener('click', () => {
  closeBonusChoice();
  emitSocket('choose-bonus', { choice: 'free-check' });
});

btnBonusReroll.addEventListener('click', () => {
  closeBonusChoice();
  emitSocket('choose-bonus', { choice: 'reroll' });
});

loadCustomGrids();
openEditorFromQuery();
