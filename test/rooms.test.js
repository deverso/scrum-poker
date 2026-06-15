import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK,
  makeRoom,
  addParticipant,
  setVote,
  reveal,
  newRound,
  setStory,
  disconnectParticipant,
  hasConnectedParticipants,
  serializeRoom,
  createRoomStore,
  voteSnapshot,
} from '../server/rooms.js';

test('makeRoom creates an empty unrevealed room with the facilitator set', () => {
  const room = makeRoom('PLAY-7K2', 'fac-1');
  assert.equal(room.code, 'PLAY-7K2');
  assert.equal(room.facilitatorId, 'fac-1');
  assert.equal(room.revealed, false);
  assert.equal(room.storyTitle, '');
  assert.deepEqual(room.deck, DECK);
  assert.equal(room.participants.size, 0);
  assert.deepEqual(room.history, []);
});

test('addParticipant adds a new participant with no vote', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  const p = room.participants.get('fac-1');
  assert.equal(p.name, 'Ana');
  assert.equal(p.vote, null);
  assert.equal(p.connected, true);
});

test('addParticipant reconnects an existing participant keeping their vote', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  disconnectParticipant(room, 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  const p = room.participants.get('fac-1');
  assert.equal(p.connected, true);
  assert.equal(p.vote, 5);
});

test('setVote accepts deck values and rejects unknown values', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 8);
  assert.equal(room.participants.get('fac-1').vote, 8);
  setVote(room, 'fac-1', 999); // not in deck -> ignored
  assert.equal(room.participants.get('fac-1').vote, 8);
});

test('setVote after reveal updates vote and sets editedAfterReveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8);
  const p = room.participants.get('fac-1');
  assert.equal(p.vote, 8);
  assert.equal(p.editedAfterReveal, true);
});

test('setVote after reveal without prior vote does NOT set editedAfterReveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 5);
  const p = room.participants.get('fac-1');
  assert.equal(p.vote, 5);
  assert.equal(p.editedAfterReveal, undefined);
});

test('newRound clears editedAfterReveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8);
  assert.equal(room.participants.get('fac-1').editedAfterReveal, true);
  newRound(room, 'fac-1');
  assert.equal(room.participants.get('fac-1').editedAfterReveal, false);
});

test('reveal only works for the facilitator', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  reveal(room, 'p-2'); // not facilitator
  assert.equal(room.revealed, false);
  reveal(room, 'fac-1');
  assert.equal(room.revealed, true);
});

test('newRound clears votes and unreveals (facilitator only)', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  newRound(room, 'p-2'); // not facilitator -> no-op
  assert.equal(room.revealed, true);
  newRound(room, 'fac-1');
  assert.equal(room.revealed, false);
  assert.equal(room.participants.get('fac-1').vote, null);
});

test('setStory updates title for facilitator only', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  setStory(room, 'p-2', 'hack'); // ignored
  assert.equal(room.storyTitle, '');
  setStory(room, 'fac-1', 'PROJ-1 Login');
  assert.equal(room.storyTitle, 'PROJ-1 Login');
});

test('disconnectParticipant keeps facilitatorId so the facilitator can reconnect', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  addParticipant(room, 'p-3', 'Carla');
  disconnectParticipant(room, 'fac-1');
  // facilitator is preserved — reconnecting restores their role
  assert.equal(room.facilitatorId, 'fac-1');
});

test('addParticipant claims facilitator only when facilitatorId has no entry in participants', () => {
  // Simulates the case where the original facilitator never returns and someone new joins.
  const room = makeRoom('R', 'ghost-fac');
  // ghost-fac is not in participants (e.g. reloaded room where they never reconnected)
  addParticipant(room, 'p-1', 'Bruno');
  assert.equal(room.facilitatorId, 'p-1');
});

test('reconnecting facilitator retains their role after a disconnect', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  disconnectParticipant(room, 'fac-1');
  assert.equal(room.facilitatorId, 'fac-1'); // still theirs while disconnected
  addParticipant(room, 'fac-1', 'Ana');      // reconnects
  assert.equal(room.facilitatorId, 'fac-1'); // still theirs after reconnect
  // and they can still exercise facilitator actions
  reveal(room, 'fac-1');
  assert.equal(room.revealed, true);
});

test('serializeRoom masks other votes before reveal but shows own vote', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  setVote(room, 'fac-1', 5);
  setVote(room, 'p-2', 8);

  const view = serializeRoom(room, 'fac-1');
  const ana = view.participants.find((p) => p.clientId === 'fac-1');
  const bruno = view.participants.find((p) => p.clientId === 'p-2');
  assert.equal(ana.vote, 5); // own vote visible
  assert.equal(bruno.vote, null); // masked
  assert.equal(bruno.hasVoted, true); // but flagged as voted
  assert.equal(view.stats, null); // no stats before reveal
  assert.equal(view.consensus, null);
});

test('serializeRoom reveals all votes plus stats and consensus after reveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  setVote(room, 'fac-1', 5);
  setVote(room, 'p-2', 8);
  reveal(room, 'fac-1');

  const view = serializeRoom(room, 'p-2');
  const ana = view.participants.find((p) => p.clientId === 'fac-1');
  assert.equal(ana.vote, 5); // visible after reveal
  assert.equal(view.stats.average, 6.5);
  assert.equal(view.consensus, 'close');
});

test('createRoomStore generates unique codes and stores rooms', () => {
  const store = createRoomStore();
  const a = store.createRoom('fac-1');
  const b = store.createRoom('fac-2');
  assert.notEqual(a.code, b.code);
  assert.equal(store.getRoom(a.code), a);
  assert.equal(store.getRoom('NOPE'), undefined);
});

test('hasConnectedParticipants reflects connection state', () => {
  const room = makeRoom('R', 'fac-1');
  assert.equal(hasConnectedParticipants(room), false); // empty
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  assert.equal(hasConnectedParticipants(room), true);
  disconnectParticipant(room, 'fac-1');
  disconnectParticipant(room, 'p-2');
  assert.equal(hasConnectedParticipants(room), false); // all disconnected
});

test('deleteRoom removes a room from the store', () => {
  const store = createRoomStore();
  const room = store.createRoom('fac-1');
  store.deleteRoom(room.code);
  assert.equal(store.getRoom(room.code), undefined);
});

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
