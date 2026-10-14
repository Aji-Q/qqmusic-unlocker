/** File-only recovery for the supported continuous Xiph VBR profile. */
import { recoverOggCandidates, refineRecovery } from './file-only-stream.js';
import { hashesFromHeader } from './file-only-ogg-hash.js';
import { pruneHashDomains } from './file-only-hash-domains.js';
import { completeStream } from './file-only-ogg-equations.js';
import { solvePrefix } from './file-only-ogg-prefix.js';
import { refineLacing } from './file-only-ogg-lacing.js';
import { refineWindows } from './file-only-ogg-windows.js';
import { verifyRecoveredOgg } from './file-only-key.js';
const BLOCK = 5120;
const MAX_WORKING_BYTES = 256 * 1024 * 1024,
  RECOVERY_RESERVE = 64 * 1024 * 1024;
const MAX_UNKNOWN_OCCURRENCES = 1_000_000;
function failure(message, code = 'recovery_unresolved', cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}
function rejected(message) {
  return failure(message, 'candidate_rejected');
}
// These are contradictions of already established bytes or original checksums.
// Every other failure remains unresolved, including resource or module failures.
const contradictions = new Set([
  'bad original CRC',
  'contradictory CRC/packet equations',
  'bad page boundary',
  'bad Vorbis packet type',
  'inconsistent known bits',
  'shift mismatch',
  'window mismatch',
  'window conflict',
  'previous window mismatch',
  'next window mismatch',
  'existing bit mismatch',
  '原始 Ogg 页长度约束不一致',
  '文件结构校验失败',
  '文件分段信息不一致',
  '文件流编号不一致',
  '文件页表校验失败',
  '文件页序不一致',
  '文件内容不完整',
]);
const isRejected = (error) =>
  error.code === 'candidate_rejected' || contradictions.has(error.message);
function memoryAllowance(length) {
  const allowance = MAX_WORKING_BYTES - RECOVERY_RESERVE - 4 * length;
  if (allowance < 0) throw failure('Short-file memory budget');
  return allowance;
}
const signature = (s) =>
  [
    s.known.length,
    s.shifts.length,
    s.pages.length,
    (s.knownBits ?? []).reduce((a, [, m]) => a + m, 0),
    (s.lacingDomains ?? []).reduce((a, [, v]) => a + v.length, 0),
  ].join(':');
