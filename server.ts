import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Card, GameState, ChatMessage } from './types.js';
import { createDeck, dealCards, determineTrickWinner, calculateRoundResult } from './gameEngine.js';
import { 
  initDB, 
  upsertUser, 
  createMatch, 
  updateMatchScores, 
  endMatch, 
  getUserStats, 
  getUserMatches,
  getUserByUsername,
  createUser,
  getUserById,
  updateUser,
  cancelMatch
} from './db.js';
import { sign, verify } from './jwt.js';

interface Room {
  roomId: string;
  gameState: GameState;
  privateHands: Map<string, Card[]>; // playerId -> true hands
  clients: Map<string, WebSocket>;    // playerId -> ws client
  chatMessages: ChatMessage[];        // in-memory message history
  matchId?: string;                   // active database match id
}

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'sipa_secret_key_2026_safe!';

// Enable CORS so the separate Vercel frontend can call this backend in production
app.use((req, res, next) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const origin = req.headers.origin;

  if (frontendUrl) {
    const normalizedFrontend = frontendUrl.replace(/\/$/, '');
    if (origin) {
      const normalizedOrigin = origin.replace(/\/$/, '');
      if (normalizedOrigin !== normalizedFrontend) {
        console.warn(`[CORS Blocked] Request origin '${origin}' does not match allowed FRONTEND_URL '${frontendUrl}'`);
        return res.status(403).send('Forbidden: Origin not allowed');
      }
    }
    res.header('Access-Control-Allow-Origin', frontendUrl);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }

  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// In-memory Room persistence
const rooms = new Map<string, Room>();

// Track socket mappings for automatic cleanup on disconnect
const clientRoomIds = new Map<WebSocket, string>();
const clientPlayerIds = new Map<WebSocket, string>();

// REST endpoint to create a room code (6-digit alphanumeric)
app.post('/api/create-room', (req, res) => {
  const { playerName, avatarId } = req.body;
  const roomId = Math.floor(100000 + Math.random() * 900000).toString();

  const initialGameState: GameState = {
    roomId,
    players: [],
    deck: [],
    currentRound: 1,
    currentTrickIndex: 0,
    currentLeaderId: '',
    currentTrickCards: [],
    activePlayerIndex: 0,
    tricksHistory: [],
    lastRoundResult: null,
    winnerId: null,
    dealerId: '',
    status: 'lobby',
    gameMode: 'online'
  };

  rooms.set(roomId, {
    roomId,
    gameState: initialGameState,
    privateHands: new Map(),
    clients: new Map(),
    chatMessages: []
  });

  res.json({ roomId });
});

// -------------------------------------------------------------
// Authentication and Registration Endpoints (with Rate Limiting & Input Sanitization)
// -------------------------------------------------------------

// Simple in-memory rate limiter to protect database from brute force or registration floods
interface RateLimitInfo {
  count: number;
  resetTime: number;
}
const rateLimits = new Map<string, RateLimitInfo>();

function rateLimiter(maxRequests: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    
    let limitInfo = rateLimits.get(ip);
    if (!limitInfo || now > limitInfo.resetTime) {
      limitInfo = {
        count: 0,
        resetTime: now + windowMs
      };
    }
    
    limitInfo.count++;
    rateLimits.set(ip, limitInfo);
    
    if (limitInfo.count > maxRequests) {
      console.warn(`[Rate Limit Exceeded] IP ${ip} exceeded limit for path ${req.path}`);
      return res.status(429).json({ error: "Trop de requêtes. Veuillez réessayer plus tard." });
    }
    next();
  };
}

// Helper functions for secure password hashing using Node's native scrypt
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const verifyHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === verifyHash;
}

