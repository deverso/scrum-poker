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
