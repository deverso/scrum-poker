import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('loadConfig applies defaults when env is empty', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.roomTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(c.databaseUrl, 'file:./data/scrum.db');
  assert.equal(c.databaseAuthToken, undefined);
});

test('loadConfig reads values from env', () => {
  const c = loadConfig({
    PORT: '8080',
    ROOM_TTL_HOURS: '48',
    DATABASE_URL: 'libsql://x.turso.io',
    DATABASE_AUTH_TOKEN: 'tok',
  });
  assert.equal(c.port, 8080);
  assert.equal(c.roomTtlMs, 48 * 60 * 60 * 1000);
  assert.equal(c.databaseUrl, 'libsql://x.turso.io');
  assert.equal(c.databaseAuthToken, 'tok');
});
