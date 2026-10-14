/** File-only recovery from repeated FLAC padding and original frame checksums. */
import { recoverHashCandidates, recoverKeyFromCandidates } from './file-only-key.js';
import { parseFlacHeader } from './file-only-flac-verify.js';

const SEGMENT = 5120;
const STREAM = 5631;
const MAX_FRAME = 256 * 1024;
const crcTable = Uint16Array.from({ length: 256 }, (_, n) => {
  let value = n << 8;
  for (let bit = 0; bit < 8; bit += 1) {
    value = ((value << 1) ^ (value & 0x8000 ? 0x8005 : 0)) & 0xffff;
  }
  return value;
});

function unsupported() {
  const error = new Error('暂时无法仅凭此文件转换');
  error.code = 'file_only_unsupported';
  error.hint = '此文件不符合当前恢复条件。';
  throw error;
}

function skip(hash, segment, seed) {
  return seed ? Math.trunc((hash / ((segment + 1) * seed)) * 100) & 511 : 0;
}

function crcByte(crc, value) {
  return ((crc << 8) & 65535) ^ crcTable[(crc >>> 8) ^ value];
}

// A long repeated ciphertext run in adjacent segments can expose zero padding.
// This is only a hypothesis: original frame CRCs, regenerated PRGA, key hash,
// original metadata and the complete final FLAC must all independently agree.
function paddingCandidates(data) {
  if (data.length < SEGMENT * 3) return [];
  const words = new Map();
  const word = offset => ((data[offset] << 24) | (data[offset + 1] << 16)
    | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
  for (let offset = 128; offset < SEGMENT - 16; offset += 1) {
    const key = word(offset);
    if (!words.has(key)) words.set(key, []);
    const positions = words.get(key);
    if (positions.length < 8) positions.push(offset);
  }
  const candidates = [];
  for (let target = SEGMENT; target < SEGMENT * 2 - 16; target += 1) {
    for (const source of words.get(word(target)) || []) {
      if (source > 128 && target > SEGMENT && data[source - 1] === data[target - 1]) continue;
      let length = 0;
      while (source + length < SEGMENT && target + length < SEGMENT * 2
          && data[source + length] === data[target + length]) length += 1;
      if (length < 1024) continue;
      const delta = source - (target - SEGMENT);
      if (Math.abs(delta) > 511) continue;
      const known = new Map();
      for (let offset = source; offset < SEGMENT; offset += 1) known.set(offset, data[offset]);
      let consistent = true;
      for (let offset = SEGMENT; offset < target + length; offset += 1) {
        const index = offset - SEGMENT + delta;
        if (known.has(index) && known.get(index) !== data[offset]) { consistent = false; break; }
        known.set(index, data[offset]);
      }
      if (consistent && known.size >= 5000 && known.size <= STREAM) {
        candidates.push({ known, shifts: new Map([[0, 0], [1, delta]]) });
        if (candidates.length === 4) return candidates;
      }
    }
  }
  return candidates;
}

function findHeaders(data, candidate, checkBudget) {
  const { known, shifts } = candidate;
  const deltas = [...shifts.values()];
  const low = Math.max(...deltas) - 511;
  const high = Math.min(...deltas) + 511;
  const patterns = new Map();
  for (const [index, value] of known) {
    if (!known.has(index + 1)) continue;
    const pattern = ((value ^ 255) << 8) | (known.get(index + 1) ^ 248);
    if (!patterns.has(pattern)) patterns.set(pattern, []);
    patterns.get(pattern).push(index);
  }
  const groups = new Map();
  const scratch = new Uint8Array(16);
  let attempts = 0;
  let headerCount = 0;
  for (let offset = 128; offset < data.length - 16; offset += 1) {
    if ((offset & 0xfffff) === 0) checkBudget();
    const relative = offset % SEGMENT;
    if (relative > SEGMENT - 16) continue;
    for (const index of patterns.get((data[offset] << 8) | data[offset + 1]) || []) {
      attempts += 1;
      if (attempts > 20000000) unsupported();
      if ((attempts & 4095) === 0) checkBudget();
      const delta = index - relative;
      if (delta < low || delta > high) continue;
      let complete = true;
      for (let i = 0; i < 16; i += 1) {
        if (!known.has(index + i)) { complete = false; break; }
        scratch[i] = data[offset + i] ^ known.get(index + i);
      }
      if (!complete) continue;
      const header = parseFlacHeader(scratch);
      if (!header || header.variable || header.number > 50000) continue;
      if (++headerCount > 32000) unsupported();
      const signature = `${header.blockCode}/${header.rateCode}/${header.depthCode}`;
      if (!groups.has(signature)) groups.set(signature, []);
      const headers = groups.get(signature);
      if (headers.length >= 20000) unsupported();
      headers.push({ ...header, offset, segment: Math.floor(offset / SEGMENT), shift: delta });
    }
  }
  const headers = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!headers || headers.length < 64) return null;
  // The overwhelming coherent sequence distinguishes audio from chance CRC8 hits.
  if (headers.length < (headers.at(-1).number - headers[0].number + 1) * 0.75) return null;
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    if (i && (header.number <= headers[i - 1].number || header.number - headers[i - 1].number > 16)) return null;
    if (shifts.has(header.segment) && shifts.get(header.segment) !== header.shift) return null;
    shifts.set(header.segment, header.shift);
  }
  return { ...candidate, headers };
}

