const socket = typeof io === 'function' ? io() : null;
const TIERS = ['ordinaire', 'semi', 'rare', 'legendaire'];
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
  }, {});
}

const screenHome = $('#screen-home');
const screenGame = $('#screen-game');
const inputName = $('#player-name');
const inputCode = $('#room-code');
const btnCreate = $('#btn-create');
const btnJoin = $('#btn-join');
const btnInfo = $('#btn-info');
const btnEditCats = $('#btn-edit-cats');
const errorMsg = $('#error-msg');
const displayCode = $('#display-code');
const playerCount = $('#player-count');
const btnPlayers = $('#btn-players');
const btnShare = $('#btn-share');
const playersPanel = $('#players-panel');
const panelBackdrop = $('#panel-backdrop');
const playersList = $('#players-list');
const btnClosePanel = $('#btn-close-panel');
const winOverlay = $('#win-overlay');
const winDrawing = $('#win-drawing');
const winTitle = $('#win-title');
const winDetail = $('#win-detail');
const btnNewGame = $('#btn-new-game');
const btnNewGame2 = $('#btn-new-game-2');
const toastEl = $('#toast');
const bonusFlash = $('#bonus-flash');
const bonusChoiceOverlay = $('#bonus-choice-overlay');
const bonusChoiceDrawing = $('#bonus-choice-drawing');
const bonusChoiceDetail = $('#bonus-choice-detail');
const btnBonusReroll = $('#btn-bonus-reroll');

let pendingBonusCategory = null;
let rerollRemaining = 0;
let freeCheckCategory = null;
let bonusCategory = null;
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

let bgMusic = null;
function startBgMusic() {
  if (bgMusic) return;
  bgMusic = new Audio('/socioloGenerique.wav');
  bgMusic.loop = false;
  bgMusic.volume = 0.8;
  bgMusic.play().catch(() => {});
}

