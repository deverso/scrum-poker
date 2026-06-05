# Scrum Poker V2 — Persistência (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistence (Turso/libSQL) so live rooms survive server restart/sleep, final estimates are recorded to a long-term history, and participant identity persists — without breaking the V1 in-memory realtime hot path.

**Architecture:** Keep `server/rooms.js`/`server/stats.js` pure and in-memory (the realtime hot path). Wrap them with a persistence layer: every state mutation writes through to libSQL; on boot the server reloads non-expired rooms from the DB into memory. New modules: `config.js` (env), `db.js` (connection + schema), `repository.js` (SQL), `persistence.js` (orchestration + reload). The server becomes a `createServer(config)` factory so tests can spin up isolated instances against a temp DB.

**Tech Stack:** Node.js (ESM), Express, Socket.IO, `@libsql/client` (Turso/libSQL — same SQL as SQLite), Node's built-in test runner. Frontend stays vanilla JS.

**Spec:** `docs/superpowers/specs/2026-06-05-scrum-poker-v2-persistencia-design.md`

---

## File Structure

```
server/
├── config.js        # NEW — loadConfig(env): port, roomTtlMs, databaseUrl, databaseAuthToken
├── db.js            # NEW — createDb(config) (libSQL client) + ensureSchema(db)
├── repository.js    # NEW — pure-ish async SQL CRUD (takes db); no sockets
├── persistence.js   # NEW — parseVote + write-through helpers + reloadRooms(db, store, ttlMs, now)
├── rooms.js         # MODIFY — makeRoom gains history:[]; serializeRoom includes history; add voteSnapshot()
├── stats.js         # unchanged
└── index.js         # MODIFY — createServer(config) factory: db init, boot reload, write-through,
                     #          saveEstimate handler, GET estimates endpoint, TTL sweep
public/
├── room.html        # MODIFY — final-value selector + save button + history sidebar containers
├── app.js           # MODIFY — render final-value selector, emit saveEstimate, render history sidebar
├── history.html     # NEW — read-only history-by-code page
├── history.js       # NEW — fetch estimates by code, render, CSV export
├── styles.css       # MODIFY — sidebar + final-value selector styles
└── (index.html/home.js unchanged)
test/
├── stats.test.js        # unchanged
├── rooms.test.js        # MODIFY — makeRoom now has history:[]; add voteSnapshot tests
├── repository.test.js   # NEW
├── persistence.test.js  # NEW
└── integration.test.js  # MODIFY — use createServer(config) + temp DB; add restart + saveEstimate tests
package.json         # MODIFY — add @libsql/client; start script uses --env-file-if-exists
render.yaml          # MODIFY — add DATABASE_URL / DATABASE_AUTH_TOKEN env vars
README.md            # MODIFY — Turso setup + env docs
.gitignore           # MODIFY — add data/ (already edited locally; commit it)
```

**Key data shapes (locked for consistency across tasks):**

- In-memory room (from `makeRoom`): `{ code, facilitatorId, storyTitle, revealed, deck, participants:Map<clientId,{name,vote,connected}>, history:[], lastActivityAt? }`.
- `roomState` (serializeRoom) adds: `history: [{ id, storyTitle, finalValue, consensus, createdAt }]` (summaries, newest first).
- Full estimate (from repository / GET endpoint): `{ id, storyTitle, finalValue, average, median, mode, consensus, votes:[{name,vote}], voterCount, createdAt }`.
- Vote stored as TEXT; `parseVote(text)`: `Number(text)` unless `NaN` (then keep string), `null` stays `null`.

---

## Task 1: Dependencies + config module

**Files:**
- Modify: `package.json`
- Create: `server/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Install @libsql/client**

Run: `npm install --strict-ssl=false @libsql/client`
Expected: added to `dependencies`; `node_modules/@libsql/client` present; no errors.
(Note: this environment requires `--strict-ssl=false` for npm installs due to a self-signed cert in the network chain.)

- [ ] **Step 2: Update `package.json` start script to load `.env` locally**

Change the `"start"` script so it loads `.env` if present (no-op in production where real env vars are set). Edit the `scripts` block to:

```json
  "scripts": {
    "start": "node --env-file-if-exists=.env server/index.js",
    "test": "node --test"
  },
```

(Node 22+/24 supports `--env-file-if-exists`. Tests do NOT rely on `.env` — they pass explicit config.)

- [ ] **Step 3: Write the failing test** — Create `test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('loadConfig applies defaults when env is empty', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.roomTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(c.databaseUrl, 'file:./data/scrum.db');
  assert.equal(c.databaseAuthToken, undefined);
});

