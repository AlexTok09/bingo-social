const express = require('express');
const compression = require('compression');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'binglou-admin');
const REDIS_URL = process.env.REDIS_URL || process.env.VALKEY_URL || process.env.KEY_VALUE_URL || '';
const QR_REDIRECT_TARGET = process.env.QR_REDIRECT_TARGET || '/';
const ROOM_KEY_PREFIX = 'bingo:room:';
const ROOM_TTL_SECONDS = 4 * 60 * 60;

app.use(compression({
  // The semantic emoji tables are application/octet-stream, which compression
  // skips by default. Force gzip on them (int8 vectors shrink ~20%).
  filter(req, res) {
    if (req.path.endsWith('.bin')) return true;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '200kb' }));

const PERSISTENT_DATA_DIR = fs.existsSync('/var/data') ? '/var/data' : __dirname;
const CATEGORIES_FILE = process.env.CATEGORIES_FILE || path.join(PERSISTENT_DATA_DIR, 'categories.json');
const CUSTOM_GRIDS_FILE = process.env.CUSTOM_GRIDS_FILE || path.join(PERSISTENT_DATA_DIR, 'custom-grids.json');
const STATS_FILE = process.env.STATS_FILE || path.join(PERSISTENT_DATA_DIR, 'stats.json');
const CUSTOM_GRID_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CUSTOM_GRIDS = 500;
const CUSTOM_LABEL_MAX = 38;
const CUSTOM_NAME_MAX = 48;
const CUSTOM_SUBJECT_MAX = 60;

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
    customGridCode: room.customGridCode || null,
    customGridName: room.customGridName || null,
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
  try {
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
  } catch (error) {
    roomStore = null;
    console.error(`Redis/Valkey unavailable, using in-memory rooms only: ${error.message}`);
  }
}

const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX = 15;
const HTTP_GRID_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const HTTP_GRID_RATE_LIMIT_MAX = 12;
const httpGridRateLimits = new Map();
const QR_SCAN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const QR_SCAN_RATE_LIMIT_MAX = 30;
const qrScanRateLimits = new Map();

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

function httpRateLimitKey(req) {
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 100) : '';
  return `${req.ip || req.socket.remoteAddress || 'unknown'}:${clientId}`;
}