let audioContext = null;
function getAudioContext() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioContext) audioContext = new AudioCtor();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function playTone({ frequency, duration, type = 'square', volume = 0.08, slideTo = null, delay = 0 }) {
  const ctx = getAudioContext();
  if (!ctx) return;

  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  if (slideTo) {
    osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  }

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

const SFX_VOLUME = 0.8;
const tapSounds = {
  ordinaire: '/ordinaire.mp3',
  semi: '/semi-ordinaire.mp3',
  rare: '/rare.mp3',
  legendaire: '/legendaire.mp3',
};

function playSfx(src) {
  const sfx = new Audio(src);
  sfx.volume = SFX_VOLUME;
  sfx.play().catch(() => {});
}

function playTapSound(category, wasChecked) {
  if (wasChecked) return;
  playSfx(tapSounds[category] || tapSounds.ordinaire);
}

function playWinSound() {
  playSfx('/bingo.wav');
}

function playBonusSound() {
  playSfx('/bonus.mp3');
}

function playRerollSound() {
  playSfx('/bonus.mp3');
}

function playFreeCheckSound() {
  playSfx(tapSounds.legendaire);
}

function playMultipickSound() {
  playSfx('/multipick.mp3');
}

function showBonusFlash(message) {
  bonusFlash.textContent = message;
  bonusFlash.classList.remove('show');
  window.requestAnimationFrame(() => bonusFlash.classList.add('show'));
  window.clearTimeout(showBonusFlash.timeout);
  showBonusFlash.timeout = window.setTimeout(() => bonusFlash.classList.remove('show'), 1500);
}

function showBonusChoice(category) {
  bonusCategory = category;
  playBonusSound();
  showBonusFlash('Bonus !');
  bonusChoiceDrawing.textContent = '🎰';
  bonusChoiceDetail.textContent = `Catégorie : ${TIER_NAMES[category]}`;
  bonusChoiceOverlay.classList.add('active');
}

function closeBonusChoice() {
  pendingBonusCategory = null;
  bonusChoiceOverlay.classList.remove('active');
}

function emitSocket(eventName, payload) {
  if (!socket) {
    showError('Multijoueur indisponible : il faut lancer le serveur Node/Socket.IO.');
    return false;
  }
  socket.emit(eventName, payload);
  return true;
}

if (!socket) {
  showError('GitHub Pages seul ne peut pas lancer les parties multijoueurs.');
  [btnCreate, btnJoin, btnEditCats].forEach(btn => {
    btn.disabled = true;
    btn.title = 'Serveur temps réel requis';
  });
}

// --- HOME ACTIONS ---

btnCreate.addEventListener('click', () => {
  const name = inputName.value.trim();
  if (!name) { showError('Entre ton prénom !'); return; }
  playerName = name;
  startBgMusic();
  emitSocket('create-room', name);
});

btnJoin.addEventListener('click', () => {
  const name = inputName.value.trim();
  const code = inputCode.value.trim().toUpperCase();
  if (!name) { showError('Entre ton prénom !'); return; }
  if (!code || code.length < 4) { showError('Code à 4 caractères !'); return; }
  playerName = name;
  startBgMusic();
  emitSocket('join-room', { code, playerName: name });
});

btnInfo.addEventListener('click', () => {
  window.location.href = '/info.html';
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
  });

  socket.on('connect_error', () => {
    showError('Connexion temps réel impossible : serveur Socket.IO requis.');
  });

  socket.on('room-created', ({ code, grid }) => {
    roomCode = code;
    myGrid = grid;
    myChecked = emptyChecked();
    myOccurrences = emptyOccurrences();
    myBonuses = emptyBonuses();
    rerollRemaining = 0;
    enterGame();
  });

  socket.on('room-joined', ({ code, grid }) => {
    roomCode = code;
    myGrid = grid;
    myChecked = emptyChecked();
    myOccurrences = emptyOccurrences();
    myBonuses = emptyBonuses();
    rerollRemaining = 0;
    enterGame();
  });

  socket.on('error-msg', (msg) => {
    showError(msg);
  });

  socket.on('grid-update', (checked) => {
    const state = checked.checked ? checked : { checked };
    myChecked = { ...emptyChecked(), ...state.checked };
    myOccurrences = { ...emptyOccurrences(), ...(state.occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(state.bonuses || {}) };
    renderGrid();
  });

  socket.on('occurrence-update', ({ category, count, occurrences, bonuses }) => {
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || myOccurrences) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || myBonuses) };
    showToast(`${TIER_NAMES[category]} x${count}`);
    renderGrid();
  });

  socket.on('bonus-choice-start', ({ category }) => {
    showBonusChoice(category);
    renderGrid();
  });

  socket.on('reroll-bonus-start', ({ remaining }) => {
    rerollRemaining = remaining;
    showToast(`Choisis ${remaining} cases à rejouer !`);
    renderGrid();
  });

  socket.on('free-check-start', ({ category }) => {
    freeCheckCategory = category;
    showToast(`Coche une case gratis dans ${TIER_NAMES[category]}`);
    renderGrid();
  });

  socket.on('free-check-done', ({ category, checked, occurrences, bonuses }) => {
    freeCheckCategory = null;
    myChecked = { ...emptyChecked(), ...(checked || {}) };
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || {}) };
    playFreeCheckSound();
    showToast('Case cochée gratis !');
    renderGrid();
  });

  socket.on('reroll-update', ({ grid, checked, occurrences, bonuses, remaining }) => {
    myGrid = grid;
    myChecked = { ...emptyChecked(), ...(checked || {}) };
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || {}) };
    rerollRemaining = remaining || 0;
    playRerollSound();
    showToast(rerollRemaining > 0 ? `Encore ${rerollRemaining} à rejouer` : 'Rejeu terminé !');
    renderGrid();
  });

  socket.on('grid-rerolled', ({ grid, checked, occurrences, bonuses }) => {
    myGrid = grid;
    myChecked = { ...emptyChecked(), ...(checked || {}) };
    myOccurrences = { ...emptyOccurrences(), ...(occurrences || {}) };
    myBonuses = { ...emptyBonuses(), ...(bonuses || {}) };
    playBonusSound();
    showToast('Cases rejouées !');
    renderGrid();
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
    playWinSound();
    winDrawing.textContent = categoryEmoji({ id: category, label: TIER_NAMES[category] || category });
    if (name === playerName) {
      winTitle.textContent = 'Tu as gagné !';
    } else {
      winTitle.textContent = `${name} a gagné !`;
    }
    winDetail.textContent = category === 'legendaire'
      ? 'Case légendaire cochée : victoire instantanée'
      : `Grille "${TIER_NAMES[category] || category}" complétée`;
    winOverlay.classList.add('active');
    btnNewGame.style.display = 'block';
  });

  socket.on('new-game-started', ({ grid }) => {
    myGrid = grid;
    myChecked = emptyChecked();
    myOccurrences = emptyOccurrences();
    myBonuses = emptyBonuses();
    rerollRemaining = 0;
    winOverlay.classList.remove('active');
    btnNewGame.style.display = 'none';
    renderGrid();
    showToast('Nouvelle partie !');
  });

  socket.on('categories-updated', () => {
    showToast('Catégories mises à jour');
  });
}