test('loadConfig reads values from env', () => {
  const c = loadConfig({
    PORT: '8080',
    ROOM_TTL_HOURS: '48',
    DATABASE_URL: 'libsql://x.turso.io',
    DATABASE_AUTH_TOKEN: 'tok',
  });
  assert.equal(c.port, 8080);
  assert.equal(c.roomTtlMs, 48 * 60 * 60 * 1000);
  assert.equal(c.databaseUrl, 'libsql://x.turso.io');
  assert.equal(c.databaseAuthToken, 'tok');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL — `loadConfig` not exported.

- [ ] **Step 5: Implement `server/config.js`**

```js
// Central config derived from environment, with dev-friendly defaults.
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    roomTtlMs: (Number(env.ROOM_TTL_HOURS) || 24) * 60 * 60 * 1000,
    databaseUrl: env.DATABASE_URL || 'file:./data/scrum.db',
    databaseAuthToken: env.DATABASE_AUTH_TOKEN || undefined,
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server/config.js test/config.test.js
git commit -m "feat: add @libsql/client and config module"
```

---

## Task 2: Database connection + schema (`db.js`)

**Files:**
- Create: `server/db.js`
- Test: `test/db.test.js`

- [ ] **Step 1: Write the failing test** — Create `test/db.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDb, ensureSchema } from '../server/db.js';

function tempUrl() {
  return `file:${tmpdir()}/scrum-test-${randomUUID()}.db`;
}

test('ensureSchema creates the rooms, participants and estimates tables', async () => {
  const db = createDb({ databaseUrl: tempUrl() });
  await ensureSchema(db);
  const res = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  const tables = res.rows.map((r) => r.name);
  assert.ok(tables.includes('rooms'));
  assert.ok(tables.includes('participants'));
  assert.ok(tables.includes('estimates'));
});

test('ensureSchema is idempotent (safe to run twice)', async () => {
  const db = createDb({ databaseUrl: tempUrl() });
  await ensureSchema(db);
  await ensureSchema(db); // must not throw
  const res = await db.execute("SELECT count(*) AS n FROM rooms");
  assert.equal(Number(res.rows[0].n), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — `createDb`/`ensureSchema` not exported.

- [ ] **Step 3: Implement `server/db.js`**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/db.js test/db.test.js
git commit -m "feat: libSQL connection and schema bootstrap"
```

---

## Task 3: Repository (SQL CRUD) — TDD

**Files:**
- Create: `server/repository.js`
- Test: `test/repository.test.js`

- [ ] **Step 1: Write the failing tests** — Create `test/repository.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDb, ensureSchema } from '../server/db.js';
import * as repo from '../server/repository.js';

async function freshDb() {
  const db = createDb({ databaseUrl: `file:${tmpdir()}/scrum-test-${randomUUID()}.db` });
  await ensureSchema(db);
  return db;
}

const T0 = 1_000_000;

test('upsertRoom inserts then updates without losing created_at', async () => {
  const db = await freshDb();
  await repo.upsertRoom(db, { code: 'R', facilitatorId: 'A', storyTitle: '', revealed: false }, T0);
  await repo.upsertRoom(db, { code: 'R', facilitatorId: 'A', storyTitle: 'Login', revealed: true }, T0 + 50);
  const row = (await db.execute({ sql: 'SELECT * FROM rooms WHERE code=?', args: ['R'] })).rows[0];
  assert.equal(row.story_title, 'Login');
  assert.equal(Number(row.revealed), 1);
  assert.equal(Number(row.created_at), T0);          // preserved
  assert.equal(Number(row.last_activity_at), T0 + 50);
});

test('upsertParticipant inserts then updates vote/connected', async () => {
  const db = await freshDb();
  await repo.upsertRoom(db, { code: 'R', facilitatorId: 'A', storyTitle: '', revealed: false }, T0);
  await repo.upsertParticipant(db, 'R', 'A', { name: 'Ana', vote: null, connected: true }, T0);
  await repo.upsertParticipant(db, 'R', 'A', { name: 'Ana', vote: 5, connected: true }, T0);
  const row = (await db.execute({ sql: 'SELECT * FROM participants WHERE room_code=? AND client_id=?', args: ['R', 'A'] })).rows[0];
  assert.equal(row.name, 'Ana');
  assert.equal(row.vote, '5');       // stored as TEXT
  assert.equal(Number(row.connected), 1);
});

test('deleteRoom removes the room and its participants', async () => {
  const db = await freshDb();
  await repo.upsertRoom(db, { code: 'R', facilitatorId: 'A', storyTitle: '', revealed: false }, T0);
  await repo.upsertParticipant(db, 'R', 'A', { name: 'Ana', vote: 5, connected: true }, T0);
  await repo.deleteRoom(db, 'R');
  assert.equal((await db.execute({ sql: 'SELECT * FROM rooms WHERE code=?', args: ['R'] })).rows.length, 0);
  assert.equal((await db.execute({ sql: 'SELECT * FROM participants WHERE room_code=?', args: ['R'] })).rows.length, 0);
});

test('loadActiveRooms returns rooms within ttl with their participants', async () => {
  const db = await freshDb();
  await repo.upsertRoom(db, { code: 'FRESH', facilitatorId: 'A', storyTitle: 's', revealed: false }, T0);
  await repo.upsertParticipant(db, 'FRESH', 'A', { name: 'Ana', vote: 8, connected: true }, T0);
  await repo.upsertRoom(db, { code: 'OLD', facilitatorId: 'B', storyTitle: '', revealed: false }, T0 - 10_000);
  const ttlMs = 5_000;
  const active = await repo.loadActiveRooms(db, ttlMs, T0); // cutoff = T0 - 5000
  const codes = active.map((a) => a.room.code);
  assert.deepEqual(codes, ['FRESH']);
  assert.equal(active[0].participants.length, 1);
  assert.equal(active[0].participants[0].vote, '8');
});

test('deleteExpiredRooms removes only rooms older than ttl', async () => {
  const db = await freshDb();
  await repo.upsertRoom(db, { code: 'FRESH', facilitatorId: 'A', storyTitle: '', revealed: false }, T0);
  await repo.upsertRoom(db, { code: 'OLD', facilitatorId: 'B', storyTitle: '', revealed: false }, T0 - 10_000);
  const removed = await repo.deleteExpiredRooms(db, 5_000, T0);
  assert.deepEqual(removed, ['OLD']);
  const remaining = (await db.execute('SELECT code FROM rooms')).rows.map((r) => r.code);
  assert.deepEqual(remaining, ['FRESH']); // only the fresh room survives
});

test('insertEstimate stores a snapshot and getEstimatesByCode returns it newest-first', async () => {
  const db = await freshDb();
  const id1 = await repo.insertEstimate(db, {
    roomCode: 'R', storyTitle: 'Login', finalValue: 5,
    average: 6.5, median: 6.5, mode: 5, consensus: 'close',
    votes: [{ name: 'Ana', vote: 5 }, { name: 'Bruno', vote: 8 }], voterCount: 2,
  }, T0);
  const id2 = await repo.insertEstimate(db, {
    roomCode: 'R', storyTitle: 'Logout', finalValue: 3,
    average: 3, median: 3, mode: 3, consensus: 'consensus',
    votes: [{ name: 'Ana', vote: 3 }], voterCount: 1,
  }, T0 + 100);
  assert.ok(id1 > 0 && id2 > id1);
  const list = await repo.getEstimatesByCode(db, 'R');
  assert.equal(list.length, 2);
  assert.equal(list[0].storyTitle, 'Logout'); // newest first
  assert.equal(list[0].finalValue, '3');
  assert.deepEqual(list[1].votes, [{ name: 'Ana', vote: 5 }, { name: 'Bruno', vote: 8 }]);
  assert.equal(list[1].voterCount, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/repository.test.js`
Expected: FAIL — `repository.js` exports missing.

- [ ] **Step 3: Implement `server/repository.js`**

```js
// Async SQL CRUD over libSQL. No sockets, no Express. All functions take the db client.

export async function upsertRoom(db, room, now) {
  await db.execute({
    sql: `INSERT INTO rooms (code, facilitator_id, story_title, revealed, created_at, last_activity_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET
            facilitator_id = excluded.facilitator_id,
            story_title    = excluded.story_title,
            revealed       = excluded.revealed,
            last_activity_at = excluded.last_activity_at`,
    args: [room.code, room.facilitatorId, room.storyTitle, room.revealed ? 1 : 0, now, now],
  });
}

export async function upsertParticipant(db, roomCode, clientId, p, now) {
  const vote = p.vote === null || p.vote === undefined ? null : String(p.vote);
  await db.execute({
    sql: `INSERT INTO participants (room_code, client_id, name, vote, connected, joined_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(room_code, client_id) DO UPDATE SET
            name = excluded.name,
            vote = excluded.vote,
            connected = excluded.connected`,
    args: [roomCode, clientId, p.name, vote, p.connected ? 1 : 0, now],
  });
}

export async function deleteRoom(db, code) {
  await db.batch([
    { sql: 'DELETE FROM participants WHERE room_code = ?', args: [code] },
    { sql: 'DELETE FROM rooms WHERE code = ?', args: [code] },
  ], 'write');
}

export async function loadActiveRooms(db, ttlMs, now) {
  const cutoff = now - ttlMs;
  const rooms = (await db.execute({
    sql: 'SELECT * FROM rooms WHERE last_activity_at >= ? ORDER BY created_at',
    args: [cutoff],
  })).rows;
  const result = [];
  for (const room of rooms) {
    const participants = (await db.execute({
      sql: 'SELECT * FROM participants WHERE room_code = ? ORDER BY joined_at',
      args: [room.code],
    })).rows;
    result.push({ room, participants });
  }
  return result;
}

export async function deleteExpiredRooms(db, ttlMs, now) {
  const cutoff = now - ttlMs;
  const expired = (await db.execute({
    sql: 'SELECT code FROM rooms WHERE last_activity_at < ?',
    args: [cutoff],
  })).rows.map((r) => r.code);
  for (const code of expired) await deleteRoom(db, code);
  return expired;
}

export async function insertEstimate(db, est, now) {
  const res = await db.execute({
    sql: `INSERT INTO estimates
            (room_code, story_title, final_value, average, median, mode, consensus, votes_json, voter_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      est.roomCode,
      est.storyTitle,
      String(est.finalValue),
      est.average ?? null,
      est.median ?? null,
      est.mode === undefined || est.mode === null ? null : String(est.mode),
      est.consensus ?? null,
      JSON.stringify(est.votes ?? []),
      est.voterCount,
      now,
    ],
  });
  return Number(res.lastInsertRowid);
}

export async function getEstimatesByCode(db, code) {
  const rows = (await db.execute({
    sql: 'SELECT * FROM estimates WHERE room_code = ? ORDER BY created_at DESC, id DESC',
    args: [code],
  })).rows;
  return rows.map((r) => ({
    id: Number(r.id),
    storyTitle: r.story_title,
    finalValue: r.final_value,
    average: r.average,
    median: r.median,
    mode: r.mode,
    consensus: r.consensus,
    votes: JSON.parse(r.votes_json),
    voterCount: Number(r.voter_count),
    createdAt: Number(r.created_at),
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/repository.test.js`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add server/repository.js test/repository.test.js
git commit -m "feat: libSQL repository (rooms, participants, estimates CRUD)"
```

---

## Task 4: `rooms.js` — history field, serialize history, voteSnapshot

**Files:**
- Modify: `server/rooms.js`
- Modify: `test/rooms.test.js`

- [ ] **Step 1: Update the `makeRoom` test and add `voteSnapshot` tests** in `test/rooms.test.js`.

Find the existing test `'makeRoom creates an empty unrevealed room with the facilitator set'` and add one assertion line after the `participants.size` check:

```js
  assert.deepEqual(room.history, []);
```

Add `voteSnapshot` to the import list at the top of the file (it currently imports from `../server/rooms.js`), and append these tests at the end of the file:

```js
test('voteSnapshot returns only participants who voted, with name and vote', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  addParticipant(room, 'p-3', 'Carla');
  setVote(room, 'fac-1', 5);
  setVote(room, 'p-2', 8);
  // Carla did not vote
  const snap = voteSnapshot(room);
  assert.deepEqual(snap, [
    { name: 'Ana', vote: 5 },
    { name: 'Bruno', vote: 8 },
  ]);
});

test('serializeRoom includes the history array', () => {
  const room = makeRoom('R', 'fac-1');
  room.history = [{ id: 1, storyTitle: 'Login', finalValue: '5', consensus: 'close', createdAt: 10 }];
  const view = serializeRoom(room, 'fac-1');
  assert.deepEqual(view.history, [{ id: 1, storyTitle: 'Login', finalValue: '5', consensus: 'close', createdAt: 10 }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rooms.test.js`
Expected: FAIL — `voteSnapshot` not exported; `room.history` undefined; `view.history` undefined.

- [ ] **Step 3: Modify `server/rooms.js`**

In `makeRoom`, add `history: []` to the returned object (after `participants`):

```js
export function makeRoom(code, facilitatorId) {
  return {
    code,
    facilitatorId,
    storyTitle: '',
    revealed: false,
    deck: DECK,
    participants: new Map(), // clientId -> { name, vote, connected }
    history: [], // [{ id, storyTitle, finalValue, consensus, createdAt }] — newest first
  };
}
```

Add the `voteSnapshot` export (place it just after `hasConnectedParticipants`):

```js
// Snapshot of who voted (name + vote), used when saving an estimate to history.
export function voteSnapshot(room) {
  return [...room.participants.values()]
    .filter((p) => p.vote !== null)
    .map((p) => ({ name: p.name, vote: p.vote }));
}
```

In `serializeRoom`, add `history` to the returned object (after `consensus`):

```js
  return {
    code: room.code,
    storyTitle: room.storyTitle,
    revealed: room.revealed,
    deck: room.deck,
    facilitatorId: room.facilitatorId,
    participants,
    stats: room.revealed ? computeStats(votes) : null,
    consensus: room.revealed ? consensusLevel(votes, room.deck) : null,
    history: room.history ?? [],
  };
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS — existing rooms/stats/config/db/repository tests plus the new rooms assertions.

- [ ] **Step 5: Commit**

```bash
git add server/rooms.js test/rooms.test.js
git commit -m "feat: room history field and voteSnapshot helper"
```

---

## Task 5: `persistence.js` — parseVote, write-through, reloadRooms (TDD)

**Files:**
- Create: `server/persistence.js`
- Test: `test/persistence.test.js`

- [ ] **Step 1: Write the failing tests** — Create `test/persistence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDb, ensureSchema } from '../server/db.js';
import { createRoomStore, makeRoom, addParticipant, setVote } from '../server/rooms.js';
import { parseVote, persistRoomMeta, persistParticipant, persistFullRoom, reloadRooms } from '../server/persistence.js';

async function freshDb() {
  const db = createDb({ databaseUrl: `file:${tmpdir()}/scrum-test-${randomUUID()}.db` });
  await ensureSchema(db);
  return db;
}

const T0 = 2_000_000;

test('parseVote converts numeric text to number and keeps special cards', () => {
  assert.equal(parseVote('5'), 5);
  assert.equal(parseVote('13'), 13);
  assert.equal(parseVote('?'), '?');
  assert.equal(parseVote('☕'), '☕');
  assert.equal(parseVote(null), null);
});

test('persistFullRoom + reloadRooms reconstructs the room with votes, connected=false', async () => {
  const db = await freshDb();
  const room = makeRoom('R', 'A');
  room.storyTitle = 'Login';
  addParticipant(room, 'A', 'Ana');
  addParticipant(room, 'B', 'Bruno');
  setVote(room, 'A', 5);
  setVote(room, 'B', '?');
  await persistFullRoom(db, room, T0);

  const store = createRoomStore();
  await reloadRooms(db, store, 60_000, T0 + 1000);
  const loaded = store.getRoom('R');
  assert.ok(loaded);
  assert.equal(loaded.storyTitle, 'Login');
  assert.equal(loaded.facilitatorId, 'A');
  const ana = loaded.participants.get('A');
  const bruno = loaded.participants.get('B');
  assert.equal(ana.vote, 5);      // numeric restored
  assert.equal(bruno.vote, '?');  // special preserved
  assert.equal(ana.connected, false); // reset on reload
  assert.deepEqual(loaded.history, []);
});

test('reloadRooms skips rooms older than ttl', async () => {
  const db = await freshDb();
  const room = makeRoom('OLD', 'A');
  addParticipant(room, 'A', 'Ana');
  await persistFullRoom(db, room, T0 - 10_000);
  const store = createRoomStore();
  await reloadRooms(db, store, 5_000, T0);
  assert.equal(store.getRoom('OLD'), undefined);
});

test('persistParticipant writes a single participant and touches the room', async () => {
  const db = await freshDb();
  const room = makeRoom('R', 'A');
  addParticipant(room, 'A', 'Ana');
  await persistFullRoom(db, room, T0);
  setVote(room, 'A', 8);
  await persistParticipant(db, room, 'A', T0 + 500);
  const store = createRoomStore();
  await reloadRooms(db, store, 60_000, T0 + 600);
  assert.equal(store.getRoom('R').participants.get('A').vote, 8);
});

test('persistRoomMeta updates room fields without participants', async () => {
  const db = await freshDb();
  const room = makeRoom('R', 'A');
  addParticipant(room, 'A', 'Ana');
  await persistFullRoom(db, room, T0);
  room.revealed = true;
  room.storyTitle = 'Edited';
  await persistRoomMeta(db, room, T0 + 10);
  const store = createRoomStore();
  await reloadRooms(db, store, 60_000, T0 + 20);
  const loaded = store.getRoom('R');
  assert.equal(loaded.revealed, true);
  assert.equal(loaded.storyTitle, 'Edited');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/persistence.test.js`
Expected: FAIL — `persistence.js` exports missing.

- [ ] **Step 3: Implement `server/persistence.js`**

```js
// Orchestrates write-through from the in-memory room model to the repository,
// and rebuilds the in-memory store from the DB on boot.
import * as repo from './repository.js';
import { makeRoom } from './rooms.js';

// Vote is stored as TEXT. Restore numbers; keep special cards ('?'/'☕') as strings.
export function parseVote(text) {
  if (text === null || text === undefined) return null;
  const n = Number(text);
  return Number.isNaN(n) ? text : n;
}

// Room metadata only (story, revealed, facilitator, activity).
export async function persistRoomMeta(db, room, now) {
  room.lastActivityAt = now;
  await repo.upsertRoom(db, room, now);
}

// One participant + room activity touch.
export async function persistParticipant(db, room, clientId, now) {
  room.lastActivityAt = now;
  const p = room.participants.get(clientId);
  await repo.upsertRoom(db, room, now);
  if (p) await repo.upsertParticipant(db, room.code, clientId, p, now);
}

// Whole room: meta + every participant (used on join and newRound).
export async function persistFullRoom(db, room, now) {
  room.lastActivityAt = now;
  await repo.upsertRoom(db, room, now);
  for (const [clientId, p] of room.participants) {
    await repo.upsertParticipant(db, room.code, clientId, p, now);
  }
}

function toHistorySummary(est) {
  return {
    id: est.id,
    storyTitle: est.storyTitle,
    finalValue: est.finalValue,
    consensus: est.consensus,
    createdAt: est.createdAt,
  };
}

// Rebuild active (non-expired) rooms into the in-memory store on boot.
export async function reloadRooms(db, store, ttlMs, now) {
  const active = await repo.loadActiveRooms(db, ttlMs, now);
  for (const { room: r, participants } of active) {
    const room = makeRoom(r.code, r.facilitator_id);
    room.storyTitle = r.story_title;
    room.revealed = !!r.revealed;
    room.lastActivityAt = Number(r.last_activity_at);
    for (const p of participants) {
      room.participants.set(p.client_id, {
        name: p.name,
        vote: parseVote(p.vote),
        connected: false, // sockets are gone after a restart; they reconnect
      });
    }
    const estimates = await repo.getEstimatesByCode(db, r.code);
    room.history = estimates.map(toHistorySummary);
    store.rooms.set(room.code, room);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/persistence.test.js`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add server/persistence.js test/persistence.test.js
git commit -m "feat: persistence orchestration and boot reload"
```

---

## Task 6: `index.js` — createServer factory, config, boot reload, write-through, TTL sweep

**Files:**
- Modify: `server/index.js`
- Modify: `test/integration.test.js` (adapt to the factory + temp DB)

This converts the module-singleton server into an async `createServer(config)` factory. The factory initializes the DB, reloads rooms, wires all handlers with write-through, and runs the TTL sweep. Direct execution (`npm start`) calls the factory and listens.

- [ ] **Step 1: Replace `server/index.js` with the factory version**

```js
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { loadConfig } from './config.js';
import { createDb, ensureSchema } from './db.js';
import * as repo from './repository.js';
import {
  persistRoomMeta,
  persistParticipant,
  persistFullRoom,
  reloadRooms,
} from './persistence.js';
import { computeStats, consensusLevel } from './stats.js';
import {
  createRoomStore,
  addParticipant,
  setVote,
  reveal,
  newRound,
  setStory,
  disconnectParticipant,
  serializeRoom,
  voteSnapshot,
} from './rooms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createServer(config) {
  const db = createDb(config);
  await ensureSchema(db);

  const store = createRoomStore();
  await reloadRooms(db, store, config.roomTtlMs, Date.now());

  const app = express();
  app.use(express.static(join(__dirname, '..', 'public')));

  const httpServer = createHttpServer(app);
  const io = new Server(httpServer);

  // Create a room (REST) and persist it before any socket joins.
  app.post('/api/rooms', express.json(), async (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    const room = store.createRoom(clientId);
    await persistRoomMeta(db, room, Date.now());
    res.json({ code: room.code });
  });

  // Read the full history for a code (works even after the live room expired).
  app.get('/api/rooms/:code/estimates', async (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    const estimates = await repo.getEstimatesByCode(db, code);
    res.json({ code, estimates });
  });

  const sessions = new Map(); // socket.id -> { code, clientId }

  function broadcastRoom(code) {
    const room = store.getRoom(code);
    if (!room) return;
    for (const [socketId, sess] of sessions) {
      if (sess.code !== code) continue;
      io.to(socketId).emit('roomState', serializeRoom(room, sess.clientId));
    }
  }

  io.on('connection', (socket) => {
    socket.on('joinRoom', async ({ code, name, clientId }) => {
      const room = store.getRoom(code);
      if (!room) {
        socket.emit('errorMessage', { message: 'Sala não encontrada.' });
        return;
      }
      const cleanClientId = String(clientId || '').trim().slice(0, 64);
      if (!cleanClientId) {
        socket.emit('errorMessage', { message: 'Identificador inválido.' });
        return;
      }
      const cleanName = String(name || 'Anônimo').slice(0, 40);
      addParticipant(room, cleanClientId, cleanName);
      sessions.set(socket.id, { code, clientId: cleanClientId });
      socket.join(code);
      broadcastRoom(code);
      await persistFullRoom(db, room, Date.now());
    });

    socket.on('vote', async ({ value }) => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      setVote(room, sess.clientId, value);
      broadcastRoom(sess.code);
      await persistParticipant(db, room, sess.clientId, Date.now());
    });

    socket.on('reveal', async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      reveal(room, sess.clientId);
      broadcastRoom(sess.code);
      await persistRoomMeta(db, room, Date.now());
    });

    socket.on('newRound', async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      newRound(room, sess.clientId);
      broadcastRoom(sess.code);
      await persistFullRoom(db, room, Date.now());
    });

    socket.on('setStory', async ({ title }) => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      setStory(room, sess.clientId, title);
      broadcastRoom(sess.code);
      await persistRoomMeta(db, room, Date.now());
    });

    socket.on('saveEstimate', async ({ finalValue }) => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      if (sess.clientId !== room.facilitatorId) return; // facilitator only
      if (!room.revealed) return;                        // only after reveal
      if (!room.deck.includes(finalValue)) return;       // must be a deck card

      const snapshot = voteSnapshot(room);
      const numericVotes = snapshot.map((s) => s.vote);
      const stats = computeStats(numericVotes);
      const now = Date.now();
      const est = {
        roomCode: room.code,
        storyTitle: room.storyTitle,
        finalValue,
        average: stats ? stats.average : null,
        median: stats ? stats.median : null,
        mode: stats ? stats.mode : null,
        consensus: consensusLevel(numericVotes, room.deck),
        votes: snapshot,
        voterCount: snapshot.length,
      };
      const id = await repo.insertEstimate(db, est, now);
      room.history.unshift({
        id,
        storyTitle: est.storyTitle,
        finalValue,
        consensus: est.consensus,
        createdAt: now,
      });
      await persistRoomMeta(db, room, now); // touch activity
      broadcastRoom(sess.code);
    });

    socket.on('disconnect', async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      sessions.delete(socket.id);
      const room = store.getRoom(sess.code);
      if (!room) return;
      disconnectParticipant(room, sess.clientId);
      broadcastRoom(sess.code);
      await persistParticipant(db, room, sess.clientId, Date.now());
    });
  });

  // Periodically expire rooms inactive beyond the TTL (memory + DB).
  const sweep = setInterval(async () => {
    const removed = await repo.deleteExpiredRooms(db, config.roomTtlMs, Date.now());
    for (const code of removed) store.rooms.delete(code);
  }, 60 * 1000);
  sweep.unref();

  return { httpServer, app, store, db };
}

// Run directly (npm start) — not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const { httpServer } = await createServer(config);
  httpServer.listen(config.port, () => {
    console.log(`Scrum Poker rodando em http://localhost:${config.port}`);
  });
}
```

- [ ] **Step 2: Adapt `test/integration.test.js` to the factory + temp DB**

The V1 test imported `{ httpServer }` and called `httpServer.listen(0)`. Replace its setup so it builds a server via `createServer` against a temp file DB. At the top of the file, change the import and `before`/`after` helpers:

Replace the existing import of the server with:

```js
import { createServer } from '../server/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
```

Replace the server-startup helper (the part that does `httpServer.listen(0)` and reads the port) so it uses:

```js
let server;
async function startServer() {
  const config = {
    port: 0,
    roomTtlMs: 24 * 60 * 60 * 1000,
    databaseUrl: `file:${tmpdir()}/scrum-int-${randomUUID()}.db`,
    databaseAuthToken: undefined,
  };
  server = await createServer(config);
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  return { port: server.httpServer.address().port, config };
}
```

Ensure the existing teardown closes `server.httpServer` (and any sockets) in `after()`. Keep all six existing V1 test cases; they should pass unchanged against the new server (the DB just persists in the background).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — config/db/repository/persistence/rooms/stats unit tests plus the adapted V1 integration tests.

- [ ] **Step 4: Smoke-test the server boots with a real file DB**

Start in background (Bash tool `run_in_background: true`):
Run: `node --env-file-if-exists=.env server/index.js`
Then:
Run: `curl -s --retry 5 --retry-connrefused --retry-delay 1 -X POST http://localhost:3000/api/rooms -H 'Content-Type: application/json' -d '{"clientId":"abc"}'`
Expected: `{"code":"PLAY-XXXX"}`. Then `curl -s http://localhost:3000/api/rooms/PLAY-XXXX/estimates` (use the returned code) → `{"code":"PLAY-XXXX","estimates":[]}`.
Then stop the server: `pkill -f "server/index.js"`. Confirm `data/scrum.db` was created.

- [ ] **Step 5: Commit**

```bash
git add server/index.js test/integration.test.js
git commit -m "feat: persistent server (factory, boot reload, write-through, save estimate, TTL sweep)"
```

---

## Task 7: Integration test — restart persistence + saveEstimate/history

**Files:**
- Modify: `test/integration.test.js`

- [ ] **Step 1: Add restart + history tests** at the end of `test/integration.test.js`.

These use the same temp-DB config TWICE (two `createServer` calls sharing one `databaseUrl`) to simulate a restart. Reuse the `socket.io-client` connect helper and `waitForRoomState` helper already in the file. Add:

```js
test('room state and history survive a server restart', async () => {
  const config = {
    port: 0,
    roomTtlMs: 24 * 60 * 60 * 1000,
    databaseUrl: `file:${tmpdir()}/scrum-restart-${randomUUID()}.db`,
    databaseAuthToken: undefined,
  };

  // --- First server instance ---
  const s1 = await createServer(config);
  await new Promise((r) => s1.httpServer.listen(0, r));
  const port1 = s1.httpServer.address().port;

  // create room (clientId A = facilitator)
  const created = await fetch(`http://localhost:${port1}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'A' }),
  }).then((r) => r.json());
  const code = created.code;

  const a1 = ioClient(`http://localhost:${port1}`, { forceNew: true, transports: ['websocket'] });
  const b1 = ioClient(`http://localhost:${port1}`, { forceNew: true, transports: ['websocket'] });
  a1.emit('joinRoom', { code, name: 'Ana', clientId: 'A' });
  b1.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
  await waitForRoomState(a1, (s) => s.participants.length === 2);
  a1.emit('vote', { value: 5 });
  b1.emit('vote', { value: 8 });
  await waitForRoomState(a1, (s) => s.participants.find((p) => p.clientId === 'B')?.hasVoted);
  a1.emit('reveal');
  await waitForRoomState(a1, (s) => s.revealed === true);
  a1.emit('saveEstimate', { finalValue: 5 });
  await waitForRoomState(a1, (s) => s.history.length === 1);

  a1.close();
  b1.close();
  await new Promise((r) => s1.httpServer.close(r));

  // --- Second server instance, same DB file (simulated restart) ---
  const s2 = await createServer(config);
  await new Promise((r) => s2.httpServer.listen(0, r));
  const port2 = s2.httpServer.address().port;

  // Ana reconnects with the same clientId
  const a2 = ioClient(`http://localhost:${port2}`, { forceNew: true, transports: ['websocket'] });
  a2.emit('joinRoom', { code, name: 'Ana', clientId: 'A' });
  const state = await waitForRoomState(a2, (s) => s.code === code);

  // Votes preserved across restart
  assert.equal(state.participants.find((p) => p.clientId === 'A').vote, 5);
  // History preserved
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].finalValue, '5');

  // History endpoint returns the full snapshot by code
  const hist = await fetch(`http://localhost:${port2}/api/rooms/${code}/estimates`).then((r) => r.json());
  assert.equal(hist.estimates.length, 1);
  assert.equal(hist.estimates[0].storyTitle, '');
  assert.equal(hist.estimates[0].voterCount, 2);
  assert.deepEqual(hist.estimates[0].votes, [{ name: 'Ana', vote: 5 }, { name: 'Bruno', vote: 8 }]);

  a2.close();
  await new Promise((r) => s2.httpServer.close(r));
});

