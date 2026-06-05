// Pure room logic for Scrum Poker. No sockets, no Express.
import { computeStats, consensusLevel } from './stats.js';

export const DECK = [1, 2, 3, 5, 8, 13, 21, 34, '?', '☕'];

export function makeRoom(code, facilitatorId) {
  return {
    code,
    facilitatorId,
    storyTitle: '',
    revealed: false,
    deck: DECK,
    participants: new Map(), // clientId -> { name, vote, connected }
  };
}

export function addParticipant(room, clientId, name) {
  const existing = room.participants.get(clientId);
  if (existing) {
    existing.connected = true;
    if (name) existing.name = name;
  } else {
    room.participants.set(clientId, { name, vote: null, connected: true });
  }
  // If the room somehow has no valid facilitator, claim it.
  const fac = room.participants.get(room.facilitatorId);
  if (!fac || !fac.connected) room.facilitatorId = clientId;
}

export function setVote(room, clientId, value) {
  if (room.revealed) return;
  if (!room.deck.includes(value)) return;
  const p = room.participants.get(clientId);
  if (p) p.vote = value;
}

export function reveal(room, clientId) {
  if (clientId !== room.facilitatorId) return;
  room.revealed = true;
}

export function newRound(room, clientId) {
  if (clientId !== room.facilitatorId) return;
  room.revealed = false;
  for (const p of room.participants.values()) p.vote = null;
}

export function setStory(room, clientId, title) {
  if (clientId !== room.facilitatorId) return;
  room.storyTitle = String(title ?? '').slice(0, 200);
}

export function disconnectParticipant(room, clientId) {
  const p = room.participants.get(clientId);
  if (p) p.connected = false;
  if (clientId === room.facilitatorId) promoteFacilitator(room);
}

function promoteFacilitator(room) {
  // Map preserves insertion order; pick the oldest still-connected participant.
  for (const [id, p] of room.participants) {
    if (p.connected) {
      room.facilitatorId = id;
      return;
    }
  }
}

export function hasConnectedParticipants(room) {
  for (const p of room.participants.values()) if (p.connected) return true;
  return false;
}

export function serializeRoom(room, viewerId) {
  const participants = [...room.participants.entries()].map(([clientId, p]) => ({
    clientId,
    name: p.name,
    connected: p.connected,
    hasVoted: p.vote !== null,
    vote: room.revealed || clientId === viewerId ? p.vote : null,
  }));

  const votes = [...room.participants.values()]
    .map((p) => p.vote)
    .filter((v) => v !== null);

  return {
    code: room.code,
    storyTitle: room.storyTitle,
    revealed: room.revealed,
    deck: room.deck,
    facilitatorId: room.facilitatorId,
    participants,
    stats: room.revealed ? computeStats(votes) : null,
    consensus: room.revealed ? consensusLevel(votes, room.deck) : null,
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export function createRoomStore() {
  const rooms = new Map();

  function generateCode() {
    let code;
    do {
      let body = '';
      for (let i = 0; i < 4; i++) {
        body += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      code = `PLAY-${body}`;
    } while (rooms.has(code));
    return code;
  }

  function createRoom(facilitatorId) {
    const code = generateCode();
    const room = makeRoom(code, facilitatorId);
    rooms.set(code, room);
    return room;
  }

  return {
    rooms,
    createRoom,
    getRoom: (code) => rooms.get(code),
    deleteRoom: (code) => rooms.delete(code),
  };
}