// --- GAME ---

function enterGame() {
  displayCode.textContent = roomCode;
  showScreen(screenGame);
  renderGrid();
}

function categoryEmoji(item) {
  const key = `${item.id || ''} ${item.label || ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  if (key.includes('papi') && key.includes('mami')) return '👴';
  if (key.includes('doudoune')) return '🧥';
  if (key.includes('vieux bourgeois')) return '🎩';
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
  if (key.includes('mange')) return '🍔';
  if (key.includes('rire') && !key.includes('fou')) return '😂';
  if (key.includes('dock') || key.includes('martins')) return '👢';

  if (key.includes('panama')) return '🏝️';
  if (key.includes('bob')) return '🪣';
  if (key.includes('instrument')) return '🎸';
  if (key.includes('militaire')) return '🪖';
  if (key.includes('kit main libre')) return '🎧';
  if (key.includes('son a donf')) return '🔊';
  if (key.includes('canne')) return '🦯';
  if (key.includes('enfant relou')) return '🧒';
  if (key.includes('geek')) return '🤓';
  if (key.includes('cheveux') && key.includes('fesses')) return '💇';
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
  if (key.includes('pipe') || key.includes('piple')) return '🪈';
  if (key.includes('cape')) return '🦸';
  if (key.includes('coupure') && key.includes('electricite')) return '⚡';
  if (key.includes('enterrement') && key.includes('garcon')) return '🎉';

  return '🎲';
}

function drawingPalette(category) {
  const palettes = {
    ordinaire: ['#b9e4ff', '#138ee8', '#ff4fa3'],
    semi: ['#bef7a7', '#20bf63', '#ff7a1a'],
    rare: ['#ffc2a6', '#ff412f', '#15a6ff'],
    legendaire: ['#d7b7ff', '#802cff', '#d6ff32'],
  };
  return palettes[category] || palettes.ordinaire;
}

function drawingType(item) {
  const key = `${item.id || ''} ${item.label || ''}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (key.includes('papi') || key.includes('mami') || key.includes('vieux') || key.includes('vieille')) return 'old';
  if (key.includes('doudoune') || key.includes('costard') || key.includes('panama') || key.includes('bob') || key.includes('casquette')) return 'clothes';
  if (key.includes('chien')) return 'dog';
  if (key.includes('clodo')) return 'rough';
  if (key.includes('marini') || key.includes('touriste') || key.includes('selfie') || key.includes('tel')) return 'tourist';
  if (key.includes('etudiant') || key.includes('livre')) return 'book';
  if (key.includes('hippie') || key.includes('style') || key.includes('frais')) return 'star';
  if (key.includes('mechant') || key.includes('gueule') || key.includes('triste') || key.includes('venere')) return 'face';
  if (key.includes('claquette') || key.includes('court') || key.includes('trebuche')) return 'legs';
  if (key.includes('poussette') || key.includes('velo') || key.includes('skate')) return 'wheels';
  if (key.includes('instrument')) return 'guitar';
  if (key.includes('caillra') || key.includes('fume') || key.includes('trace')) return 'smoke';
  if (key.includes('ivre') || key.includes('embrass') || key.includes('couple')) return 'drink';
  if (key.includes('decathlon')) return 'sport';
  if (key.includes('danse')) return 'dance';
  if (key.includes('horodateur')) return 'meter';
  if (key.includes('jumeaux')) return 'twins';
  if (key.includes('parle')) return 'speech';
  if (key.includes('deguise')) return 'mask';
  if (key.includes('police')) return 'police';
  if (key.includes('bagarre')) return 'fight';
  if (key.includes('mouette')) return 'bird';
  if (key.includes('pipi')) return 'splash';
  if (key.includes('nudite')) return 'body';
  if (key.includes('accident')) return 'crash';
  if (key.includes('impossible') || key.includes('instant') || key.includes('legendaire')) return 'legend';
  return 'weird';
}

