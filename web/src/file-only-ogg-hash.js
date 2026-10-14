const MAX_HASH = 0xffffffff;
const skip = (hash, segment, seed) =>
  seed ? Math.trunc((hash / ((segment + 1) * seed)) * 100) & 511 : 0;
export function publicPrefix(observation) {
  const expected = new Map();
  const set = (start, bytes) =>
    bytes.forEach((v, i) => {
      if (start + i < 128) expected.set(start + i, v);
    });
  const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
  const serial = Array.from(observation.serial);
  const magic = [79, 103, 103, 83, 0];
  for (const [start, seq, flags] of [
    [0, 0, 2],
    [58, 1, 0],
  ]) {
    set(start, magic);
    set(start + 5, [flags, ...new Array(8).fill(0), ...serial, ...u32(seq)]);
  }
  set(26, [1, 30, 1, 118, 111, 114, 98, 105, 115, 0, 0, 0, 0]);
  set(57, [1]);
  if (observation.header?.commentStart >= 86 && observation.header.vendor?.length) {
    const { commentStart, vendor, setup } = observation.header;
    set(84, [commentStart - 85]);
    set(commentStart, [3, 118, 111, 114, 98, 105, 115, ...u32(vendor.length), ...vendor]);
    if (setup) {
      const packetLaces = (n) => [...new Array(Math.floor(n / 255)).fill(255), n % 255];
      const laces = [...packetLaces(setup.start - commentStart), ...packetLaces(setup.length)];
      if (laces.length === commentStart - 85) set(85, laces);
    }
  }
  return expected;
}
export function hashesFromHeader(cipher, observation, checkpoint = () => {}) {
  const shifts =
    observation.shifts instanceof Map ? observation.shifts : new Map(observation.shifts);
  const expected = publicPrefix(observation);
  const deltas = [...shifts.values()];
  const low = Math.max(0, -Math.min(...deltas)),
    high = Math.min(511, 511 - Math.max(...deltas));
  const results = [];
  let comparisons = 0,
    intervalsSeen = 0;
  for (let reference = low; reference <= high; reference++) {
    checkpoint();
    const knownKey = new Map();
    let valid = true;
    for (const [position, plain] of expected) {
      if (!shifts.has(position)) continue;
      const index = shifts.get(position) + reference;
      const value = cipher[position] ^ plain;
      if (knownKey.has(index) && knownKey.get(index) !== value) {
        valid = false;
        break;
      }
      knownKey.set(index, value);
    }
    if (!valid) continue;
    const fixed = [];
    for (const [segment, delta] of shifts) {
      if (!knownKey.has(segment & 511)) continue;
      const seed = knownKey.get(segment & 511),
        value = delta + reference;
      if (!seed) {
        if (value !== 0) {
          valid = false;
          break;
        }
        continue;
      }
      fixed.push({ segment, seed, value, denominator: (segment + 1) * seed });
    }
    if (!valid || fixed.length < 4) continue;
    fixed.sort((a, b) => b.denominator - a.denominator);
    // Retain a one-integer margin around exact rational windows. Every retained
    // hash is checked against the original IEEE-double expression afterwards.
    let intervals = [[1, MAX_HASH]];
    for (const constraint of fixed.slice(0, 5)) {
      const { denominator: d, value: s } = constraint;
      const next = [];
      for (const [lo, hi] of intervals) {
        const first = Math.max(0, Math.floor(((100 * lo) / d - s) / 512) - 1);
        const last = Math.floor(((100 * hi) / d - s) / 512) + 1;
        for (let m = first; m <= last; m++) {
          if ((intervalsSeen & 4095) === 0) checkpoint();
          if (++intervalsSeen > 5000000) throw new Error('hash interval budget');
          const start = Math.max(lo, Math.ceil(((512 * m + s) * d) / 100) - 1);
          const end = Math.min(hi, Math.ceil(((512 * m + s + 1) * d) / 100) + 1);
          if (start <= end) next.push([start, end]);
        }
      }
      intervals = next;
      if (!intervals.length) break;
    }
    const tested = new Set();
    for (const [lo, hi] of intervals)
      for (let hash = lo; hash <= hi; hash++) {
        if (tested.has(hash)) continue;
        tested.add(hash);
        if (++comparisons > 2_000_000) throw new Error('hash search budget');
        if ((comparisons & 4095) === 0) checkpoint();
        if (!fixed.every(({ segment, seed, value }) => skip(hash, segment, seed) === value))
          continue;
        const groups = Array.from({ length: 512 }, () => []);
        for (const [segment, delta] of shifts)
          groups[segment & 511].push([segment, delta + reference]);
        const choices = groups.map((group, i) =>
          Array.from({ length: knownKey.has(i) ? 1 : 256 }, (_, seed) =>
            knownKey.has(i) ? knownKey.get(i) : seed,
          ).filter((seed) =>
            group.every(([segment, value]) => skip(hash, segment, seed) === value),
          ),
        );
        if (choices.some((c) => !c.length)) continue;
        results.push({ hash, reference, choices, knownKey: [...knownKey] });
        if (results.length > 64) throw new Error('hash ambiguity');
      }
  }
  return {
    candidates: results,
    stats: {
      comparisons,
      intervalsSeen,
      referenceRange: [low, high],
      fixedBytes: expected.size,
    },
  };
}