test('non-facilitator cannot save an estimate', async () => {
  const config = {
    port: 0,
    roomTtlMs: 24 * 60 * 60 * 1000,
    databaseUrl: `file:${tmpdir()}/scrum-nf-${randomUUID()}.db`,
    databaseAuthToken: undefined,
  };
  const s = await createServer(config);
  await new Promise((r) => s.httpServer.listen(0, r));
  const port = s.httpServer.address().port;
  const code = (await fetch(`http://localhost:${port}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'A' }),
  }).then((r) => r.json())).code;

  const a = ioClient(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
  const b = ioClient(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
  a.emit('joinRoom', { code, name: 'Ana', clientId: 'A' });
  b.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
  await waitForRoomState(a, (s) => s.participants.length === 2);
  a.emit('vote', { value: 5 });
  a.emit('reveal');
  await waitForRoomState(a, (s) => s.revealed === true);
  b.emit('saveEstimate', { finalValue: 5 }); // B is not facilitator

  // Give it a moment; history must stay empty
  await new Promise((r) => setTimeout(r, 300));
  const hist = await fetch(`http://localhost:${port}/api/rooms/${code}/estimates`).then((r) => r.json());
  assert.equal(hist.estimates.length, 0);

  a.close(); b.close();
  await new Promise((r) => s.httpServer.close(r));
});
```

Note: this assumes the file already imports the socket.io-client connect function (named `ioClient` here — match whatever the existing helper is called; if the existing helper has a different name, use that name instead) and `waitForRoomState`, `tmpdir`, `randomUUID`, `createServer`. If `ioClient` is not the existing name, alias the import: `import { io as ioClient } from 'socket.io-client';`.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — all prior tests plus the two new integration tests.

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.js
git commit -m "test: restart persistence and saveEstimate authorization"
```

---

## Task 8: Frontend — final-value selector + save estimate

**Files:**
- Modify: `public/room.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add a save container to `public/room.html`**

Insert a new `<div id="save">` between `#result` and `#hand`:

```html
    <div id="result"></div>
    <div id="save"></div>
    <div class="hand" id="hand"></div>
```

- [ ] **Step 2: Render the final-value selector in `public/app.js`**

Add a module-level variable near the top (after `let state = null;`):

```js
let finalValue = null; // facilitator's chosen final card before saving
```

Add a `renderSave()` function (place it after `renderResult`) and call it from `render()` right after `renderResult();`:

```js
function render() {
  if (!state) return;
  els.roomCode.textContent = state.code;
  els.count.textContent = `${state.participants.filter((p) => p.connected).length} pessoas`;
  renderStory();
  renderTable();
  renderResult();
  renderSave();
  renderHand();
  renderActions();
  renderHistory();
}
```

(Note: `renderHistory` is added in Task 9; if implementing Task 8 alone, omit that line until Task 9.)

Add the elements lookup: in the `els` object add `save: document.getElementById('save')`.

Add the function:

```js
function renderSave() {
  els.save.innerHTML = '';
  // Only the facilitator, only after reveal, only when there are numeric stats.
  if (!isFacilitator() || !state.revealed) return;

  const wrap = document.createElement('div');
  wrap.className = 'save-box';

  const label = document.createElement('div');
  label.className = 'save-label';
  label.textContent = 'Valor final acordado:';
  wrap.appendChild(label);

  // Default the selection to the most-voted card (mode) once per reveal.
  if (finalValue === null && state.stats) finalValue = state.stats.mode;

  const cards = document.createElement('div');
  cards.className = 'save-cards';
  for (const value of state.deck) {
    const card = document.createElement('div');
    const special = typeof value !== 'number';
    card.className = 'card' + (special ? ' special' : '') + (value === finalValue ? ' selected' : '');
    card.textContent = value;
    card.addEventListener('click', () => {
      finalValue = value;
      renderSave();
    });
    cards.appendChild(card);
  }
  wrap.appendChild(cards);

  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Salvar estimativa';
  btn.disabled = finalValue === null;
  btn.addEventListener('click', () => {
    if (finalValue === null) return;
    socket.emit('saveEstimate', { finalValue });
  });
  wrap.appendChild(btn);

  els.save.appendChild(wrap);
}
```

Reset `finalValue` when a new round starts so the next reveal re-defaults to the mode. In the existing `socket.on('roomState', ...)`, set it based on revealed state:

```js
socket.on('roomState', (s) => {
  if (state && state.revealed && !s.revealed) finalValue = null; // round was reset
  state = s;
  render();
});
```

- [ ] **Step 3: Add styles to `public/styles.css`** (append at the end):

```css
.save-box { text-align: center; margin: 16px 0; }
.save-label { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.save-cards { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-bottom: 12px; }
.save-cards .card { width: 40px; height: 56px; font-size: 16px; }
```

- [ ] **Step 4: Manual sanity (optional)**

Start the server (`run_in_background: true`, `node --env-file-if-exists=.env server/index.js`), open two browser windows, create a room, vote, reveal — confirm the facilitator sees the final-value selector (mode preselected) and "Salvar estimativa". Stop the server with `pkill -f "server/index.js"`. Full behavior is covered by integration tests in Task 7.

- [ ] **Step 5: Commit**

```bash
git add public/room.html public/app.js public/styles.css
git commit -m "feat: final-value selector and save estimate (facilitator)"
```

---

## Task 9: Frontend — history sidebar (visible to all)

**Files:**
- Modify: `public/room.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add sidebar markup + toggle to `public/room.html`**

Add a toggle button in the topbar and a sidebar container. Update the topbar and add the aside (inside `<main class="room">`, after the topbar or as a sibling — place the aside right after the opening `<main>`):

In the topbar `<span>` block, add a history toggle next to the share link:

```html
    <div class="topbar">
      <span>Sala <b id="roomCode"></b> · <span class="share" id="share">copiar link</span></span>
      <span><span class="hist-toggle" id="histToggle">histórico</span> · <span id="count"></span></span>
    </div>

    <aside class="sidebar hidden" id="sidebar">
      <div class="sidebar-head">
        <b>Histórico</b>
        <span class="sidebar-close" id="sidebarClose">✕</span>
      </div>
      <div id="historyList"></div>
      <button class="btn" id="exportCsv">copiar CSV</button>
      <a class="hist-link" id="histPageLink" target="_blank">abrir página do histórico ↗</a>
    </aside>
```

- [ ] **Step 2: Render history + wire toggle/export in `public/app.js`**

Add to the `els` object: `sidebar`, `histToggle`, `sidebarClose`, `historyList`, `exportCsv`, `histPageLink`.

Add a date formatter and `renderHistory()` (and make sure `render()` calls it — see Task 8 Step 2):

```js
function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderHistory() {
  els.historyList.innerHTML = '';
  const items = state.history || [];
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hist-empty';
    empty.textContent = 'Nenhuma estimativa salva ainda.';
    els.historyList.appendChild(empty);
    return;
  }
  for (const h of items) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const val = document.createElement('span');
    val.className = 'hist-value';
    val.textContent = h.finalValue;
    const title = document.createElement('span');
    title.className = 'hist-title';
    title.textContent = h.storyTitle || '(sem título)';
    const when = document.createElement('span');
    when.className = 'hist-when';
    when.textContent = fmtDate(h.createdAt);
    row.append(val, title, when);
    els.historyList.appendChild(row);
  }
}
```

Wire the toggle, close, export, and page link once (place near the `els.share` click handler):

```js
els.histToggle.addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
els.sidebarClose.addEventListener('click', () => els.sidebar.classList.add('hidden'));
els.histPageLink.href = `history.html?code=${encodeURIComponent(code)}`;

