import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Define DB Schemas and types
export interface DBUser {
  id: string;
  username: string;
  avatar_id: string;
  created_at?: string;
}

export interface DBMatch {
  id: string;
  room_id: string;
  game_mode: string;
  status: string;
  winner_id: string | null;
  created_at?: string;
  ended_at?: string | null;
}

export interface DBMatchPlayer {
  match_id: string;
  player_id: string;
  score: number;
  is_host: boolean;
  is_ai: boolean;
  username?: string;
  avatar_id?: string;
}

// Database Connection configuration
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let pool: Pool | null = null;
let useFallback = true;

const FALLBACK_FILE_PATH = path.join(process.cwd(), 'sipa_db_fallback.json');

// Local fallback DB structure
interface FallbackDB {
  users: { [id: string]: DBUser };
  matches: { [id: string]: DBMatch };
  match_players: DBMatchPlayer[];
}

let fallbackData: FallbackDB = {
  users: {},
  matches: {},
  match_players: [],
};

// Initialize fallback JSON file
function loadFallbackData() {
  try {
    if (fs.existsSync(FALLBACK_FILE_PATH)) {
      const content = fs.readFileSync(FALLBACK_FILE_PATH, 'utf-8');
      fallbackData = JSON.parse(content);
    } else {
      saveFallbackData();
    }
  } catch (err) {
    console.error('Error loading local DB fallback file, starting fresh:', err);
  }
}

