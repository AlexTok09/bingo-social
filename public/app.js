const socket = typeof io === 'function' ? io() : null;
const TIERS = ['ordinaire', 'semi', 'rare', 'legendaire'];
const TIER_NAMES = {
  ordinaire: 'Ordinaire',
  semi: 'Semi-Ordinaire',
  rare: 'Rare',
  legendaire: 'Légendaire',
};
const TIER_EMOJIS = {
  ordinaire: '🏆',
  semi: '💎',
  rare: '🌟',
  legendaire: '🔮',
};

let myGrid = null;
let myChecked = emptyChecked();
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

const screenHome = $('#screen-home');
const screenGame = $('#screen-game');
const inputName = $('#player-name');
const inputCode = $('#room-code');
const btnCreate = $('#btn-create');
const btnJoin = $('#btn-join');
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
const winEmoji = $('#win-emoji');
const winTitle = $('#win-title');
const winDetail = $('#win-detail');
const btnNewGame = $('#btn-new-game');
const btnNewGame2 = $('#btn-new-game-2');
const toastEl = $('#toast');

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
  emitSocket('create-room', name);
});

btnJoin.addEventListener('click', () => {
  const name = inputName.value.trim();
  const code = inputCode.value.trim().toUpperCase();
  if (!name) { showError('Entre ton prénom !'); return; }
  if (!code || code.length < 4) { showError('Code à 4 caractères !'); return; }
  playerName = name;
  emitSocket('join-room', { code, playerName: name });
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
    enterGame();
  });

  socket.on('room-joined', ({ code, grid }) => {
    roomCode = code;
    myGrid = grid;
    myChecked = emptyChecked();
    enterGame();
  });

  socket.on('error-msg', (msg) => {
    showError(msg);
  });

  socket.on('grid-update', (checked) => {
    myChecked = { ...emptyChecked(), ...checked };
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
    winEmoji.textContent = TIER_EMOJIS[category] || '🏁';
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
    winOverlay.classList.remove('active');
    btnNewGame.style.display = 'none';
    renderGrid();
    showToast('Nouvelle partie !');
  });
}

// --- GAME ---

function enterGame() {
  displayCode.textContent = roomCode;
  showScreen(screenGame);
  renderGrid();
}

function renderGrid() {
  TIERS.forEach(category => {
    const container = $(`#grid-${category}`);
    const section = $(`#section-${category}`);
    const items = myGrid[category] || [];
    const checked = myChecked[category] || [];
    if (!container || !section) return;

    container.innerHTML = '';

    items.forEach((item, index) => {
      const cell = document.createElement('div');
      cell.className = `cell ${category}-cell`;

      if (checked.includes(index)) {
        cell.classList.add('checked');
      }

      const emojiSpan = document.createElement('span');
      emojiSpan.className = 'emoji';
      emojiSpan.textContent = item.emoji;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'label';
      labelSpan.textContent = item.label;

      cell.appendChild(emojiSpan);
      cell.appendChild(labelSpan);

      cell.addEventListener('click', () => {
        emitSocket('toggle-cell', { category, index });
        cell.classList.add('just-checked');
        setTimeout(() => cell.classList.remove('just-checked'), 250);
      });

      container.appendChild(cell);
    });

    const progress = $(`#progress-${category}`);
    progress.textContent = `${checked.length}/${items.length}`;

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

// --- CATEGORY EDITOR ---

const screenEditor = $('#screen-editor');
const btnEditCats = $('#btn-edit-cats');
const btnEditorBack = $('#btn-editor-back');
const btnEditorReset = $('#btn-editor-reset');
const btnSaveCats = $('#btn-save-cats');

let editCategories = null;

btnEditCats.addEventListener('click', () => {
  emitSocket('get-categories');
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

      const inputEmoji = document.createElement('input');
      inputEmoji.type = 'text';
      inputEmoji.className = 'edit-emoji';
      inputEmoji.value = item.emoji;
      inputEmoji.setAttribute('data-tier', tier);
      inputEmoji.setAttribute('data-index', index);
      inputEmoji.setAttribute('data-field', 'emoji');

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

      row.appendChild(inputEmoji);
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
        label: '',
        emoji: '\u{2753}'
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
    const emojiInput = row.querySelector('.edit-emoji');
    const labelInput = row.querySelector('.edit-label');
    if (!emojiInput || !labelInput) return;
    const tier = emojiInput.getAttribute('data-tier');
    const index = parseInt(emojiInput.getAttribute('data-index'));
    if (editCategories[tier] && editCategories[tier][index]) {
      editCategories[tier][index].emoji = emojiInput.value;
      editCategories[tier][index].label = labelInput.value;
    }
  });
  TIERS.forEach(tier => {
    editCategories[tier] = editCategories[tier].filter(c => c.label.trim() !== '');
  });
}