els.exportCsv.addEventListener('click', () => {
  const rows = [['historia', 'valor_final', 'consenso', 'data']];
  for (const h of state.history || []) {
    rows.push([h.storyTitle || '', h.finalValue, h.consensus || '', new Date(h.createdAt).toISOString()]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(csv).then(() => {
      els.exportCsv.textContent = 'CSV copiado!';
      setTimeout(() => (els.exportCsv.textContent = 'copiar CSV'), 1500);
    });
  }
});
```

- [ ] **Step 3: Add sidebar styles to `public/styles.css`** (append at the end):

```css
.hist-toggle { cursor: pointer; text-decoration: underline; }
.sidebar {
  position: fixed; top: 0; right: 0; width: 300px; max-width: 90vw; height: 100vh;
  background: var(--panel); border-left: 1px solid var(--panel-2);
  padding: 16px; overflow-y: auto; box-shadow: -8px 0 24px rgba(0,0,0,.4);
  transition: transform 0.2s; z-index: 10;
}
.sidebar.hidden { transform: translateX(110%); }
.sidebar-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.sidebar-close { cursor: pointer; color: var(--muted); }
.hist-empty { color: var(--muted); font-size: 13px; }
.hist-item { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--panel-2); font-size: 13px; }
.hist-value { background: var(--accent); color: #fff; border-radius: 6px; padding: 2px 8px; font-weight: 700; min-width: 22px; text-align: center; }
.hist-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-when { color: var(--muted); font-size: 11px; }
.hist-link { display: block; margin-top: 12px; color: var(--accent); font-size: 13px; }
#exportCsv { margin-top: 12px; }
```

- [ ] **Step 4: Commit**

```bash
git add public/room.html public/app.js public/styles.css
git commit -m "feat: live history sidebar with CSV export"
```

---

## Task 10: History-by-code page

**Files:**
- Create: `public/history.html`
- Create: `public/history.js`

- [ ] **Step 1: Create `public/history.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scrum Poker — Histórico</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body class="home">
  <main class="home-card" style="width: 520px;">
    <h1>📜 Histórico</h1>
    <p class="tagline">Sala <b id="code"></b></p>
    <div id="list"></div>
    <button id="exportCsv" class="btn">copiar CSV</button>
    <p id="error" class="error" hidden></p>
    <a href="index.html" class="hist-link">← voltar ao início</a>
  </main>
  <script src="history.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/history.js`**

```js
// Read-only history for a room code. Works even after the live room expired.
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
const listEl = document.getElementById('list');
const errorEl = document.getElementById('error');
document.getElementById('code').textContent = code || '—';

let estimates = [];

function fmtDate(ms) {
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function render() {
  listEl.innerHTML = '';
  if (estimates.length === 0) {
    listEl.innerHTML = '<p class="hist-empty">Nenhuma estimativa registrada para este código.</p>';
    return;
  }
  for (const e of estimates) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const val = document.createElement('span');
    val.className = 'hist-value';
    val.textContent = e.finalValue;
    const title = document.createElement('span');
    title.className = 'hist-title';
    title.textContent = e.storyTitle || '(sem título)';
    const when = document.createElement('span');
    when.className = 'hist-when';
    when.textContent = fmtDate(e.createdAt);
    row.append(val, title, when);
    listEl.appendChild(row);
  }
}

document.getElementById('exportCsv').addEventListener('click', () => {
  const rows = [['historia', 'valor_final', 'consenso', 'media', 'votantes', 'data']];
  for (const e of estimates) {
    rows.push([e.storyTitle || '', e.finalValue, e.consensus || '', e.average ?? '', e.voterCount, new Date(e.createdAt).toISOString()]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(csv).then(() => {
      const b = document.getElementById('exportCsv');
      b.textContent = 'CSV copiado!';
      setTimeout(() => (b.textContent = 'copiar CSV'), 1500);
    });
  }
});

async function load() {
  if (!code) {
    errorEl.textContent = 'Código não informado na URL (?code=...).';
    errorEl.hidden = false;
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/estimates`);
    if (!res.ok) throw new Error('falha ao carregar');
    const data = await res.json();
    estimates = data.estimates || [];
    render();
  } catch {
    errorEl.textContent = 'Não foi possível carregar o histórico.';
    errorEl.hidden = false;
  }
}

