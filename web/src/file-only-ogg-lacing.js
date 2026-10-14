const N = 5120,
  MAX_TARGET = 65535,
  MAX_GROUPS = 16;
function invalid() {
  const e = new Error('原始 Ogg 页长度约束不一致');
  e.code = 'file_only_unsupported';
  throw e;
}
const full = () => new Set(Array.from({ length: 256 }, (_, i) => i));
const equal = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));
function reachable(profiles, target, checkpoint, exclude = -1) {
  if (!Number.isInteger(target) || target < 0 || target > MAX_TARGET) return 0n;
  const cap = (1n << BigInt(target + 1)) - 1n;
  let reach = 1n;
  for (let n = 0; n < profiles.length; n++) {
    checkpoint();
    if (n === exclude) continue;
    let updated = 0n;
    for (const total of profiles[n].keys()) {
      checkpoint();
      if (total <= target) updated |= reach << BigInt(total);
    }
    reach = updated & cap;
    if (!reach) break;
  }
  return reach;
}
export function refineLacing(data, observation, checkpoint = () => {}) {
  if (!(data instanceof Uint8Array) || data.length > 100 * 1024 * 1024) invalid();
  const known = new Map(observation.known),
    shifts = new Map(observation.shifts),
    domains = new Map((observation.lacingDomains ?? []).map(([j, v]) => [j, new Set(v)]));
  // CRC completion may have fixed a byte since these domains were collected.
  // Intersect that new evidence instead of overwriting it with a stale domain.
  for (const [j, values] of domains) {
    checkpoint();
    if (!values.size) invalid();
    if (known.has(j)) {
      const value = known.get(j);
      if (!values.has(value)) invalid();
      domains.set(j, new Set([value]));
    }
  }
  for (const [j, mask, value] of observation.knownBits ?? []) {
    checkpoint();
    if (known.has(j)) {
      if ((known.get(j) & mask) !== value) invalid();
      continue;
    }
    const values = domains.get(j) ?? full();
    domains.set(j, new Set([...values].filter((v) => (v & mask) === value)));
    if (!domains.get(j).size) invalid();
  }
  const before = known.size;
  const qi = (off) => {
    const delta = shifts.get(Math.floor(off / N));
    return delta === undefined ? null : (off % N) + delta;
  };
  const read = (off, count) => {
    if (off < 128 || off + count > data.length) return null;
    const b = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const j = qi(off + i);
      if (j === null || !known.has(j)) return null;
      b[i] = data[off + i] ^ known.get(j);
    }
    return b;
  };
  const number = (bytes) =>
    bytes === null
      ? null
      : (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const pages = [...observation.pages].sort((a, b) => a.offset - b.offset);
  if (pages.length > 100000) invalid();
  const boundary = (n) => {
    const start = pages[n].offset,
      seq = number(read(start + 18, 4));
    if (seq === null) return null;
    let end;
    if (n + 1 < pages.length) {
      end = pages[n + 1].offset;
      if (number(read(end + 18, 4)) !== seq + 1) return null;
    } else {
      const flag = read(start + 5, 1);
      if (!flag || !(flag[0] & 4)) return null;
      end = data.length;
    }
    if (end <= start + 27 || end > data.length) invalid();
    return { start, end, seq };
  };
  const profile = (groups) =>
    [...groups].map(([j, ciphers]) => {
      checkpoint();
      const sums = new Map();
      for (const value of domains.get(j) ?? full()) {
        checkpoint();
        const total = ciphers.reduce((sum, c) => sum + (c ^ value), 0);
        const values = sums.get(total) ?? new Set();
        values.add(value);
        sums.set(total, values);
      }
      return sums;
    });
  const group = (start, count, countIndex = null, countValue = null) => {
    let sum = 0;
    const groups = new Map();
    for (let off = start + 27; off < start + 27 + count; off++) {
      checkpoint();
      const j = qi(off);
      if (j === null) return null;
      if (j === countIndex) sum += data[off] ^ countValue;
      else if (known.has(j)) sum += data[off] ^ known.get(j);
      else {
        const ciphers = groups.get(j) ?? [];
        ciphers.push(data[off]);
        groups.set(j, ciphers);
      }
    }
    return { sum, groups };
  };
  let countRecovered = 0;
  for (let n = 0; n < pages.length; n++) {
    checkpoint();
    const b = boundary(n);
    if (!b || read(b.start + 26, 1)) continue;
    const index = qi(b.start + 26);
    if (index === null) continue;
    const allowed = domains.get(index) ?? full(),
      keep = new Set();
    const minimum = Math.max(1, Math.ceil((b.end - b.start - 27) / 256)),
      maximum = Math.min(255, b.end - b.start - 27);
    for (let count = minimum; count <= maximum; count++) {
      checkpoint();
      const value = data[b.start + 26] ^ count;
      if (!allowed.has(value)) continue;
      const g = group(b.start, count, index, value);
      if (!g) continue;
      const target = b.end - b.start - 27 - count - g.sum;
      if (target < 0 || target > MAX_TARGET) continue;
      const profiles = profile(g.groups);
      let min = 0,
        max = 0;
      for (const p of profiles) {
        min += Math.min(...p.keys());
        max += Math.max(...p.keys());
      }
      if (target < min || target > max) continue;
      if (
        g.groups.size > MAX_GROUPS ||
        (reachable(profiles, target, checkpoint) >> BigInt(target)) & 1n
      )
        keep.add(value);
    }
    if (!keep.size) invalid();
    domains.set(index, keep);
    if (keep.size === 1) {
      known.set(index, [...keep][0]);
      countRecovered++;
    }
  }
  const constraints = [];
  for (let n = 0; n < pages.length; n++) {
    checkpoint();
    const b = boundary(n);
    if (!b) continue;
    const count = read(b.start + 26, 1)?.[0];
    if (count === undefined) continue;
    if (!count) invalid();
    const g = group(b.start, count);
    if (!g) continue;
    const target = b.end - b.start - 27 - count - g.sum;
    if (target < 0 || target > 255 * count || target > MAX_TARGET) invalid();
    if (!g.groups.size) {
      if (target) invalid();
      continue;
    }
    for (const j of g.groups.keys()) if (!domains.has(j)) domains.set(j, full());
    constraints.push({ target, groups: g.groups });
  }
  let changed = true,
    rounds = 0;
  while (changed) {
    checkpoint();
    if (++rounds > 256) invalid();
    changed = false;
    for (const { target, groups } of constraints) {
      checkpoint();
      if (groups.size > MAX_GROUPS) continue;
      const keys = [...groups.keys()],
        profiles = profile(groups),
        survivors = keys.map(() => new Set());
      for (let k = 0; k < keys.length; k++) {
        checkpoint();
        const reach = reachable(profiles, target, checkpoint, k);
        for (const [total, values] of profiles[k]) {
          checkpoint();
          if (total <= target && (reach >> BigInt(target - total)) & 1n)
            for (const v of values) survivors[k].add(v);
        }
      }
      for (let k = 0; k < keys.length; k++) {
        const j = keys[k],
          keep = survivors[k];
        if (!keep.size) invalid();
        if (!equal(keep, domains.get(j))) {
          domains.set(j, keep);
          changed = true;
        }
      }
    }
  }
  const bits = [];
  for (const [j, values] of domains) {
    checkpoint();
    if (values.size === 1) {
      known.set(j, [...values][0]);
      continue;
    }
    const first = [...values][0];
    let mask = 255;
    for (const v of values) mask &= ~(first ^ v) & 255;
    if (mask) bits.push([j, mask, first & mask]);
  }
  return {
    ...observation,
    known: [...known],
    knownBits: bits,
    lacingDomains: [...domains]
      .filter(([j]) => !known.has(j))
      .map(([j, v]) => [j, [...v].sort((a, b) => a - b)]),
    lacingStats: {
      newQ: known.size - before,
      countRecovered,
      constraints: constraints.length,
      rounds,
      partialVariables: bits.length,
      partialBits: bits.reduce((n, [, mask]) => n + mask.toString(2).replaceAll('0', '').length, 0),
    },
  };
}
