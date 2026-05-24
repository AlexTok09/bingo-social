const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const CATEGORIES_FILE = path.join(__dirname, 'categories.json');

const DEFAULT_CATEGORIES = {
  ordinaire: [
    { id: 'papi-mami', label: 'Papi et mami', emoji: '\u{1F474}' },
    { id: 'doudoune', label: 'Doudoune sans manche', emoji: '\u{1F9E5}' },
    { id: 'vieux-bourgeois', label: 'Vieux bourgeois', emoji: '\u{1F3A9}' },
    { id: 'femme-chien', label: 'Femme et chien', emoji: '\u{1F429}' },
    { id: 'clodo', label: 'Clodo', emoji: '\u{1F377}' },
    { id: 'vieille-bourgeoise', label: 'Vieille bourgeoise', emoji: '\u{1F451}' },
    { id: 'jean-charles', label: 'Jean Charles marinière', emoji: '\u{26F5}' },
    { id: 'etudiant', label: 'Étudiant', emoji: '\u{1F4DA}' },
    { id: 'hippie', label: 'Hippie', emoji: '\u{270C}\u{FE0F}' },
    { id: 'mechant', label: 'Mr ou Mme méchant', emoji: '\u{1F624}' },
    { id: 'claquette', label: 'Claquette', emoji: '\u{1FA74}' },
    { id: 'gros-touriste', label: 'Gros touriste', emoji: '\u{1F4F8}' },
    { id: 'poussette', label: 'Poussette', emoji: '\u{1F476}' },
    { id: 'velo-cargo', label: 'Vélo cargo', emoji: '\u{1F6B2}' },
    { id: 'instrument', label: 'Porte un instrument', emoji: '\u{1F3B8}' },
    { id: 'panama', label: 'Panama', emoji: '\u{1F920}' },
    { id: 'bob', label: 'Bob', emoji: '\u{1FA96}' },
    { id: 'casquette', label: 'Casquette', emoji: '\u{1F9E2}' },
    { id: 'style-ouf', label: 'Style de ouf', emoji: '\u{1F60E}' },
    { id: 'caillra', label: 'Caillra', emoji: '\u{1F525}' },
    { id: 'fait-la-gueule', label: 'Fait la gueule', emoji: '\u{1F612}' },
    { id: 'heureux', label: 'Heureux comme tout', emoji: '\u{1F604}' },
    { id: 'triste', label: 'Triste à souhait', emoji: '\u{1F622}' },
    { id: 'ultra-frais', label: 'Il/elle ultra frais/fraîche', emoji: '\u{2744}\u{FE0F}' },
    { id: 'scotche-tel', label: 'Scotché au tel', emoji: '\u{1F4F1}' },
    { id: 'costard', label: 'Costard', emoji: '\u{1F454}' },
  ],
  semi: [
    { id: 'bien-ivre', label: 'Bien ivre', emoji: '\u{1F37A}' },
    { id: 'couple-decathlon', label: 'Couple décathlon', emoji: '\u{1F3C3}' },
    { id: 'clodo-venere', label: 'Clodo vénère', emoji: '\u{1F92C}' },
    { id: 'auto-selfie', label: 'Auto-selfie', emoji: '\u{1F933}' },
    { id: 'danse-rue', label: 'Danse dans la rue', emoji: '\u{1F483}' },
    { id: 'horodateur', label: "Fouille dans l'horodateur", emoji: '\u{1F17F}\u{FE0F}' },
    { id: 'lit-livre', label: 'Lit un livre', emoji: '\u{1F4D6}' },
    { id: 'embrassent', label: "Gens qui s'embrassent", emoji: '\u{1F48F}' },
    { id: 'jumeaux', label: 'Jumeaux', emoji: '\u{1F46F}' },
    { id: 'parle-seul', label: 'Parle tout seul', emoji: '\u{1F5E3}\u{FE0F}' },
    { id: 'skate', label: 'Roule en skate', emoji: '\u{1F6F9}' },
    { id: 'court', label: 'Il/elle court', emoji: '\u{1F3C3}\u{200D}\u{2640}\u{FE0F}' },
    { id: 'fume-tar', label: 'Fume un tar', emoji: '\u{1F6AC}' },
    { id: 'trebuche', label: 'Trébuche', emoji: '\u{1F938}' },
    { id: 'deguise', label: 'Déguisé(e)', emoji: '\u{1F3AD}' },
    { id: 'couple-improbable', label: 'Couple improbable', emoji: '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F466}' },
  ],
  rare: [
    { id: 'police', label: 'Contrôle police', emoji: '\u{1F694}' },
    { id: 'bagarre', label: 'Bagarre de rue', emoji: '\u{1F94A}' },
    { id: 'mouette', label: 'Mouette qui vol un sandwich', emoji: '\u{1F985}' },
    { id: 'pipi-rue', label: 'Pipi dans la rue', emoji: '\u{1F6BD}' },
    { id: 'trace', label: 'Tape une trace', emoji: '\u{1F443}' },
    { id: 'nudite', label: 'Nudité', emoji: '\u{1FAE3}' },
    { id: 'accident', label: 'Accident de la circulation', emoji: '\u{1F4A5}' },
  ]
};

function loadCategories() {
  try {
    if (fs.existsSync(CATEGORIES_FILE)) {
      const data = fs.readFileSync(CATEGORIES_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
}

function saveCategories(categories) {
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categories, null, 2), 'utf-8');
}

let CATEGORIES = loadCategories();

const GRID_CONFIG = {
  ordinaire: 12,
  semi: 6,
  rare: 2
};

const rooms = new Map();

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
  };
}

function getProgress(player) {
  return {
    ordinaire: { checked: player.checked.ordinaire.length, total: player.grid.ordinaire.length },
    semi: { checked: player.checked.semi.length, total: player.grid.semi.length },
    rare: { checked: player.checked.rare.length, total: player.grid.rare.length },
  };
}

function getPlayersInfo(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    progress: getProgress(p),
  }));
}

io.on('connection', (socket) => {

  socket.on('get-categories', () => {
    socket.emit('categories-data', CATEGORIES);
  });

  socket.on('save-categories', (categories) => {
    if (!categories || !categories.ordinaire || !categories.semi || !categories.rare) return;
    CATEGORIES = categories;
    saveCategories(CATEGORIES);
    socket.emit('categories-saved');
  });

  socket.on('reset-categories', () => {
    CATEGORIES = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    saveCategories(CATEGORIES);
    socket.emit('categories-data', CATEGORIES);
    socket.emit('categories-saved');
  });

  socket.on('create-room', (playerName) => {
    const code = generateRoomCode();
    const grid = generateGrid();
    const player = {
      id: socket.id,
      name: playerName,
      grid,
      checked: { ordinaire: [], semi: [], rare: [] },
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
      checked: { ordinaire: [], semi: [], rare: [] },
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
      p.checked = { ordinaire: [], rare: [], exceptionnel: [] };
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
