const express = require('express');
const compression = require('compression');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'binglou-admin');
const REDIS_URL = process.env.REDIS_URL || process.env.VALKEY_URL || process.env.KEY_VALUE_URL || '';
const ROOM_KEY_PREFIX = 'bingo:room:';
const ROOM_TTL_SECONDS = 4 * 60 * 60;

app.use(compression());
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
  return { ordinaire: 0, semi: 0, rare: 0, legendaire: 0, joker: 0 };
}

function emptyPendingBonus() {
  return null;
}

function totalCheckedCount(player) {
  return Object.values(player.checked || {}).reduce((sum, checked) => sum + (checked?.length || 0), 0);
}

function getCompletedTiers(player) {
  return Object.keys(GRID_CONFIG).filter(tier =>
    Array.isArray(player.checked?.[tier]) &&
    Array.isArray(player.grid?.[tier]) &&
    player.grid[tier].length > 0 &&
    player.checked[tier].length === player.grid[tier].length
  );
}

// La légendaire fait gagner instantanément (tous modes). Sinon il faut
// room.tiersToWin grilles complétées (1 = normal, 2 = difficile).
function evaluateWinner(room, player, justCategory) {
  const completed = getCompletedTiers(player);
  if (completed.includes('legendaire')) return 'legendaire';
  if (completed.length >= (room.tiersToWin || 1)) {
    return justCategory && completed.includes(justCategory) ? justCategory : completed[completed.length - 1];
  }
  return null;
}

