// libSQL (Turso/SQLite) connection + schema. Works with file: URLs locally and
// libsql:// URLs in production.
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code             TEXT PRIMARY KEY,
  facilitator_id   TEXT NOT NULL,
  story_title      TEXT NOT NULL DEFAULT '',
  revealed         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  room_code  TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  vote       TEXT,
  connected  INTEGER NOT NULL DEFAULT 0,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (room_code, client_id)
);
CREATE TABLE IF NOT EXISTS estimates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code    TEXT NOT NULL,
  story_title  TEXT NOT NULL,
  final_value  TEXT NOT NULL,
  average      REAL,
  median       REAL,
  mode         TEXT,
  consensus    TEXT,
  votes_json   TEXT NOT NULL,
  voter_count  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_estimates_room ON estimates(room_code, created_at);
`;

export function createDb(config) {
  // For local file: URLs, make sure the parent directory exists.
  if (config.databaseUrl.startsWith('file:')) {
    const path = config.databaseUrl.slice('file:'.length);
    if (path && path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
  }
  return createClient({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken,
  });
}

export async function ensureSchema(db) {
  await db.executeMultiple(SCHEMA);
}
