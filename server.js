const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'binglou-admin');

app.use(express.json({ limit: '200kb' }));

const CATEGORIES_FILE = process.env.CATEGORIES_FILE || path.join(__dirname, 'categories.json');

const CATEGORIES_SOURCE_FILE = path.join(__dirname, 'categories-editables.txt');
const TIER_HEADINGS = {
  'ordinaire': 'ordinaire',
  'semi-ordinaire': 'semi',
  'semi': 'semi',
  'rare': 'rare',
  'legendaire': 'legendaire',
  'légendaire': 'legendaire',
};

function slugifyLabel(label) {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'categorie';
}

function emptyCategories() {
  return { ordinaire: [], semi: [], rare: [], legendaire: [] };
}

function emptyChecked() {
  return { ordinaire: [], semi: [], rare: [], legendaire: [] };
}

function emptyOccurrences() {
  return { ordinaire: {}, semi: {}, rare: {}, legendaire: {} };
}

function emptyBonuses() {
  return { ordinaire: 0, semi: 0, rare: 0, legendaire: 0 };
}

function emptyPendingBonus() {
  return null;
}

function totalCheckedCount(player) {
  return Object.values(player.checked || {}).reduce((sum, checked) => sum + (checked?.length || 0), 0);
}

function isValidTier(tier) {
  return Object.prototype.hasOwnProperty.call(GRID_CONFIG, tier);
}

function snapshotPlayerState(player) {
  return {
    checked: player.checked,
    occurrences: player.occurrences,
    bonuses: player.bonuses,
  };
}

function syncPlayerState(socket, player) {
  socket.emit('grid-update', snapshotPlayerState(player));
}

function validateCategoriesConfig(categories) {
  if (!categories || typeof categories !== 'object') {
    return 'Catégories invalides.';
  }

  for (const [tier, count] of Object.entries(GRID_CONFIG)) {
    const items = categories[tier];
    if (!Array.isArray(items) || items.length < count) {
      return `La catégorie ${tier} doit contenir au moins ${count} éléments.`;
    }
    if (items.some(item => !item || typeof item.label !== 'string' || !item.label.trim())) {
      return `La catégorie ${tier} contient un élément invalide.`;
    }
  }

  return null;
}

function parseEditableCategories(text) {
  const categories = emptyCategories();
  let currentTier = null;

  text.split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) return;

    const heading = line.replace(/:$/, '').toLowerCase();
    if (TIER_HEADINGS[heading]) {
      currentTier = TIER_HEADINGS[heading];
      return;
    }

    if (!currentTier) return;
    categories[currentTier].push({
      id: slugifyLabel(line),
      label: line,
    });
  });

  return categories;
}

function loadDefaultCategories() {
  const data = fs.readFileSync(CATEGORIES_SOURCE_FILE, 'utf-8');
  return parseEditableCategories(data);
}

const DEFAULT_CATEGORIES = loadDefaultCategories();
function loadCategories() {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  try {
    if (fs.existsSync(CATEGORIES_FILE)) {
      const data = fs.readFileSync(CATEGORIES_FILE, 'utf-8');
      const loaded = normalizeCategories({ ...defaults, ...JSON.parse(data) });
      if (!validateCategoriesConfig(loaded)) {
        return loaded;
      }
    }
  } catch (e) {}
  return normalizeCategories(defaults);
}

function saveCategories(categories) {
  fs.mkdirSync(path.dirname(CATEGORIES_FILE), { recursive: true });
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(normalizeCategories(categories), null, 2), 'utf-8');
}

function normalizeCategories(categories) {
  return Object.fromEntries(Object.entries(categories).map(([tier, items]) => [
    tier,
    (items || []).map(({ id, label }) => ({ id, label })),
  ]));
}

let CATEGORIES = loadCategories();

const GRID_CONFIG = {
  ordinaire: 12,
  semi: 6,
  rare: 2,
  legendaire: 1
};

const BONUS_REPEAT_THRESHOLD = {
  semi: 2,
};

const BONUS_REROLL_COUNT = {
  semi: 2,
};

const rooms = new Map();

function isAdminRequest(req) {
  return Boolean(ADMIN_PASSWORD) && req.get('x-admin-password') === ADMIN_PASSWORD;
}

function publicCategories() {
  return JSON.parse(JSON.stringify(CATEGORIES));
}