function clearReconnectTimer(player) {
  if (player.reconnectTimeout) {
    clearTimeout(player.reconnectTimeout);
    player.reconnectTimeout = null;
  }
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

async function getActionContext(socket, payload = {}) {
  const payloadRoomCode = typeof payload?.roomCode === 'string' ? payload.roomCode.toUpperCase().trim() : '';
  const roomCode = socket.roomCode || payloadRoomCode;
  if (!roomCode) return {};

  const room = await getRoom(roomCode);
  if (!room) return { roomCode };

  const actionClientId = payload?.clientId || socket.clientId || null;
  let player = room.players.find(p => p.id === socket.id);
  if (!player && actionClientId) {
    player = room.players.find(p => p.clientId === actionClientId);
  }

  if (player) {
    clearReconnectTimer(player);
    player.id = socket.id;
    if (actionClientId && !player.clientId) player.clientId = actionClientId;
    socket.clientId = player.clientId || actionClientId;
    socket.roomCode = roomCode;
    socket.join(roomCode);
    player.disconnectedAt = null;
  }

  return { roomCode, room, player };
}

async function scheduleDisconnectedRemoval(roomCode, clientId) {
  const room = await getRoom(roomCode);
  if (!room) return;
  const player = room.players.find(p => p.clientId === clientId || (!p.clientId && p.id === clientId));
  if (!player) return;

  clearReconnectTimer(player);
  player.disconnectedAt = Date.now();
  await persistRoom(room);
  player.reconnectTimeout = setTimeout(async () => {
    const currentRoom = await getRoom(roomCode);
    if (!currentRoom) return;
    const currentPlayer = currentRoom.players.find(p => p.clientId === clientId || (!p.clientId && p.id === clientId));
    if (!currentPlayer || !currentPlayer.disconnectedAt) return;

    currentRoom.players = currentRoom.players.filter(p => p.clientId !== clientId && p.id !== clientId);
    if (currentRoom.players.length === 0) {
      rooms.delete(roomCode);
      await deletePersistedRoom(roomCode);
    } else {
      await persistRoom(currentRoom);
      io.to(roomCode).emit('players-update', getPlayersInfo(currentRoom));
      io.to(roomCode).emit('player-left', currentPlayer.name);
    }
  }, RECONNECT_GRACE_MS);
}

function buildPlayerState(room, player) {
  return {
    code: room.code,
    grid: player.grid,
    checked: player.checked,
    occurrences: player.occurrences,
    bonuses: player.bonuses,
    pendingBonus: player.pendingBonus,
    winner: room.winner,
    tiersToWin: room.tiersToWin || 1,
    players: getPlayersInfo(room),
  };
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

const GRID_CONFIG = {
  ordinaire: 12,
  semi: 6,
  rare: 2,
  legendaire: 1
};

const BONUS_REPEAT_THRESHOLD = {
  semi: 3,
};

const BONUS_REROLL_COUNT = {
  semi: 3,
};

// Cocher une de ces catégories offre une case gratis, toutes grilles confondues
const POESIE_BONUS_IDS = new Set(['heureux-comme-tout', 'regarde-le-ciel', 'fou-rire']);

const RECONNECT_GRACE_MS = 15 * 60 * 1000;

const rooms = new Map();
let roomStore = null;

function roomKey(roomCode) {
  return `${ROOM_KEY_PREFIX}${roomCode}`;
}

function serializeRoom(room) {
  return {
    ...room,
    players: room.players.map(({ reconnectTimeout, ...player }) => ({
      ...player,
      reconnectTimeout: null,
    })),
  };
}

function hydrateRoom(room) {
  if (!room || typeof room !== 'object' || !room.code || !Array.isArray(room.players)) return null;
  room.players.forEach(player => {
    player.reconnectTimeout = null;
    player.checked ||= emptyChecked();
    player.occurrences ||= emptyOccurrences();
    player.bonuses ||= emptyBonuses();
    player.pendingBonus ??= emptyPendingBonus();
  });
  return room;
}

async function persistRoom(room) {
  if (!roomStore || !room?.code) return;
  try {
    await roomStore.set(roomKey(room.code), JSON.stringify(serializeRoom(room)), 'EX', ROOM_TTL_SECONDS);
  } catch (error) {
    console.error('Room persistence failed:', error.message);
  }
}

async function deletePersistedRoom(roomCode) {
  if (!roomStore || !roomCode) return;
  try {
    await roomStore.del(roomKey(roomCode));
  } catch (error) {
    console.error('Room deletion failed:', error.message);
  }
}

async function loadRoom(roomCode) {
  if (!roomStore || !roomCode) return null;
  try {
    const raw = await roomStore.get(roomKey(roomCode));
    if (!raw) return null;
    const room = hydrateRoom(JSON.parse(raw));
    if (!room) return null;
    rooms.set(room.code, room);
    return room;
  } catch (error) {
    console.error('Room load failed:', error.message);
    return null;
  }
}

async function getRoom(roomCode) {
  return rooms.get(roomCode) || await loadRoom(roomCode);
}

async function loadPersistedRooms() {
  if (!roomStore) return;
  try {
    const keys = await roomStore.keys(`${ROOM_KEY_PREFIX}*`);
    if (!keys.length) return;
    const values = await roomStore.mget(keys);
    values.forEach(raw => {
      if (!raw) return;
      try {
        const room = hydrateRoom(JSON.parse(raw));
        if (room) rooms.set(room.code, room);
      } catch {}
    });
    console.log(`Loaded ${rooms.size} persisted room(s)`);
  } catch (error) {
    console.error('Persisted room bootstrap failed:', error.message);
  }
}

async function initRealtimeStore() {
  if (!REDIS_URL) return;
  const redisOptions = { lazyConnect: true, maxRetriesPerRequest: null };
  const pubClient = new Redis(REDIS_URL, redisOptions);
  const subClient = pubClient.duplicate();
  const dataClient = pubClient.duplicate();

  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
    dataClient.connect(),
  ]);

  io.adapter(createAdapter(pubClient, subClient));
  roomStore = dataClient;
  await loadPersistedRooms();
  console.log('Redis/Valkey realtime store enabled');
}

const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX = 15;

function checkRateLimit(socket) {
  const now = Date.now();
  if (!socket._rlWindow || now - socket._rlWindow > RATE_LIMIT_WINDOW_MS) {
    socket._rlWindow = now;
    socket._rlCount = 1;
    return true;
  }
  socket._rlCount += 1;
  if (socket._rlCount > RATE_LIMIT_MAX) {
    socket.emit('error-msg', 'Trop de requêtes, ralentis.');
    return false;
  }
  return true;
}

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

function isAdminRequest(req) {
  return Boolean(ADMIN_PASSWORD) && req.get('x-admin-password') === ADMIN_PASSWORD;
}

function publicCategories() {
  return JSON.parse(JSON.stringify(CATEGORIES));
}

async function applyCategories(categories, options = {}) {
  CATEGORIES = normalizeCategories(categories);
  saveCategories(CATEGORIES);
  io.emit('categories-updated', publicCategories());

  if (!options.resetRooms) return;

  for (const room of rooms.values()) {
    room.winner = null;
    room.players.forEach(p => {
      clearReconnectTimer(p);
      p.disconnectedAt = null;
      p.grid = generateGrid();
      p.checked = emptyChecked();
      p.occurrences = emptyOccurrences();
      p.bonuses = emptyBonuses();
      p.pendingBonus = emptyPendingBonus();
    });

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('new-game-started', { grid: p.grid, tiersToWin: room.tiersToWin || 1 });
      }
    });

    io.to(room.code).emit('players-update', getPlayersInfo(room));
    await persistRoom(room);
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

