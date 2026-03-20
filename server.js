// server.js
// Chess Server - Single File Production Build
// Features: Express, WebSocket, chess.js, lowdb with compressed storage, JWT auth, ELO, anti-cheat

// ==================== IMPORTS ====================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Chess } = require('chess.js');
const { Low } = require('lowdb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs').promises;
const path = require('path');

// ==================== ENV VARIABLES ====================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (8tdtidt8fpugfy9r96r9r969r69fy9f9yfy99) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
const SALT_ROUNDS = 10;
const INITIAL_ELO = 1200;
const MOVE_COOLDOWN_MS = 500;
const MAX_MOVES_PER_SECOND = 2;
const DB_FILE = path.join(__dirname, 'db.json.gz'); // compressed

// ==================== COMPRESSED JSON ADAPTER ====================
// Custom lowdb adapter that reads/writes gzipped JSON
class CompressedJSONFile {
  constructor(filename) {
    this.filename = filename;
  }

  async read() {
    let data;
    try {
      const compressed = await fs.readFile(this.filename);
      const json = await this.decompress(compressed);
      data = JSON.parse(json);
    } catch (e) {
      if (e.code === 'ENOENT') {
        // File doesn't exist, return default structure
        return null;
      }
      throw e;
    }
    return data;
  }

  async write(data) {
    const json = JSON.stringify(data, null, 2); // keep pretty for occasional manual inspection
    const compressed = await this.compress(json);
    await fs.writeFile(this.filename, compressed);
  }

  compress(str) {
    return new Promise((resolve, reject) => {
      zlib.gzip(str, (err, buffer) => {
        if (err) reject(err);
        else resolve(buffer);
      });
    });
  }

  decompress(buffer) {
    return new Promise((resolve, reject) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result.toString());
      });
    });
  }
}

// ==================== LOWDB SETUP ====================
const adapter = new CompressedJSONFile(DB_FILE);
const db = new Low(adapter);

async function initDb() {
  await db.read();
  // If db is empty (null), initialize with default structure
  if (db.data === null) {
    db.data = {
      users: [],
      rooms: [],
      chatMessages: [],
      gameLogs: [],
      leaderboard: [],
    };
  } else {
    // Ensure all collections exist (in case of partial data)
    db.data.users ||= [];
    db.data.rooms ||= [];
    db.data.chatMessages ||= [];
    db.data.gameLogs ||= [];
    db.data.leaderboard ||= [];
  }
  await db.write();
}
initDb().catch(console.error);

// ==================== EXPRESS APP ====================
const app = express();
app.use(cors());
app.use(express.json());