function applyCategories(categories, options = {}) {
  CATEGORIES = normalizeCategories(categories);
  saveCategories(CATEGORIES);
  io.emit('categories-updated', publicCategories());

  if (!options.resetRooms) return;

  for (const room of rooms.values()) {
    room.winner = null;
    room.players.forEach(p => {
      p.grid = generateGrid();
      p.checked = emptyChecked();
      p.occurrences = emptyOccurrences();
      p.bonuses = emptyBonuses();
      p.pendingBonus = emptyPendingBonus();
    });

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('new-game-started', { grid: p.grid });
      }
    });

    io.to(room.code).emit('players-update', getPlayersInfo(room));
  }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateGrid() {
  return {
    ordinaire: pickGridItems(CATEGORIES.ordinaire, GRID_CONFIG.ordinaire),
    semi: pickGridItems(CATEGORIES.semi, GRID_CONFIG.semi),
    rare: pickGridItems(CATEGORIES.rare, GRID_CONFIG.rare),
    legendaire: pickGridItems(CATEGORIES.legendaire, GRID_CONFIG.legendaire),
  };
}

function ultraKey(item) {
  if (!/\(ultra\)/i.test(item.label)) return null;
  return slugifyLabel(item.label.replace(/\(ultra\)/ig, ''));
}

function pickGridItems(items, count) {
  const selected = [];
  let hasUltra = false;

  for (const item of shuffleArray(items)) {
    const isUltra = Boolean(ultraKey(item));
    if (isUltra && hasUltra) continue;
    selected.push(item);
    if (isUltra) hasUltra = true;
    if (selected.length === count) return selected;
  }

  return selected;
}

function rerollOneCell(player, tier, index) {
  const checked = new Set(player.checked[tier] || []);
  if (checked.has(index) || !player.grid[tier]?.[index]) return false;

  const current = player.grid[tier][index];
  const usedIds = new Set(player.grid[tier].map(item => item.id));
  usedIds.delete(current.id);
  const hasUltraElsewhere = player.grid[tier].some((item, itemIndex) => itemIndex !== index && ultraKey(item));
  const replacement = shuffleArray(CATEGORIES[tier]).find(candidate => {
    const isUltra = Boolean(ultraKey(candidate));
    return !usedIds.has(candidate.id) && (!isUltra || !hasUltraElsewhere);
  });

  if (!replacement) return false;
  player.grid[tier][index] = replacement;
  delete player.occurrences[tier][index];
  return true;
}

function getProgress(player) {
  return {
    ordinaire: { checked: player.checked.ordinaire.length, total: player.grid.ordinaire.length },
    semi: { checked: player.checked.semi.length, total: player.grid.semi.length },
    rare: { checked: player.checked.rare.length, total: player.grid.rare.length },
    legendaire: { checked: player.checked.legendaire.length, total: player.grid.legendaire.length },
  };
}

function getPlayersInfo(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    progress: getProgress(p),
  }));
}

function removePlayerFromRoom(socket) {
  if (!socket.roomCode) return;
  const room = rooms.get(socket.roomCode);
  if (!room) {
    socket.roomCode = null;
    return;
  }

  const name = room.players.find(p => p.id === socket.id)?.name;
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(socket.roomCode);

  if (room.players.length === 0) {
    rooms.delete(socket.roomCode);
  } else {
    io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
    if (name) io.to(socket.roomCode).emit('player-left', name);
  }

  socket.roomCode = null;
}

app.get('/api/admin/categories', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }
  res.json(publicCategories());
});

app.put('/api/admin/categories', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }

  const categories = req.body?.categories;
  const resetRooms = req.body?.resetRooms !== false;
  const categoriesError = validateCategoriesConfig(categories);
  if (categoriesError) {
    res.status(400).json({ error: categoriesError });
    return;
  }

  applyCategories(categories, { resetRooms });
  res.json({ ok: true, categories: publicCategories(), resetRooms });
});

app.post('/api/admin/reset-categories', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }

  const resetRooms = req.body?.resetRooms !== false;
  applyCategories(DEFAULT_CATEGORIES, { resetRooms });
  res.json({ ok: true, categories: publicCategories(), resetRooms });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static('public'));