function categoryDrawing(item, category) {
  const [paper, main, hit] = drawingPalette(category);
  const type = drawingType(item);
  const common = `
    <rect x="8" y="9" width="84" height="78" rx="8" fill="${paper}" stroke="#16120f" stroke-width="5"/>
    <path d="M13 28 C27 17 42 37 57 22 S83 25 88 15" fill="none" stroke="${hit}" stroke-width="4" stroke-linecap="round"/>
    <path d="M18 75 C33 63 49 84 66 69 S83 72 88 58" fill="none" stroke="#16120f" stroke-width="3" stroke-linecap="round" opacity=".35"/>
  `;
  const drawings = {
    old: `<circle cx="50" cy="40" r="20" fill="#fff9dd" stroke="#16120f" stroke-width="5"/><path d="M31 33 C39 17 62 17 70 33" fill="none" stroke="${main}" stroke-width="7"/><path d="M39 43 L43 43 M57 43 L61 43" stroke="#16120f" stroke-width="5" stroke-linecap="round"/><path d="M39 57 C46 62 55 62 62 57" fill="none" stroke="#16120f" stroke-width="4"/><path d="M28 83 C35 67 65 67 72 83" fill="${main}" stroke="#16120f" stroke-width="5"/>`,
    clothes: `<path d="M31 30 L50 20 L69 30 L77 78 L23 78 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M38 31 L50 43 L62 31" fill="#fff9dd" stroke="#16120f" stroke-width="4"/><path d="M25 29 C36 12 64 12 75 29" fill="${hit}" stroke="#16120f" stroke-width="5"/>`,
    dog: `<path d="M28 58 C28 38 44 28 60 35 C77 42 76 70 58 75 C42 80 28 72 28 58Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M31 45 L17 31 L24 60 Z M66 39 L84 28 L75 58 Z" fill="${hit}" stroke="#16120f" stroke-width="5"/><circle cx="51" cy="55" r="4" fill="#16120f"/><path d="M59 61 C65 67 72 66 76 60" fill="none" stroke="#16120f" stroke-width="4"/>`,
    rough: `<path d="M28 81 L37 33 L58 24 L74 82 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M38 36 L22 51 M57 30 L78 43 M39 60 L68 54" stroke="#fff9dd" stroke-width="6" stroke-linecap="round"/><circle cx="48" cy="28" r="12" fill="${hit}" stroke="#16120f" stroke-width="5"/>`,
    tourist: `<circle cx="49" cy="38" r="17" fill="#fff9dd" stroke="#16120f" stroke-width="5"/><rect x="26" y="57" width="48" height="25" rx="5" fill="${main}" stroke="#16120f" stroke-width="5"/><rect x="61" y="23" width="20" height="27" rx="4" fill="${hit}" stroke="#16120f" stroke-width="4"/><circle cx="52" cy="68" r="8" fill="#fff" stroke="#16120f" stroke-width="4"/>`,
    book: `<path d="M20 31 C31 24 42 25 50 33 C59 25 70 24 81 31 L81 78 C70 70 59 72 50 81 C41 72 30 70 20 78 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M50 34 L50 80 M30 42 L43 45 M58 45 L72 41" stroke="#16120f" stroke-width="4"/>`,
    star: `<path d="M50 14 L60 37 L85 35 L66 52 L73 78 L50 64 L27 78 L34 52 L15 35 L40 37 Z" fill="${hit}" stroke="#16120f" stroke-width="5"/><circle cx="50" cy="50" r="13" fill="${main}" stroke="#16120f" stroke-width="4"/>`,
    face: `<circle cx="50" cy="48" r="30" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M30 38 L43 43 M70 38 L57 43" stroke="#16120f" stroke-width="5" stroke-linecap="round"/><path d="M38 65 C47 56 57 56 66 65" fill="none" stroke="#16120f" stroke-width="5"/>`,
    legs: `<path d="M38 22 L50 22 L46 53 L59 80 L48 83 L36 55 Z M58 23 L69 26 L63 55 L78 73 L69 82 L53 59 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M30 83 L51 80 M62 83 L82 75" stroke="${hit}" stroke-width="7" stroke-linecap="round"/>`,
    wheels: `<circle cx="29" cy="70" r="13" fill="#fff9dd" stroke="#16120f" stroke-width="5"/><circle cx="72" cy="70" r="13" fill="#fff9dd" stroke="#16120f" stroke-width="5"/><path d="M29 70 L45 45 L58 70 L72 70 L54 45 L39 45" fill="none" stroke="${main}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M54 44 L69 30" stroke="#16120f" stroke-width="5"/>`,
    guitar: `<path d="M32 57 C18 71 40 90 52 74 C66 88 88 66 71 53 C81 37 60 24 50 41 C40 25 19 39 32 57Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M55 45 L83 17" stroke="${hit}" stroke-width="8" stroke-linecap="round"/><path d="M43 61 L69 35" stroke="#16120f" stroke-width="4"/>`,
    smoke: `<path d="M23 68 L73 50" stroke="${main}" stroke-width="11" stroke-linecap="round"/><path d="M20 69 L76 49" stroke="#16120f" stroke-width="4" stroke-linecap="round"/><path d="M37 39 C22 26 49 18 37 8 M57 42 C45 29 74 21 61 9" fill="none" stroke="${hit}" stroke-width="6" stroke-linecap="round"/>`,
    drink: `<path d="M31 23 L70 23 L63 78 L38 78 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M35 43 L67 43" stroke="#fff9dd" stroke-width="8"/><path d="M70 31 C88 31 88 57 66 55" fill="none" stroke="#16120f" stroke-width="5"/>`,
    sport: `<circle cx="50" cy="30" r="12" fill="${hit}" stroke="#16120f" stroke-width="5"/><path d="M49 44 L34 62 L47 65 L33 84 M52 44 L68 57 L78 47 M51 62 L66 82" fill="none" stroke="${main}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path d="M49 44 L34 62 L47 65 L33 84 M52 44 L68 57 L78 47 M51 62 L66 82" fill="none" stroke="#16120f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    dance: `<circle cx="48" cy="25" r="11" fill="${hit}" stroke="#16120f" stroke-width="5"/><path d="M47 39 C30 47 33 67 49 63 C67 59 72 42 55 37" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M31 51 L16 39 M65 47 L84 36 M47 62 L31 84 M54 62 L74 81" stroke="#16120f" stroke-width="6" stroke-linecap="round"/>`,
    meter: `<rect x="29" y="18" width="42" height="66" rx="10" fill="${main}" stroke="#16120f" stroke-width="5"/><circle cx="50" cy="42" r="15" fill="#fff9dd" stroke="#16120f" stroke-width="4"/><path d="M50 42 L62 35" stroke="${hit}" stroke-width="5" stroke-linecap="round"/>`,
    twins: `<circle cx="36" cy="37" r="14" fill="${main}" stroke="#16120f" stroke-width="5"/><circle cx="64" cy="37" r="14" fill="${hit}" stroke="#16120f" stroke-width="5"/><path d="M20 82 C24 59 48 59 52 82 M48 82 C52 59 76 59 80 82" fill="#fff9dd" stroke="#16120f" stroke-width="5"/>`,
    speech: `<path d="M19 28 H77 V62 H49 L32 78 L36 62 H19 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M32 42 H64 M32 52 H55" stroke="#fff9dd" stroke-width="6" stroke-linecap="round"/>`,
    mask: `<path d="M21 33 C36 20 64 20 79 33 C75 66 61 80 50 68 C39 80 25 66 21 33Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M32 45 C38 39 44 39 49 45 M51 45 C57 39 63 39 69 45" fill="none" stroke="#16120f" stroke-width="5"/><path d="M42 61 C47 64 53 64 58 61" fill="none" stroke="${hit}" stroke-width="5"/>`,
    police: `<path d="M50 15 L78 29 L72 65 C66 78 57 84 50 86 C43 84 34 78 28 65 L22 29 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M36 45 H64 M50 31 V68" stroke="#fff9dd" stroke-width="7" stroke-linecap="round"/>`,
    fight: `<path d="M26 48 L42 31 L56 45 L73 30 L81 43 L63 59 L74 74 L60 82 L45 65 L29 80 L18 67 L35 53 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M36 42 L64 70 M66 41 L37 70" stroke="${hit}" stroke-width="6" stroke-linecap="round"/>`,
    bird: `<path d="M16 56 C33 30 49 37 52 55 C62 35 79 31 88 56 C72 49 64 56 55 70 C44 54 31 50 16 56Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M48 56 L63 49 L56 63 Z" fill="${hit}" stroke="#16120f" stroke-width="4"/>`,
    splash: `<path d="M50 16 C66 39 80 54 74 71 C68 87 32 87 26 71 C20 54 35 39 50 16Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M37 68 C44 74 56 74 63 68" fill="none" stroke="#fff9dd" stroke-width="5"/>`,
    body: `<circle cx="50" cy="27" r="12" fill="${hit}" stroke="#16120f" stroke-width="5"/><path d="M36 43 C43 36 57 36 64 43 L70 80 H30 Z" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M35 53 L18 68 M65 53 L82 68" stroke="#16120f" stroke-width="6" stroke-linecap="round"/>`,
    crash: `<path d="M48 13 L57 36 L82 25 L67 48 L88 62 L63 64 L67 88 L49 70 L29 88 L35 63 L12 59 L34 47 L19 24 L42 36 Z" fill="${hit}" stroke="#16120f" stroke-width="5"/><path d="M35 53 H65 M45 40 L55 67" stroke="${main}" stroke-width="7" stroke-linecap="round"/>`,
    legend: `<path d="M50 12 L64 38 L92 42 L71 62 L77 90 L50 76 L23 90 L29 62 L8 42 L36 38 Z" fill="${hit}" stroke="#16120f" stroke-width="5"/><circle cx="50" cy="52" r="20" fill="${main}" stroke="#16120f" stroke-width="5"/><path d="M39 52 C45 43 56 43 62 52 C56 61 45 61 39 52Z" fill="#fff9dd" stroke="#16120f" stroke-width="4"/><circle cx="50" cy="52" r="5" fill="#16120f"/>`,
    weird: `<path d="M25 35 C34 12 71 20 68 45 C87 51 76 83 52 73 C35 91 12 67 25 51 C14 44 16 36 25 35Z" fill="${main}" stroke="#16120f" stroke-width="5"/><circle cx="42" cy="48" r="5" fill="#16120f"/><circle cx="61" cy="45" r="5" fill="#16120f"/><path d="M39 64 C47 70 58 70 66 61" fill="none" stroke="${hit}" stroke-width="5" stroke-linecap="round"/>`,
  };

  return `<svg class="drawing" viewBox="0 0 100 100" aria-hidden="true">${common}${drawings[type] || drawings.weird}</svg>`;
}

