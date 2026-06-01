# Scrum Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a simple real-time Scrum Poker web app where a remote team joins a shared room, votes secretly with Fibonacci cards, and reveals all votes at once with stats and a consensus indicator.

**Architecture:** A single Node.js process. Express serves the static frontend; Socket.IO handles real-time room events. Room state lives in memory (a `Map`), with no database — rooms are ephemeral and cleaned up when empty. Business logic (`stats.js`, `rooms.js`) is kept pure and isolated from sockets so it can be unit-tested directly.

**Tech Stack:** Node.js (ESM), Express, Socket.IO, Node's built-in test runner (`node:test`). Vanilla HTML/CSS/JS frontend with the Socket.IO browser client.

---

## File Structure

```
scrum-poker/
├── server/
│   ├── index.js        # Express + Socket.IO transport layer (wiring only)
│   ├── rooms.js        # pure room logic: create/join/leave/vote/reveal/newRound + serialization
│   └── stats.js        # pure stats (average/median/mode/range) + 3-level consensus
├── public/
│   ├── index.html      # home: create / join
│   ├── home.js         # home page logic (create/join → redirect to room)
│   ├── room.html       # room screen shell
│   ├── app.js          # Socket.IO client + room UI rendering
│   └── styles.css      # styling
├── test/
│   ├── stats.test.js   # unit tests for stats.js
│   └── rooms.test.js   # unit tests for rooms.js
├── package.json
├── Procfile            # deploy (web: node server/index.js)
├── .gitignore          # (already exists)
└── README.md           # run locally + deploy
```

Responsibilities:
- `stats.js` — pure functions only; no I/O, no sockets. Input is an array of vote values; output is plain objects.
- `rooms.js` — pure functions operating on plain room objects + a small in-memory store factory. No sockets, no Express. Imports `stats.js` for serialization.
- `server/index.js` — the only file that knows about Express and Socket.IO. Translates socket events into `rooms.js` calls and broadcasts per-viewer state.
- `public/app.js` — the only frontend logic file; renders both home actions and the room screen.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "scrum-poker",
  "version": "1.0.0",
  "description": "Real-time Scrum Poker for planning sessions",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.19.2",
    "socket.io": "^4.7.5"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created; `express` and `socket.io` present; `package-lock.json` written; no errors.

- [ ] **Step 3: Create empty source files so the structure exists**

Run: `mkdir -p server public test && touch server/index.js server/rooms.js server/stats.js`
Expected: files exist (empty for now).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server
git commit -m "chore: scaffold scrum-poker project (express + socket.io, ESM)"
```

---

## Task 2: `stats.js` — pure stats + consensus (TDD)

**Files:**
- Create/implement: `server/stats.js`
- Test: `test/stats.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/stats.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, consensusLevel } from '../server/stats.js';

const DECK = [1, 2, 3, 5, 8, 13, 21, 34, '?', '☕'];

test('computeStats returns null when there are no numeric votes', () => {
  assert.equal(computeStats(['?', '☕']), null);
  assert.equal(computeStats([]), null);
});

test('computeStats ignores non-numeric cards', () => {
  const s = computeStats([5, 8, '?', '☕']);
  assert.equal(s.count, 2);
  assert.equal(s.min, 5);
  assert.equal(s.max, 8);
});

test('computeStats computes average rounded to 2 decimals', () => {
  const s = computeStats([5, 5, 8, 5]);
  assert.equal(s.average, 5.75);
});

test('computeStats computes median for odd and even counts', () => {
  assert.equal(computeStats([1, 5, 3]).median, 3); // sorted [1,3,5]
  assert.equal(computeStats([1, 3, 5, 8]).median, 4); // (3+5)/2
});

test('computeStats computes mode (most voted)', () => {
  assert.equal(computeStats([5, 5, 8, 13]).mode, 5);
});

test('consensusLevel returns null when no numeric votes', () => {
  assert.equal(consensusLevel(['?', '☕'], DECK), null);
});

test('consensusLevel returns consensus when all numeric votes equal', () => {
  assert.equal(consensusLevel([5, 5, 5], DECK), 'consensus');
  assert.equal(consensusLevel([5, 5, '?'], DECK), 'consensus');
});