function checkHttpGridRateLimit(req, res) {
  const now = Date.now();
  const key = httpRateLimitKey(req);
  const current = httpGridRateLimits.get(key);
  if (!current || now - current.windowStart > HTTP_GRID_RATE_LIMIT_WINDOW_MS) {
    httpGridRateLimits.set(key, { windowStart: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (current.count > HTTP_GRID_RATE_LIMIT_MAX) {
    res.status(429).json({ error: 'Trop de requêtes, ralentis.' });
    return false;
  }
  return true;
}

function checkQrScanRateLimit(req, res) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = qrScanRateLimits.get(key);
  if (!current || now - current.windowStart > QR_SCAN_RATE_LIMIT_WINDOW_MS) {
    qrScanRateLimits.set(key, { windowStart: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (current.count > QR_SCAN_RATE_LIMIT_MAX) {
    res.status(429).json({ error: 'Trop de scans, ralentis.' });
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of httpGridRateLimits) {
    if (now - entry.windowStart > HTTP_GRID_RATE_LIMIT_WINDOW_MS * 2) {
      httpGridRateLimits.delete(key);
    }
  }
}, HTTP_GRID_RATE_LIMIT_WINDOW_MS).unref();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of qrScanRateLimits) {
    if (now - entry.windowStart > QR_SCAN_RATE_LIMIT_WINDOW_MS * 2) {
      qrScanRateLimits.delete(key);
    }
  }
}, QR_SCAN_RATE_LIMIT_WINDOW_MS).unref();

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
let CUSTOM_GRIDS = loadCustomGrids();
let STATS = loadStats();

function normalizeCustomEmoji(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return Array.from(text).slice(0, 2).join('');
}

function normalizeCustomCategories(categories) {
  const normalized = emptyCategories();
  for (const tier of Object.keys(GRID_CONFIG)) {
    const items = Array.isArray(categories?.[tier]) ? categories[tier] : [];
    normalized[tier] = items
      .map((item, index) => {
        const label = typeof item?.label === 'string' ? item.label.trim().slice(0, CUSTOM_LABEL_MAX) : '';
        const emojis = Array.isArray(item?.emojis) ? item.emojis.map(normalizeCustomEmoji).filter(Boolean).slice(0, 2) : [];
        return label ? {
          id: item?.id || `${slugifyLabel(label)}-${index + 1}`,
          label,
          emojis,
        } : null;
      })
      .filter(Boolean)
      .slice(0, 80);
  }
  return normalized;
}

function validateCustomGridPayload(payload) {
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  const subject = typeof payload?.subject === 'string' ? payload.subject.trim() : '';
  if (!name) return 'Donne un nom à ta grille.';
  if (!subject) return 'Dis ce que ta grille désigne.';

  const categories = normalizeCustomCategories(payload?.categories);
  const categoriesError = validateCategoriesConfig(categories);
  if (categoriesError) return categoriesError;
  return null;
}

function loadCustomGrids() {
  try {
    if (!fs.existsSync(CUSTOM_GRIDS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(CUSTOM_GRIDS_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).map(([code, grid]) => [code, {
      code,
      editToken: grid.editToken,
      ownerClientId: grid.ownerClientId || null,
      name: String(grid.name || '').slice(0, CUSTOM_NAME_MAX),
      subject: String(grid.subject || '').slice(0, CUSTOM_SUBJECT_MAX),
      isPublic: grid.isPublic !== false,
      categories: normalizeCustomCategories(grid.categories),
      createdAt: grid.createdAt || Date.now(),
      updatedAt: grid.updatedAt || Date.now(),
      plays: Number(grid.plays || 0),
    }]));
  } catch (error) {
    console.error('Custom grids load failed:', error.message);
    return {};
  }
}

function saveCustomGrids() {
  fs.mkdirSync(path.dirname(CUSTOM_GRIDS_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_GRIDS_FILE, JSON.stringify(CUSTOM_GRIDS, null, 2), 'utf-8');
}

// Compteur privé : nombre total de parties lancées (création de salon + rejeu).
function normalizeStats(raw = {}) {
  const qrScans = raw.qrScans && typeof raw.qrScans === 'object' ? raw.qrScans : {};
  return {
    gamesPlayed: Number(raw.gamesPlayed || 0),
    firstAt: Number(raw.firstAt) || Date.now(),
    qrScans: {
      total: Number(qrScans.total || 0),
      events: Array.isArray(qrScans.events) ? qrScans.events.filter(Boolean) : [],
    },
  };
}

function loadStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return normalizeStats();
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    return normalizeStats(parsed);
  } catch (error) {
    console.error('Stats load failed:', error.message);
    return normalizeStats();
  }
}

function saveStats() {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(STATS), 'utf-8');
  } catch (error) {
    console.error('Stats save failed:', error.message);
  }
}

function bumpGamesPlayed() {
  STATS.gamesPlayed += 1;
  saveStats();
}

function classifyUserAgent(userAgent = '') {
  const ua = String(userAgent || '');
  const likelyBot = /\b(bot|crawler|spider|ahrefs|semrush|googlebot|bingbot)\b/i.test(ua);
  const likelyHuman = !likelyBot && /(iphone|android|mobile safari|crios|chrome mobile)/i.test(ua);
  return { likelyHuman, likelyBot };
}