// ==================== JWT MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ==================== HTTP ENDPOINTS ====================

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    await db.read();
    const existing = db.data.users.find(u => u.username === username);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = {
      id: crypto.randomUUID(),
      username,
      password: hashed,
      elo: INITIAL_ELO,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    };
    db.data.users.push(newUser);
    await db.write();
    res.status(201).json({ message: 'User created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    await db.read();
    const user = db.data.users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Profile (protected)
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    await db.read();
    const user = db.data.users.find(u => u.id === req.user.id);
    if (!user) return res.sendStatus(404);
    const { password, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    await db.read();
    // sort by elo descending, limit to top 100
    const leaderboard = db.data.users
      .map(({ password, ...u }) => u) // remove passwords
      .sort((a, b) => b.elo - a.elo)
      .slice(0, 100);
    res.json(leaderboard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== WEBSOCKET SERVER ====================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory state for active connections and games
const activeUsers = new Map(); // userId -> { socket, rooms: Set(roomCode) }
const userLastMoves = new Map(); // userId -> [timestamps] (for rate limiting)
const rooms = new Map(); // roomCode -> { chess: Chess, players: Map(userId -> { socket, username, color }), status, gameId, moveHistory, lastMoveTime }

// Helper: generate unique 6-char room code
function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
}

// Helper: update leaderboard collection (could also be done on game end)
async function updateLeaderboard() {
  await db.read();
  const sorted = db.data.users
    .map(({ password, ...u }) => u)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 100);
  db.data.leaderboard = sorted;
  await db.write();
}

// Helper: compute ELO change
function computeEloChange(winnerElo, loserElo, draw = false) {
  if (draw) {
    // simple draw: both get small change? we'll use 16 point system
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const change = Math.round(32 * (0.5 - expectedWinner));
    return { winnerChange: change, loserChange: -change };
  } else {
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const change = Math.round(32 * (1 - expectedWinner));
    return { winnerChange: change, loserChange: -change };
  }
}

// Helper: anti-cheat rate limit
function checkRateLimit(userId) {
  const now = Date.now();
  const timestamps = userLastMoves.get(userId) || [];
  // Filter timestamps within last second
  const recent = timestamps.filter(t => now - t < 1000);
  if (recent.length >= MAX_MOVES_PER_SECOND) {
    return false; // too many moves per second
  }
  const lastMove = timestamps.length ? timestamps[timestamps.length - 1] : 0;
  if (now - lastMove < MOVE_COOLDOWN_MS) {
    return false; // too soon
  }
  // Update
  recent.push(now);
  userLastMoves.set(userId, recent);
  return true;
}

// WebSocket connection handler
wss.on('connection', async (ws, req) => {
  // Extract token from query string (ws://...?token=...)
  const params = new URLSearchParams(req.url?.split('?')[1]);
  const token = params.get('token');
  if (!token) {
    ws.close(1008, 'No token');
    return;
  }

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    ws.close(1008, 'Invalid token');
    return;
  }

  // Ensure user exists in db
  await db.read();
  const dbUser = db.data.users.find(u => u.id === user.id);
  if (!dbUser) {
    ws.close(1008, 'User not found');
    return;
  }

  // Attach user to socket
  ws.user = { id: user.id, username: dbUser.username };
  ws.roomCode = null; // current room

  // Handle duplicate connections: disconnect old socket for same user
  const existing = activeUsers.get(user.id);
  if (existing && existing.socket.readyState === WebSocket.OPEN) {
    existing.socket.close(1000, 'New connection');
  }
  activeUsers.set(user.id, { socket: ws, rooms: new Set() });

  console.log(`User ${ws.user.username} connected`);

  // Send initial connection success
  ws.send(JSON.stringify({ type: 'connected', message: 'Authenticated' }));

  // Message handler
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      await handleMessage(ws, msg);
    } catch (err) {
      console.error('Message handling error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  // Close handler
  ws.on('close', async () => {
    console.log(`User ${ws.user?.username} disconnected`);
    if (ws.user) {
      // Remove from active users
      activeUsers.delete(ws.user.id);
      // If in a room, handle leaving
      if (ws.roomCode) {
        await handleLeaveRoom(ws, ws.roomCode, true); // true = disconnect
      }
      // Clean rate limit data after some time? we'll keep for now
    }
  });
});

// Message router
async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'joinRoom':
      await handleJoinRoom(ws, msg);
      break;
    case 'leaveRoom':
      await handleLeaveRoom(ws, ws.roomCode);
      break;
    case 'move':
      await handleMove(ws, msg);
      break;
    case 'chat':
      await handleChat(ws, msg);
      break;
    case 'resign':
      await handleResign(ws);
      break;
    case 'drawOffer':
      await handleDrawOffer(ws);
      break;
    case 'drawResponse':
      await handleDrawResponse(ws, msg);
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

// Join room logic
async function handleJoinRoom(ws, msg) {
  const { roomCode, isPublic } = msg;
  let targetRoomCode = roomCode;

  // If no roomCode and public, create new public room
  if (!targetRoomCode && isPublic) {
    targetRoomCode = generateRoomCode();
    // ensure unique
    while (rooms.has(targetRoomCode)) {
      targetRoomCode = generateRoomCode();
    }
    // Create room in memory
    const chess = new Chess();
    rooms.set(targetRoomCode, {
      chess,
      players: new Map(),
      status: 'waiting',
      moveHistory: [],
      lastMoveTime: null,
    });
    // Also store in db as persistent record
    await db.read();
    db.data.rooms.push({
      roomCode: targetRoomCode,
      isPublic: true,
      createdAt: new Date().toISOString(),
      status: 'waiting',
    });
    await db.write();
  } else if (targetRoomCode) {
    // Join existing room
    if (!rooms.has(targetRoomCode)) {
      // Load from db if needed? For simplicity, we only keep active rooms in memory.
      // If room not active, reject.
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found or inactive' }));
      return;
    }
  } else {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid room code' }));
    return;
  }

  const room = rooms.get(targetRoomCode);
  if (room.players.size >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
    return;
  }

  // Assign color: if no players, white; if one, black
  const color = room.players.size === 0 ? 'w' : 'b';
  const userId = ws.user.id;

  // Check if user already in room (shouldn't happen, but handle)
  if (room.players.has(userId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Already in room' }));
    return;
  }

  room.players.set(userId, {
    socket: ws,
    username: ws.user.username,
    color,
  });
  ws.roomCode = targetRoomCode;
  activeUsers.get(userId).rooms.add(targetRoomCode);

  // If room now has 2 players, start game
  if (room.players.size === 2) {
    room.status = 'playing';
    // Update db room status
    await db.read();
    const dbRoom = db.data.rooms.find(r => r.roomCode === targetRoomCode);
    if (dbRoom) dbRoom.status = 'playing';
    await db.write();

    // Notify both players game start
    const [playerA, playerB] = Array.from(room.players.values());
    playerA.socket.send(JSON.stringify({
      type: 'gameStart',
      color: playerA.color,
      opponent: playerB.username,
      fen: room.chess.fen(),
    }));
    playerB.socket.send(JSON.stringify({
      type: 'gameStart',
      color: playerB.color,
      opponent: playerA.username,
      fen: room.chess.fen(),
    }));
  } else {
    // Notify waiting player
    ws.send(JSON.stringify({
      type: 'roomJoined',
      roomCode: targetRoomCode,
      color,
      waiting: true,
    }));
  }

  // Broadcast updated player list to everyone in room
  broadcastRoomPlayers(targetRoomCode);
}

async function handleLeaveRoom(ws, roomCode, disconnected = false) {
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  const userId = ws.user.id;

  if (!room.players.has(userId)) return;

  const wasPlaying = room.status === 'playing';
  const playerColor = room.players.get(userId).color;
  room.players.delete(userId);
  activeUsers.get(userId)?.rooms.delete(roomCode);
  ws.roomCode = null;

  // If room becomes empty, remove it
  if (room.players.size === 0) {
    rooms.delete(roomCode);
    // Update db room status to finished?
    await db.read();
    const dbRoom = db.data.rooms.find(r => r.roomCode === roomCode);
    if (dbRoom) dbRoom.status = 'abandoned';
    await db.write();
    return;
  }

  // If game was playing, the remaining player wins by forfeit
  if (wasPlaying) {
    const winner = Array.from(room.players.values())[0]; // only one left
    const loserUsername = ws.user.username;
    // Game over
    await endGame(room, roomCode, {
      result: winner.color === 'w' ? 'white' : 'black',
      reason: 'resign', // treat as resignation
      winnerId: winner.socket.user.id,
      loserId: userId,
    });
  } else {
    // Just left while waiting, update others
    broadcastRoomPlayers(roomCode);
  }
}

async function handleMove(ws, msg) {
  const roomCode = ws.roomCode;
  if (!roomCode || !rooms.has(roomCode)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' }));
    return;
  }
  const room = rooms.get(roomCode);
  if (room.status !== 'playing') {
    ws.send(JSON.stringify({ type: 'error', message: 'Game not in progress' }));
    return;
  }

  const userId = ws.user.id;
  const player = room.players.get(userId);
  if (!player) {
    ws.send(JSON.stringify({ type: 'error', message: 'You are not a player in this game' }));
    return;
  }

  // Check turn
  const turn = room.chess.turn();
  if (player.color !== turn) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not your turn' }));
    return;
  }

  // Anti-cheat rate limit
  if (!checkRateLimit(userId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Move too fast (rate limit)' }));
    return;
  }

  const moveStr = msg.move;
  try {
    const move = room.chess.move(moveStr, { sloppy: true }); // allow promotion like e7e8q
    if (!move) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid move' }));
      return;
    }

    // Record move
    room.moveHistory.push(move.san);
    room.lastMoveTime = Date.now();

    // Broadcast move to both players
    const gameState = {
      fen: room.chess.fen(),
      turn: room.chess.turn(),
      inCheck: room.chess.in_check(),
      move: move.san,
      checkmate: room.chess.is_checkmate(),
      stalemate: room.chess.is_stalemate(),
      draw: room.chess.is_draw(),
    };

    broadcastToRoom(roomCode, {
      type: 'moveMade',
      ...gameState,
      by: ws.user.username,
    });

    // Check game end
    if (gameState.checkmate || gameState.stalemate || gameState.draw) {
      let result, reason;
      if (gameState.checkmate) {
        result = room.chess.turn() === 'w' ? 'black' : 'white'; // winner is opposite of current turn
        reason = 'checkmate';
      } else if (gameState.stalemate) {
        result = 'draw';
        reason = 'stalemate';
      } else if (gameState.draw) {
        result = 'draw';
        reason = 'draw';
      }
      await endGame(room, roomCode, { result, reason, winnerId: null, loserId: null });
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: 'Move error' }));
  }
}