io.on('connection', (socket) => {

  socket.on('get-categories', () => {
    socket.emit('categories-data', publicCategories());
  });

  socket.on('save-categories', (categories) => {
    socket.emit('error-msg', 'Edition déplacée dans /admin.');
  });

  socket.on('reset-categories', () => {
    socket.emit('error-msg', 'Edition déplacée dans /admin.');
  });

  socket.on('create-room', (playerName) => {
    const code = generateRoomCode();
    const grid = generateGrid();
    const player = {
      id: socket.id,
      name: playerName,
      grid,
      checked: emptyChecked(),
      occurrences: emptyOccurrences(),
      bonuses: emptyBonuses(),
      pendingBonus: emptyPendingBonus(),
    };
    rooms.set(code, {
      code,
      players: [player],
      winner: null,
      createdAt: Date.now(),
    });
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-created', { code, grid });
    io.to(code).emit('players-update', getPlayersInfo(rooms.get(code)));
  });

  socket.on('join-room', ({ code, playerName }) => {
    const roomCode = code.toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error-msg', 'Salon introuvable !');
      return;
    }
    if (room.winner) {
      socket.emit('error-msg', 'Cette partie est déjà terminée !');
      return;
    }
    if (room.players.find(p => p.name === playerName)) {
      socket.emit('error-msg', 'Ce nom est déjà pris !');
      return;
    }
    const grid = generateGrid();
    const player = {
      id: socket.id,
      name: playerName,
      grid,
      checked: emptyChecked(),
      occurrences: emptyOccurrences(),
      bonuses: emptyBonuses(),
      pendingBonus: emptyPendingBonus(),
    };
    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('room-joined', { code: roomCode, grid });
    io.to(roomCode).emit('players-update', getPlayersInfo(room));
    io.to(roomCode).emit('player-joined', playerName);
  });

  socket.on('leave-room', () => {
    removePlayerFromRoom(socket);
  });

  socket.on('toggle-cell', ({ category, index }, ack) => {
    const reply = (payload) => {
      if (typeof ack === 'function') ack(payload);
    };

    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) {
      reply({ ok: false, reason: 'Salon introuvable.' });
      return;
    }
    const player = room.players.find(p => p.id === socket.id);
    if (room.winner) {
      if (player) syncPlayerState(socket, player);
      reply({ ok: false, reason: 'La partie est déjà terminée.' });
      return;
    }
    if (!player) {
      reply({ ok: false, reason: 'Joueur introuvable.' });
      return;
    }
    if (player.pendingBonus) {
      syncPlayerState(socket, player);
      reply({ ok: false, reason: 'Termine ton bonus avant de cocher une case.' });
      return;
    }

    player.occurrences ||= emptyOccurrences();
    player.bonuses ||= emptyBonuses();

    const categoryKey = typeof category === 'string' ? category : '';
    const indexNumber = Number(index);
    const checkedList = player.checked[categoryKey];
    const gridItems = player.grid[categoryKey];
    if (!isValidTier(categoryKey) || !Array.isArray(checkedList) || !Array.isArray(gridItems) || !Number.isInteger(indexNumber) || indexNumber < 0 || indexNumber >= gridItems.length) {
      syncPlayerState(socket, player);
      reply({ ok: false, reason: 'Case invalide.' });
      return;
    }

    const idx = checkedList.indexOf(indexNumber);
    if (idx === -1) {
      checkedList.push(indexNumber);
      player.occurrences[categoryKey][indexNumber] = 1;
    } else {
      checkedList.splice(idx, 1);
      delete player.occurrences[categoryKey][indexNumber];
    }

    syncPlayerState(socket, player);
    reply({ ok: true });

    if (checkedList.length === gridItems.length) {
      room.winner = { id: player.id, name: player.name, category: categoryKey };
      io.to(socket.roomCode).emit('game-won', room.winner);
    }

    const checkedTotal = totalCheckedCount(player);
    if (!room.winner && !player.pendingBonus && checkedTotal >= 2 && checkedTotal % 2 === 0) {
      player.pendingBonus = { type: 'reroll-picks', remaining: 1, picked: [] };
      socket.emit('reroll-bonus-start', { remaining: 1 });
    }

    io.to(socket.roomCode).emit('cell-activity', {
      playerId: player.id,
      name: player.name,
      category: categoryKey,
      index: indexNumber,
      label: gridItems[indexNumber]?.label || '',
      checked: idx === -1,
    });

    io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('repeat-cell', ({ category, index }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.winner) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.pendingBonus) return;

    player.occurrences ||= emptyOccurrences();
    player.bonuses ||= emptyBonuses();

    const categoryKey = typeof category === 'string' ? category : '';
    const indexNumber = Number(index);
    const checkedList = player.checked[categoryKey];
    const gridItems = player.grid[categoryKey];
    if (!isValidTier(categoryKey) || !Array.isArray(checkedList) || !Array.isArray(gridItems) || !Number.isInteger(indexNumber) || indexNumber < 0 || indexNumber >= gridItems.length) return;
    if (!checkedList.includes(indexNumber)) return;

    const currentCount = player.occurrences[categoryKey][indexNumber] || 1;
    const nextCount = currentCount + 1;
    const bonusThreshold = BONUS_REPEAT_THRESHOLD[categoryKey] || 3;
    const rerollCount = BONUS_REROLL_COUNT[categoryKey] || 3;

    if (nextCount >= bonusThreshold) {
      player.occurrences[categoryKey][indexNumber] = 1;
      player.pendingBonus = { type: 'bonus-choice', category: categoryKey, rerollCount };
      socket.emit('bonus-choice-start', { category: categoryKey, rerollCount });
    } else {
      player.occurrences[categoryKey][indexNumber] = nextCount;
      socket.emit('occurrence-update', {
        category: categoryKey,
        index: indexNumber,
        count: nextCount,
        occurrences: player.occurrences,
        bonuses: player.bonuses,
      });
    }

    socket.emit('grid-update', {
      checked: player.checked,
      occurrences: player.occurrences,
      bonuses: player.bonuses,
    });
  });

  socket.on('reroll-cell', ({ category, index }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.winner) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.pendingBonus?.type !== 'reroll-picks') return;
    const categoryKey = typeof category === 'string' ? category : '';
    const indexNumber = Number(index);
    const gridItems = player.grid[categoryKey];
    if (!isValidTier(categoryKey) || !Array.isArray(gridItems) || !Number.isInteger(indexNumber) || indexNumber < 0 || indexNumber >= gridItems.length) return;
    const pickKey = `${categoryKey}:${indexNumber}`;
    if (player.pendingBonus.picked.includes(pickKey)) return;

    player.occurrences ||= emptyOccurrences();
    player.bonuses ||= emptyBonuses();

    if (!rerollOneCell(player, categoryKey, indexNumber)) return;
    player.pendingBonus.picked.push(pickKey);
    player.pendingBonus.remaining -= 1;
    const remaining = player.pendingBonus.remaining;
    if (remaining <= 0) {
      player.pendingBonus = emptyPendingBonus();
    }

    socket.emit('reroll-update', {
      grid: player.grid,
      checked: player.checked,
      occurrences: player.occurrences,
      bonuses: player.bonuses,
      remaining,
    });
    io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('choose-bonus', ({ choice }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.winner) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.pendingBonus?.type !== 'bonus-choice') return;

    const category = player.pendingBonus.category;
    const rerollCount = player.pendingBonus.rerollCount || 3;

    if (choice === 'free-check') {
      player.pendingBonus = { type: 'free-check', category };
      socket.emit('free-check-start', { category });
    } else if (choice === 'reroll') {
      player.pendingBonus = { type: 'reroll-picks', remaining: rerollCount, picked: [] };
      socket.emit('reroll-bonus-start', { remaining: rerollCount });
    }
  });

  socket.on('free-check-cell', ({ category, index }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.winner) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.pendingBonus?.type !== 'free-check') return;
    const categoryKey = typeof category === 'string' ? category : '';
    const indexNumber = Number(index);
    if (categoryKey !== player.pendingBonus.category) return;
    if (!isValidTier(categoryKey) || !Array.isArray(player.grid[categoryKey]) || !Number.isInteger(indexNumber) || indexNumber < 0 || indexNumber >= player.grid[categoryKey].length) return;
    if (player.checked[categoryKey].includes(indexNumber)) return;

    player.checked[categoryKey].push(indexNumber);
    player.occurrences[categoryKey][indexNumber] = 1;
    player.pendingBonus = emptyPendingBonus();

    socket.emit('free-check-done', {
      category: categoryKey,
      index: indexNumber,
      checked: player.checked,
      occurrences: player.occurrences,
      bonuses: player.bonuses,
    });
    socket.emit('grid-update', {
      checked: player.checked,
      occurrences: player.occurrences,
      bonuses: player.bonuses,
    });
    io.to(socket.roomCode).emit('cell-activity', {
      playerId: player.id,
      name: player.name,
      category: categoryKey,
      index: indexNumber,
      label: player.grid[categoryKey][indexNumber]?.label || '',
      checked: true,
    });

    if (player.checked[categoryKey].length === player.grid[categoryKey].length) {
      room.winner = { id: player.id, name: player.name, category: categoryKey };
      io.to(socket.roomCode).emit('game-won', room.winner);
    }

    io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('new-game', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    room.winner = null;
    room.players.forEach(p => {
      p.grid = generateGrid();
      p.checked = emptyChecked();
      p.occurrences = emptyOccurrences();
      p.bonuses = emptyBonuses();
      p.pendingBonus = emptyPendingBonus();
    });

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('new-game-started', { grid: p.grid });
      }
    });

    io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('disconnect', () => {
    removePlayerFromRoom(socket);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 4 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bingo Social sur http://localhost:${PORT}`);
});