function renderGrid() {
  TIERS.forEach(category => {
    const container = $(`#grid-${category}`);
    const section = $(`#section-${category}`);
    const items = myGrid[category] || [];
    const checked = myChecked[category] || [];
    const occurrences = myOccurrences[category] || {};
    const bonuses = myBonuses[category] || 0;
    if (!container || !section) return;

    container.innerHTML = '';

    items.forEach((item, index) => {
      const cell = document.createElement('div');
      cell.className = `cell ${category}-cell`;

      if (checked.includes(index)) {
        cell.classList.add('checked');
      }

      if (!checked.includes(index) && rerollRemaining > 0) {
        cell.classList.add('reroll-target');
      }

      if (!checked.includes(index) && freeCheckCategory === category) {
        cell.classList.add('freecheck-target');
      }

      const emojiSpan = document.createElement('span');
      emojiSpan.className = 'emoji';
      emojiSpan.textContent = categoryEmoji(item);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'label';
      labelSpan.textContent = item.label.replace(/\s*\(ultra\)/gi, '');

      cell.appendChild(emojiSpan);
      cell.appendChild(labelSpan);

      const count = occurrences[index] || (checked.includes(index) ? 1 : 0);
      if (count > 1) {
        const countBadge = document.createElement('span');
        countBadge.className = 'occurrence-badge';
        countBadge.textContent = `x${count}`;
        cell.appendChild(countBadge);
      }

      let longPressTimer = null;
      let didLongPress = false;

      cell.addEventListener('pointerdown', () => {
        didLongPress = false;
        if (!checked.includes(index)) return;
        longPressTimer = window.setTimeout(() => {
          didLongPress = true;
          playMultipickSound();
          emitSocket('repeat-cell', { category, index });
          cell.classList.add('long-pressing');
          window.setTimeout(() => cell.classList.remove('long-pressing'), 260);
        }, 560);
      });

      ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
        cell.addEventListener(eventName, () => {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
        });
      });

      cell.addEventListener('click', (event) => {
        if (didLongPress) {
          event.preventDefault();
          event.stopPropagation();
          window.setTimeout(() => { didLongPress = false; }, 0);
          return;
        }
        if (freeCheckCategory) {
          if (category !== freeCheckCategory) {
            showToast(`Choisis dans ${TIER_NAMES[freeCheckCategory]}`);
            return;
          }
          if (checked.includes(index)) {
            showToast('Choisis une case non cochée');
            return;
          }
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
        const wasChecked = checked.includes(index);
        playTapSound(category, wasChecked);
        emitSocket('toggle-cell', { category, index });
        cell.classList.add('just-checked');
        setTimeout(() => cell.classList.remove('just-checked'), 250);
      });

      container.appendChild(cell);
    });

    const progress = $(`#progress-${category}`);
    progress.textContent = `${checked.length}/${items.length}`;
    const bonus = $(`#bonus-${category}`);
    if (bonus) {
      bonus.textContent = rerollRemaining > 0 ? `rejouer x${rerollRemaining}` : (freeCheckCategory === category ? 'gratis !' : (bonuses > 0 ? `bonus x${bonuses}` : ''));
    }

    if (checked.length === items.length) {
      section.classList.add('complete');
    } else {
      section.classList.remove('complete');
    }
  });
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