async function handleChat(ws, msg) {
  const roomCode = ws.roomCode;
  if (!roomCode || !rooms.has(roomCode)) return;
  const text = msg.message?.trim();
  if (!text) return;

  // Store in db
  await db.read();
  db.data.chatMessages.push({
    id: crypto.randomUUID(),
    roomCode,
    username: ws.user.username,
    message: text,
    timestamp: new Date().toISOString(),
  });
  await db.write();

  // Broadcast to room
  broadcastToRoom(roomCode, {
    type: 'chat',
    username: ws.user.username,
    message: text,
    timestamp: Date.now(),
  });
}

async function handleResign(ws) {
  const roomCode = ws.roomCode;
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  if (room.status !== 'playing') return;

  const userId = ws.user.id;
  const player = room.players.get(userId);
  if (!player) return;

  // Opponent wins
  const winner = Array.from(room.players.values()).find(p => p.color !== player.color);
  if (!winner) return; // shouldn't happen

  await endGame(room, roomCode, {
    result: winner.color === 'w' ? 'white' : 'black',
    reason: 'resign',
    winnerId: winner.socket.user.id,
    loserId: userId,
  });
}

async function handleDrawOffer(ws) {
  const roomCode = ws.roomCode;
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  if (room.status !== 'playing') return;

  // Store draw offer state (simple: we'll just send offer to other player)
  const userId = ws.user.id;
  const player = room.players.get(userId);
  if (!player) return;

  const opponent = Array.from(room.players.values()).find(p => p.color !== player.color);
  if (!opponent) return;

  opponent.socket.send(JSON.stringify({
    type: 'drawOffered',
    by: ws.user.username,
  }));
}