function saveFallbackData() {
  try {
    fs.writeFileSync(FALLBACK_FILE_PATH, JSON.stringify(fallbackData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving local DB fallback file:', err);
  }
}

// Initialize Database connection and create tables
export async function initDB(): Promise<boolean> {
  if (connectionString) {
    try {
      console.log('Connecting to PostgreSQL database...');
      pool = new Pool({
        connectionString,
        ssl: {
          rejectUnauthorized: false, // Required for Vercel/Neon serverless postgres
        },
      });

      // Test connection
      await pool.query('SELECT NOW()');

      // Create Tables
      console.log('PostgreSQL connected. Creating tables if not existing...');
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sipa_users (
          id VARCHAR(50) PRIMARY KEY,
          username VARCHAR(100) NOT NULL,
          avatar_id VARCHAR(50) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS sipa_matches (
          id VARCHAR(50) PRIMARY KEY,
          room_id VARCHAR(50) NOT NULL,
          game_mode VARCHAR(50) NOT NULL,
          status VARCHAR(50) NOT NULL,
          winner_id VARCHAR(50) REFERENCES sipa_users(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          ended_at TIMESTAMP WITH TIME ZONE
        );
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS sipa_match_players (
          match_id VARCHAR(50) REFERENCES sipa_matches(id) ON DELETE CASCADE,
          player_id VARCHAR(50) NOT NULL,
          score INTEGER NOT NULL DEFAULT 0,
          is_host BOOLEAN NOT NULL DEFAULT FALSE,
          is_ai BOOLEAN NOT NULL DEFAULT FALSE,
          PRIMARY KEY (match_id, player_id)
        );
      `);

      useFallback = false;
      console.log('PostgreSQL database successfully initialized.');
      return true;
    } catch (err) {
      console.warn('PostgreSQL connection failed. Falling back to local JSON database storage.');
      console.warn('Reason:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('No DATABASE_URL or POSTGRES_URL provided. Operating in local fallback JSON database mode.');
  }

  // Fallback Setup
  loadFallbackData();
  useFallback = true;
  return false;
}

// -------------------------------------------------------------
// Database Operations
// -------------------------------------------------------------

/**
 * Register or update a user's details (username, avatar)
 */
export async function upsertUser(id: string, username: string, avatarId: string): Promise<DBUser> {
  const normalizedUsername = username.trim() || `Joueur_${id.substring(0, 5)}`;
  const normalizedAvatarId = avatarId || 'av1';

  if (!useFallback && pool) {
    try {
      await pool.query(
        `INSERT INTO sipa_users (id, username, avatar_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) 
         DO UPDATE SET username = $2, avatar_id = $3`,
        [id, normalizedUsername, normalizedAvatarId]
      );
      return { id, username: normalizedUsername, avatar_id: normalizedAvatarId };
    } catch (err) {
      console.error('Error in Postgres upsertUser:', err);
    }
  }

  // Fallback mode
  fallbackData.users[id] = {
    id,
    username: normalizedUsername,
    avatar_id: normalizedAvatarId,
    created_at: fallbackData.users[id]?.created_at || new Date().toISOString(),
  };
  saveFallbackData();
  return fallbackData.users[id];
}

/**
 * Register a newly started match and all participating players
 */
export async function createMatch(
  roomId: string,
  gameMode: string,
  players: Array<{ id: string; name: string; isHost: boolean; isAI: boolean; avatarId?: string }>
): Promise<string> {
  const matchId = `match_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;

  // First, upsert all players so their usernames and profiles are persistent
  for (const player of players) {
    await upsertUser(player.id, player.name, player.avatarId || 'av1');
  }

  if (!useFallback && pool) {
    try {
      await pool.query(
        `INSERT INTO sipa_matches (id, room_id, game_mode, status)
         VALUES ($1, $2, $3, 'playing')`,
        [matchId, roomId, gameMode]
      );

      for (const player of players) {
        await pool.query(
          `INSERT INTO sipa_match_players (match_id, player_id, score, is_host, is_ai)
           VALUES ($1, $2, 0, $3, $4)`,
          [matchId, player.id, player.isHost, player.isAI]
        );
      }
      return matchId;
    } catch (err) {
      console.error('Error in Postgres createMatch:', err);
    }
  }

  // Fallback mode
  fallbackData.matches[matchId] = {
    id: matchId,
    room_id: roomId,
    game_mode: gameMode,
    status: 'playing',
    winner_id: null,
    created_at: new Date().toISOString(),
    ended_at: null,
  };

  for (const player of players) {
    fallbackData.match_players.push({
      match_id: matchId,
      player_id: player.id,
      score: 0,
      is_host: player.isHost,
      is_ai: player.isAI,
    });
  }
  saveFallbackData();
  return matchId;
}

/**
 * Update the score values during rounds of play
 */
export async function updateMatchScores(
  matchId: string,
  scores: { [playerId: string]: number }
): Promise<boolean> {
  if (!useFallback && pool) {
    try {
      for (const [playerId, score] of Object.entries(scores)) {
        await pool.query(
          `UPDATE sipa_match_players 
           SET score = $1 
           WHERE match_id = $2 AND player_id = $3`,
          [score, matchId, playerId]
        );
      }
      return true;
    } catch (err) {
      console.error('Error in Postgres updateMatchScores:', err);
    }
  }

  // Fallback mode
  let updated = false;
  fallbackData.match_players = fallbackData.match_players.map((mp) => {
    if (mp.match_id === matchId && scores[mp.player_id] !== undefined) {
      updated = true;
      return { ...mp, score: scores[mp.player_id] };
    }
    return mp;
  });

  if (updated) {
    saveFallbackData();
  }
  return updated;
}

/**
 * Finalize a match with a declared winner
 */
export async function endMatch(matchId: string, winnerId: string | null): Promise<boolean> {
  if (!useFallback && pool) {
    try {
      await pool.query(
        `UPDATE sipa_matches 
         SET status = 'completed', winner_id = $1, ended_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [winnerId, matchId]
      );
      return true;
    } catch (err) {
      console.error('Error in Postgres endMatch:', err);
    }
  }

  // Fallback mode
  if (fallbackData.matches[matchId]) {
    fallbackData.matches[matchId].status = 'completed';
    fallbackData.matches[matchId].winner_id = winnerId;
    fallbackData.matches[matchId].ended_at = new Date().toISOString();
    saveFallbackData();
    return true;
  }
  return false;
}

/**
 * Retrieve comprehensive playing statistics for a user
 */
export async function getUserStats(playerId: string) {
  if (!useFallback && pool) {
    try {
      // Total matches played
      const totalRes = await pool.query(
        `SELECT COUNT(DISTINCT match_id) as count 
         FROM sipa_match_players 
         WHERE player_id = $1`,
        [playerId]
      );
      const totalMatches = parseInt(totalRes.rows[0]?.count || '0', 10);

      // Total wins
      const winsRes = await pool.query(
        `SELECT COUNT(*) as count 
         FROM sipa_matches 
         WHERE winner_id = $1 AND status = 'completed'`,
        [playerId]
      );
      const wins = parseInt(winsRes.rows[0]?.count || '0', 10);

      const losses = Math.max(0, totalMatches - wins);
      const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;

      return {
        totalMatches,
        wins,
        losses,
        winRate,
      };
    } catch (err) {
      console.error('Error in Postgres getUserStats:', err);
    }
  }

  // Fallback mode
  const userMatchIds = fallbackData.match_players
    .filter((mp) => mp.player_id === playerId)
    .map((mp) => mp.match_id);

  const uniqueMatchIds = Array.from(new Set(userMatchIds));
  const totalMatches = uniqueMatchIds.length;

  let wins = 0;
  for (const mId of uniqueMatchIds) {
    const match = fallbackData.matches[mId];
    if (match && match.winner_id === playerId && match.status === 'completed') {
      wins++;
    }
  }

  const losses = Math.max(0, totalMatches - wins);
  const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;

  return {
    totalMatches,
    wins,
    losses,
    winRate,
  };
}

/**
 * Retrieve a list of recent matches played by a player, including participants and final scores
 */
export async function getUserMatches(playerId: string) {
  if (!useFallback && pool) {
    try {
      // 1. Fetch matches the user participated in
      const matchesRes = await pool.query(
        `SELECT m.id, m.room_id, m.game_mode, m.status, m.winner_id, m.created_at, m.ended_at
         FROM sipa_matches m
         JOIN sipa_match_players mp ON m.id = mp.match_id
         WHERE mp.player_id = $1
         ORDER BY m.created_at DESC
         LIMIT 10`,
        [playerId]
      );

      const matches = [];

      for (const row of matchesRes.rows) {
        // Fetch all players for this match
        const playersRes = await pool.query(
          `SELECT mp.player_id, mp.score, mp.is_host, mp.is_ai, u.username, u.avatar_id
           FROM sipa_match_players mp
           LEFT JOIN sipa_users u ON mp.player_id = u.id
           WHERE mp.match_id = $1`,
          [row.id]
        );

        const players = playersRes.rows.map((p) => ({
          playerId: p.player_id,
          name: p.username || (p.is_ai ? p.player_id : 'Joueur'),
          score: p.score,
          isHost: p.is_host,
          isAI: p.is_ai,
          avatarId: p.avatar_id || 'av1',
        }));

        matches.push({
          matchId: row.id,
          roomId: row.room_id,
          gameMode: row.game_mode,
          status: row.status,
          winnerId: row.winner_id,
          createdAt: row.created_at,
          endedAt: row.ended_at,
          players,
        });
      }

      return matches;
    } catch (err) {
      console.error('Error in Postgres getUserMatches:', err);
    }
  }

  // Fallback mode
  const userMatchIds = fallbackData.match_players
    .filter((mp) => mp.player_id === playerId)
    .map((mp) => mp.match_id);

  // Filter unique and sort matches by creation date descending
  const uniqueMatchIds = Array.from(new Set(userMatchIds));
  const matchesList = uniqueMatchIds
    .map((mId) => fallbackData.matches[mId])
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
    .slice(0, 10);

  const result = [];
  for (const m of matchesList) {
    const playersForMatch = fallbackData.match_players
      .filter((mp) => mp.match_id === m.id)
      .map((mp) => {
        const user = fallbackData.users[mp.player_id];
        return {
          playerId: mp.player_id,
          name: user ? user.username : (mp.is_ai ? mp.player_id : 'Joueur'),
          score: mp.score,
          isHost: mp.is_host,
          isAI: mp.is_ai,
          avatarId: user ? user.avatar_id : 'av1',
        };
      });

    result.push({
      matchId: m.id,
      roomId: m.room_id,
      gameMode: m.game_mode,
      status: m.status,
      winnerId: m.winner_id,
      createdAt: m.created_at,
      endedAt: m.ended_at,
      players: playersForMatch,
    });
  }

  return result;
}
