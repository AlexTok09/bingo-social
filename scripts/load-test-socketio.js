const { io } = require('socket.io-client');

const url = process.env.URL || 'http://localhost:3000';
const totalPlayers = Number(process.env.PLAYERS || 100);
const roomCount = Math.max(1, Number(process.env.ROOMS || Math.ceil(totalPlayers / 20)));
const durationMs = Number(process.env.DURATION_MS || 60000);
const toggleIntervalMs = Number(process.env.TOGGLE_INTERVAL_MS || 2500);
const rampMs = Number(process.env.RAMP_MS || 10000);

const metrics = {
  connected: 0,
  created: 0,
  joined: 0,
  toggleOk: 0,
  toggleFail: 0,
  toggleReasons: {},
  errors: 0,
  disconnects: 0,
};

const sockets = [];
const roomCodes = [];
const clients = [];
let stopping = false;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clientId(index) {
  return `load-${process.pid}-${Date.now()}-${index}`;
}

function connectSocket() {
  return io(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 10000,
  });
}

function once(socket, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      socket.off('error-msg', onError);
      socket.off('connect_error', onError);
    }

    function onEvent(payload) {
      cleanup();
      resolve(payload);
    }

    function onError(error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    socket.once(eventName, onEvent);
    socket.once('error-msg', onError);
    socket.once('connect_error', onError);
  });
}

async function createRoom(index) {
  const socket = connectSocket();
  const cid = clientId(index);
  sockets.push(socket);
  socket.on('connect', () => { metrics.connected += 1; });
  socket.on('disconnect', () => { metrics.disconnects += 1; });

  await once(socket, 'connect');
  socket.emit('create-room', {
    playerName: `Host${index}`,
    clientId: cid,
  });
  const state = await once(socket, 'room-created');
  roomCodes.push(state.code);
  metrics.created += 1;
  clients.push({ socket, roomCode: state.code, grid: state.grid, playerName: `Host${index}`, clientId: cid });
}

async function joinRoom(index) {
  const socket = connectSocket();
  const cid = clientId(index);
  sockets.push(socket);
  socket.on('connect', () => { metrics.connected += 1; });
  socket.on('disconnect', () => { metrics.disconnects += 1; });
  socket.on('error-msg', () => { metrics.errors += 1; });

  await once(socket, 'connect');
  const roomCode = roomCodes[index % roomCodes.length];
  const playerName = `P${index}`;
  socket.emit('join-room', {
    code: roomCode,
    playerName,
    clientId: cid,
  });
  const state = await once(socket, 'room-joined');
  metrics.joined += 1;
  clients.push({ socket, roomCode, grid: state.grid, playerName, clientId: cid });
}

function randomTogglePayload(client) {
  const tiers = Object.keys(client.grid || {}).filter(tier => Array.isArray(client.grid[tier]) && client.grid[tier].length > 0);
  const category = tiers[Math.floor(Math.random() * tiers.length)];
  const max = client.grid[category].length;
  return {
    roomCode: client.roomCode,
    clientId: client.clientId,
    category,
    index: Math.floor(Math.random() * max),
  };
}

function startTraffic() {
  clients.forEach((client, index) => {
    const jitter = Math.floor(Math.random() * toggleIntervalMs);
    setTimeout(() => {
      const timer = setInterval(() => {
        if (stopping || !client.socket.connected || !client.grid) return;
        client.socket.emit('toggle-cell', randomTogglePayload(client), ({ ok, reason } = {}) => {
          if (ok) metrics.toggleOk += 1;
          else {
            metrics.toggleFail += 1;
            const key = reason || 'unknown';
            metrics.toggleReasons[key] = (metrics.toggleReasons[key] || 0) + 1;
          }
        });
      }, toggleIntervalMs);
      client.timer = timer;
    }, jitter + (index % 25) * 20);
  });
}

function printMetrics(label) {
  const live = sockets.filter(socket => socket.connected).length;
  console.log(JSON.stringify({ label, live, ...metrics }));
}

async function main() {
  console.log(`Load test target=${url} players=${totalPlayers} rooms=${roomCount} durationMs=${durationMs}`);

  for (let i = 0; i < roomCount; i += 1) {
    await createRoom(i);
  }

  for (let i = roomCount; i < totalPlayers; i += 1) {
    await wait(Math.max(0, Math.floor(rampMs / Math.max(1, totalPlayers - roomCount))));
    try {
      await joinRoom(i);
    } catch (error) {
      metrics.errors += 1;
      console.error(`join failed for player ${i}: ${error.message}`);
    }
  }

  printMetrics('ready');
  startTraffic();
  const reporter = setInterval(() => printMetrics('tick'), 5000);
  await wait(durationMs);
  clearInterval(reporter);
  stopping = true;
  clients.forEach(client => clearInterval(client.timer));
  sockets.forEach(socket => socket.disconnect());
  printMetrics('done');

  if (metrics.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