function framePairs(headers) {
  const frames = [];
  for (let i = 0; i < headers.length - 1; i += 1) {
    const a = headers[i];
    const b = headers[i + 1];
    if (b.number === a.number + 1 && b.offset - a.offset <= MAX_FRAME) frames.push([a.offset, b.offset]);
  }
  return frames;
}

// CRC16 is linear over bits. Solve the missing common stream bytes using the
// original CRC bytes already present in complete frames. Never rewrite a CRC.
function completeStream(data, observation, candidate, checkBudget) {
  const known = new Map(observation.known);
  const shifts = new Map(observation.shifts);
  const { hash, reference, choices } = candidate;
  for (let segment = 0; segment * SEGMENT < data.length; segment += 1) {
    const possibilities = new Set(choices[segment & 511].map(seed => skip(hash, segment, seed) - reference));
    if (possibilities.size !== 1) continue;
    const [delta] = possibilities;
    if (shifts.has(segment) && shifts.get(segment) !== delta) unsupported();
    shifts.set(segment, delta);
  }
  const frames = framePairs(observation.headers).filter(([start, end]) => {
    for (let segment = Math.floor(start / SEGMENT); segment <= Math.floor((end - 1) / SEGMENT); segment += 1) {
      if (!shifts.has(segment)) return false;
    }
    return true;
  });
  if (frames.length < 32) unsupported();
  const unknown = [];
  for (let index = -reference; index < STREAM - reference; index += 1) {
    if (!known.has(index)) unknown.push(index);
  }
  if (unknown.length > 631) unsupported();
  const variables = new Map(unknown.map((index, i) => [index, i * 8]));
  const variableCount = unknown.length * 8;
  const words = Math.ceil(variableCount / 32);
  const pivots = new Array(variableCount);
  const answers = new Uint8Array(variableCount);
  let rank = 0;
  const maxLength = Math.max(...frames.map(([start, end]) => end - start));
  const influence = new Uint16Array(maxLength * 8);
  for (let bit = 0; bit < 8; bit += 1) influence[bit] = crcTable[1 << bit];
  for (let distance = 1; distance < maxLength; distance += 1) {
    for (let bit = 0; bit < 8; bit += 1) influence[distance * 8 + bit] = crcByte(influence[(distance - 1) * 8 + bit], 0);
  }
  for (const [start, end] of frames) {
    checkBudget();
    const rows = Array.from({ length: 16 }, () => new Uint32Array(words));
    let crc = 0;
    for (let offset = start; offset < end; offset += 1) {
      const index = offset % SEGMENT + shifts.get(Math.floor(offset / SEGMENT));
      crc = crcByte(crc, data[offset] ^ (known.get(index) || 0));
      if (known.has(index)) continue;
      const variable = variables.get(index);
      if (variable === undefined) unsupported();
      for (let bit = 0; bit < 8; bit += 1) {
        let value = influence[(end - offset - 1) * 8 + bit];
        const mask = (1 << ((variable + bit) & 31)) >>> 0;
        const word = (variable + bit) >>> 5;
        while (value) {
          const row = 31 - Math.clz32(value & -value);
          rows[row][word] ^= mask;
          value &= value - 1;
        }
      }
    }
    for (let bit = 0; bit < 16; bit += 1) {
      const row = rows[bit];
      let answer = (crc >>> bit) & 1;
      let word = words - 1;
      while (word >= 0) {
        if (!row[word]) { word -= 1; continue; }
        const pivot = word * 32 + 31 - Math.clz32(row[word]);
        if (!pivots[pivot]) {
          pivots[pivot] = row; answers[pivot] = answer; rank += 1; break;
        }
        for (let i = 0; i <= word; i += 1) row[i] ^= pivots[pivot][i];
        answer ^= answers[pivot];
      }
      if (word < 0 && answer) unsupported();
    }
    if (rank === variableCount) break;
  }
  if (rank !== variableCount) unsupported();
  const solved = new Uint8Array(variableCount);
  for (let pivot = 0; pivot < variableCount; pivot += 1) {
    const row = pivots[pivot];
    let answer = answers[pivot];
    for (let bit = 0; bit < pivot; bit += 1) {
      if ((row[bit >>> 5] >>> (bit & 31)) & 1) answer ^= solved[bit];
    }
    solved[pivot] = answer;
  }
  for (let i = 0; i < unknown.length; i += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value |= solved[i * 8 + bit] << bit;
    known.set(unknown[i], value);
  }
  return known;
}