async function handleDrawResponse(ws, msg) {
  const roomCode = ws.roomCode;
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  if (room.status !== 'playing') return;

  const accepted = msg.accept;
  if (!accepted) {
    // just notify offerer that it was declined
    // find opponent who offered (we don't store who offered, so we broadcast to both)
    broadcastToRoom(roomCode, {
      type: 'drawDeclined',
      by: ws.user.username,
    });
    return;
  }

  // Draw accepted
  await endGame(room, roomCode, {
    result: 'draw',
    reason: 'agreement',
    winnerId: null,
    loserId: null,
  });
}

// End game: update stats, ELO, save log, close room
async function endGame(room, roomCode, { result, reason, winnerId, loserId }) {
  room.status = 'finished';

  const players = Array.from(room.players.values());
  const whitePlayer = players.find(p => p.color === 'w');
  const blackPlayer = players.find(p => p.color === 'b');

  // Update db stats
  await db.read();

  if (result === 'white') {
    // white wins
    await updateUserStats(winnerId, 'win', loserId);
  } else if (result === 'black') {
    await updateUserStats(winnerId, 'win', loserId);
  } else if (result === 'draw') {
    // draw: update both
    if (whitePlayer) await updateUserStats(whitePlayer.socket.user.id, 'draw', blackPlayer?.socket.user.id);
    if (blackPlayer) await updateUserStats(blackPlayer.socket.user.id, 'draw', whitePlayer?.socket.user.id);
  }

  // Save game log
  db.data.gameLogs.push({
    id: crypto.randomUUID(),
    roomCode,
    white: whitePlayer?.username,
    black: blackPlayer?.username,
    result,
    reason,
    finalFen: room.chess.fen(),
    moves: room.moveHistory.join(' '),
    date: new Date().toISOString(),
  });

  // Update room in db
  const dbRoom = db.data.rooms.find(r => r.roomCode === roomCode);
  if (dbRoom) {
    dbRoom.status = 'finished';
    dbRoom.result = result;
    dbRoom.reason = reason;
  }

  await db.write();
  await updateLeaderboard();

  // Notify players
  broadcastToRoom(roomCode, {
    type: 'gameOver',
    result,
    reason,
  });

  // Remove room from memory after short delay (to allow final messages)
  setTimeout(() => {
    rooms.delete(roomCode);
    // Also remove from active users' rooms sets
    players.forEach(p => {
      const userRec = activeUsers.get(p.socket.user.id);
      if (userRec) userRec.rooms.delete(roomCode);
    });
  }, 5000);
}