function hashFor(cipher, state, checkpoint) {
  const { candidates } = hashesFromHeader(cipher, state, checkpoint);
  if (!candidates.length) throw failure('No compatible hash established');
  if (candidates.length !== 1) throw failure('Hash candidates unresolved');
  const p = pruneHashDomains(candidates[0], 1_000_000, checkpoint);
  if (!p.stats.solutions) throw rejected('No compatible hash');
  return p.candidate;
}
function improve(cipher, state, candidate, checkpoint) {
  const r = completeStream(cipher, state, candidate, { checkpoint });
  return refineRecovery(
    cipher,
    { ...state, known: [...r.known], shifts: [...r.shifts] },
    checkpoint,
  );
}
function resolveShifts(cipher, state, candidate, checkpoint) {
  const missing = [];
  let sh = new Map(state.shifts);
  for (let segment = 0; segment * BLOCK < cipher.length; segment++)
    if (!sh.has(segment)) {
      const options = [
        ...new Set(
          candidate.choices[segment & 511].map(
            (v) =>
              (v ? Math.trunc((candidate.hash / ((segment + 1) * v)) * 100) & 511 : 0) -
              candidate.reference,
          ),
        ),
      ];
      missing.push({ segment, options });
    }
  if (missing.length > 48) throw failure('Too many unresolved segments');
  missing.sort((a, b) => a.options.length - b.options.length);
  for (const { segment, options } of missing) {
    checkpoint();
    if (new Map(state.shifts).has(segment)) continue;
    let valid = 0,
      first = null;
    for (const delta of options) {
      checkpoint();
      try {
        const r = completeStream(
          cipher,
          { ...state, shifts: [...new Map(state.shifts), [segment, delta]] },
          candidate,
          { checkpoint },
        );
        valid++;
        first ??= r;
      } catch (error) {
        if (!isRejected(error)) throw error;
      }
    }
    if (valid === 0) throw rejected('No compatible segment');
    if (valid === 1) {
      const r = first;
      state = refineRecovery(
        cipher,
        { ...state, known: [...r.known], shifts: [...r.shifts] },
        checkpoint,
      );
    }
  }
  return state;
}
function initialBytes(cipher, state, prefix, checkpoint) {
  const known = new Map(state.known),
    shifts = new Map(state.shifts);
  const data = cipher.slice();
  data.set(prefix);
  for (let p = 128; p < data.length; p++) {
    if ((p & 65535) === 0) checkpoint();
    const delta = shifts.get(Math.floor(p / BLOCK));
    if (delta === undefined) throw failure('Missing segment');
    const j = (p % BLOCK) + delta;
    if (known.has(j)) data[p] ^= known.get(j);
  }
  return data;
}
function headerPackets(cipher, state, prefix) {
  const known = new Map(state.known),
    shifts = new Map(state.shifts),
    { commentStart, setup } = state.header ?? {};
  if (
    !Number.isInteger(commentStart) ||
    !Number.isInteger(setup?.start) ||
    !Number.isInteger(setup?.length)
  )
    throw failure('Unknown header boundaries');
  return [
    [28, 58],
    [commentStart, setup.start],
    [setup.start, setup.start + setup.length],
  ].map(([start, end]) => {
    if (start < 0 || end <= start || end > cipher.length || end - start > 131072)
      throw failure('Header packet budget or boundary');
    const data = new Uint8Array(end - start);
    for (let p = start; p < end; p++) {
      if (p < 128) {
        data[p - start] = prefix[p];
        continue;
      }
      const delta = shifts.get(Math.floor(p / BLOCK)),
        j = (p % BLOCK) + delta;
      if (delta === undefined || !known.has(j)) throw failure('Unknown header bytes');
      data[p - start] = cipher[p] ^ known.get(j);
    }
    return data;
  });
}

function packetDescriptors(data, unknownAt, checkpoint) {
  const allowance = memoryAllowance(data.length),
    packets = [];
  let chunks = [],
    size = 0,
    offset = 0,
    unknowns = [],
    unknownCount = 0,
    overhead = 0;
  const reserve = (bytes) => {
    overhead += bytes;
    if (overhead > allowance) throw failure('Packet metadata memory budget');
  };
  while (offset < data.length) {
    checkpoint();
    if (
      offset + 27 > data.length ||
      String.fromCharCode(...data.subarray(offset, offset + 4)) !== 'OggS'
    )
      throw failure('Invalid or unresolved Ogg framing');
    if (unknownAt(offset + 26) !== undefined) throw failure('Unknown lacing count');
    const count = data[offset + 26];
    let body = offset + 27 + count;
    if (body > data.length) throw rejected('Truncated page');
    for (let i = 0; i < count; i++) {
      if (unknownAt(offset + 27 + i) !== undefined) throw failure('Unknown lacing');
      const length = data[offset + 27 + i];
      if (body + length > data.length) throw rejected('Truncated packet');
      chunks.push(data.subarray(body, body + length));
      for (let j = 0; j < length; j++) {
        const variable = unknownAt(body + j);
        if (variable !== undefined) {
          if (++unknownCount > MAX_UNKNOWN_OCCURRENCES)
            throw failure('Unknown byte occurrence budget');
          reserve(64);
          unknowns.push([size + j, variable]);
        }
      }
      size += length;
      body += length;
      if (size > 131072) throw failure('Vorbis packet budget');
      if (length < 255) {
        reserve(256);
        const bytes = new Uint8Array(size);
        let pos = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, pos);
          pos += chunk.length;
        }
        packets.push({ bytes, unknowns });
        chunks = [];
        size = 0;
        unknowns = [];
        if (packets.length > 500000) throw failure('Vorbis packet count budget');
      }
    }
    if (body - offset > 65307 || body <= offset) throw rejected('Invalid Ogg page length');
    offset = body;
  }
  if (size) throw rejected('Incomplete final packet');
  return packets;
}