load();
```

- [ ] **Step 3: Sanity-check the page is served**

Start server (`run_in_background: true`), `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/history.html` → `200`. Stop with `pkill -f "server/index.js"`.

- [ ] **Step 4: Commit**

```bash
git add public/history.html public/history.js
git commit -m "feat: history-by-code page with CSV export"
```

---

## Task 11: Deploy config + docs

**Files:**
- Modify: `render.yaml`
- Modify: `README.md`
- Modify: `.gitignore` (add `data/` — already edited locally; ensure committed)

- [ ] **Step 1: Add DB env vars to `render.yaml`**

Update the `envVars` block to include the database vars as dashboard-set secrets (`sync: false` means "set this value in the Render dashboard, don't read from the blueprint"):

```yaml
    envVars:
      - key: NODE_VERSION
        value: "22"
      - key: ROOM_TTL_HOURS
        value: "24"
      - key: DATABASE_URL
        sync: false
      - key: DATABASE_AUTH_TOKEN
        sync: false
```

- [ ] **Step 2: Update `README.md`**

Add a "Persistência (V2)" section documenting the env vars and Turso setup. Append before the existing Deploy section (or update Deploy). Include:

````markdown
## Persistência (V2)

As salas e o histórico de estimativas são persistidos em **libSQL/Turso** (SQLite hospedado).

### Variáveis de ambiente

| Env | Default (dev) | Produção |
|-----|---------------|----------|
| `DATABASE_URL` | `file:./data/scrum.db` | `libsql://<seu-db>.turso.io` |
| `DATABASE_AUTH_TOKEN` | (vazio para `file:`) | token do Turso |
| `ROOM_TTL_HOURS` | `24` | `24` (ajustável) |

