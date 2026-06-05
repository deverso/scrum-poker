import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDb, ensureSchema } from '../server/db.js';

function tempUrl() {
  return `file:${tmpdir()}/scrum-test-${randomUUID()}.db`;
}

test('ensureSchema creates the rooms, participants and estimates tables', async () => {
  const db = createDb({ databaseUrl: tempUrl() });
  await ensureSchema(db);
  const res = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  const tables = res.rows.map((r) => r.name);
  assert.ok(tables.includes('rooms'));
  assert.ok(tables.includes('participants'));
  assert.ok(tables.includes('estimates'));
});

test('ensureSchema is idempotent (safe to run twice)', async () => {
  const db = createDb({ databaseUrl: tempUrl() });
  await ensureSchema(db);
  await ensureSchema(db); // must not throw
  const res = await db.execute("SELECT count(*) AS n FROM rooms");
  assert.equal(Number(res.rows[0].n), 0);
});
