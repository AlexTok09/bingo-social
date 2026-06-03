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

const DEFAULT_CATEGORIES = {
  ordinaire: [
    { id: 'papi-mami', label: 'Papi et mami' },
    { id: 'doudoune', label: 'Doudoune sans manche' },
    { id: 'vieux-bourgeois', label: 'Vieux bourgeois' },
    { id: 'femme-chien', label: 'Femme et chien' },
    { id: 'clodo', label: 'Clodo' },
    { id: 'vieille-bourgeoise', label: 'Vieille bourgeoise' },
    { id: 'jean-charles', label: 'Jean Charles marinière' },
    { id: 'etudiant', label: 'Étudiant' },
    { id: 'hippie', label: 'Hippie' },
    { id: 'mechant', label: 'Mr ou Mme méchant' },
    { id: 'claquette', label: 'Claquette' },
    { id: 'gros-touriste', label: 'Gros touriste' },
    { id: 'poussette', label: 'Poussette' },
    { id: 'velo-cargo', label: 'Vélo cargo' },
    { id: 'instrument', label: 'Porte un instrument' },
    { id: 'panama', label: 'Panama' },
    { id: 'bob', label: 'Bob' },
    { id: 'casquette', label: 'Casquette' },
    { id: 'style-ouf', label: 'Style de ouf' },
    { id: 'caillra', label: 'Caillra' },
    { id: 'fait-la-gueule', label: 'Fait la gueule' },
    { id: 'heureux', label: 'Heureux comme tout' },
    { id: 'triste', label: 'Triste à souhait' },
    { id: 'ultra-frais', label: 'Il/elle ultra frais/fraîche' },
    { id: 'scotche-tel', label: 'Scotché au tel' },
    { id: 'costard', label: 'Costard' },
  ],
  semi: [
    { id: 'bien-ivre', label: 'Bien ivre' },
    { id: 'couple-decathlon', label: 'Couple décathlon' },
    { id: 'clodo-venere', label: 'Clodo vénère' },
    { id: 'auto-selfie', label: 'Auto-selfie' },
    { id: 'danse-rue', label: 'Danse dans la rue' },
    { id: 'horodateur', label: "Fouille dans l'horodateur" },
    { id: 'lit-livre', label: 'Lit un livre' },
    { id: 'embrassent', label: "Gens qui s'embrassent" },
    { id: 'jumeaux', label: 'Jumeaux' },
    { id: 'parle-seul', label: 'Parle tout seul' },
    { id: 'skate', label: 'Roule en skate' },
    { id: 'court', label: 'Il/elle court' },
    { id: 'fume-tar', label: 'Fume un tar' },
    { id: 'trebuche', label: 'Trébuche' },
    { id: 'deguise', label: 'Déguisé(e)' },
    { id: 'couple-improbable', label: 'Couple improbable' },
  ],
  rare: [
    { id: 'police', label: 'Contrôle police' },
    { id: 'bagarre', label: 'Bagarre de rue' },
    { id: 'mouette', label: 'Mouette qui vol un sandwich' },
    { id: 'pipi-rue', label: 'Pipi dans la rue' },
    { id: 'trace', label: 'Tape une trace' },
    { id: 'nudite', label: 'Nudité' },
    { id: 'accident', label: 'Accident de la circulation' },
  ],
  legendaire: [
    { id: 'instant-win', label: 'La scène impossible' },
  ]
};

function loadCategories() {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  try {
    if (fs.existsSync(CATEGORIES_FILE)) {
      const data = fs.readFileSync(CATEGORIES_FILE, 'utf-8');
      return normalizeCategories({ ...defaults, ...JSON.parse(data) });
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
      p.checked = { ordinaire: [], semi: [], rare: [], legendaire: [] };
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
    ordinaire: shuffleArray(CATEGORIES.ordinaire).slice(0, GRID_CONFIG.ordinaire),
    semi: shuffleArray(CATEGORIES.semi).slice(0, GRID_CONFIG.semi),
    rare: shuffleArray(CATEGORIES.rare).slice(0, GRID_CONFIG.rare),
    legendaire: shuffleArray(CATEGORIES.legendaire).slice(0, GRID_CONFIG.legendaire),
  };
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
  if (!categories || !categories.ordinaire || !categories.semi || !categories.rare || !categories.legendaire) {
    res.status(400).json({ error: 'Catégories invalides.' });
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
      checked: { ordinaire: [], semi: [], rare: [], legendaire: [] },
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
      checked: { ordinaire: [], semi: [], rare: [], legendaire: [] },
    };
    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.emit('room-joined', { code: roomCode, grid });
    io.to(roomCode).emit('players-update', getPlayersInfo(room));
    io.to(roomCode).emit('player-joined', playerName);
  });

  socket.on('toggle-cell', ({ category, index }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.winner) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const checkedList = player.checked[category];
    if (!checkedList || !player.grid[category]) return;
    const idx = checkedList.indexOf(index);
    if (idx === -1) {
      checkedList.push(index);
    } else {
      checkedList.splice(idx, 1);
    }

    socket.emit('grid-update', player.checked);

    if (checkedList.length === player.grid[category].length) {
      room.winner = { id: player.id, name: player.name, category };
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
      p.checked = { ordinaire: [], semi: [], rare: [], legendaire: [] };
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
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        const name = room.players.find(p => p.id === socket.id)?.name;
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(socket.roomCode);
        } else {
          io.to(socket.roomCode).emit('players-update', getPlayersInfo(room));
          if (name) io.to(socket.roomCode).emit('player-left', name);
        }
      }
    }
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
