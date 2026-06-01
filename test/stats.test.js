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

test('computeStats returns the lowest card on a mode tie', () => {
  assert.equal(computeStats([5, 5, 8, 8]).mode, 5);
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
