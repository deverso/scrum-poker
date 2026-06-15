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
  newTask,
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
    try {
      await persistRoomMeta(db, room, Date.now());
    } catch (err) {
      store.deleteRoom(room.code); // roll back the in-memory room if persistence failed
      console.error('[server error] create room', err);
      return res.status(500).json({ error: 'could not create room' });
    }
    res.json({ code: room.code });
  });

  // Read the full history for a code (works even after the live room expired).
  app.get('/api/rooms/:code/estimates', async (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    try {
      const estimates = await repo.getEstimatesByCode(db, code);
      res.json({ code, estimates });
    } catch (err) {
      console.error('[server error] get estimates', err);
      res.status(500).json({ error: 'could not load history' });
    }
  });

  // Wrap async socket/interval callbacks so a rejected DB write logs instead of crashing the process.
  const guard = (fn) => (...args) => fn(...args).catch((err) => console.error('[server error]', err));

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
    socket.on('joinRoom', guard(async ({ code, name, clientId }) => {
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
    }));

    socket.on('vote', guard(async ({ value }) => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      setVote(room, sess.clientId, value);
      broadcastRoom(sess.code);
      await persistParticipant(db, room, sess.clientId, Date.now());
    }));

    socket.on('reveal', guard(async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      reveal(room, sess.clientId);
      broadcastRoom(sess.code);
      await persistRoomMeta(db, room, Date.now());
    }));

    socket.on('newRound', guard(async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      newRound(room, sess.clientId);
      room.estimateSaved = false;
      broadcastRoom(sess.code);
      await persistFullRoom(db, room, Date.now());
    }));

    socket.on('newTask', guard(async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      newTask(room, sess.clientId);
      room.estimateSaved = false;
      broadcastRoom(sess.code);
      await persistFullRoom(db, room, Date.now());
    }));

    socket.on('setStory', guard(async ({ title }) => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      setStory(room, sess.clientId, title);
      broadcastRoom(sess.code);
      await persistRoomMeta(db, room, Date.now());
    }));

    socket.on('saveEstimate', guard(async ({ finalValue }) => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      const room = store.getRoom(sess.code);
      if (!room) return;
      if (sess.clientId !== room.facilitatorId) return; // facilitator only
      if (!room.revealed) return;                        // only after reveal
      const card = room.deck.find((v) => String(v) === String(finalValue));
      if (card === undefined) return;                    // must be a deck card
      if (room.estimateSaved) return;                    // already saved this round
      room.estimateSaved = true;

      const snapshot = voteSnapshot(room);
      const numericVotes = snapshot.map((s) => s.vote);
      const stats = computeStats(numericVotes);
      const now = Date.now();
      const est = {
        roomCode: room.code,
        storyTitle: room.storyTitle,
        finalValue: card,
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
        finalValue: card,
        consensus: est.consensus,
        createdAt: now,
      });
      await persistRoomMeta(db, room, now); // touch activity
      broadcastRoom(sess.code);
    }));

    socket.on('disconnect', guard(async () => {
      const sess = sessions.get(socket.id);
      if (!sess) return;
      sessions.delete(socket.id);
      const room = store.getRoom(sess.code);
      if (!room) return;
      disconnectParticipant(room, sess.clientId);
      broadcastRoom(sess.code);
      await persistParticipant(db, room, sess.clientId, Date.now());
    }));
  });

  // Periodically expire rooms inactive beyond the TTL (memory + DB).
  const sweep = setInterval(guard(async () => {
    const removed = await repo.deleteExpiredRooms(db, config.roomTtlMs, Date.now());
    for (const code of removed) store.deleteRoom(code);
  }), 60 * 1000);
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