btnClosePanel.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);

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

// --- NEW GAME ---

btnNewGame.addEventListener('click', () => emitSocket('new-game'));
btnNewGame2.addEventListener('click', () => emitSocket('new-game'));

btnBonusFreecheck.addEventListener('click', () => {
  closeBonusChoice();
  emitSocket('choose-bonus', { choice: 'free-check' });
});

btnBonusReroll.addEventListener('click', () => {
  closeBonusChoice();
  emitSocket('choose-bonus', { choice: 'reroll' });
});

// --- CATEGORY EDITOR ---

const screenEditor = $('#screen-editor');
const btnEditorBack = $('#btn-editor-back');
const btnEditorReset = $('#btn-editor-reset');
const btnSaveCats = $('#btn-save-cats');

let editCategories = null;

btnEditCats.addEventListener('click', () => {
  window.location.href = '/admin';
});

if (socket) {
  socket.on('categories-data', (categories) => {
    editCategories = { ...TIERS.reduce((acc, tier) => ({ ...acc, [tier]: [] }), {}), ...JSON.parse(JSON.stringify(categories)) };
    renderEditor();
    showScreen(screenEditor);
  });
}

btnEditorBack.addEventListener('click', () => {
  showScreen(screenHome);
});

btnEditorReset.addEventListener('click', () => {
  if (confirm('Remettre toutes les catégories par défaut ?')) {
    emitSocket('reset-categories');
  }
});