function refineSeeds(data, headers, known, candidate, checkBudget) {
  const { hash, reference } = candidate;
  const choices = candidate.choices.map(values => values.slice());
  const stream = Uint8Array.from({ length: STREAM }, (_, index) => known.get(index - reference));
  let tests = 0;
  const frames = framePairs(headers);
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const [start, end] of frames) {
      checkBudget();
      const groups = new Set();
      for (let segment = Math.floor(start / SEGMENT); segment <= Math.floor((end - 1) / SEGMENT); segment += 1) {
        if (choices[segment & 511].length > 1) groups.add(segment & 511);
      }
      if (groups.size !== 1) continue;
      const [target] = groups;
      const kept = [];
      for (const candidateSeed of choices[target]) {
        if (++tests > 100000) unsupported();
        let crc = 0;
        for (let offset = start; offset < end;) {
          const segment = Math.floor(offset / SEGMENT);
          const limit = Math.min(end, (segment + 1) * SEGMENT);
          const seed = (segment & 511) === target ? candidateSeed : choices[segment & 511][0];
          const delta = skip(hash, segment, seed);
          while (offset < limit) {
            crc = crcByte(crc, data[offset] ^ stream[offset % SEGMENT + delta]);
            offset += 1;
          }
        }
        if (crc === 0) kept.push(candidateSeed);
      }
      if (!kept.length) unsupported();
      if (kept.length < choices[target].length) { choices[target] = kept; changed = true; }
    }
    if (!changed) break;
  }
  return { ...candidate, choices };
}

/** Return null quickly for files without a credible FLAC padding/header seed. */
export function recoverFlacKey(data, onProgress = () => {}) {
  if (!(data instanceof Uint8Array) || data.length > 100 * 1024 * 1024) unsupported();
  const deadline = performance.now() + 90000;
  const checkBudget = () => { if (performance.now() > deadline) unsupported(); };
  let progress = 0;
  const report = value => { progress = Math.max(progress, value); onProgress(progress); checkBudget(); };
  const padding = paddingCandidates(data);
  let credible = false;
  for (const initial of padding) {
    checkBudget();
    try {
      const observation = findHeaders(data, initial, checkBudget);
      if (!observation) continue;
      credible = true;
      report(0.12);
      const candidates = recoverHashCandidates(observation, value => report(0.12 + value * 0.35));
      if (candidates.length > 8) unsupported();
      const recovered = [];
      for (const candidate of candidates) {
        try {
          // Some inputs already determine the key. Unused stream positions
          // need not have independent CRC equations when the full key can
          // regenerate thousands of inferred bytes and pass final FLAC checks.
          if (candidate.choices.reduce((count, values) => count * values.length, 1) <= 4096) {
            try {
              recovered.push(recoverKeyFromCandidates({ known: observation.known, candidates: [candidate] }));
              continue;
            } catch (error) {
              if (error.code !== 'file_only_unsupported') throw error;
            }
          }
          const known = completeStream(data, observation, candidate, checkBudget);
          report(0.65);
          const refined = refineSeeds(data, observation.headers, known, candidate, checkBudget);
          const key = recoverKeyFromCandidates({ known, candidates: [refined] }, value => report(0.8 + value * 0.2));
          recovered.push(key);
        } catch (error) {
          if (error.code !== 'file_only_unsupported') throw error;
        }
      }
      if (recovered.length !== 1) unsupported();
      report(1);
      return recovered[0];
    } catch (error) {
      if (error.code !== 'file_only_unsupported') throw error;
    }
  }
  if (credible) unsupported();
  return null;
}
