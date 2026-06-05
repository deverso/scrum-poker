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