async function removePlayerFromRoom(socket) {
  if (!socket.roomCode) return;
  const room = await getRoom(socket.roomCode);
  if (!room) {
    socket.roomCode = null;
    return;
  }

  const player = room.players.find(p => p.id === socket.id || (socket.clientId && p.clientId === socket.clientId));
  const name = player?.name;
  if (player) clearReconnectTimer(player);
  room.players = room.players.filter(p => p.id !== socket.id && (!socket.clientId || p.clientId !== socket.clientId));
  socket.leave(socket.roomCode);

  if (room.players.length === 0) {
    rooms.delete(socket.roomCode);
    await deletePersistedRoom(socket.roomCode);
  } else {
    await persistRoom(room);
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

app.put('/api/admin/categories', async (req, res) => {
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

  await applyCategories(categories, { resetRooms });
  res.json({ ok: true, categories: publicCategories(), resetRooms });
});

app.post('/api/admin/reset-categories', async (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }

  const resetRooms = req.body?.resetRooms !== false;
  await applyCategories(DEFAULT_CATEGORIES, { resetRooms });
  res.json({ ok: true, categories: publicCategories(), resetRooms });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static('public', {
  etag: true,
  setHeaders(res, filePath) {
    // Médias volumineux qui changent rarement : cache long.
    // HTML/CSS/JS : revalidation à chaque chargement (mises à jour immédiates).
    if (/\.(mp3|png|jpe?g|svg|ico|webp|mp4|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

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

  socket.on('create-room', async (payload) => {
    if (!checkRateLimit(socket)) return;
    const playerName = typeof payload === 'string' ? payload : payload?.playerName;
    const clientId = typeof payload === 'object' && payload ? payload.clientId : null;
    const normalizedName = typeof playerName === 'string' ? playerName.trim() : '';
    if (!normalizedName) {
      socket.emit('error-msg', 'Entre ton prénom !');
      return;
    }
    const code = generateRoomCode();
    const grid = generateGrid();
    const player = {
      id: socket.id,
      clientId,
      name: normalizedName,
      grid,
      checked: emptyChecked(),
      occurrences: emptyOccurrences(),
      bonuses: emptyBonuses(),
      pendingBonus: emptyPendingBonus(),
      disconnectedAt: null,
    };
    rooms.set(code, {
      code,
      players: [player],
      winner: null,
      tiersToWin: 1,
      createdAt: Date.now(),
    });
    await persistRoom(rooms.get(code));
    socket.join(code);
    socket.roomCode = code;
    socket.clientId = clientId;
    socket.emit('room-created', { code, grid, tiersToWin: 1 });
    io.to(code).emit('players-update', getPlayersInfo(rooms.get(code)));
  });

  socket.on('join-room', async (payload) => {
    if (!checkRateLimit(socket)) return;
    const code = payload?.code;
    const playerName = payload?.playerName;
    const clientId = payload?.clientId || null;
    const roomCode = typeof code === 'string' ? code.toUpperCase().trim() : '';
    const normalizedName = typeof playerName === 'string' ? playerName.trim() : '';
    if (!normalizedName) {
      socket.emit('error-msg', 'Entre ton prénom !');
      return;
    }
    if (roomCode.length < 4) {
      socket.emit('error-msg', 'Code à 4 caractères !');
      return;
    }
    const room = await getRoom(roomCode);
    if (!room) {
      socket.emit('error-msg', 'Salon introuvable !');
      return;
    }
    if (room.winner) {
      socket.emit('error-msg', 'Cette partie est déjà terminée !');
      return;
    }
    if (room.players.find(p => p.name === normalizedName)) {
      socket.emit('error-msg', 'Ce nom est déjà pris !');
      return;
    }
    const grid = generateGrid();
    const player = {
      id: socket.id,
      clientId,
      name: normalizedName,
      grid,
      checked: emptyChecked(),
      occurrences: emptyOccurrences(),
      bonuses: emptyBonuses(),
      pendingBonus: emptyPendingBonus(),
      disconnectedAt: null,
    };
    room.players.push(player);
    await persistRoom(room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.clientId = clientId;
    socket.emit('room-joined', { code: roomCode, grid, tiersToWin: room.tiersToWin || 1 });
    io.to(roomCode).emit('players-update', getPlayersInfo(room));
    io.to(roomCode).emit('player-joined', normalizedName);
  });

  socket.on('leave-room', async () => {
    await removePlayerFromRoom(socket);
  });

  socket.on('resume-session', async (payload = {}) => {
    const { roomCode, clientId } = payload;
    if (!roomCode || !clientId) return;
    const normalizedRoomCode = roomCode.toUpperCase().trim();
    const room = await getRoom(normalizedRoomCode);
    if (!room) {
      socket.emit('session-resume-failed', { reason: 'Salon introuvable.' });
      return;
    }

    const player = room.players.find(p => p.clientId === clientId);
    if (!player) {
      socket.emit('session-resume-failed', { reason: 'Session introuvable.' });
      return;
    }

    clearReconnectTimer(player);
    player.id = socket.id;
    player.disconnectedAt = null;
    socket.clientId = player.clientId || clientId;
    socket.join(normalizedRoomCode);
    socket.roomCode = normalizedRoomCode;
    await persistRoom(room);

    socket.emit('session-restored', buildPlayerState(room, player));
    io.to(normalizedRoomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('toggle-cell', async (payload = {}, ack) => {
    const { category, index } = payload;
    const reply = (payload) => {
      if (typeof ack === 'function') ack(payload);
    };
    if (!checkRateLimit(socket)) {
      reply({ ok: false, reason: 'Trop de requêtes, ralentis.' });
      return;
    }

    const { roomCode, room, player } = await getActionContext(socket, payload);
    if (!roomCode) return;
    if (!room) {
      reply({ ok: false, reason: 'Salon introuvable.' });
      return;
    }
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

    const checkedTotal = totalCheckedCount(player);
    if (!player.pendingBonus && checkedTotal >= 2 && checkedTotal % 2 === 0) {
      player.bonuses.joker = (player.bonuses.joker || 0) + 1;
      socket.emit('joker-earned', { count: player.bonuses.joker });
    }

    const winCategory = evaluateWinner(room, player, categoryKey);
    if (winCategory && !room.winner) {
      room.winner = { id: player.id, clientId: player.clientId, name: player.name, category: winCategory, hard: (room.tiersToWin || 1) > 1 };
      io.to(roomCode).emit('game-won', room.winner);
    }

    if (idx === -1 && !room.winner && !player.pendingBonus && POESIE_BONUS_IDS.has(gridItems[indexNumber]?.id)) {
      player.pendingBonus = { type: 'free-check', category: categoryKey, source: 'poesie' };
      socket.emit('free-check-start', { category: categoryKey, source: 'poesie' });
    }

    await persistRoom(room);

    io.to(roomCode).emit('cell-activity', {
      playerId: player.id,
      name: player.name,
      category: categoryKey,
      index: indexNumber,
      label: gridItems[indexNumber]?.label || '',
      checked: idx === -1,
    });

    io.to(roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('repeat-cell', async (payload = {}) => {
    if (!checkRateLimit(socket)) return;
    const { category, index } = payload;
    const { room, player } = await getActionContext(socket, payload);
    if (!room || room.winner) return;
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
    const baseThreshold = BONUS_REPEAT_THRESHOLD[categoryKey] || 3;
    const rerollCount = BONUS_REROLL_COUNT[categoryKey] || 3;

    // Seuils cumulatifs, gap doublé à chaque palier : 3, 9, 21, 45, ...
    let bonusThreshold = baseThreshold;
    let bonusGap = baseThreshold;
    while (bonusThreshold < nextCount) { bonusGap *= 2; bonusThreshold += bonusGap; }

    player.occurrences[categoryKey][indexNumber] = nextCount;
    if (nextCount === bonusThreshold) {
      player.pendingBonus = { type: 'bonus-choice', category: categoryKey, rerollCount };
      socket.emit('bonus-choice-start', { category: categoryKey, rerollCount });
    } else {
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
    await persistRoom(room);
  });

  socket.on('reroll-cell', async (payload = {}) => {
    if (!checkRateLimit(socket)) return;
    const { category, index } = payload;
    const { room, player } = await getActionContext(socket, payload);
    if (!room || room.winner) return;
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
      category: categoryKey,
      index: indexNumber,
    });
    await persistRoom(room);
    io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('use-joker', async (payload = {}) => {
    if (!checkRateLimit(socket)) return;
    const { room, player } = await getActionContext(socket, payload);
    if (!room || room.winner) return;
    if (!player) return;

    player.bonuses ||= emptyBonuses();

    // Re-clic joker pendant reroll bonus repeat : retour au choix
    if (player.pendingBonus?.type === 'reroll-picks' && player.pendingBonus.source !== 'joker' && player.pendingBonus.picked.length === 0) {
      const { category, rerollCount } = player.pendingBonus;
      player.pendingBonus = { type: 'bonus-choice', category, rerollCount };
      socket.emit('bonus-choice-start', { category, rerollCount });
      socket.emit('grid-update', { checked: player.checked, occurrences: player.occurrences, bonuses: player.bonuses });
      await persistRoom(room);
      return;
    }

    // Re-clic joker avant d'avoir relancé une case : annulation et remboursement
    if (player.pendingBonus?.type === 'reroll-picks' && player.pendingBonus.source === 'joker' && player.pendingBonus.picked.length === 0) {
      player.pendingBonus = emptyPendingBonus();
      player.bonuses.joker = (player.bonuses.joker || 0) + 1;
      socket.emit('joker-cancelled', { count: player.bonuses.joker });
      socket.emit('grid-update', {
        checked: player.checked,
        occurrences: player.occurrences,
        bonuses: player.bonuses,
      });
      await persistRoom(room);
      return;
    }

    if (player.pendingBonus) return;
    if ((player.bonuses.joker || 0) <= 0) return;

    player.bonuses.joker -= 1;
    player.pendingBonus = { type: 'reroll-picks', remaining: 1, picked: [], source: 'joker' };
    socket.emit('reroll-bonus-start', { remaining: 1, source: 'joker' });
    socket.emit('grid-update', {
      checked: player.checked,
      occurrences: player.occurrences,
      bonuses: player.bonuses,
    });
    await persistRoom(room);
  });

  socket.on('choose-bonus', async (payload = {}) => {
    if (!checkRateLimit(socket)) return;
    const { choice } = payload;
    const { room, player } = await getActionContext(socket, payload);
    if (!room || room.winner) return;
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
    await persistRoom(room);
  });

  socket.on('free-check-cell', async (payload = {}) => {
    if (!checkRateLimit(socket)) return;
    const { category, index } = payload;
    const { room, player, roomCode } = await getActionContext(socket, payload);
    if (!room || room.winner) return;
    if (!player || player.pendingBonus?.type !== 'free-check') return;
    const categoryKey = typeof category === 'string' ? category : '';
    const indexNumber = Number(index);
    if (player.pendingBonus.category && categoryKey !== player.pendingBonus.category) return;
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
    io.to(roomCode).emit('cell-activity', {
      playerId: player.id,
      name: player.name,
      category: categoryKey,
      index: indexNumber,
      label: player.grid[categoryKey][indexNumber]?.label || '',
      checked: true,
    });

    const winCategory = evaluateWinner(room, player, categoryKey);
    if (winCategory && !room.winner) {
      room.winner = { id: player.id, clientId: player.clientId, name: player.name, category: winCategory, hard: (room.tiersToWin || 1) > 1 };
      io.to(roomCode).emit('game-won', room.winner);
    }

    await persistRoom(room);
    io.to(roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('new-game', async (payload = {}) => {
    if (!checkRateLimit(socket)) return;
    const { room, roomCode, player } = await getActionContext(socket, payload);
    if (!room || !player) return;

    room.tiersToWin = payload && payload.difficulty === 'hard' ? 2 : 1;
    room.winner = null;
    room.players.forEach(p => {
      clearReconnectTimer(p);
      p.grid = generateGrid();
      p.checked = emptyChecked();
      p.occurrences = emptyOccurrences();
      p.bonuses = emptyBonuses();
      p.pendingBonus = emptyPendingBonus();
    });

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('new-game-started', { grid: p.grid, tiersToWin: room.tiersToWin });
      }
    });

    await persistRoom(room);
    io.to(roomCode).emit('players-update', getPlayersInfo(room));
  });

  socket.on('disconnect', async () => {
    if (!socket.roomCode) return;
    const room = await getRoom(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id || (socket.clientId && p.clientId === socket.clientId));
    if (!player) return;
    clearReconnectTimer(player);
    await scheduleDisconnectedRemoval(socket.roomCode, player.clientId || socket.id);
  });
});

setInterval(async () => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 4 * 60 * 60 * 1000) {
      rooms.delete(code);
      await deletePersistedRoom(code);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
initRealtimeStore()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Bingo Social sur http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
