// Recover only a unique original prefix. Only original ciphertext, inferred stream,
// format-derived structure and skip candidate domains enter this module.
const BLOCK = 5120;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, b) => {
  let x = b << 24;
  for (let i = 0; i < 8; i++) x = (x << 1) ^ (x >>> 31 ? 0x04c11db7 : 0);
  return x >>> 0;
});
const text = new TextEncoder();
const entries32 = (v, offset) => [0, 1, 2, 3].map((i) => [offset + i, (v >>> (i * 8)) & 255]);
function fail(reason) {
  throw new Error(reason);
}
function crc(data, start, end) {
  let c = 0;
  for (let p = start; p < end; p++) {
    const b = p >= start + 22 && p < start + 26 ? 0 : data[p];
    c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 255]) >>> 0;
  }
  return (
    (c ^
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(start + 22, true)) >>>
    0
  );
}
function publicPrefix(observations) {
  observations = normalize(observations);
  const fixed = new Map();
  const put = (p, b) => {
    if (p < 128) {
      if (fixed.has(p) && fixed.get(p) !== b) fail('Conflicting public constraints');
      fixed.set(p, b);
    }
  };
  for (const [start, sequence] of [
    [0, 0],
    [58, 1],
  ]) {
    [79, 103, 103, 83, 0, sequence ? 0 : 2, ...Array(8).fill(0)].forEach((b, i) =>
      put(start + i, b),
    );
    observations.serial.forEach((b, i) => put(start + 14 + i, b));
    entries32(sequence, start + 18).forEach(([p, b]) => put(p, b));
  }
  [
    [26, 1],
    [27, 30],
    [28, 1],
    ...[...text.encode('vorbis')].map((b, i) => [29 + i, b]),
    ...[35, 36, 37, 38].map((p) => [p, 0]),
    [57, 1],
  ].forEach(([p, b]) => put(p, b));
  const { commentStart, setupStart, setupLength, vendor } = observations;
  if (Number.isInteger(commentStart)) {
    const count = commentStart - 85;
    if (count < 1 || count > 255) fail('Invalid commentStart');
    put(84, count);
    [3, ...text.encode('vorbis')].forEach((b, i) => put(commentStart + i, b));
    if (vendor) {
      const bytes = typeof vendor === 'string' ? text.encode(vendor) : vendor;
      entries32(bytes.length, commentStart + 7).forEach(([p, b]) => put(p, b));
      bytes.forEach((b, i) => put(commentStart + 11 + i, b));
    }
    if (Number.isInteger(setupStart) && Number.isInteger(setupLength)) {
      const lengths = [setupStart - commentStart, setupLength],
        lacing = [];
      for (const length of lengths) {
        if (length < 0) fail('Invalid packet length');
        for (let j = 0; j < Math.floor(length / 255); j++) lacing.push(255);
        lacing.push(length % 255);
      }
      if (lacing.length !== count) fail('Lacing count differs from template');
      lacing.forEach((b, i) => put(85 + i, b));
    }
  }
  return fixed;
}
function affineBasis(values) {
  const base = values[0],
    pivots = Array(8).fill(0),
    basis = [];
  for (const value of values) {
    let x = value ^ base;
    for (let p = 7; p >= 0 && x; p--) {
      if (!(x & (1 << p))) continue;
      if (pivots[p]) x ^= pivots[p];
      else {
        pivots[p] = x;
        basis.push(x);
        break;
      }
    }
  }
  return { base, basis };
}
function gaussian(rows, count) {
  const pivots = new Map(),
    mask = (1n << BigInt(count)) - 1n;
  for (let row of rows) {
    while (row & mask) {
      const coefficient = row & mask;
      const low = coefficient & -coefficient;
      const p = low.toString(2).length - 1;
      if (pivots.has(p)) row ^= pivots.get(p);
      else {
        pivots.set(p, row);
        break;
      }
    }
    if (!(row & mask) && row >> BigInt(count)) return null;
  }
  const free = [];
  for (let i = 0; i < count; i++) if (!pivots.has(i)) free.push(i);
  function solve(freeBits) {
    let assignment = 0n;
    free.forEach((p, i) => {
      if (freeBits & (1n << BigInt(i))) assignment |= 1n << BigInt(p);
    });
    for (const p of [...pivots.keys()].sort((a, b) => b - a)) {
      const row = pivots.get(p);
      let value = (row >> BigInt(count)) & 1n;
      let terms = row & mask & assignment;
      while (terms) {
        value ^= 1n;
        terms &= terms - 1n;
      }
      if (value) assignment |= 1n << BigInt(p);
    }
    return assignment;
  }
  return { free, rank: pivots.size, solve };
}
function normalize(observations) {
  const header = observations.header ?? {};
  return {
    ...observations,
    commentStart: observations.commentStart ?? (header.commentStart || undefined),
    vendor: observations.vendor ?? header.vendor,
    setupStart: observations.setupStart ?? header.setup?.start,
    setupLength: observations.setupLength ?? header.setup?.length,
  };
}
export function solvePrefix(cipher, observations, candidates, options = {}) {
  const checkpoint = options.checkpoint ?? (() => {});
  observations = normalize(observations);
  const known =
      observations.known instanceof Map ? observations.known : new Map(observations.known),
    shifts =
      observations.shifts instanceof Map ? observations.shifts : new Map(observations.shifts);
  const fixed = publicPrefix(observations),
    body = cipher.slice();
  let unknownBodyBytes = 0,
    firstUnknown = Infinity;
  for (let p = 128; p < cipher.length; p++) {
    const delta = shifts.get(Math.floor(p / BLOCK));
    const j = (p % BLOCK) + delta;
    if (delta === undefined || !known.has(j)) {
      unknownBodyBytes++;
      firstUnknown = Math.min(firstUnknown, p);
      continue;
    }
    body[p] ^= known.get(j);
  }
  let secondEnd;
  if (observations.setupStart !== undefined && observations.setupLength !== undefined)
    secondEnd = observations.setupStart + observations.setupLength;
  else
    for (let p = 128; p < body.length - 27; p++) {
      if (
        body[p] === 79 &&
        body[p + 1] === 103 &&
        body[p + 2] === 103 &&
        body[p + 3] === 83 &&
        body[p + 4] === 0 &&
        body[p + 18] === 2 &&
        body[p + 19] === 0 &&
        body[p + 20] === 0 &&
        body[p + 21] === 0 &&
        observations.serial.every((b, i) => body[p + 14 + i] === b)
      ) {
        secondEnd = p;
        break;
      }
    }
  if (!secondEnd || secondEnd > 100000) fail('Unknown second page boundary');
  if (firstUnknown < secondEnd) fail(`Missing second-page stream at ${firstUnknown}`);
  const successes = [],
    diagnostics = [];
  let unresolved = 0;
  for (const candidate of candidates) {
    checkpoint();
    const { reference } = candidate,
      domains = new Map(),
      positions = new Map();
    let invalid = false;
    const groups = Array.from({ length: 512 }, () => []);
    for (const [segment, delta] of shifts) groups[segment & 511].push([segment, delta + reference]);
    const choices = candidate.choices.map((values, i) =>
      values.filter((seed) =>
        groups[i].every(
          ([segment, value]) =>
            (seed ? Math.trunc((candidate.hash / ((segment + 1) * seed)) * 100) & 511 : 0) ===
            value,
        ),
      ),
    );
    if (choices.some((values) => !values.length)) {
      diagnostics.push({ reason: 'empty key domain rejects hash' });
      continue;
    }
    for (let i = 0; i < 128; i++) {
      const delta = shifts.get(i);
      if (delta === undefined) fail(`Missing prefix segment ${i}`);
      const j = delta + reference;
      if (j < 0 || j > 511) fail('Invalid reference');
      if (!domains.has(j)) domains.set(j, [...choices[j]]);
      if (!positions.has(j)) positions.set(j, []);
      positions.get(j).push(i);
      if (fixed.has(i)) {
        const expected = cipher[i] ^ fixed.get(i);
        domains.set(
          j,
          domains.get(j).filter((v) => v === expected),
        );
        if (!domains.get(j).length) {
          invalid = true;
          break;
        }
      }
    }
    if (invalid) {
      diagnostics.push({ reason: 'fixed constraints reject hash' });
      continue;
    }
    const out = body.slice(),
      variables = [],
      bases = new Map();
    for (const [j, values] of domains) {
      const { base, basis } = affineBasis(values);
      bases.set(j, base);
      for (const p of positions.get(j)) out[p] = cipher[p] ^ base;
      for (const diff of basis) variables.push({ j, diff, positions: positions.get(j) });
    }
    const rows = [];
    for (const [start, end] of [
      [0, 58],
      [58, secondEnd],
    ]) {
      const baseline = crc(out, start, end),
        coefficients = variables.map((v) => {
          for (const p of v.positions) out[p] ^= v.diff;
          const value = crc(out, start, end) ^ baseline;
          for (const p of v.positions) out[p] ^= v.diff;
          return value >>> 0;
        });
      for (let bit = 0; bit < 32; bit++) {
        let row = BigInt((baseline >>> bit) & 1) << BigInt(variables.length);
        coefficients.forEach((c, i) => {
          if ((c >>> bit) & 1) row |= 1n << BigInt(i);
        });
        rows.push(row);
      }
    }
    const system = gaussian(rows, variables.length);
    if (!system) {
      diagnostics.push({
        reason: 'inconsistent CRC system',
        variables: variables.length,
      });
      continue;
    }
    diagnostics.push({
      variables: variables.length,
      rank: system.rank,
      free: system.free.length,
      domains: domains.size,
      variableKeyIndices: [...new Set(variables.map((v) => v.j))],
    });
    // A budget-limited branch is unresolved, not disproved. Even one other
    // surviving prefix cannot establish uniqueness across an unsearched branch.
    if (system.free.length > Math.min(options.maxFree ?? 20, 20)) {
      unresolved++;
      diagnostics.push({
        reason: 'prefix search budget',
        free: system.free.length,
      });
      continue;
    }
    const limit = 1 << system.free.length;
    for (let f = 0; f < limit; f++) {
      if ((f & 255) === 0) checkpoint();
      const bits = system.solve(BigInt(f)),
        values = new Map(bases);
      variables.forEach((v, i) => {
        if (bits & (1n << BigInt(i))) values.set(v.j, values.get(v.j) ^ v.diff);
      });
      if ([...domains].some(([j, domain]) => !domain.includes(values.get(j)))) continue;
      const result = out.slice();
      for (const [j, ps] of positions) for (const p of ps) result[p] = cipher[p] ^ values.get(j);
      if (crc(result, 0, 58) !== 0 || crc(result, 58, secondEnd) !== 0)
        fail('Internal CRC solver error');
      if (!successes.some((previous) => previous.subarray(0, 128).every((b, i) => b === result[i])))
        successes.push(result);
      if (successes.length > 1) break;
    }
    if (successes.length > 1) break;
  }
  if (successes.length !== 1 || unresolved) {
    const error = new Error(`Prefix is not unique (${successes.length}, unresolved ${unresolved})`);
    error.diagnostics = diagnostics;
    error.unresolved = unresolved;
    error.ambiguities =
      successes.length > 1
        ? [...successes[0].subarray(0, 128)].flatMap((b, i) => (b === successes[1][i] ? [] : [i]))
        : [];
    throw error;
  }
  return {
    prefix: successes[0].slice(0, 128),
    data: unknownBodyBytes ? null : successes[0],
    unknownBodyBytes,
    diagnostics,
  };
}
export { publicPrefix };