async function finishProfile(cipher, state, candidate, prefix, makeValidator, checkpoint) {
  memoryAllowance(cipher.length);
  // A stream cell never used by the file has no bearing on output uniqueness.
  const used = new Set(),
    sh = new Map(state.shifts),
    known = new Map(state.known);
  for (let p = 128; p < cipher.length; p++) {
    if ((p & 65535) === 0) checkpoint();
    const delta = sh.get(Math.floor(p / BLOCK));
    if (delta === undefined) throw failure('Missing segment');
    used.add((p % BLOCK) + delta);
  }
  for (let j = -candidate.reference; j < 5631 - candidate.reference; j++)
    if (!used.has(j) && !known.has(j)) known.set(j, 0);
  state = { ...state, known: [...known] };
  const r = completeStream(cipher, state, candidate, {
      system: true,
      checkpoint,
    }),
    { unknown, pivots, rhs } = r.system;
  const nbits = unknown.length * 8,
    free = Array.from({ length: nbits }, (_, i) => i).filter((i) => !pivots[i]);
  if (free.length > 12) throw failure('Audio stream is not uniquely recoverable within budget');
  const ids = new Map(unknown.map((j, i) => [j, i]));
  const unknownAt = (p) =>
    p < 128 ? undefined : ids.get((p % BLOCK) + sh.get(Math.floor(p / BLOCK)));
  const base = initialBytes(cipher, state, prefix, checkpoint),
    packets = packetDescriptors(base, unknownAt, checkpoint);
  if (packets.slice(0, 3).some((p) => p.unknowns.length)) throw failure('Unknown header bytes');
  const validator = makeValidator(packets.slice(0, 3).map((p) => p.bytes));
  let answer = null;
  try {
    const affected = [];
    for (const packet of packets.slice(3)) {
      checkpoint();
      if (packet.unknowns.length) affected.push(packet);
      else if (!validator.validatePacket(packet.bytes))
        throw rejected('Outside the complete Xiph VBR packet profile');
    }
    for (let f = 0; f < 2 ** free.length; f++) {
      checkpoint();
      const bits = new Uint8Array(nbits);
      free.forEach((p, i) => (bits[p] = (f >> i) & 1));
      for (let p = 0; p < nbits; p++)
        if (pivots[p]) {
          let v = rhs[p];
          for (let j = 0; j < p; j++) if ((pivots[p][j >>> 5] >>> (j & 31)) & 1) v ^= bits[j];
          bits[p] = v;
        }
      const values = unknown.map((_, i) => {
        let value = 0;
        for (let b = 0; b < 8; b++) value |= bits[i * 8 + b] << b;
        return value;
      });
      let valid = true;
      for (const packet of affected) {
        const bytes = packet.bytes.slice();
        for (const [p, i] of packet.unknowns) bytes[p] ^= values[i];
        if (!validator.validatePacket(bytes)) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      if (answer) throw failure('More than one complete audio candidate', 'ambiguous_recovery');
      answer = values;
    }
    if (!answer) throw rejected('No complete audio candidate');
    const result = base.slice();
    for (let p = 128; p < result.length; p++) {
      if ((p & 65535) === 0) checkpoint();
      const i = unknownAt(p);
      if (i !== undefined) result[p] ^= answer[i];
    }
    try {
      verifyRecoveredOgg(result);
    } catch (error) {
      if (error.code === 'file_only_unsupported')
        throw rejected('Invalid original Ogg checksums or framing');
      throw error;
    }
    return result;
  } finally {
    validator.dispose();
  }
}

export async function recoverShortOgg(cipher, onProgress = () => {}, options = {}) {
  memoryAllowance(cipher.length);
  const started = performance.now(),
    checkpoint =
      options.checkpoint ??
      (() => {
        if (performance.now() - started > 140000) {
          const e = new Error('文件分析超时');
          e.code = 'recovery_timeout';
          throw e;
        }
      });
  const report = (phase, state) => {
    checkpoint();
    options.onStage?.(phase, {
      known: state.known.length,
      shifts: state.shifts.length,
      pages: state.pages.length,
    });
  };
  let answer = null;
  for (const initial of recoverOggCandidates(cipher, checkpoint)) {
    let state = initial;
    try {
      report('structure', state);
      onProgress(0.2);
      for (let round = 0; round < 12; round++) {
        const before = signature(state),
          candidate = hashFor(cipher, state, checkpoint);
        state = improve(cipher, state, candidate, checkpoint);
        report('crc', state);
        if (signature(state) !== before) continue;
        if (state.shifts.length < Math.ceil(cipher.length / BLOCK)) {
          state = resolveShifts(cipher, state, candidate, checkpoint);
          report('segments', state);
          if (signature(state) !== before) continue;
          throw failure('Unresolved segments');
        }
        state = refineLacing(cipher, state, checkpoint);
        report('lacing', state);
        if (signature(state) === before) break;
      }
      if (state.shifts.length !== Math.ceil(cipher.length / BLOCK))
        throw failure('Unresolved segments');
      let candidate = hashFor(cipher, state, checkpoint);
      let prefix = solvePrefix(cipher, state, [candidate], {
        checkpoint,
      }).prefix;
      onProgress(0.5);
      const { createValidatorFactory } = await import('./vorbis-packet-validator.js');
      const make = options.validatorFactory ?? (await createValidatorFactory());
      // Initialize before using the two-mode, unrestricted-VBR window relations.
      const headerValidator = make(headerPackets(cipher, state, prefix));
      headerValidator.dispose();
      for (let round = 0; round < 6; round++) {
        const before = signature(state);
        state = refineLacing(cipher, state, checkpoint);
        state = improve(cipher, state, candidate, checkpoint);
        report('lacing-crc', state);
        if (signature(state) === before) break;
      }
      const { solveLacing } = await import('./file-only-ogg-sat.js');
      state = await solveLacing(cipher, state, candidate, checkpoint);
      state = improve(cipher, state, candidate, checkpoint);
      report('exact-lacing', state);
      onProgress(0.7);
      state = refineWindows(cipher, state, checkpoint);
      state = improve(cipher, state, candidate, checkpoint);
      report('windows', state);
      candidate = hashFor(cipher, state, checkpoint);
      prefix = solvePrefix(cipher, state, [candidate], { checkpoint }).prefix;
      const result = await finishProfile(cipher, state, candidate, prefix, make, checkpoint);
      if (answer && (!answer.every((v, i) => v === result[i]) || answer.length !== result.length)) {
        const e = new Error('Conflicting complete templates');
        e.code = 'ambiguous_recovery';
        throw e;
      }
      answer = result;
      onProgress(0.96);
    } catch (error) {
      if (!isRejected(error)) {
        if (
          error.code === 'recovery_timeout' ||
          error.code === 'ambiguous_recovery' ||
          error.code === 'recovery_unresolved'
        )
          throw error;
        throw failure(
          error.message ?? 'Candidate recovery unresolved',
          'recovery_unresolved',
          error,
        );
      }
      options.onError?.(error.message);
    }
  }
  if (!answer) {
    const e = new Error('此文件暂不支持免密钥转换');
    e.code = 'file_only_unsupported';
    throw e;
  }
  onProgress(1);
  return answer;
}
