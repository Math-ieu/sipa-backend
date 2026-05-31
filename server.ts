import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Card, GameState, ChatMessage } from './types.js';
import { createDeck, dealCards, determineTrickWinner, calculateRoundResult } from './gameEngine.js';
import { initDB, upsertUser, createMatch, updateMatchScores, endMatch, getUserStats, getUserMatches } from './db.js';

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

// Enable CORS so the separate Vercel frontend can call this backend in production
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
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

// Enregistrement/mise à jour du pseudo et sceau
app.post('/api/users', async (req, res) => {
  try {
    const { playerId, playerName, avatarId } = req.body;
    if (!playerId) {
      return res.status(400).json({ error: "playerId est requis" });
    }
    const user = await upsertUser(playerId, playerName, avatarId);
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
    const stats = await getUserStats(playerId);
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
    const matches = await getUserMatches(playerId);
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
    const matchId = await createMatch(roomId || 'local', gameMode || 'ai', players);
    const scoresMap: { [id: string]: number } = {};
    players.forEach((p) => {
      scoresMap[p.id] = p.score || 0;
    });
    await updateMatchScores(matchId, scoresMap);
    await endMatch(matchId, winnerId || null);
    res.json({ success: true, matchId });
  } catch (err) {
    console.error('Erreur dans /api/matches/end-local :', err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

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
        const room = rooms.get(roomId);

        if (!room) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: "Ce salon n'existe pas. Veuillez vérifier le code." }
          }));
          return;
        }

        const players = room.gameState.players;
        const existingPlayerIdx = players.findIndex(p => p.id === playerId);

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
            id: playerId,
            name: playerName,
            score: 0,
            hand: [],
            isAI: false,
            isHost,
            avatarId
          });
        } else {
          players[existingPlayerIdx].name = playerName;
          players[existingPlayerIdx].avatarId = avatarId;
        }

        room.clients.set(playerId, ws);
        clientRoomIds.set(ws, roomId);
        clientPlayerIds.set(ws, playerId);

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
        const { roomId } = data.payload;
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
        const { roomId, playerId, card, playerName } = data.payload;
        const room = rooms.get(roomId);
        if (!room) return;

        const players = room.gameState.players;
        const currentTrickCards = room.gameState.currentTrickCards;
        const currentTrickIndex = room.gameState.currentTrickIndex;

        const activePlayer = players[room.gameState.activePlayerIndex];
        if (!activePlayer || activePlayer.id !== playerId) return;

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
        } else {
          const leadPlay = currentTrickCards[0];
          const startingSuit = leadPlay.card.suit;

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
        }

        broadcastRoomState(room);
      }

      if (data.type === 'deal_next_round') {
        const { roomId } = data.payload;
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
        const { roomId } = data.payload;
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
        const { roomId, senderId, senderName, avatarId, text } = data.payload;
        const room = rooms.get(roomId);
        if (!room) return;

        const chatMsg: ChatMessage = {
          id: 'msg_' + Math.random().toString(36).substring(2, 11),
          senderId,
          senderName,
          avatarId,
          text,
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