btnSaveCats.addEventListener('click', () => {
  collectEditorData();
  emitSocket('save-categories', editCategories);
});

if (socket) {
  socket.on('categories-saved', () => {
    showToast('Catégories sauvegardées !');
    showScreen(screenHome);
  });
}

function renderEditor() {
  TIERS.forEach(tier => {
    const list = $(`#editor-list-${tier}`);
    const count = $(`#count-${tier}`);
    const items = editCategories[tier] || [];
    if (!list || !count) return;

    count.textContent = `${items.length}`;
    list.innerHTML = '';

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'editor-item';

      const preview = document.createElement('div');
      preview.className = 'edit-drawing-preview';
      preview.innerHTML = categoryDrawing(item, tier);

      const inputLabel = document.createElement('input');
      inputLabel.type = 'text';
      inputLabel.className = 'edit-label';
      inputLabel.value = item.label;
      inputLabel.placeholder = 'Nom de la catégorie';
      inputLabel.setAttribute('data-tier', tier);
      inputLabel.setAttribute('data-index', index);
      inputLabel.setAttribute('data-field', 'label');

      const btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-item';
      btnDel.textContent = '×';
      btnDel.addEventListener('click', () => {
        editCategories[tier].splice(index, 1);
        renderEditor();
      });

      row.appendChild(preview);
      row.appendChild(inputLabel);
      row.appendChild(btnDel);
      list.appendChild(row);
    });
  });

  $$('.btn-add').forEach(btn => {
    btn.onclick = () => {
      const tier = btn.getAttribute('data-tier');
      editCategories[tier].push({
        id: 'custom-' + Date.now(),
        label: ''
      });
      renderEditor();
      const list = $(`#editor-list-${tier}`);
      const lastInput = list.querySelector('.editor-item:last-child .edit-label');
      if (lastInput) lastInput.focus();
    };
  });
}

function collectEditorData() {
  $$('.editor-item').forEach(row => {
    const labelInput = row.querySelector('.edit-label');
    if (!labelInput) return;
    const tier = labelInput.getAttribute('data-tier');
    const index = parseInt(labelInput.getAttribute('data-index'));
    if (editCategories[tier] && editCategories[tier][index]) {
      editCategories[tier][index].label = labelInput.value;
    }
  });
  TIERS.forEach(tier => {
    editCategories[tier] = editCategories[tier].filter(c => c.label.trim() !== '');
  });
}