async function updateUserStats(userId, outcome, opponentId) {
  if (!userId) return;
  const user = db.data.users.find(u => u.id === userId);
  if (!user) return;

  user.gamesPlayed += 1;

  let opponentElo = null;
  if (opponentId) {
    const opponent = db.data.users.find(u => u.id === opponentId);
    if (opponent) opponentElo = opponent.elo;
  }

  if (outcome === 'win') {
    user.wins += 1;
    if (opponentElo !== null) {
      const change = computeEloChange(user.elo, opponentElo, false).winnerChange;
      user.elo += change;
    } else {
      user.elo += 16; // default
    }
  } else if (outcome === 'loss') {
    user.losses += 1;
    if (opponentElo !== null) {
      const change = computeEloChange(opponentElo, user.elo, false).loserChange; // loserChange is negative
      user.elo += change; // change is negative
    } else {
      user.elo -= 16;
    }
  } else if (outcome === 'draw') {
    user.draws += 1;
    if (opponentElo !== null) {
      const change = computeEloChange(user.elo, opponentElo, true).winnerChange; // symmetric
      user.elo += change;
    }
  }
}

// Broadcast to all players in a room
function broadcastToRoom(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const json = JSON.stringify(message);
  room.players.forEach(p => {
    if (p.socket.readyState === WebSocket.OPEN) {
      p.socket.send(json);
    }
  });
}

// Send updated player list to room
function broadcastRoomPlayers(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const players = Array.from(room.players.values()).map(p => ({
    username: p.username,
    color: p.color,
  }));
  broadcastToRoom(roomCode, { type: 'roomPlayers', players });
}

// ==================== START SERVER ====================
server.listen(PORT, () => {
  console.log(`Chess server running on port ${PORT}`);
  console.log(`Database stored compressed at: ${DB_FILE}`);
});