// Inscription d'un nouvel utilisateur (avec Honeypot, Rate Limiter et Sanitization)
app.post('/api/auth/register', rateLimiter(5, 15 * 60 * 1000), async (req, res) => {
  try {
    const { username, password, avatarId, email_confirm } = req.body;

    // Protection anti-bot Honeypot
    if (email_confirm) {
      console.warn('[Bot Detected] Honeypot field was filled during registration!');
      return res.status(400).json({ error: "Validation anti-bot échouée." });
    }

    if (!username || !password) {
      return res.status(400).json({ error: "Le pseudo et le mot de passe sont requis." });
    }

    const trimmedUsername = username.trim();
    const usernameRegex = /^[a-zA-Z0-9_\-]{3,16}$/;
    if (!usernameRegex.test(trimmedUsername)) {
      return res.status(400).json({ error: "Le pseudo doit contenir entre 3 et 16 caractères et ne peut inclure que des lettres, chiffres, tirets (-) et underscores (_)." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
    }

    // Vérifier si le pseudo est déjà pris par un utilisateur inscrit
    const existingUser = await getUserByUsername(trimmedUsername);
    if (existingUser && existingUser.password_hash) {
      return res.status(400).json({ error: "Ce pseudo est déjà utilisé par un compte enregistré." });
    }

    // Créer l'utilisateur
    const passwordHash = hashPassword(password);
    const playerId = `user_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
    const avatar = String(avatarId || 'av1').trim().substring(0, 10).replace(/[^a-zA-Z0-9_\-]/g, '');

    const newUser = await createUser(playerId, trimmedUsername, passwordHash, avatar);

    // Créer la session JWT (expire dans 7 jours)
    const token = sign({ userId: playerId, username: trimmedUsername }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        avatarId: newUser.avatar_id
      }
    });
  } catch (err) {
    console.error('Erreur dans /api/auth/register :', err);
    res.status(500).json({ error: "Erreur lors de la création du compte." });
  }
});

// Connexion de l'utilisateur (avec Rate Limiter)
app.post('/api/auth/login', rateLimiter(15, 5 * 60 * 1000), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Le pseudo et le mot de passe sont requis." });
    }

    const trimmedUsername = String(username).trim();
    const usernameRegex = /^[a-zA-Z0-9_\-]{3,16}$/;
    if (!usernameRegex.test(trimmedUsername)) {
      return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    }

    const user = await getUserByUsername(trimmedUsername);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    }

    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    }

    // Créer la session JWT (expire dans 7 jours)
    const token = sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        avatarId: user.avatar_id
      }
    });
  } catch (err) {
    console.error('Erreur dans /api/auth/login :', err);
    res.status(500).json({ error: "Erreur lors de la connexion." });
  }
});

// Récupération de la session de l'utilisateur connecté
app.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Jeton de session absent." });
    }

    const token = authHeader.split(' ')[1];
    let decoded: any;
    try {
      decoded = verify(token, JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ error: "Session invalide ou expirée." });
    }

    // Récupérer l'utilisateur
    const user = await getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: "Utilisateur introuvable." });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        avatarId: user.avatar_id
      }
    });
  } catch (err) {
    console.error('Erreur dans /api/auth/me :', err);
    res.status(500).json({ error: "Erreur lors de la récupération du profil." });
  }
});

// Déconnexion de l'utilisateur (stateless JWT)
app.post('/api/auth/logout', async (req, res) => {
  res.json({ success: true });
});

// Mise à jour des informations de l'utilisateur connecté (pseudo, avatar, mot de passe)
app.put('/api/users/update', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Jeton de session absent." });
    }

    const token = authHeader.split(' ')[1];
    let decoded: any;
    try {
      decoded = verify(token, JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ error: "Session invalide ou expirée." });
    }

    const userId = decoded.userId;
    const user = await getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: "Utilisateur introuvable." });
    }

    const { username, avatarId, currentPassword, newPassword } = req.body;

    const trimmedUsername = (username || '').trim();
    if (!trimmedUsername) {
      return res.status(400).json({ error: "Le pseudo ne peut pas être vide." });
    }

    // Si le pseudo change, vérifier s'il est déjà pris
    if (trimmedUsername.toLowerCase() !== user.username.toLowerCase()) {
      const existingUser = await getUserByUsername(trimmedUsername);
      if (existingUser && existingUser.id !== userId) {
        return res.status(400).json({ error: "Ce pseudo est déjà utilisé." });
      }
    }

    let passwordHashToSave: string | undefined = undefined;

    // Si un nouveau mot de passe est fourni
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Le mot de passe actuel est requis pour changer de mot de passe." });
      }

      if (!user.password_hash) {
        return res.status(500).json({ error: "Erreur de configuration du compte." });
      }

      const isCurrentPasswordValid = verifyPassword(currentPassword, user.password_hash);
      if (!isCurrentPasswordValid) {
        return res.status(400).json({ error: "Le mot de passe actuel est incorrect." });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 6 caractères." });
      }

      passwordHashToSave = hashPassword(newPassword);
    }

    // Effectuer la mise à jour
    const updatedUser = await updateUser(userId, trimmedUsername, avatarId, passwordHashToSave);

    // Signer un nouveau jeton avec le pseudo mis à jour
    const newToken = sign({ userId, username: trimmedUsername }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: "Profil mis à jour avec succès !",
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        avatarId: updatedUser.avatar_id
      },
      token: newToken
    });
  } catch (err) {
    console.error('Erreur dans /api/users/update :', err);
    res.status(500).json({ error: "Erreur lors de la mise à jour du profil." });
  }
});

// Enregistrement/mise à jour du pseudo et sceau
app.post('/api/users', async (req, res) => {
  try {
    const { playerId, playerName, avatarId } = req.body;
    if (!playerId) {
      return res.status(400).json({ error: "playerId est requis" });
    }
    
    // Strict input filtering and escape to block SQLi and malicious payloads
    const sanitizedPlayerId = String(playerId).trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '');
    const sanitizedPlayerName = String(playerName || '').trim().substring(0, 16).replace(/[<>]/g, '');
    const sanitizedAvatarId = String(avatarId || 'av1').trim().substring(0, 10).replace(/[^a-zA-Z0-9_\-]/g, '');

    const user = await upsertUser(sanitizedPlayerId, sanitizedPlayerName, sanitizedAvatarId);
    res.json(user);
  } catch (err) {
    console.error('Erreur dans /api/users :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Récupération des statistiques utilisateur
app.get('/api/users/:playerId/stats', async (req, res) => {
  try {
    const { playerId } = req.params;
    const sanitizedPlayerId = String(playerId).trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '');
    const stats = await getUserStats(sanitizedPlayerId);
    res.json(stats);
  } catch (err) {
    console.error('Erreur dans /api/users/:playerId/stats :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Récupération de l'historique des matchs d'un joueur
app.get('/api/users/:playerId/matches', async (req, res) => {
  try {
    const { playerId } = req.params;
    const sanitizedPlayerId = String(playerId).trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '');
    const matches = await getUserMatches(sanitizedPlayerId);
    res.json(matches);
  } catch (err) {
    console.error('Erreur dans /api/users/:playerId/matches :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Sauvegarde des résultats d'un match local (contre l'IA)
app.post('/api/matches/end-local', async (req, res) => {
  try {
    const { roomId, gameMode, players, winnerId } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: "players est requis et doit être un tableau" });
    }

    // Protection par assainissement rigoureux des entrées pour la base de données
    const sanitizedRoomId = String(roomId || 'local').trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '');
    const sanitizedGameMode = String(gameMode || 'ai').trim().substring(0, 20).replace(/[^a-zA-Z0-9_\-]/g, '');
    const sanitizedWinnerId = winnerId ? String(winnerId).trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '') : null;

    const sanitizedPlayers = players.map((p: any) => {
      return {
        id: String(p.id || '').trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, ''),
        name: String(p.name || '').trim().substring(0, 16).replace(/[<>]/g, ''), // Bloque XSS injecté dans le pseudo
        isHost: !!p.isHost,
        isAI: !!p.isAI,
        avatarId: String(p.avatarId || 'av1').trim().substring(0, 10).replace(/[^a-zA-Z0-9_\-]/g, ''),
        score: typeof p.score === 'number' ? p.score : 0
      };
    });

    const matchId = await createMatch(sanitizedRoomId, sanitizedGameMode, sanitizedPlayers);
    const scoresMap: { [id: string]: number } = {};
    sanitizedPlayers.forEach((p) => {
      scoresMap[p.id] = p.score;
    });
    await updateMatchScores(matchId, scoresMap);
    await endMatch(matchId, sanitizedWinnerId);
    res.json({ success: true, matchId });
  } catch (err) {
    console.error('Erreur dans /api/matches/end-local :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Sauvegarde d'un match local annulé en base de données pour traçabilité
app.post('/api/matches/cancel-local', async (req, res) => {
  try {
    const { roomId, gameMode, players } = req.body;
    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: "players est requis et doit être un tableau" });
    }

    const sanitizedRoomId = String(roomId || 'local').trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '');
    const sanitizedGameMode = String(gameMode || 'ai').trim().substring(0, 20).replace(/[^a-zA-Z0-9_\-]/g, '');

    const sanitizedPlayers = players.map((p: any) => {
      return {
        id: String(p.id || '').trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, ''),
        name: String(p.name || '').trim().substring(0, 16).replace(/[<>]/g, ''),
        isHost: !!p.isHost,
        isAI: !!p.isAI,
        avatarId: String(p.avatarId || 'av1').trim().substring(0, 10).replace(/[^a-zA-Z0-9_\-]/g, ''),
        score: typeof p.score === 'number' ? p.score : 0
      };
    });

    const matchId = await createMatch(sanitizedRoomId, sanitizedGameMode, sanitizedPlayers);
    const scoresMap: { [id: string]: number } = {};
    sanitizedPlayers.forEach((p) => {
      scoresMap[p.id] = p.score;
    });
    await updateMatchScores(matchId, scoresMap);
    await cancelMatch(matchId);
    res.json({ success: true, matchId });
  } catch (err) {
    console.error('Erreur dans /api/matches/cancel-local :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Resolve a vote: check majority and execute the action
async function resolveVote(room: Room) {
  const vote = room.gameState.activeVote;
  if (!vote) return;

  const totalPlayers = room.gameState.players.length;
  const yesVotes = Object.values(vote.votes).filter(v => v === true).length;
  const noVotes = Object.values(vote.votes).filter(v => v === false).length;
  const majority = Math.ceil(totalPlayers / 2);

  // Check if majority is reached
  const approved = yesVotes >= majority;

  if (approved) {
    const action = vote.action;

    if (action === 'cancel') {
      // Save match as canceled in DB for traceability
      if (room.matchId) {
        const scoresMap: { [id: string]: number } = {};
        room.gameState.players.forEach(p => { scoresMap[p.id] = p.score; });
        await updateMatchScores(room.matchId, scoresMap).catch(err => console.error('Erreur mise à jour scores avant annulation:', err));
        await cancelMatch(room.matchId).catch(err => console.error('Erreur annulation match en DB:', err));
      }
      room.gameState.status = 'canceled';
      room.gameState.activeVote = null;
    } else if (action === 'end') {
      // End match with highest scorer as winner
      let highestScorePlayer = room.gameState.players[0];
      room.gameState.players.forEach(p => {
        if (p.score > highestScorePlayer.score) {
          highestScorePlayer = p;
        }
      });
      const winnerId = highestScorePlayer && highestScorePlayer.score > 0 ? highestScorePlayer.id : null;
      
      if (room.matchId) {
        const scoresMap: { [id: string]: number } = {};
        room.gameState.players.forEach(p => { scoresMap[p.id] = p.score; });
        await updateMatchScores(room.matchId, scoresMap).catch(err => console.error('Erreur mise à jour scores avant fin:', err));
        await endMatch(room.matchId, winnerId).catch(err => console.error('Erreur fin match en DB:', err));
      }
      room.gameState.status = 'game_over';
      room.gameState.winnerId = winnerId;
      room.gameState.activeVote = null;
    } else if (action === 'pause') {
      room.gameState.status = 'paused';
      room.gameState.activeVote = null;
    } else if (action === 'resume') {
      room.gameState.status = 'playing';
      room.gameState.activeVote = null;
    }
  } else {
    // Vote rejected - clear the active vote
    room.gameState.activeVote = null;
  }
}

// Broadcast public state to all connected clients in a specific room
function broadcastRoomState(room: Room) {
  room.gameState.players.forEach((p) => {
    const ws = room.clients.get(p.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const playersForClient = room.gameState.players.map((item) => {
        if (item.id === p.id) {
          return {
            ...item,
            hand: room.privateHands.get(p.id) || []
          };
        } else {
          return {
            ...item,
            hand: []
          };
        }
      });

      const clientState = {
        ...room.gameState,
        players: playersForClient
      };

      ws.send(JSON.stringify({
        type: 'room:updated',
        payload: clientState
      }));

      const privateHand = room.privateHands.get(p.id) || [];
      ws.send(JSON.stringify({
        type: 'your:hand',
        payload: privateHand
      }));
    }
  });
}

// WebSocket setup
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const origin = request.headers.origin;

  if (frontendUrl && origin) {
    const normalizedFrontend = frontendUrl.replace(/\/$/, '');
    const normalizedOrigin = origin.replace(/\/$/, '');

    if (normalizedOrigin !== normalizedFrontend) {
      console.warn(`[WS Blocked] WebSocket upgrade rejected for origin '${origin}'. Expected '${frontendUrl}'`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const urlObj = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = urlObj.pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'join') {
        const { roomId, playerId, playerName, avatarId } = data.payload;
        
        // Strict input sanitization for WS payloads to prevent injection or malicious clients
        const sanitizedRoomId = String(roomId || '').trim().substring(0, 10).replace(/[^a-zA-Z0-9_\-]/g, '');
        const sanitizedPlayerId = String(playerId || '').trim().substring(0, 50).replace(/[^a-zA-Z0-9_\-]/g, '');
        const sanitizedPlayerName = String(playerName || '').trim().substring(0, 16).replace(/[<>]/g, '');
        const sanitizedAvatarId = String(avatarId || 'av1').trim().substring(0, 10).replace(/[^a-zA-Z0-9_\-]/g, '');

        const room = rooms.get(sanitizedRoomId);

        if (!room) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: "Ce salon n'existe pas. Veuillez vérifier le code." }
          }));
          return;
        }

        const players = room.gameState.players;
        const existingPlayerIdx = players.findIndex(p => p.id === sanitizedPlayerId);

        if (existingPlayerIdx === -1) {
          if (players.length >= 4) {
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: "Ce salon est déjà complet (maximum 4 joueurs)." }
            }));
            return;
          }
          if (room.gameState.status !== 'lobby') {
            ws.send(JSON.stringify({
              type: 'error',
              payload: { message: "La partie a déjà débuté dans ce salon." }
            }));
            return;
          }

          const isHost = players.length === 0;
          players.push({
            id: sanitizedPlayerId,
            name: sanitizedPlayerName,
            score: 0,
            hand: [],
            isAI: false,
            isHost,
            avatarId: sanitizedAvatarId
          });
        } else {
          players[existingPlayerIdx].name = sanitizedPlayerName;
          players[existingPlayerIdx].avatarId = sanitizedAvatarId;
        }

        room.clients.set(sanitizedPlayerId, ws);
        clientRoomIds.set(ws, sanitizedRoomId);
        clientPlayerIds.set(ws, sanitizedPlayerId);

        if (room.gameState.status === 'lobby' && players.length > 0) {
          room.gameState.currentLeaderId = players[0].id;
          room.gameState.dealerId = players[0].id;
        }

        ws.send(JSON.stringify({
          type: 'joined',
          payload: { gameState: room.gameState }
        }));

        ws.send(JSON.stringify({
          type: 'chat:history',
          payload: room.chatMessages || []
        }));

        broadcastRoomState(room);
      }

      if (data.type === 'start_game') {
        const roomId = clientRoomIds.get(ws);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;

        const players = room.gameState.players;
        
        try {
          const playersForDb = players.map(p => ({
            id: p.id,
            name: p.name,
            isHost: p.isHost || false,
            isAI: p.isAI || false,
            avatarId: p.avatarId
          }));
          const dbMatchId = await createMatch(roomId, 'online', playersForDb);
          room.matchId = dbMatchId;
        } catch (dbErr) {
          console.error('Erreur lors de la création du match multijoueur en DB :', dbErr);
        }
        
        const playersCount = players.length;
        const deck = createDeck();
        const { hands } = dealCards(deck, playersCount);

        room.privateHands.clear();
        for (let i = 0; i < playersCount; i++) {
          const player = players[i];
          room.privateHands.set(player.id, hands[i]);
          player.hand = [];
        }

        const host = players.find(p => p.isHost) || players[0];
        const startingLeaderId = host.id;

        room.gameState.status = 'playing';
        room.gameState.currentRound = 1;
        room.gameState.currentTrickIndex = 0;
        room.gameState.currentLeaderId = startingLeaderId;
        room.gameState.activePlayerIndex = players.findIndex(p => p.id === startingLeaderId);
        room.gameState.currentTrickCards = [];
        room.gameState.tricksHistory = [];
        room.gameState.winnerId = null;
        room.gameState.lastRoundResult = null;

        broadcastRoomState(room);
      }

      if (data.type === 'play_card') {
        const roomId = clientRoomIds.get(ws);
        const playerId = clientPlayerIds.get(ws);
        if (!roomId || !playerId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const players = room.gameState.players;
        const currentTrickCards = room.gameState.currentTrickCards;
        const currentTrickIndex = room.gameState.currentTrickIndex;

        const activePlayer = players[room.gameState.activePlayerIndex];
        if (!activePlayer || activePlayer.id !== playerId) return;

        const { card } = data.payload;
        const playerName = activePlayer.name;

        currentTrickCards.push({
          playerId,
          card,
          playerName
        });

        const hand = room.privateHands.get(playerId) || [];
        const nextHand = hand.filter(c => c.id !== card.id);
        room.privateHands.set(playerId, nextHand);

        const totalPlayers = players.length;
        if (currentTrickCards.length < totalPlayers) {
          room.gameState.activePlayerIndex = (room.gameState.activePlayerIndex + 1) % totalPlayers;
          broadcastRoomState(room);
        } else {
          const leadPlay = currentTrickCards[0];
          const startingSuit = leadPlay.card.suit;

          // Broadcast the state so the last card is visible on the board for everyone!
          broadcastRoomState(room);

          setTimeout(async () => {
            const trickWinnerId = determineTrickWinner(currentTrickCards, startingSuit);
            const winningPlayIdx = currentTrickCards.findIndex(p => p.playerId === trickWinnerId);
            const winningCard = currentTrickCards[winningPlayIdx].card;

            const newTrickResult = {
              trickIndex: currentTrickIndex,
              leadPlayerId: room.gameState.currentLeaderId,
              winnerId: trickWinnerId,
              winningCard,
              playedCards: [...currentTrickCards]
            };

            room.gameState.tricksHistory.push(newTrickResult);

            if (currentTrickIndex >= 4) {
              const roundResult = calculateRoundResult(room.gameState.tricksHistory, room.gameState.currentRound || 1);

              const winnerIdx = players.findIndex(p => p.id === roundResult.winnerId);
              if (winnerIdx !== -1) {
                players[winnerIdx].score += roundResult.pointsGained;
              }

              room.gameState.status = 'round_end';
              room.gameState.lastRoundResult = roundResult;

              if (room.matchId) {
                const scoresMap: { [id: string]: number } = {};
                players.forEach(p => {
                  scoresMap[p.id] = p.score;
                });
                await updateMatchScores(room.matchId, scoresMap).catch(err => console.error('Erreur lors de la mise à jour des scores en DB :', err));
              }

              const matchWinner = players.find(p => p.score >= 11);
              if (matchWinner) {
                room.gameState.status = 'game_over';
                room.gameState.winnerId = matchWinner.id;
                if (room.matchId) {
                  await endMatch(room.matchId, matchWinner.id).catch(err => console.error('Erreur lors de la clôture du match en DB :', err));
                }
              }
            } else {
              const nextLeaderIdx = players.findIndex(p => p.id === trickWinnerId);
              room.gameState.currentTrickCards = [];
              room.gameState.currentTrickIndex = currentTrickIndex + 1;
              room.gameState.currentLeaderId = trickWinnerId;
              room.gameState.activePlayerIndex = nextLeaderIdx >= 0 ? nextLeaderIdx : 0;
            }
            broadcastRoomState(room);
          }, 1400);
        }
      }

      if (data.type === 'deal_next_round') {
        const roomId = clientRoomIds.get(ws);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;

        const players = room.gameState.players;
        const playersCount = players.length;

        const deck = createDeck();
        const { hands } = dealCards(deck, playersCount);

        room.privateHands.clear();
        for (let i = 0; i < playersCount; i++) {
          const player = players[i];
          room.privateHands.set(player.id, hands[i]);
          player.hand = [];
        }

        const prevWinnerId = room.gameState.lastRoundResult?.winnerId || players[0].id;
        const startingLeaderIndex = players.findIndex(p => p.id === prevWinnerId);

        room.gameState.status = 'playing';
        room.gameState.currentRound = (room.gameState.currentRound || 1) + 1;
        room.gameState.currentTrickIndex = 0;
        room.gameState.currentLeaderId = prevWinnerId;
        room.gameState.activePlayerIndex = startingLeaderIndex >= 0 ? startingLeaderIndex : 0;
        room.gameState.currentTrickCards = [];
        room.gameState.tricksHistory = [];
        room.gameState.lastRoundResult = null;

        broadcastRoomState(room);
      }

      if (data.type === 'reset_scores') {
        const roomId = clientRoomIds.get(ws);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;

        if (room.matchId) {
          const players = room.gameState.players;
          let highestScorePlayer = players[0];
          players.forEach(p => {
            if (p.score > highestScorePlayer.score) {
              highestScorePlayer = p;
            }
          });
          if (highestScorePlayer && highestScorePlayer.score > 0) {
            await endMatch(room.matchId, highestScorePlayer.id).catch(err => console.error('Erreur de clôture sur reset :', err));
          }
          room.matchId = undefined;
        }

        room.gameState.players.forEach(p => {
          p.score = 0;
        });

        broadcastRoomState(room);
      }

      if (data.type === 'send_message') {
        const roomId = clientRoomIds.get(ws);
        const senderId = clientPlayerIds.get(ws);
        if (!roomId || !senderId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const player = room.gameState.players.find(p => p.id === senderId);
        if (!player) return;

        const { text } = data.payload;
        const sanitizedText = String(text || '').trim().substring(0, 200).replace(/[<>]/g, '');

        const chatMsg: ChatMessage = {
          id: 'msg_' + crypto.randomUUID().substring(0, 8) + '_' + Date.now(),
          senderId: player.id,
          senderName: player.name,
          avatarId: player.avatarId || 'av1',
          text: sanitizedText,
          timestamp: new Date().toISOString()
        };

        if (!room.chatMessages) {
          room.chatMessages = [];
        }
        room.chatMessages.push(chatMsg);
        if (room.chatMessages.length > 80) {
          room.chatMessages.shift();
        }

        room.gameState.players.forEach((p) => {
          const wsClient = room.clients.get(p.id);
          if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({
              type: 'chat:message',
              payload: chatMsg
            }));
          }
        });
      }

      // ─── VOTE SYSTEM ─────────────────────────────────────────────
      if (data.type === 'initiate_vote') {
        const roomId = clientRoomIds.get(ws);
        const playerId = clientPlayerIds.get(ws);
        if (!roomId || !playerId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        // Prevent duplicate votes
        if (room.gameState.activeVote) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: 'Un vote est déjà en cours.' }
          }));
          return;
        }

        const action = data.payload?.action;
        if (!['cancel', 'end', 'pause', 'resume'].includes(action)) return;

        // Can only resume when paused
        if (action === 'resume' && room.gameState.status !== 'paused') return;
        // Can only pause/cancel/end when playing or in round_end
        if (action !== 'resume' && room.gameState.status !== 'playing' && room.gameState.status !== 'round_end') return;

        const player = room.gameState.players.find(p => p.id === playerId);
        if (!player) return;

        const votes: Record<string, boolean> = {};
        votes[playerId] = true; // Initiator votes yes

        room.gameState.activeVote = {
          initiatorId: playerId,
          initiatorName: player.name,
          action,
          votes,
          expiresAt: Date.now() + 60000, // 60 second timeout
        };

        // If only one player, resolve immediately
        if (room.gameState.players.length <= 1) {
          await resolveVote(room);
        }

        broadcastRoomState(room);
      }

      if (data.type === 'cast_vote') {
        const roomId = clientRoomIds.get(ws);
        const playerId = clientPlayerIds.get(ws);
        if (!roomId || !playerId) return;

        const room = rooms.get(roomId);
        if (!room || !room.gameState.activeVote) return;

        const vote = !!data.payload?.vote;
        room.gameState.activeVote.votes[playerId] = vote;

        // Check if all players have voted
        const totalPlayers = room.gameState.players.length;
        const totalVotes = Object.keys(room.gameState.activeVote.votes).length;

        if (totalVotes >= totalPlayers) {
          await resolveVote(room);
        }

        broadcastRoomState(room);
      }
      // ─── END VOTE SYSTEM ──────────────────────────────────────────

    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    const roomId = clientRoomIds.get(ws);
    const playerId = clientPlayerIds.get(ws);

    if (roomId && playerId) {
      const room = rooms.get(roomId);
      if (room) {
        room.clients.delete(playerId);

        if (room.clients.size === 0) {
          if (room.matchId) {
            const players = room.gameState.players;
            let highestScorePlayer = players[0];
            players.forEach(p => {
              if (p.score > highestScorePlayer.score) {
                highestScorePlayer = p;
              }
            });
            if (highestScorePlayer && highestScorePlayer.score > 0) {
              endMatch(room.matchId, highestScorePlayer.id).catch(err => console.error('Erreur de clôture sur déconnexion générale :', err));
            }
          }
          rooms.delete(roomId);
        } else {
          const pMeta = room.gameState.players.find(p => p.id === playerId);
          if (pMeta?.isHost) {
            const nextHostId = Array.from(room.clients.keys())[0];
            room.gameState.players.forEach((p) => {
              p.isHost = (p.id === nextHostId);
            });
          }

          if (room.gameState.status === 'lobby') {
            room.gameState.players = room.gameState.players.filter(p => p.id !== playerId);
            if (room.gameState.players.length > 0) {
              room.gameState.currentLeaderId = room.gameState.players[0].id;
              room.gameState.dealerId = room.gameState.players[0].id;
            }
          }

          broadcastRoomState(room);
        }
      }
    }

    clientRoomIds.delete(ws);
    clientPlayerIds.delete(ws);
  });
});

async function startServer() {
  // Initialiser la base de données (PostgreSQL ou fichier JSON local de secours)
  try {
    await initDB();
  } catch (dbInitErr) {
    console.error('Impossible d\'initialiser la base de données :', dbInitErr);
  }

  // Statut de statut de santé API
  app.get('/api/status', (req, res) => {
    res.json({ 
      status: 'ok', 
      time: new Date().toISOString(),
      roomsCount: rooms.size
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SIPA Standalone backend server listening on port ${PORT}`);
  });
}

startServer();
