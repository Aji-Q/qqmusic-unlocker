const N = 5120,
  STREAM = 5631;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  n <<= 24;
  for (let k = 0; k < 8; k++) n = (n << 1) ^ (n < 0 ? 0x04c11db7 : 0);
  return n >>> 0;
});
const step = (crc, v) => ((crc << 8) ^ crcTable[(crc >>> 24) ^ v]) >>> 0;
const skip = (h, s, v) => (v ? Math.trunc((h / ((s + 1) * v)) * 100) & 511 : 0);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
export function completeStream(cipher, observations, candidate, options = {}) {
  const checkpoint = options.checkpoint ?? (() => {});
  const known = new Map(observations.known),
    shifts = new Map(observations.shifts),
    { hash, reference, choices } = candidate;
  for (let seg = 0; seg * N < cipher.length; seg++) {
    const ds = new Set(choices[seg & 511].map((v) => skip(hash, seg, v) - reference));
    if (ds.size === 1) {
      const [d] = ds;
      if (shifts.has(seg) && shifts.get(seg) !== d) throw new Error('shift mismatch');
      shifts.set(seg, d);
    }
  }
  const read = (o, n) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const at = o + i,
        seg = Math.floor(at / N);
      if (!shifts.has(seg) || !known.has((at % N) + shifts.get(seg))) return null;
      b[i] = cipher[at] ^ known.get((at % N) + shifts.get(seg));
    }
    return b;
  };
  const frames = [],
    packetStarts = [],
    ordered = [...observations.pages].sort((a, b) => a.offset - b.offset);
  for (let pageIndex = 0; pageIndex < ordered.length; pageIndex++) {
    checkpoint();
    const start = ordered[pageIndex].offset,
      count = read(start + 26, 1)?.[0],
      lace = count ? read(start + 27, count) : null,
      flag = read(start + 5, 1)?.[0];
    let end;
    if (lace) {
      end = start + 27 + lace.length + lace.reduce((a, b) => a + b, 0);
      let pos = start + 27 + lace.length,
        beginning = flag !== undefined && !(flag & 1);
      for (const n of lace) {
        if (beginning && n > 0) packetStarts.push(pos);
        pos += n;
        beginning = n < 255;
      }
    }
    const seq = read(start + 18, 4),
      next = ordered[pageIndex + 1],
      nextSeq = next && read(next.offset + 18, 4);
    let boundary;
    if (seq && nextSeq && u32(nextSeq, 0) === u32(seq, 0) + 1) boundary = next.offset;
    else if (!next && flag !== undefined && flag & 4) boundary = cipher.length;
    if (end !== undefined && boundary !== undefined && end !== boundary)
      throw new Error('bad page boundary');
    end ??= boundary;
    if (end === undefined) continue;
    if (end > cipher.length || end <= start + 27 || end - start > 65307)
      throw new Error('bad page boundary');
    let aligned = true;
    for (let seg = Math.floor(start / N); seg <= Math.floor((end - 1) / N); seg++)
      if (!shifts.has(seg)) aligned = false;
    if (aligned) frames.push([start, end]);
  }
  const unknown = [];
  for (let i = -reference; i < STREAM - reference; i++) if (!known.has(i)) unknown.push(i);
  if (unknown.length > 2048 || frames.length > 100000) throw new Error('equation budget');
  const vars = new Map(unknown.map((j, i) => [j, i * 8])),
    nbits = unknown.length * 8,
    words = Math.ceil(nbits / 32),
    pivots = new Array(nbits),
    rhs = new Uint8Array(nbits);
  let rank = 0,
    valid = 0,
    packetBits = 0;
  const addRow = (row, value) => {
    let w = words - 1;
    while (w >= 0) {
      if (!row[w]) {
        w--;
        continue;
      }
      const p = w * 32 + 31 - Math.clz32(row[w]);
      if (!pivots[p]) {
        pivots[p] = row;
        rhs[p] = value;
        rank++;
        return;
      }
      for (let i = 0; i <= w; i++) row[i] ^= pivots[p][i];
      value ^= rhs[p];
    }
    if (value) throw new Error('contradictory CRC/packet equations');
  };
  for (const [j, mask, value] of observations.knownBits ?? []) {
    if (known.has(j)) {
      if ((known.get(j) & mask) !== value) throw new Error('inconsistent known bits');
      continue;
    }
    const index = vars.get(j);
    if (index === undefined) throw new Error('known bits out of Q range');
    for (let bit = 0; bit < 8; bit++)
      if (mask & (1 << bit)) {
        const row = new Uint32Array(words),
          p = index + bit;
        row[p >>> 5] |= 1 << (p & 31);
        addRow(row, (value >> bit) & 1);
      }
  }
  for (const off of packetStarts) {
    const seg = Math.floor(off / N);
    if (!shifts.has(seg)) continue;
    const j = (off % N) + shifts.get(seg),
      value = cipher[off] & 1;
    if (known.has(j)) {
      if ((known.get(j) & 1) !== value) throw new Error('bad Vorbis packet type');
      continue;
    }
    const idx = vars.get(j);
    if (idx === undefined) throw new Error('out of Q range');
    const row = new Uint32Array(words);
    row[idx >>> 5] |= 1 << (idx & 31);
    addRow(row, value);
    packetBits++;
  }
  const maxLen = frames.reduce((m, [a, b]) => Math.max(m, b - a), 0);
  if (!Number.isFinite(maxLen)) throw new Error('no complete frames');
  const influence = new Uint32Array(maxLen * 8);
  for (let b = 0; b < 8; b++) influence[b] = crcTable[1 << b];
  for (let d = 1; d < maxLen; d++)
    for (let b = 0; b < 8; b++) influence[d * 8 + b] = step(influence[(d - 1) * 8 + b], 0);
  for (const [start, end] of frames) {
    checkpoint();
    const rows = Array.from({ length: 32 }, () => new Uint32Array(words));
    let crc = 0,
      stored = 0,
      miss = 0;
    for (let off = start; off < end; off++) {
      const j = (off % N) + shifts.get(Math.floor(off / N)),
        at = off - start,
        v = cipher[off] ^ (known.get(j) || 0);
      if (at >= 22 && at < 26) {
        stored ^= v << ((at - 22) * 8);
        crc = step(crc, 0);
      } else crc = step(crc, v);
      if (known.has(j)) continue;
      miss++;
      const idx = vars.get(j);
      if (idx === undefined) throw new Error('out of Q range');
      for (let bit = 0; bit < 8; bit++) {
        let effect =
          at >= 22 && at < 26
            ? (1 << ((at - 22) * 8 + bit)) >>> 0
            : influence[(end - off - 1) * 8 + bit];
        const word = (idx + bit) >>> 5,
          mask = 1 << ((idx + bit) & 31);
        while (effect) {
          const row = 31 - Math.clz32(effect & -effect);
          rows[row][word] ^= mask;
          effect = (effect & (effect - 1)) >>> 0;
        }
      }
    }
    crc = (crc ^ stored) >>> 0;
    if (!miss) {
      if (crc) throw new Error('bad original CRC');
      valid++;
    }
    for (let bit = 0; bit < 32; bit++) addRow(rows[bit], (crc >>> bit) & 1);
    if (rank === nbits) break;
  }
  // Project pivot variables on free variables, retaining only genuinely unique bytes.
  const free = [];
  for (let i = 0; i < nbits; i++) if (!pivots[i]) free.push(i);
  const freeMap = new Map(free.map((v, i) => [v, i])),
    fw = Math.ceil(free.length / 32),
    deps = new Array(nbits),
    values = new Uint8Array(nbits),
    solved = new Uint8Array(nbits);
  for (let p = 0; p < nbits; p++) {
    if ((p & 63) === 0) checkpoint();
    const dep = new Uint32Array(fw);
    deps[p] = dep;
    if (!pivots[p]) {
      const v = freeMap.get(p);
      dep[v >>> 5] |= 1 << (v & 31);
      continue;
    }
    let value = rhs[p];
    const row = pivots[p];
    for (let w = 0; w <= p >>> 5; w++) {
      let bits = row[w];
      if (w === p >>> 5) bits = (bits & ~(1 << (p & 31))) >>> 0;
      while (bits) {
        const b = 31 - Math.clz32(bits & -bits),
          i = w * 32 + b;
        value ^= values[i];
        for (let k = 0; k < fw; k++) dep[k] ^= deps[i][k];
        bits = (bits & (bits - 1)) >>> 0;
      }
    }
    values[p] = value;
    solved[p] = dep.every((x) => !x) ? 1 : 0;
  }
  let added = 0;
  for (let i = 0; i < unknown.length; i++)
    if (solved.subarray(i * 8, i * 8 + 8).every((x) => x)) {
      let byte = 0;
      for (let k = 0; k < 8; k++) byte |= values[i * 8 + k] << k;
      known.set(unknown[i], byte);
      added++;
    }
  return {
    known,
    shifts,
    system: options.system ? { unknown, pivots, rhs, frames } : undefined,
    stats: {
      frames: frames.length,
      packetBits,
      valid,
      rank,
      variables: nbits,
      free: free.length,
      newQ: added,
      known: known.size,
      shifts: shifts.size,
    },
  };
}
