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

// Room metadata only (story, revealed, facilitator, activity); also stamps room.lastActivityAt.
export async function persistRoomMeta(db, room, now) {
  room.lastActivityAt = now;
  await repo.upsertRoom(db, room, now);
}

// One participant + room activity touch; also stamps room.lastActivityAt.
export async function persistParticipant(db, room, clientId, now) {
  const p = room.participants.get(clientId);
  if (!p) return;
  room.lastActivityAt = now;
  await repo.upsertRoom(db, room, now);
  await repo.upsertParticipant(db, room.code, clientId, p, now);
}

// Whole room: meta + every participant (used on join and newRound); also stamps room.lastActivityAt.
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
