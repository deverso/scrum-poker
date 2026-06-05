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
  assert.equal(parseVote(undefined), null);
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
  assert.equal(loaded.lastActivityAt, T0 + 10);
});