Localmente, sem configurar nada, o app usa um arquivo SQLite em `data/scrum.db`
(ignorado pelo git). Crie um `.env` para sobrescrever (carregado via `--env-file-if-exists`).

### Turso (produção)

```bash
# instalar a CLI: https://docs.turso.tech/cli/installation
turso db create scrumpoker
turso db show scrumpoker --url        # -> DATABASE_URL (libsql://...)
turso db tokens create scrumpoker     # -> DATABASE_AUTH_TOKEN
```

No Render, defina `DATABASE_URL` e `DATABASE_AUTH_TOKEN` no painel (Environment),
não no `render.yaml`. As salas expiram após `ROOM_TTL_HOURS` de inatividade; o
histórico de estimativas é mantido indefinidamente e fica acessível por código em
`/history.html?code=XXXX`.
````

- [ ] **Step 3: Ensure `data/` is gitignored and committed**

Run: `git check-ignore data/ && echo ignored`
Expected: prints `data/` and `ignored`. (The `.gitignore` line was added during planning; this commit records it.)

- [ ] **Step 4: Commit**

```bash
git add render.yaml README.md .gitignore
git commit -m "docs: V2 persistence env vars, Turso setup, render.yaml DB vars"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all suites pass (config, db, repository, persistence, rooms, stats, integration incl. restart). Note the pass/fail counts.

- [ ] **Step 2: Manual end-to-end with persistence**

Start the server (`run_in_background: true`, `node --env-file-if-exists=.env server/index.js`). In two browser windows (one normal, one incognito):
1. Create a room (window A = facilitator), join from window B.
2. Both vote; A reveals → stats + consensus show; A sees the final-value selector (mode preselected).
3. A picks a final card and clicks **Salvar estimativa** → the history sidebar (toggle in topbar) shows the item for BOTH windows.
4. A clicks **Nova rodada**; estimate another story; save again → two items in history.
5. **Restart test:** stop the server (`pkill -f "server/index.js"`) and start it again. Reload window A (rejoin same code) → the room reloads with prior votes/state and the history is still present.
6. Open `history.html?code=<code>` directly → the saved estimates render; **copiar CSV** works.

- [ ] **Step 3: Stop the server**

`pkill -f "server/index.js"`. No commit (verification only).

---

## Notes for the implementer

- Keep `rooms.js`/`stats.js` pure — all DB access lives in `repository.js`/`persistence.js`/`index.js`.
- The realtime hot path stays in memory: handlers update the in-memory room and **broadcast first**, then `await` the write-through (so persistence latency never delays the UI).
- Votes are TEXT in the DB; always round-trip through `parseVote` on read and `String(...)` on write so `5` ↔ `'5'` and `'?'`/`'☕'` survive.
- `estimates` has no FK to `rooms` (by design) so history survives room expiry; `deleteExpiredRooms`/`deleteRoom` never touch `estimates`.
- The server is now an async factory (`createServer(config)`); tests construct isolated instances against temp file DBs. Never rely on a global singleton.
- This environment needs `npm install --strict-ssl=false` for any new package.
