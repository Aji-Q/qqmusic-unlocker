/** Recover a QMC2 RC4 key from repeated segment skips. No external key source. */
const MAX_HASH = 0xffffffff;
const PERIOD = 512;
const MAX_SEGMENTS = 100 * 1024 * 1024 / 5120;

function unsupported() {
  const error = new Error('暂时无法仅凭此文件转换');
  error.code = 'file_only_unsupported';
  error.hint = '此文件不符合当前恢复条件。';
  throw error;
}

function skip(hash, segment, seed) {
  return seed ? Math.trunc((hash / ((segment + 1) * seed)) * 100) & 511 : 0;
}

function matchingSeeds(hash, observations) {
  const choices = [];
  for (let seed = 0; seed < 256; seed += 1) {
    if (observations.every(([segment, value]) => skip(hash, segment, seed) === value)) {
      choices.push(seed);
    }
  }
  return choices;
}

function keyHash(key) {
  let hash = 1;
  for (const value of key) {
    if (!value) continue;
    const next = (hash * value) >>> 0;
    if (!next || next <= hash) break;
    hash = next;
  }
  return hash;
}

function streamMatches(key, known, reference) {
  const state = Uint8Array.from({ length: PERIOD }, (_, i) => i & 255);
  let j = 0;
  for (let i = 0; i < PERIOD; i += 1) {
    j = (j + state[i] + key[i]) % PERIOD;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let a = 0;
  let b = 0;
  let compared = 0;
  for (let i = 0; i < 5631; i += 1) {
    a = (a + 1) % PERIOD;
    b = (b + state[a]) % PERIOD;
    [state[a], state[b]] = [state[b], state[a]];
    if (known.has(i - reference)) {
      compared += 1;
      if (state[(state[a] + state[b]) % PERIOD] !== known.get(i - reference)) return false;
    }
  }
  return compared >= 128;
}

/**
 * Solve the public skip formula using each seed's observations 512 segments apart.
 * The recovered key must regenerate the original hash and independently inferred
 * stream. A matching file header alone never accepts a candidate.
 */
export function recoverFileKey({ known, shifts }, onProgress = () => {}) {
  if (!(known instanceof Map) || !(shifts instanceof Map) || known.size < 128
      || known.size > 5631 || shifts.size > MAX_SEGMENTS) unsupported();
  for (const [index, value] of known) {
    if (!Number.isInteger(index) || index < -511 || index > 5630
        || !Number.isInteger(value) || value < 0 || value > 255) unsupported();
  }
  for (const [segment, delta] of shifts) {
    if (!Number.isInteger(segment) || segment < 0 || segment >= MAX_SEGMENTS
        || !Number.isInteger(delta) || Math.abs(delta) > 511
        || (segment === 0 && delta !== 0)) unsupported();
  }
  const deadline = performance.now() + 30_000;
  let tCandidates = 0;
  let hashTests = 0;
  let keyTests = 0;
  const checkBudget = () => {
    if (performance.now() > deadline || tCandidates > 30_000_000
        || hashTests > 2_000_000 || keyTests > 4096) unsupported();
  };
  const deltas = [...shifts.values(), 0];
  const low = Math.max(0, -Math.min(...deltas));
  const high = Math.min(511, 511 - Math.max(...deltas));
  if (low > high || high - low > 32) unsupported();
  const recovered = [];
  let progress = 0;
  const reportProgress = (value) => {
    progress = Math.max(progress, value);
    onProgress(progress);
    checkBudget();
  };
  for (let reference = low; reference <= high; reference += 1) {
    checkBudget();
    const groups = Array.from({ length: PERIOD }, () => []);
    groups[0].push([0, reference]);
    for (const [segment, delta] of shifts) {
      if (segment === 0) continue;
      const value = delta + reference;
      if (value < 0 || value > 511) unsupported();
      groups[segment & 511].push([segment, value]);
    }
    for (const group of groups) group.sort((a, b) => a[0] - b[0]);
    if (groups.some(group => group.length < 1)) unsupported();
    // A zero seed gives no hash information. Use another early residue group
    // with four observations, rather than assuming key[0] must be nonzero.
    const anchor = groups.findIndex(group => group.length >= 4 && group[0][0] <= 7
      && group.some(([, value]) => value !== 0));
    if (anchor < 0) unsupported();
    const first = groups[anchor];
    const enumerateHashes = (tolerance) => {
      const [firstSegment, firstSkip] = first[0];
      const [lastSegment, lastSkip] = first.at(-1);
      const firstDenominator = firstSegment + 1;
      const denominator = lastSegment + 1;
      const cycle = firstDenominator * PERIOD;
      const maxT = MAX_HASH * 100;
      const hashes = new Set();
      const maxM = Math.floor(maxT / (denominator * PERIOD));
      const offsets = tolerance ? [-1, 0, 1] : [0];
      for (let m = 0; m <= maxM; m += 1) {
        for (const lastOffset of offsets) {
          const lastResidue = (lastSkip + lastOffset + PERIOD) % PERIOD;
          const start = denominator * (PERIOD * m + lastResidue);
          const end = Math.min(maxT, start + denominator - 1);
          for (const firstOffset of offsets) {
            const firstResidue = (firstSkip + firstOffset + PERIOD) % PERIOD;
            const base = firstDenominator * firstResidue;
            // Intersect floor(T / firstDenominator) mod 512 windows with
            // the final observation's interval; works for any early seed.
            const n = Math.max(0, Math.ceil((start - base - firstDenominator + 1) / cycle));
            for (let window = base + n * cycle; window <= end; window += cycle) {
              const lastT = Math.min(end, window + firstDenominator - 1);
              for (let t = Math.max(start, window); t <= lastT; t += 1) {
                tCandidates += 1;
                if (!first.every(([segment, value]) => {
                  const residue = Math.floor(t / (segment + 1)) % PERIOD;
                  const difference = (residue - value + PERIOD) % PERIOD;
                  return difference <= tolerance || difference >= PERIOD - tolerance;
                })) continue;
                for (let seed = 1; seed < 256; seed += 1) {
                  const lower = Math.max(1, Math.ceil(t * seed / 100));
                  const upper = Math.min(MAX_HASH, Math.ceil((t + 1) * seed / 100) - 1);
                  for (let hash = lower; hash <= upper; hash += 1) {
                    hashTests += 1;
                    // The interval search only supplies candidates. Acceptance
                    // always uses the original IEEE-double skip formula.
                    if (first.every(([segment, value]) => skip(hash, segment, seed) === value)) hashes.add(hash);
                  }
                }
              }
            }
          }
        }
        if (m % 1024 === 0) {
          checkBudget();
          if (hashes.size > 10000) unsupported();
          if (m % 65536 === 0) reportProgress((reference - low
            + (tolerance + m / (maxM + 1)) / 2) / (high - low + 1) * 0.7);
        }
      }
      if (hashes.size > 10000) unsupported();
      return [...hashes];
    };
    const groupOrder = groups.map((observations, index) => ({ observations, index }))
      .filter(group => group.index !== anchor)
      .sort((a, b) => b.observations.length - a.observations.length);
    const countBefore = recovered.length;
    const testedHashes = new Set();
    // Usually the exact integer search succeeds. Retry adjacent rational
    // residues only when IEEE rounding might have excluded the true hash.
    for (const tolerance of [0, 1]) {
      let candidates = enumerateHashes(tolerance).filter(hash => !testedHashes.has(hash));
      for (const { observations } of groupOrder) {
        if (candidates.length <= 8) break;
        checkBudget();
        candidates = candidates.filter(hash => matchingSeeds(hash, observations).length > 0);
      }
      for (const hash of candidates) {
        checkBudget();
        testedHashes.add(hash);
        const choices = groups.map(observations => matchingSeeds(hash, observations));
        if (choices.some(values => values.length === 0)) continue;
        const combinations = choices.reduce((product, values) => product * values.length, 1);
        if (combinations > 4096) continue;
        const key = new Uint8Array(PERIOD);
        const visit = (index) => {
          if (index === PERIOD) {
            keyTests += 1;
            checkBudget();
            if (keyHash(key) === hash && streamMatches(key, known, reference)) recovered.push(key.slice());
            return;
          }
          for (const value of choices[index]) {
            key[index] = value;
            visit(index + 1);
          }
        };
        visit(0);
      }
      if (recovered.length > countBefore) break;
    }
    if (recovered.length > 1) unsupported();
  }
  if (recovered.length !== 1) unsupported();
  onProgress(1);
  return recovered[0];
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte << 24;
  for (let i = 0; i < 8; i += 1) value = (value << 1) ^ ((value >>> 31) ? 0x04c11db7 : 0);
  return value >>> 0;
});

