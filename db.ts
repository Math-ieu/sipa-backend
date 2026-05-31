import 'dotenv/config';
import { Pool } from 'pg';
import sqlite3 from 'sqlite3';
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
const dbType = process.env.DB_TYPE || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sqlitePath = process.env.SQLITE_PATH || 'sipa.db';

let pool: Pool | null = null;
let sqliteDb: sqlite3.Database | null = null;

/**
 * Execute a query in SQLite returning a Promise compatible with PostgreSQL pg client response.
 */
function executeSql(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
  return new Promise((resolve, reject) => {
    if (!sqliteDb) {
      return reject(new Error('SQLite database is not initialized.'));
    }
    
    // Replace $1, $2, ... with ? for SQLite compatibility
    const translatedSql = sql.replace(/\$\d+/g, '?');
    
    // Convert boolean values to 1 or 0 for SQLite
    const convertedParams = params.map(p => typeof p === 'boolean' ? (p ? 1 : 0) : p);

    sqliteDb.all(translatedSql, convertedParams, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve({ rows });
      }
    });
  });
}

/**
 * Unified query wrapper executing queries on PostgreSQL or SQLite depending on the environment.
 */
async function dbQuery(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
  if (pool) {
    return await pool.query(sql, params);
  } else if (sqliteDb) {
    return await executeSql(sql, params);
  } else {
    throw new Error('No database connection initialized.');
  }
}

/**
 * Initialize Database connection and create tables
 */
export async function initDB(): Promise<boolean> {
  if (dbType === 'postgres' && connectionString) {
    try {
      console.log('Connecting to PostgreSQL database...');
      pool = new Pool({
        connectionString,
        ssl: {
          rejectUnauthorized: false, // Required for Railway/Neon/Vercel serverless postgres
        },
      });

      // Test connection
      await pool.query('SELECT NOW()');

      // Create Tables in PostgreSQL
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

      console.log('PostgreSQL database successfully initialized.');
      return true;
    } catch (err) {
      console.error('PostgreSQL connection or initialization failed:', err instanceof Error ? err.message : err);
      throw err;
    }
  } else {
    // SQLite Setup
    try {
      console.log(`Connecting to SQLite database (${sqlitePath})...`);
      const absolutePath = path.isAbsolute(sqlitePath) ? sqlitePath : path.join(process.cwd(), sqlitePath);
      
      // Ensure the directory exists
      const dir = path.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      sqliteDb = new sqlite3.Database(absolutePath);

      // Enable foreign keys in SQLite
      await executeSql('PRAGMA foreign_keys = ON');

      console.log('SQLite connected. Creating tables if not existing...');
      
      await executeSql(`
        CREATE TABLE IF NOT EXISTS sipa_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          avatar_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await executeSql(`
        CREATE TABLE IF NOT EXISTS sipa_matches (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          game_mode TEXT NOT NULL,
          status TEXT NOT NULL,
          winner_id TEXT REFERENCES sipa_users(id) ON DELETE SET NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          ended_at TEXT
        );
      `);

      await executeSql(`
        CREATE TABLE IF NOT EXISTS sipa_match_players (
          match_id TEXT REFERENCES sipa_matches(id) ON DELETE CASCADE,
          player_id TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 0,
          is_host INTEGER NOT NULL DEFAULT 0,
          is_ai INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (match_id, player_id)
        );
      `);

      console.log('SQLite database successfully initialized.');
      return true;
    } catch (err) {
      console.error('SQLite connection or initialization failed:', err instanceof Error ? err.message : err);
      throw err;
    }
  }
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

  try {
    await dbQuery(
      `INSERT INTO sipa_users (id, username, avatar_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) 
       DO UPDATE SET username = EXCLUDED.username, avatar_id = EXCLUDED.avatar_id`,
      [id, normalizedUsername, normalizedAvatarId]
    );
    return { id, username: normalizedUsername, avatar_id: normalizedAvatarId };
  } catch (err) {
    console.error('Error in upsertUser:', err);
    throw err;
  }
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

  try {
    await dbQuery(
      `INSERT INTO sipa_matches (id, room_id, game_mode, status)
       VALUES ($1, $2, $3, 'playing')`,
      [matchId, roomId, gameMode]
    );

    for (const player of players) {
      await dbQuery(
        `INSERT INTO sipa_match_players (match_id, player_id, score, is_host, is_ai)
         VALUES ($1, $2, 0, $3, $4)`,
        [matchId, player.id, player.isHost, player.isAI]
      );
    }
    return matchId;
  } catch (err) {
    console.error('Error in createMatch:', err);
    throw err;
  }
}

/**
 * Update the score values during rounds of play
 */
export async function updateMatchScores(
  matchId: string,
  scores: { [playerId: string]: number }
): Promise<boolean> {
  try {
    for (const [playerId, score] of Object.entries(scores)) {
      await dbQuery(
        `UPDATE sipa_match_players 
         SET score = $1 
         WHERE match_id = $2 AND player_id = $3`,
        [score, matchId, playerId]
      );
    }
    return true;
  } catch (err) {
    console.error('Error in updateMatchScores:', err);
    return false;
  }
}

/**
 * Finalize a match with a declared winner
 */
export async function endMatch(matchId: string, winnerId: string | null): Promise<boolean> {
  try {
    await dbQuery(
      `UPDATE sipa_matches 
       SET status = 'completed', winner_id = $1, ended_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [winnerId, matchId]
    );
    return true;
  } catch (err) {
    console.error('Error in endMatch:', err);
    return false;
  }
}

/**
 * Retrieve comprehensive playing statistics for a user
 */
export async function getUserStats(playerId: string) {
  try {
    // Total matches played
    const totalRes = await dbQuery(
      `SELECT COUNT(DISTINCT match_id) as count 
       FROM sipa_match_players 
       WHERE player_id = $1`,
      [playerId]
    );
    const totalMatches = parseInt(totalRes.rows[0]?.count || '0', 10);

    // Total wins
    const winsRes = await dbQuery(
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
    console.error('Error in getUserStats:', err);
    return {
      totalMatches: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
    };
  }
}

/**
 * Retrieve a list of recent matches played by a player, including participants and final scores
 */
export async function getUserMatches(playerId: string) {
  try {
    // 1. Fetch matches the user participated in
    const matchesRes = await dbQuery(
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
      const playersRes = await dbQuery(
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
        isHost: !!p.is_host, // Coerce numeric (0 or 1) and true/false to boolean
        isAI: !!p.is_ai,     // Coerce numeric (0 or 1) and true/false to boolean
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
    console.error('Error in getUserMatches:', err);
    return [];
  }
}