test('consensusLevel returns close when votes are on adjacent deck cards', () => {
  assert.equal(consensusLevel([5, 8], DECK), 'close'); // positions 3,4
  assert.equal(consensusLevel([5, 8, 8], DECK), 'close');
});

test('consensusLevel returns diverge when votes span more than one deck step', () => {
  assert.equal(consensusLevel([2, 21], DECK), 'diverge');
  assert.equal(consensusLevel([3, 5, 8], DECK), 'diverge'); // positions 2,3,4 span 2
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/stats.test.js`
Expected: FAIL — `computeStats`/`consensusLevel` are not exported (module is empty).

- [ ] **Step 3: Implement `server/stats.js`**

```js
// Pure statistics + consensus logic for Scrum Poker. No I/O, no sockets.

function numericVotes(votes) {
  return votes.filter((v) => typeof v === 'number');
}

export function computeStats(votes) {
  const nums = numericVotes(votes).sort((a, b) => a - b);
  if (nums.length === 0) return null;

  const sum = nums.reduce((a, b) => a + b, 0);
  const average = Math.round((sum / nums.length) * 100) / 100;

  const mid = Math.floor(nums.length / 2);
  const median =
    nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;

  const counts = new Map();
  for (const n of nums) counts.set(n, (counts.get(n) || 0) + 1);
  let mode = nums[0];
  let best = 0;
  for (const [value, count] of counts) {
    if (count > best) {
      best = count;
      mode = value;
    }
  }

  return {
    average,
    median,
    mode,
    min: nums[0],
    max: nums[nums.length - 1],
    count: nums.length,
  };
}

// Consensus based on how far apart votes are in the deck sequence.
// 'consensus' = all numeric votes identical
// 'close'     = distinct votes occupy adjacent deck positions (span <= 1)
// 'diverge'   = distinct votes span more than one deck position
export function consensusLevel(votes, deck) {
  const numericDeck = deck.filter((v) => typeof v === 'number');
  const nums = numericVotes(votes);
  if (nums.length === 0) return null;

  const distinct = [...new Set(nums)];
  if (distinct.length === 1) return 'consensus';

  const positions = distinct
    .map((v) => numericDeck.indexOf(v))
    .sort((a, b) => a - b);
  const span = positions[positions.length - 1] - positions[0];

  return span <= 1 ? 'close' : 'diverge';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/stats.test.js`
Expected: PASS — all `stats` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/stats.js test/stats.test.js
git commit -m "feat: pure stats and 3-level consensus logic"
```

---

## Task 3: `rooms.js` — pure room logic (TDD)

**Files:**
- Create/implement: `server/rooms.js`
- Test: `test/rooms.test.js`

This module exports the canonical `DECK`, pure functions that mutate a plain room object, a `serializeRoom` function (which applies vote masking and attaches stats/consensus from `stats.js`), and a `createRoomStore` factory the server uses to hold all rooms.

- [ ] **Step 1: Write the failing tests**

Create `test/rooms.test.js`:

```js
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
  serializeRoom,
  createRoomStore,
} from '../server/rooms.js';

test('makeRoom creates an empty unrevealed room with the facilitator set', () => {
  const room = makeRoom('PLAY-7K2', 'fac-1');
  assert.equal(room.code, 'PLAY-7K2');
  assert.equal(room.facilitatorId, 'fac-1');
  assert.equal(room.revealed, false);
  assert.equal(room.storyTitle, '');
  assert.deepEqual(room.deck, DECK);
  assert.equal(room.participants.size, 0);
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

test('setVote is ignored after reveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8);
  assert.equal(room.participants.get('fac-1').vote, 5);
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

test('disconnectParticipant promotes oldest connected participant to facilitator', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  addParticipant(room, 'p-3', 'Carla');
  disconnectParticipant(room, 'fac-1');
  assert.equal(room.facilitatorId, 'p-2');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rooms.test.js`
Expected: FAIL — exports do not exist yet.

- [ ] **Step 3: Implement `server/rooms.js`**

```js
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
```

Note: `createRoomStore`'s `generateCode` uses `Math.random()`. That is correct for the real server runtime. (Do not run this module inside a Workflow script, where `Math.random` is unavailable — it is only exercised by `node --test` and the live server.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/rooms.test.js`
Expected: PASS — all `rooms` tests green.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — both `stats.test.js` and `rooms.test.js` green.

- [ ] **Step 6: Commit**

```bash
git add server/rooms.js test/rooms.test.js
git commit -m "feat: pure room logic with vote masking and facilitator promotion"
```

---

## Task 4: `server/index.js` — Express + Socket.IO wiring

**Files:**
- Implement: `server/index.js`

- [ ] **Step 1: Implement `server/index.js`**

```js
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
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
    const cleanName = String(name || 'Anônimo').slice(0, 40);
    addParticipant(room, clientId, cleanName);
    sessions.set(socket.id, { code, clientId });
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
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`Scrum Poker rodando em http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Smoke-test that the server starts**

Start the server in the background (use the Bash tool's `run_in_background: true`):

Run: `node server/index.js`

Then verify the create-room endpoint responds (the `--retry` flags wait for the server to come up without a foreground `sleep`):

Run: `curl -s --retry 5 --retry-connrefused --retry-delay 1 -X POST http://localhost:3000/api/rooms -H 'Content-Type: application/json' -d '{"clientId":"abc"}'`
Expected: JSON like `{"code":"PLAY-XXXX"}`.

Then stop the background server (e.g. `pkill -f "node server/index.js"`).

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: socket.io server with per-viewer state broadcast and room cleanup"
```

---

## Task 5: `public/index.html` — home page

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Create `public/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scrum Poker</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body class="home">
  <main class="home-card">
    <h1>🃏 Scrum Poker</h1>
    <p class="tagline">Estimativa colaborativa para a planning do time.</p>

    <label>Seu nome
      <input id="name" type="text" placeholder="Ex: Ana" maxlength="40" />
    </label>

    <button id="create" class="btn primary">Criar sala</button>

    <div class="divider"><span>ou entrar numa sala</span></div>

    <label>Código da sala
      <input id="code" type="text" placeholder="PLAY-XXXX" autocomplete="off" />
    </label>
    <button id="join" class="btn">Entrar</button>

    <p id="error" class="error" hidden></p>
  </main>

  <script src="home.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/home.js`**

```js
// Home page: create or join a room, then redirect to room.html?code=CODE.
function getClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) {
    id = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('clientId', id);
  }
  return id;
}

const nameInput = document.getElementById('name');
const codeInput = document.getElementById('code');
const errorEl = document.getElementById('error');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function saveName() {
  const name = nameInput.value.trim();
  if (!name) {
    showError('Digite seu nome primeiro.');
    return null;
  }
  localStorage.setItem('name', name);
  return name;
}

// Prefill name and code from storage / URL.
nameInput.value = localStorage.getItem('name') || '';
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeInput.value = urlCode;

document.getElementById('create').addEventListener('click', async () => {
  if (!saveName()) return;
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId() }),
  });
  if (!res.ok) return showError('Não foi possível criar a sala.');
  const { code } = await res.json();
  location.href = `room.html?code=${encodeURIComponent(code)}`;
});

document.getElementById('join').addEventListener('click', () => {
  if (!saveName()) return;
  const code = codeInput.value.trim().toUpperCase();
  if (!code) return showError('Digite o código da sala.');
  location.href = `room.html?code=${encodeURIComponent(code)}`;
});
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/home.js
git commit -m "feat: home page to create/join rooms"
```

---

## Task 6: `public/styles.css` — styling

**Files:**
- Create: `public/styles.css`

- [ ] **Step 1: Create `public/styles.css`**

```css
:root {
  --bg: #0f172a;
  --panel: #1e293b;
  --panel-2: #334155;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #6366f1;
  --accent-2: #4338ca;
  --ok: #4ade80;
  --warn: #facc15;
  --diverge: #f87171;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
}

/* ---------- Home ---------- */
body.home {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.home-card {
  background: var(--panel);
  padding: 32px;
  border-radius: 16px;
  width: 360px;
  max-width: 92vw;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.home-card h1 { margin: 0 0 4px; font-size: 28px; }
.tagline { color: var(--muted); margin: 0 0 20px; }
.home-card label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 14px;
}
.home-card input {
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--panel-2);
  background: var(--bg);
  color: var(--text);
  font-size: 15px;
}
.btn {
  width: 100%;
  padding: 11px;
  border: 1px solid var(--panel-2);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:hover { filter: brightness(1.1); }
.divider {
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  margin: 18px 0;
  position: relative;
}
.divider span { background: var(--panel); padding: 0 10px; position: relative; z-index: 1; }
.divider::before {
  content: ''; position: absolute; left: 0; right: 0; top: 50%;
  height: 1px; background: var(--panel-2);
}
.error { color: var(--diverge); font-size: 13px; margin-top: 12px; }

/* ---------- Room ---------- */
.room {
  max-width: 720px;
  margin: 0 auto;
  padding: 20px 16px 60px;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--muted);
}
.topbar .share { cursor: pointer; text-decoration: underline; }
.story {
  font-size: 18px;
  font-weight: 600;
  margin: 10px 0 20px;
  color: #fff;
  display: flex;
  gap: 8px;
  align-items: center;
}
.story input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--panel-2);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
}
.table {
  background: var(--panel);
  border-radius: 14px;
  padding: 22px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  justify-content: center;
  min-height: 130px;
  align-items: center;
}
.seat { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 70px; }
.seat .mini {
  width: 46px; height: 64px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 18px;
}
.seat .back {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
}
.seat .waiting { background: var(--panel-2); border: 2px dashed #475569; }
.seat .face { background: #fff; color: var(--bg); }
.seat .name {
  font-size: 12px; color: var(--muted);
  max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.seat .name.offline { opacity: 0.4; }

.consensus { text-align: center; padding: 10px; border-radius: 8px; font-weight: 600; margin: 16px 0; }
.consensus.consensus { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.consensus.close { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.consensus.diverge { background: rgba(248, 113, 113, 0.15); color: var(--diverge); }

.stats { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin: 16px 0; }
.stat { background: var(--panel); border-radius: 10px; padding: 10px 16px; text-align: center; min-width: 72px; }
.stat .v { font-size: 22px; font-weight: 700; color: #fff; }
.stat .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

.hand { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 22px; }
.card {
  width: 48px; height: 68px; border-radius: 8px;
  background: #fff; color: var(--bg);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 18px;
  border: 2px solid transparent; cursor: pointer;
  transition: transform 0.1s, box-shadow 0.1s;
}
.card.special { background: var(--panel); color: #fff; }
.card.selected {
  border-color: var(--accent);
  transform: translateY(-8px);
  box-shadow: 0 8px 18px rgba(99, 102, 241, 0.5);
}
.actions { display: flex; gap: 10px; justify-content: center; margin-top: 22px; }
.actions .btn { width: auto; padding: 10px 20px; }
.hint { text-align: center; color: var(--muted); font-size: 12px; margin-top: 10px; }
```

- [ ] **Step 2: Commit**

```bash
git add public/styles.css
git commit -m "style: theme and layout for home and room"
```

---

## Task 7: `public/room.html` + `public/app.js` — room screen

**Files:**
- Create: `public/room.html`
- Create: `public/app.js`

- [ ] **Step 1: Create `public/room.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scrum Poker — Sala</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="room">
    <div class="topbar">
      <span>Sala <b id="roomCode"></b> · <span class="share" id="share">copiar link</span></span>
      <span id="count"></span>
    </div>

    <div class="story" id="story"></div>
    <div class="table" id="table"></div>

    <div id="result"></div>
    <div class="hand" id="hand"></div>
    <div class="actions" id="actions"></div>
    <p class="hint" id="hint"></p>
  </main>

  <script src="/socket.io/socket.io.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/app.js`**

```js
// Room screen: connects via Socket.IO, renders state, sends user actions.
function getClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) {
    id = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('clientId', id);
  }
  return id;
}

const clientId = getClientId();
const name = localStorage.getItem('name') || 'Anônimo';
const code = new URLSearchParams(location.search).get('code');

if (!code) location.href = 'index.html';

const socket = io();
let state = null;

const els = {
  roomCode: document.getElementById('roomCode'),
  count: document.getElementById('count'),
  story: document.getElementById('story'),
  table: document.getElementById('table'),
  result: document.getElementById('result'),
  hand: document.getElementById('hand'),
  actions: document.getElementById('actions'),
  hint: document.getElementById('hint'),
  share: document.getElementById('share'),
};

const CONSENSUS_TEXT = {
  consensus: '✅ Consenso — todos na mesma carta',
  close: '👍 Quase lá — votos em cartas vizinhas',
  diverge: '⚠️ Divergência — vale uma conversa antes de reestimar',
};

socket.on('connect', () => {
  socket.emit('joinRoom', { code, name, clientId });
});

socket.on('errorMessage', ({ message }) => {
  alert(message);
  location.href = 'index.html';
});

socket.on('roomState', (s) => {
  state = s;
  render();
});

els.share.addEventListener('click', () => {
  const url = `${location.origin}/index.html?code=${encodeURIComponent(code)}`;
  navigator.clipboard.writeText(url);
  els.share.textContent = 'link copiado!';
  setTimeout(() => (els.share.textContent = 'copiar link'), 1500);
});

function isFacilitator() {
  return state && state.facilitatorId === clientId;
}

function myVote() {
  const me = state.participants.find((p) => p.clientId === clientId);
  return me ? me.vote : null;
}

function render() {
  if (!state) return;
  els.roomCode.textContent = state.code;
  els.count.textContent = `${state.participants.filter((p) => p.connected).length} pessoas`;
  renderStory();
  renderTable();
  renderResult();
  renderHand();
  renderActions();
}

function renderStory() {
  els.story.innerHTML = '';
  const label = document.createTextNode('📝 ');
  els.story.appendChild(label);
  if (isFacilitator()) {
    const input = document.createElement('input');
    input.value = state.storyTitle;
    input.placeholder = 'O que estamos estimando?';
    input.addEventListener('change', () =>
      socket.emit('setStory', { title: input.value })
    );
    els.story.appendChild(input);
  } else {
    els.story.appendChild(
      document.createTextNode(state.storyTitle || '(sem título)')
    );
  }
}

function renderTable() {
  els.table.innerHTML = '';
  for (const p of state.participants) {
    const seat = document.createElement('div');
    seat.className = 'seat';

    const mini = document.createElement('div');
    if (state.revealed) {
      mini.className = 'mini face';
      mini.textContent = p.vote === null ? '–' : p.vote;
    } else if (p.hasVoted) {
      mini.className = 'mini back';
      mini.textContent = '✓';
    } else {
      mini.className = 'mini waiting';
    }

    const nm = document.createElement('div');
    nm.className = 'name' + (p.connected ? '' : ' offline');
    const crown = p.clientId === state.facilitatorId ? '👑 ' : '';
    nm.textContent = crown + p.name;

    seat.appendChild(mini);
    seat.appendChild(nm);
    els.table.appendChild(seat);
  }
}

function renderResult() {
  els.result.innerHTML = '';
  if (!state.revealed) return;

  if (state.consensus) {
    const c = document.createElement('div');
    c.className = 'consensus ' + state.consensus;
    c.textContent = CONSENSUS_TEXT[state.consensus];
    els.result.appendChild(c);
  }

  if (state.stats) {
    const wrap = document.createElement('div');
    wrap.className = 'stats';
    const items = [
      ['Média', state.stats.average],
      ['Mediana', state.stats.median],
      ['Mais votada', state.stats.mode],
      ['Intervalo', `${state.stats.min}–${state.stats.max}`],
    ];
    for (const [label, value] of items) {
      const s = document.createElement('div');
      s.className = 'stat';
      s.innerHTML = `<div class="v">${value}</div><div class="l">${label}</div>`;
      wrap.appendChild(s);
    }
    els.result.appendChild(wrap);
  }
}

function renderHand() {
  els.hand.innerHTML = '';
  if (state.revealed) return; // no voting while revealed
  const selected = myVote();
  for (const value of state.deck) {
    const card = document.createElement('div');
    const special = typeof value !== 'number';
    card.className = 'card' + (special ? ' special' : '') + (value === selected ? ' selected' : '');
    card.textContent = value;
    card.addEventListener('click', () => socket.emit('vote', { value }));
    els.hand.appendChild(card);
  }
}

function renderActions() {
  els.actions.innerHTML = '';
  els.hint.textContent = '';
  if (!isFacilitator()) {
    els.hint.textContent = 'Aguardando o facilitador 👑 controlar a rodada.';
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  if (state.revealed) {
    btn.textContent = 'Nova rodada';
    btn.addEventListener('click', () => socket.emit('newRound'));
  } else {
    btn.textContent = 'Revelar votos';
    btn.addEventListener('click', () => socket.emit('reveal'));
  }
  els.actions.appendChild(btn);
}
```

- [ ] **Step 3: Commit**

```bash
git add public/room.html public/app.js
git commit -m "feat: room screen with voting, reveal, stats and consensus"
```

---

## Task 8: README + deploy config

**Files:**
- Create: `Procfile`
- Create: `README.md`

- [ ] **Step 1: Create `Procfile`**

```
web: node server/index.js
```

- [ ] **Step 2: Create `README.md`**

````markdown
# 🃏 Scrum Poker

Estimativa colaborativa em tempo real para a planning do time. Cada pessoa entra
numa sala pelo navegador, vota em segredo com cartas de Fibonacci, e os votos são
revelados ao mesmo tempo — com estatísticas e indicador de consenso.

## Funcionalidades

- Salas em tempo real (Socket.IO), entrada só com o nome (sem cadastro).
- Baralho Fibonacci puro: `1, 2, 3, 5, 8, 13, 21, 34` + `?` e `☕`.
- Voto secreto até o facilitador revelar.
- Na revelação: média, mediana, mais votada, intervalo e consenso (3 níveis).
- Facilitador (quem cria a sala) controla revelar / nova rodada / título.

## Rodar localmente

```bash
npm install
npm start
# abra http://localhost:3000
```

Para testar com várias pessoas na mesma máquina, abra abas anônimas diferentes
(cada aba tem seu próprio `clientId`).

## Testes

```bash
npm test
```

Cobrem a lógica pura de estatísticas/consenso (`server/stats.js`) e de salas
(`server/rooms.js`).

## Deploy

A app usa `process.env.PORT`, então funciona direto em Render, Railway ou Fly.io.

- **Render:** novo Web Service → build `npm install` → start `npm start`.
- **Railway:** detecta `package.json` e usa `npm start` automaticamente.
- O `Procfile` (`web: node server/index.js`) cobre plataformas estilo Heroku.

> Estado em memória: as salas são efêmeras e somem ao reiniciar o servidor ou
> após ~5 min vazias. Para histórico/persistência, seria preciso um banco (fora
> do escopo do v1).
````

- [ ] **Step 3: Commit**

```bash
git add Procfile README.md
git commit -m "docs: README and deploy config (Procfile)"
```

---

## Task 9: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the server**

Run: `npm start`
Expected: `Scrum Poker rodando em http://localhost:3000`.

- [ ] **Step 2: Verify the full flow in the browser**

Open `http://localhost:3000` in two different browser windows (use one normal + one
incognito so they get different `clientId`s). Verify:

1. Window A: enter a name, click **Criar sala** → lands in a room showing a code.
2. Copy the link (or code), open it in Window B, enter a different name, **Entrar**.
3. Both windows show 2 participants; Window A's name has a 👑.
4. Each window clicks a card → the other sees a ✓ (back), **not** the value.
5. Window A (facilitator) clicks **Revelar votos** → both windows flip face-up and
   show stats + a consensus banner. Window B has no action button (only the hint).
6. Pick votes like `5` and `8` → consensus shows "👍 Quase lá"; pick `2` and `21` →
   "⚠️ Divergência"; same value in both → "✅ Consenso".
7. Window A clicks **Nova rodada** → votes clear, cards return, story title persists.
8. Window A edits the story title → Window B sees the updated title.
9. Close Window A → Window B's oldest participant (itself) is promoted to 👑 and gains
   the action button.

- [ ] **Step 3: Stop the server**

Press `Ctrl+C`. No commit needed — this task is verification only.

---

## Notes for the implementer

- This is a greenfield project; follow the file structure above exactly.
- Keep `stats.js` and `rooms.js` free of any Express/Socket.IO imports — that isolation is what makes them unit-testable.
- All vote masking happens in `serializeRoom`; the server must never emit an unmasked vote before reveal. The broadcast loop in `server/index.js` calls `serializeRoom` once per viewer for exactly this reason.
- `home.js`, `app.js`, and the server all generate/read `clientId` from `localStorage` the same way — that consistency is what enables reconnection.