/** Verify every ORIGINAL page checksum, including the recovered first 128 bytes. */
export function verifyRecoveredOgg(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  let sequence = 0;
  let serial;
  let lastGranule = 0n;
  let continued = false;
  let ended = false;
  while (offset < data.length) {
    if (ended || offset + 27 > data.length || data[offset] !== 79 || data[offset + 1] !== 103
        || data[offset + 2] !== 103 || data[offset + 3] !== 83 || data[offset + 4] !== 0) unsupported();
    const flags = data[offset + 5];
    const granule = view.getBigUint64(offset + 6, true);
    const currentSerial = view.getUint32(offset + 14, true);
    const currentSequence = view.getUint32(offset + 18, true);
    const expectedCrc = view.getUint32(offset + 22, true);
    const count = data[offset + 26];
    if (!count || offset + 27 + count > data.length || flags & ~7
        || Boolean(flags & 1) !== continued || Boolean(flags & 2) !== (sequence === 0)
        || currentSequence !== sequence || (serial !== undefined && serial !== currentSerial)) unsupported();
    let length = 27 + count;
    for (let i = 0; i < count; i += 1) length += data[offset + 27 + i];
    if (offset + length > data.length) unsupported();
    let crc = 0;
    for (let i = 0; i < length; i += 1) {
      const value = i >= 22 && i < 26 ? 0 : data[offset + i];
      crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ value) & 255]) >>> 0;
    }
    if (crc !== expectedCrc) unsupported();
    if (granule !== 0xffffffffffffffffn) {
      if (granule < lastGranule) unsupported();
      lastGranule = granule;
    }
    if (sequence === 0) {
      const p = offset + 27 + count;
      if (length !== 58 || count !== 1 || data[p] !== 1
          || String.fromCharCode(...data.subarray(p + 1, p + 7)) !== 'vorbis'
          || view.getUint32(p + 7, true) !== 0 || !data[p + 11]
          || !view.getUint32(p + 12, true) || data[p + 29] !== 1) unsupported();
    }
    serial = currentSerial;
    continued = data[offset + 26 + count] === 255;
    ended = Boolean(flags & 4);
    offset += length;
    sequence += 1;
  }
  if (sequence < 3 || !ended || continued) unsupported();
  return { pages: sequence };
}
