// Pure statistics + consensus logic for Scrum Poker. No I/O, no sockets.

function numericVotes(votes) {
  return votes.filter((v) => typeof v === 'number' && !Number.isNaN(v));
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
  // On a tie, the lowest value wins: nums is sorted ascending, and `best` only
  // updates on a strictly greater count, so the first (smallest) max stays.
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