function countBy(items, keyFn, limit = 8) {
  const counts = new Map();
  items.forEach(item => {
    const key = keyFn(item);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function recordQrScan(payload = {}, req) {
  const now = Date.now();
  const userAgent = String(payload.userAgent || req.get('user-agent') || '').slice(0, 300);
  const referrer = String(payload.referrer || req.get('referer') || '').slice(0, 500);
  const pathname = String(payload.pathname || '/qr').slice(0, 200);
  const timestampMs = Number(Date.parse(payload.timestamp)) || now;
  const classification = classifyUserAgent(userAgent);
  const event = {
    event: 'qr_scan',
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    userAgent,
    referrer,
    pathname,
    source: 'sticker',
    campaign: 'stickers_rennes',
    likelyHuman: classification.likelyHuman,
    likelyBot: classification.likelyBot,
  };

  STATS.qrScans ||= { total: 0, events: [] };
  STATS.qrScans.total += 1;
  STATS.qrScans.events.push(event);
  saveStats();
  return event;
}

function qrScanStats() {
  const events = STATS.qrScans?.events || [];
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const eventTime = event => Number(event.timestampMs || Date.parse(event.timestamp) || 0);
  const todayEvents = events.filter(event => eventTime(event) >= today.getTime());
  const weekEvents = events.filter(event => eventTime(event) >= sevenDaysAgo);
  const mobileHumanEvents = events.filter(event => event.likelyHuman);

  return {
    total: Number(STATS.qrScans?.total || 0),
    today: todayEvents.length,
    last7Days: weekEvents.length,
    likelyHuman: events.filter(event => event.likelyHuman).length,
    likelyBot: events.filter(event => event.likelyBot).length,
    topMobileUserAgents: countBy(mobileHumanEvents, event => event.userAgent || 'Inconnu', 6),
    referrers: countBy(events, event => event.referrer || '', 8),
  };
}

function publicCustomGrid(grid) {
  return {
    code: grid.code,
    name: grid.name,
    subject: grid.subject,
    isPublic: grid.isPublic !== false,
    categories: grid.categories,
    createdAt: grid.createdAt,
    updatedAt: grid.updatedAt,
    plays: grid.plays || 0,
  };
}

function resolveCustomGrid(lookup = '', clientId = null) {
  const raw = String(lookup || '').trim();
  if (!raw) return null;

  const code = raw.toUpperCase();
  if (CUSTOM_GRIDS[code]) return CUSTOM_GRIDS[code];

  const slug = slugifyLabel(raw);
  const matches = Object.values(CUSTOM_GRIDS)
    .filter(grid => {
      if (slugifyLabel(grid.name) !== slug) return false;
      return grid.isPublic !== false || (clientId && grid.ownerClientId === clientId);
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return matches[0] || null;
}

function findPublicGridByName(name = '', excludeCode = null) {
  const slug = slugifyLabel(name);
  if (!slug) return null;
  return Object.values(CUSTOM_GRIDS).find(grid =>
    grid.code !== excludeCode &&
    grid.isPublic !== false &&
    slugifyLabel(grid.name) === slug
  ) || null;
}

function generateCustomGridCode(name = '') {
  const prefix = slugifyLabel(name).replace(/-/g, '').slice(0, 3).toUpperCase() || 'SOC';
  let code = '';
  do {
    code = prefix;
    while (code.length < 6) {
      code += CUSTOM_GRID_CODE_CHARS[Math.floor(Math.random() * CUSTOM_GRID_CODE_CHARS.length)];
    }
  } while (CUSTOM_GRIDS[code]);
  return code;
}

function generateEditToken() {
  return crypto.randomBytes(24).toString('base64url');
}

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
      p.grid = generateGrid(room.categories || CATEGORIES);
      p.checked = emptyChecked();
      p.occurrences = emptyOccurrences();
      p.occurrenceMax = emptyOccurrences();
      p.bonuses = emptyBonuses();
      p.pendingBonus = emptyPendingBonus();
      p.maxChecked = 0;
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

function generateGrid(sourceCategories = CATEGORIES) {
  return {
    ordinaire: pickGridItems(sourceCategories.ordinaire, GRID_CONFIG.ordinaire),
    semi: pickGridItems(sourceCategories.semi, GRID_CONFIG.semi),
    rare: pickGridItems(sourceCategories.rare, GRID_CONFIG.rare),
    legendaire: pickGridItems(sourceCategories.legendaire, GRID_CONFIG.legendaire),
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

function rerollOneCell(player, tier, index, sourceCategories = CATEGORIES) {
  const checked = new Set(player.checked[tier] || []);
  if (checked.has(index) || !player.grid[tier]?.[index]) return false;

  const current = player.grid[tier][index];
  const usedIds = new Set(player.grid[tier].map(item => item.id));
  usedIds.delete(current.id);
  const hasUltraElsewhere = player.grid[tier].some((item, itemIndex) => itemIndex !== index && ultraKey(item));
  const replacement = shuffleArray(sourceCategories[tier]).find(candidate => {
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

app.get('/api/original-categories', (req, res) => {
  res.json({ categories: DEFAULT_CATEGORIES });
});

app.get('/api/qr-config', (req, res) => {
  res.json({ redirectTarget: QR_REDIRECT_TARGET });
});

app.post('/api/qr-scan', (req, res) => {
  if (!checkQrScanRateLimit(req, res)) return;
  const event = recordQrScan(req.body || {}, req);
  res.status(201).json({ ok: true, event: 'qr_scan', timestamp: event.timestamp });
});

app.delete('/api/admin/custom-grids/:code', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }
  const code = String(req.params.code || '').toUpperCase().trim();
  if (!CUSTOM_GRIDS[code]) {
    res.status(404).json({ error: 'Grille introuvable.' });
    return;
  }
  delete CUSTOM_GRIDS[code];
  saveCustomGrids();
  res.json({ ok: true });
});

app.get('/api/admin/stats', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'Mot de passe invalide.' });
    return;
  }
  const grids = Object.values(CUSTOM_GRIDS);
  res.json({
    gamesPlayed: STATS.gamesPlayed,
    firstAt: STATS.firstAt,
    activeRooms: rooms.size,
    customGrids: grids.length,
    customGridPlays: grids.reduce((sum, grid) => sum + (grid.plays || 0), 0),
    qr: qrScanStats(),
  });
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

app.get('/api/custom-grids', (req, res) => {
  const grids = Object.values(CUSTOM_GRIDS)
    .filter(grid => grid.isPublic !== false)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 100)
    .map(publicCustomGrid);
  res.json({ grids });
});

app.get('/api/custom-grids/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase().trim();
  const grid = CUSTOM_GRIDS[code];
  if (!grid || grid.isPublic === false) {
    res.status(404).json({ error: 'Grille introuvable.' });
    return;
  }
  res.json({ grid: publicCustomGrid(grid) });
});

app.get('/api/custom-grids/:code/edit/:token', (req, res) => {
  const code = String(req.params.code || '').toUpperCase().trim();
  const token = String(req.params.token || '');
  const grid = CUSTOM_GRIDS[code];
  if (!grid || grid.editToken !== token) {
    res.status(404).json({ error: 'Lien d’édition invalide.' });
    return;
  }
  res.json({ grid: { ...publicCustomGrid(grid), editToken: grid.editToken } });
});

app.post('/api/custom-grids', (req, res) => {
  if (!checkHttpGridRateLimit(req, res)) return;

  if (Object.keys(CUSTOM_GRIDS).length >= MAX_CUSTOM_GRIDS) {
    res.status(429).json({ error: 'Trop de grilles créées pour le moment.' });
    return;
  }

  const error = validateCustomGridPayload(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  if (req.body.isPublic !== false && findPublicGridByName(req.body.name)) {
    res.status(409).json({ error: 'Ce nom de grille est déjà pris. Choisis-en un autre.' });
    return;
  }

  const now = Date.now();
  const code = generateCustomGridCode(req.body.name);
  const grid = {
    code,
    editToken: generateEditToken(),
    ownerClientId: typeof req.body.clientId === 'string' ? req.body.clientId.slice(0, 100) : null,
    name: req.body.name.trim().slice(0, CUSTOM_NAME_MAX),
    subject: req.body.subject.trim().slice(0, CUSTOM_SUBJECT_MAX),
    isPublic: req.body.isPublic !== false,
    categories: normalizeCustomCategories(req.body.categories),
    createdAt: now,
    updatedAt: now,
    plays: 0,
  };

  CUSTOM_GRIDS[code] = grid;
  saveCustomGrids();
  res.status(201).json({ grid: { ...publicCustomGrid(grid), editToken: grid.editToken } });
});

app.put('/api/custom-grids/:code/edit/:token', (req, res) => {
  if (!checkHttpGridRateLimit(req, res)) return;

  const code = String(req.params.code || '').toUpperCase().trim();
  const token = String(req.params.token || '');
  const existing = CUSTOM_GRIDS[code];
  if (!existing || existing.editToken !== token) {
    res.status(404).json({ error: 'Lien d’édition invalide.' });
    return;
  }

  const error = validateCustomGridPayload(req.body);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  if (req.body.isPublic !== false && findPublicGridByName(req.body.name, code)) {
    res.status(409).json({ error: 'Ce nom de grille est déjà pris. Choisis-en un autre.' });
    return;
  }

  if (!existing.ownerClientId && typeof req.body.clientId === 'string') {
    existing.ownerClientId = req.body.clientId.slice(0, 100);
  }
  existing.name = req.body.name.trim().slice(0, CUSTOM_NAME_MAX);
  existing.subject = req.body.subject.trim().slice(0, CUSTOM_SUBJECT_MAX);
  existing.isPublic = req.body.isPublic !== false;
  existing.categories = normalizeCustomCategories(req.body.categories);
  existing.updatedAt = Date.now();
  saveCustomGrids();
  res.json({ grid: { ...publicCustomGrid(existing), editToken: existing.editToken } });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/qr', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
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
    const customGridLookup = typeof payload === 'object' && payload ? String(payload.customGridCode || '').trim() : '';
    const customGrid = customGridLookup ? resolveCustomGrid(customGridLookup, clientId) : null;
    if (customGridLookup && !customGrid) {
      socket.emit('error-msg', 'Grille custom introuvable !');
      return;
    }
    const sourceCategories = customGrid?.categories || CATEGORIES;
    const grid = generateGrid(sourceCategories);
    const player = {
      id: socket.id,
      clientId,
      name: normalizedName,
      grid,
      checked: emptyChecked(),
      occurrences: emptyOccurrences(),
      occurrenceMax: emptyOccurrences(),
      bonuses: emptyBonuses(),
      pendingBonus: emptyPendingBonus(),
      maxChecked: 0,
      disconnectedAt: null,
    };
    rooms.set(code, {
      code,
      players: [player],
      winner: null,
      tiersToWin: 1,
      customGridCode: customGrid?.code || null,
      customGridName: customGrid?.name || null,
      categories: sourceCategories,
      createdAt: Date.now(),
    });
    if (customGrid) {
      customGrid.plays = (customGrid.plays || 0) + 1;
      customGrid.updatedAt = Date.now();
      saveCustomGrids();
    }
    await persistRoom(rooms.get(code));
    bumpGamesPlayed();
    socket.join(code);
    socket.roomCode = code;
    socket.clientId = clientId;
    socket.emit('room-created', { code, grid, tiersToWin: 1, customGridCode: customGrid?.code || null, customGridName: customGrid?.name || null });
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
    const grid = generateGrid(room.categories || CATEGORIES);
    const player = {
      id: socket.id,
      clientId,
      name: normalizedName,
      grid,
      checked: emptyChecked(),
      occurrences: emptyOccurrences(),
      occurrenceMax: emptyOccurrences(),
      bonuses: emptyBonuses(),
      pendingBonus: emptyPendingBonus(),
      maxChecked: 0,
      disconnectedAt: null,
    };
    room.players.push(player);
    await persistRoom(room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.clientId = clientId;
    socket.emit('room-joined', { code: roomCode, grid, tiersToWin: room.tiersToWin || 1, customGridCode: room.customGridCode || null, customGridName: room.customGridName || null });
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

    // 1 joker toutes les 2 cases cochées, basé sur le plus haut total atteint
    // (high-water). Décocher puis recocher ne redonne donc jamais de joker.
    const checkedTotal = totalCheckedCount(player);
    const prevMax = player.maxChecked || 0;
    if (checkedTotal > prevMax) {
      player.maxChecked = checkedTotal;
      const newJokers = Math.floor(checkedTotal / 2) - Math.floor(prevMax / 2);
      if (newJokers > 0) {
        player.bonuses.joker = (player.bonuses.joker || 0) + newJokers;
        socket.emit('joker-earned', { count: player.bonuses.joker });
      }
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
    player.occurrenceMax ||= emptyOccurrences();
    player.bonuses ||= emptyBonuses();

    const categoryKey = typeof category === 'string' ? category : '';
    const indexNumber = Number(index);
    const checkedList = player.checked[categoryKey];
    const gridItems = player.grid[categoryKey];
    if (!isValidTier(categoryKey) || !Array.isArray(checkedList) || !Array.isArray(gridItems) || !Number.isInteger(indexNumber) || indexNumber < 0 || indexNumber >= gridItems.length) return;
    if (!checkedList.includes(indexNumber)) return;

    const currentCount = player.occurrences[categoryKey][indexNumber] || 1;
    const nextCount = currentCount + 1;
    const prevMaxCell = player.occurrenceMax[categoryKey][indexNumber] || 1;
    const baseThreshold = BONUS_REPEAT_THRESHOLD[categoryKey] || 3;
    const rerollCount = BONUS_REROLL_COUNT[categoryKey] || 3;

    // Seuils cumulatifs, gap doublé à chaque palier : 3, 9, 21, 45, ...
    let bonusThreshold = baseThreshold;
    let bonusGap = baseThreshold;
    while (bonusThreshold < nextCount) { bonusGap *= 2; bonusThreshold += bonusGap; }

    player.occurrences[categoryKey][indexNumber] = nextCount;
    // High-water : un palier n'octroie son bonus qu'au premier passage, donc
    // décrémenter (appui long) puis re-répéter ne refarme jamais le bonus.
    const isNewHigh = nextCount > prevMaxCell;
    if (isNewHigh) player.occurrenceMax[categoryKey][indexNumber] = nextCount;
    if (isNewHigh && nextCount === bonusThreshold) {
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

  // Appui long : redescend le compteur d'un cran (3 -> 2 -> 1). L'uncheck final
  // (1 -> rien) passe par toggle-cell côté client.
  socket.on('decrement-cell', async (payload = {}) => {
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
    if (currentCount <= 1) return;
    const nextCount = currentCount - 1;
    player.occurrences[categoryKey][indexNumber] = nextCount;

    socket.emit('occurrence-update', {
      category: categoryKey,
      index: indexNumber,
      count: nextCount,
      occurrences: player.occurrences,
      bonuses: player.bonuses,
    });
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

    if (!rerollOneCell(player, categoryKey, indexNumber, room.categories || CATEGORIES)) return;
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
      p.grid = generateGrid(room.categories || CATEGORIES);
      p.checked = emptyChecked();
      p.occurrences = emptyOccurrences();
      p.occurrenceMax = emptyOccurrences();
      p.bonuses = emptyBonuses();
      p.pendingBonus = emptyPendingBonus();
      p.maxChecked = 0;
    });

    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.id);
      if (s) {
        s.emit('new-game-started', { grid: p.grid, tiersToWin: room.tiersToWin });
      }
    });

    await persistRoom(room);
    bumpGamesPlayed();
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
