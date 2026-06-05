import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────
// Server lifecycle helpers
// ──────────────────────────────────────────────

let PORT;
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
  return server.httpServer.address().port;
}

before(async () => {
  PORT = await startServer();
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

// ──────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────

/** Create a room via REST and return its code. */
async function createRoom(clientId) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  });
  const body = await res.json();
  return body.code;
}

/** Connect a socket.io client. Returns the socket instance. */
function connectClient() {
  return ioc(`http://127.0.0.1:${PORT}`, {
    forceNew: true,
    transports: ['websocket'],
  });
}

/**
 * Wait for the next `roomState` event on a socket that satisfies `predicate`.
 * Rejects after `timeoutMs` milliseconds so tests fail loudly instead of
 * hanging.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {(state: object) => boolean} predicate
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<object>} the matching roomState payload
 */
function waitForRoomState(socket, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('roomState', handler);
      reject(new Error(`waitForRoomState timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off('roomState', handler);
        resolve(state);
      }
    }

    socket.on('roomState', handler);
  });
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

test('1. create + two clients join', async () => {
  const code = await createRoom('A');

  const sockA = connectClient();
  const sockB = connectClient();

  try {
    // A joins first to become facilitator
    const stateAJoined = waitForRoomState(
      sockA,
      (s) => s.participants.some((p) => p.clientId === 'A'),
    );
    sockA.emit('joinRoom', { code, name: 'Alice', clientId: 'A' });
    await stateAJoined;

    // B joins; wait until both are present
    const stateBJoined = waitForRoomState(
      sockA,
      (s) => s.participants.length === 2,
    );
    sockB.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
    const state = await stateBJoined;

    assert.equal(state.participants.length, 2, 'should have 2 participants');
    assert.equal(state.facilitatorId, 'A', 'A should be facilitator');
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});

test('2. vote masking before reveal', async () => {
  const code = await createRoom('A');

  const sockA = connectClient();
  const sockB = connectClient();

  try {
    // Both join
    sockA.emit('joinRoom', { code, name: 'Alice', clientId: 'A' });
    await waitForRoomState(sockA, (s) => s.participants.some((p) => p.clientId === 'A'));

    sockB.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
    await waitForRoomState(sockA, (s) => s.participants.length === 2);

    // A votes 5; B votes 8
    sockA.emit('vote', { value: 5 });
    await waitForRoomState(sockA, (s) => {
      const pA = s.participants.find((p) => p.clientId === 'A');
      return pA && pA.hasVoted;
    });

    sockB.emit('vote', { value: 8 });
    // Wait for B to see its own vote
    const stateOnB = await waitForRoomState(sockB, (s) => {
      const pB = s.participants.find((p) => p.clientId === 'B');
      return pB && pB.hasVoted;
    });

    // B can see its own vote
    const bFromB = stateOnB.participants.find((p) => p.clientId === 'B');
    assert.equal(bFromB.vote, 8, "B should see its own vote as 8");

    // B cannot see A's vote (masked to null)
    const aFromB = stateOnB.participants.find((p) => p.clientId === 'A');
    assert.equal(aFromB.vote, null, "B should not see A's vote before reveal");
    assert.equal(aFromB.hasVoted, true, "A's hasVoted should be true");

    // Stats and consensus are null before reveal
    assert.equal(stateOnB.stats, null, 'stats should be null before reveal');
    assert.equal(stateOnB.consensus, null, 'consensus should be null before reveal');
    assert.equal(stateOnB.revealed, false, 'room should not be revealed yet');
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});

test('3. reveal exposes votes + stats + consensus', async () => {
  const code = await createRoom('A');

  const sockA = connectClient();
  const sockB = connectClient();

  try {
    sockA.emit('joinRoom', { code, name: 'Alice', clientId: 'A' });
    await waitForRoomState(sockA, (s) => s.participants.some((p) => p.clientId === 'A'));

    sockB.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
    await waitForRoomState(sockA, (s) => s.participants.length === 2);

    sockA.emit('vote', { value: 5 });
    await waitForRoomState(sockA, (s) => s.participants.find((p) => p.clientId === 'A')?.hasVoted);

    sockB.emit('vote', { value: 8 });
    await waitForRoomState(sockB, (s) => s.participants.find((p) => p.clientId === 'B')?.hasVoted);

    // A reveals
    sockA.emit('reveal');
    const stateRevealed = await waitForRoomState(sockA, (s) => s.revealed === true);

    assert.equal(stateRevealed.revealed, true, 'room should be revealed');

    const aVote = stateRevealed.participants.find((p) => p.clientId === 'A')?.vote;
    const bVote = stateRevealed.participants.find((p) => p.clientId === 'B')?.vote;
    assert.equal(aVote, 5, "A's vote should be 5 after reveal");
    assert.equal(bVote, 8, "B's vote should be 8 after reveal");

    assert.ok(stateRevealed.stats, 'stats should not be null after reveal');
    assert.equal(stateRevealed.stats.average, 6.5, 'average of 5 and 8 should be 6.5');
    assert.equal(stateRevealed.consensus, 'close', 'consensus should be close (5 and 8 are adjacent in deck)');
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});

test('4. non-facilitator cannot reveal', async () => {
  const code = await createRoom('A');

  const sockA = connectClient();
  const sockB = connectClient();

  try {
    sockA.emit('joinRoom', { code, name: 'Alice', clientId: 'A' });
    await waitForRoomState(sockA, (s) => s.participants.some((p) => p.clientId === 'A'));

    sockB.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
    await waitForRoomState(sockA, (s) => s.participants.length === 2);

    // A does newRound (only facilitator can) to ensure clean state
    sockA.emit('newRound');
    await waitForRoomState(sockA, (s) => s.revealed === false);

    // B (non-facilitator) tries to reveal — should be ignored by server
    // We track the state after B emits reveal
    let revealedByB = false;
    const revealListener = new Promise((resolve) => {
      // Give the server a moment to process the event and respond
      // We also vote as A to trigger a fresh roomState, then check revealed
      setTimeout(resolve, 300);
    });

    sockB.emit('reveal');
    await revealListener;

    // Now A votes to trigger a fresh roomState and confirm revealed is still false
    sockA.emit('vote', { value: 3 });
    const stateAfter = await waitForRoomState(sockA, (s) =>
      s.participants.find((p) => p.clientId === 'A')?.hasVoted === true,
    );

    assert.equal(stateAfter.revealed, false, 'room should still not be revealed after non-facilitator tries to reveal');
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});

test('5. invalid room code emits errorMessage', async () => {
  const sockC = connectClient();

  try {
    const errorPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for errorMessage')), 2000);
      sockC.once('errorMessage', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    sockC.emit('joinRoom', { code: 'BOGUS-0000', name: 'Charlie', clientId: 'C' });
    const err = await errorPromise;

    assert.ok(err.message, 'errorMessage should have a message property');
    assert.match(err.message, /não encontrada/i, 'error should indicate room not found');
  } finally {
    sockC.disconnect();
  }
});

test('6. facilitator promotion on disconnect', async () => {
  const code = await createRoom('A');

  const sockA = connectClient();
  const sockB = connectClient();

  try {
    sockA.emit('joinRoom', { code, name: 'Alice', clientId: 'A' });
    await waitForRoomState(sockA, (s) => s.participants.some((p) => p.clientId === 'A'));

    sockB.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
    await waitForRoomState(sockA, (s) => s.participants.length === 2);

    // Disconnect A (the facilitator); B should be promoted
    const promotionPromise = waitForRoomState(sockB, (s) => s.facilitatorId === 'B');
    sockA.disconnect();
    const stateAfterDisconnect = await promotionPromise;

    assert.equal(stateAfterDisconnect.facilitatorId, 'B', 'B should be promoted to facilitator after A disconnects');
  } finally {
    // sockA already disconnected
    sockB.disconnect();
  }
});
