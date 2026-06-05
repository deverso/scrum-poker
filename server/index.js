import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import { argv } from 'node:process';
import {
  createRoomStore,
  addParticipant,
  setVote,
  reveal,
  newRound,
  setStory,
  disconnectParticipant,
  serializeRoom,
  hasConnectedParticipants,
} from './rooms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000; // delete empty rooms after 5 min

const app = express();
app.use(express.static(join(__dirname, '..', 'public')));

const httpServer = createServer(app);
const io = new Server(httpServer);
const store = createRoomStore();

// REST endpoint to create a room before any socket connects.
app.post('/api/rooms', express.json(), (req, res) => {
  const clientId = String(req.body?.clientId || '').trim();
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const room = store.createRoom(clientId);
  res.json({ code: room.code });
});

// socket.id -> { code, clientId } so we can clean up on disconnect.
const sessions = new Map();

function broadcastRoom(code) {
  const room = store.getRoom(code);
  if (!room) return;
  for (const [socketId, sess] of sessions) {
    if (sess.code !== code) continue;
    io.to(socketId).emit('roomState', serializeRoom(room, sess.clientId));
  }
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ code, name, clientId }) => {
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
  });

  socket.on('vote', ({ value }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const room = store.getRoom(sess.code);
    if (!room) return;
    setVote(room, sess.clientId, value);
    broadcastRoom(sess.code);
  });

  socket.on('reveal', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const room = store.getRoom(sess.code);
    if (!room) return;
    reveal(room, sess.clientId);
    broadcastRoom(sess.code);
  });

  socket.on('newRound', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const room = store.getRoom(sess.code);
    if (!room) return;
    newRound(room, sess.clientId);
    broadcastRoom(sess.code);
  });

  socket.on('setStory', ({ title }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const room = store.getRoom(sess.code);
    if (!room) return;
    setStory(room, sess.clientId, title);
    broadcastRoom(sess.code);
  });

  socket.on('disconnect', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    sessions.delete(socket.id);
    const room = store.getRoom(sess.code);
    if (!room) return;
    disconnectParticipant(room, sess.clientId);
    if (!hasConnectedParticipants(room)) room.emptySince = Date.now();
    broadcastRoom(sess.code);
  });
});

// Periodically remove rooms that have stayed empty past the grace period.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of store.rooms) {
    if (hasConnectedParticipants(room)) {
      delete room.emptySince;
    } else if (room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
      store.deleteRoom(code);
    }
  }
}, 60 * 1000).unref();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  httpServer.listen(PORT, () => {
    console.log(`Scrum Poker rodando em http://localhost:${PORT}`);
  });
}

export { httpServer, app };
