/** Recover a repeated QMC2 stream from public Vorbis structure, inside a Worker.
 * All hypotheses must still pass key reconstruction and ORIGINAL Ogg CRCs.
 * No filename, account data, cached key, or song-specific bytes are consulted.
 */
import { vorbisTemplates } from './vorbis-templates.js';

const BLOCK = 5120;
const MAX_SIZE = 100 * 1024 * 1024;
const MAX_PAGES = 100_000;
const MAX_ROUNDS = 48;
const MAX_MS = 90_000;
const MAGIC = [79, 103, 103, 83, 0];
const text = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const VENDORS = [
  text.encode('Xiph.Org libVorbis I 20150105 (\u26c4\u26c4\u26c4\u26c4)'),
  text.encode('Xiph.Org libVorbis I 20200704 (Reducing Environment)'),
];

function fail(message = '此文件暂不支持免密钥转换', code = 'file_only_unsupported') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function five(a, b, c, d, e) {
  return a * 0x100000000 + b * 0x1000000 + c * 0x10000 + d * 0x100 + e;
}
function u32(bytes, offset = 0) {
  return (
    (bytes[offset] +
      bytes[offset + 1] * 256 +
      bytes[offset + 2] * 65536 +
      bytes[offset + 3] * 16777216) >>>
    0
  );
}
function entries32(value, offset) {
  return [0, 1, 2, 3].map((i) => [offset + i, (value >>> (i * 8)) & 255]);
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte << 24;
  for (let bit = 0; bit < 8; bit += 1)
    value = ((value << 1) ^ (value & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  return value;
});

function seedCandidates(cipher, checkpoint) {
  const patterns = new Map();
  for (const vendor of VENDORS) {
    for (let count = 1; count <= 255; count += 1) {
      // The 30-byte identification packet occupies one 58-byte Ogg page.
      const commentStart = 58 + 27 + count;
      const vendorStart = commentStart + 11;
      const known = new Map();
      vendor.forEach((byte, i) => {
        if (vendorStart + i >= 128) known.set(vendorStart + i, cipher[vendorStart + i] ^ byte);
      });
      const hypothesis = { vendor, commentStart, known };
      for (const [j] of known) {
        if (![0, 1, 2, 3, 4].every((i) => known.has(j + i))) continue;
        const needle = five(...MAGIC.map((byte, i) => byte ^ known.get(j + i)));
        const values = patterns.get(needle) ?? [];
        values.push({ hypothesis, j });
        patterns.set(needle, values);
      }
    }
  }
  const candidates = [];
  let trials = 0;
  for (let segment = 1; segment * BLOCK < cipher.length; segment += 1) {
    checkpoint();
    const start = segment * BLOCK;
    const end = Math.min(1024, cipher.length - start - 27);
    for (let remainder = 0; remainder <= end; remainder += 1) {
      const off = start + remainder;
      const matched = patterns.get(
        five(cipher[off], cipher[off + 1], cipher[off + 2], cipher[off + 3], cipher[off + 4]),
      );
      if (!matched) continue;
      for (const { hypothesis, j } of matched) {
        trials += 1;
        if (trials > 100_000) fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
        const delta = j - remainder;
        if (Math.abs(delta) > 511) continue;
        const decode = (i) =>
          hypothesis.known.has(j + i) ? cipher[off + i] ^ hypothesis.known.get(j + i) : null;
        const serial = [14, 15, 16, 17].map(decode);
        if (serial.filter((v) => v !== null).length < 2) continue;
        let checks = 0;
        let valid = true;
        for (const i of [5, 10, 11, 12, 13, 21]) {
          const value = decode(i);
          if (value === null) continue;
          checks += 1;
          if ((i === 5 && value > 7) || (i !== 5 && value !== 0)) valid = false;
        }
        if (!valid || checks < 4) continue;
        const anchor = { offset: off, segment, shift_delta: delta, stream_start: j };
        const group = candidates.find(
          (candidate) =>
            candidate.commentStart === hypothesis.commentStart &&
            candidate.vendor === hypothesis.vendor &&
            candidate.serial.every(
              (value, i) => value === null || serial[i] === null || value === serial[i],
            ),
        );
        if (group) {
          serial.forEach((value, i) => {
            if (value !== null) group.serial[i] = value;
          });
          if (!group.anchors.some((item) => item.offset === off)) group.anchors.push(anchor);
        } else candidates.push({ ...hypothesis, serial, anchor, anchors: [anchor] });
        if (candidates.length > 16) fail('文件结构存在歧义，无法安全转换', 'recovery_unresolved');
      }
    }
  }
  return candidates;
}

class Recovery {
  constructor(cipher, seed, checkpoint) {
    this.cipher = cipher;
    this.seed = seed;
    this.serial = seed.serial;
    this.known = new Map(seed.known);
    this.shifts = new Map([[0, 0]]);
    this.pages = new Map();
    this.checkpoint = checkpoint;
    this.fixed = [
      ...MAGIC.map((v, i) => [i, v]),
      ...[10, 11, 12, 13, 21].map((i) => [i, 0]),
      ...seed.serial.flatMap((v, i) => (v === null ? [] : [[14 + i, v]])),
    ];
    this.low = 0;
    this.high = 0;
    for (const anchor of seed.anchors) {
      this.addPage(anchor.offset, anchor.segment, anchor.shift_delta);
      this.addExpected(anchor.offset, this.fixed);
    }
  }

  addKnown(index, value) {
    if (index < -511 || index >= BLOCK + 511) fail();
    if (this.known.has(index) && this.known.get(index) !== value) fail('文件结构校验失败');
    this.known.set(index, value);
  }
  clone() {
    const copy = Object.create(Recovery.prototype);
    Object.assign(copy, this);
    copy.known = new Map(this.known);
    copy.shifts = new Map(this.shifts);
    copy.pages = new Map(this.pages);
    copy.serial = this.serial.slice();
    copy.fixed = this.fixed.map((pair) => pair.slice());
    return copy;
  }
  setShift(segment, delta) {
    if (Math.max(this.high, delta) - Math.min(this.low, delta) > 511) fail('文件分段信息不一致');
    if (this.shifts.has(segment) && this.shifts.get(segment) !== delta) fail('文件分段信息不一致');
    this.shifts.set(segment, delta);
    this.low = Math.min(this.low, delta);
    this.high = Math.max(this.high, delta);
  }
  keyPosition(offset) {
    const segment = Math.floor(offset / BLOCK);
    if (offset < 128 || offset >= this.cipher.length || !this.shifts.has(segment)) return null;
    return (offset % BLOCK) + this.shifts.get(segment);
  }
  read(offset, count) {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      offset < 128 ||
      offset + count > this.cipher.length
    )
      return null;
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      const index = this.keyPosition(offset + i);
      if (index === null || !this.known.has(index)) return null;
      result[i] = this.cipher[offset + i] ^ this.known.get(index);
    }
    return result;
  }
  addExpected(offset, expected) {
    const additions = [];
    for (const [i, plain] of expected) {
      const index = this.keyPosition(offset + i);
      if (index === null) continue;
      const value = this.cipher[offset + i] ^ plain;
      if (this.known.has(index) && this.known.get(index) !== value) fail('文件结构校验失败');
      additions.push([index, value]);
    }
    for (const [index, value] of additions) this.addKnown(index, value);
  }
  addPage(offset, segment, delta) {
    this.setShift(segment, delta);
    if (!this.pages.has(offset)) {
      if (this.pages.size >= MAX_PAGES) fail('文件页数超过处理限制', 'recovery_unresolved');
      this.pages.set(offset, {
        offset,
        segment,
        shift_delta: delta,
        stream_start: (offset % BLOCK) + delta,
      });
    }
  }

  learnSerial() {
    for (let i = 0; i < 4; i += 1) {
      if (this.serial[i] !== null) continue;
      const values = new Set();
      for (const { offset } of this.pages.values()) {
        const value = this.read(offset + 14 + i, 1)?.[0];
        if (value !== undefined) values.add(value);
      }
      if (values.size > 1) fail('文件流编号不一致');
      if (values.size === 1) {
        this.serial[i] = [...values][0];
        this.fixed.push([14 + i, this.serial[i]]);
      }
    }
  }

  scan() {
    const patterns = new Map();
    let min = Infinity;
    let max = -Infinity;
    for (const [j] of this.known) {
      min = Math.min(min, j);
      max = Math.max(max, j);
      if (![0, 1, 2, 3, 4].every((i) => this.known.has(j + i))) continue;
      const key = five(...MAGIC.map((v, i) => v ^ this.known.get(j + i)));
      const values = patterns.get(key) ?? [];
      values.push(j);
      patterns.set(key, values);
    }
    const minR = Math.max(0, min - 511);
    const maxR = Math.min(BLOCK - 27, max + 511);
    let trials = 0;
    for (let segment = 1; segment * BLOCK < this.cipher.length; segment += 1) {
      this.checkpoint();
      const start = segment * BLOCK;
      const end = Math.min(maxR, this.cipher.length - start - 27);
      for (let r = minR; r <= end; r += 1) {
        const off = start + r;
        const c = this.cipher;
        const found = patterns.get(five(c[off], c[off + 1], c[off + 2], c[off + 3], c[off + 4]));
        if (!found) continue;
        for (const j of found) {
          trials += 1;
          if (trials > 500_000) fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
          const delta = j - r;
          if (Math.abs(delta) > 511 || Math.max(this.high, delta) - Math.min(this.low, delta) > 511)
            continue;
          let checks = 0;
          let valid = true;
          for (const [i, value] of this.fixed) {
            if (i < 5 || !this.known.has(j + i)) continue;
            checks += 1;
            if ((c[off + i] ^ this.known.get(j + i)) !== value) {
              valid = false;
              break;
            }
          }
          if (this.known.has(j + 5)) {
            checks += 1;
            if ((c[off + 5] ^ this.known.get(j + 5)) > 7) valid = false;
          }
          if (!valid || checks < 4) continue;
          this.addPage(off, segment, delta);
          this.addExpected(off, this.fixed);
        }
      }
    }
  }

  voteLacing() {
    const votes = new Map();
    let work = 0;
    for (const { offset } of this.pages.values()) {
      this.checkpoint();
      const count = this.read(offset + 26, 1)?.[0];
      if (!count || offset + 27 + count > this.cipher.length) continue;
      for (let i = 0; i < count; i += 1) {
        work += 1;
        if (work > 2_000_000) fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
        const at = offset + 27 + i;
        const j = this.keyPosition(at);
        if (j === null) continue;
        const value = this.cipher[at] ^ 255;
        const options = votes.get(j) ?? new Map();
        const segments = options.get(value) ?? new Set();
        segments.add(Math.floor(at / BLOCK));
        options.set(value, segments);
        votes.set(j, options);
      }
    }
    const additions = [];
    for (const [j, options] of votes) {
      const ranked = [...options].sort((a, b) => b[1].size - a[1].size);
      const [value, supporters] = ranked[0];
      const total = ranked.reduce((sum, entry) => sum + entry[1].size, 0);
      if (
        supporters.size < 4 ||
        supporters.size / total < 0.6 ||
        supporters.size - (ranked[1]?.[1].size ?? 0) < 2
      )
        continue;
      if (this.known.has(j) && this.known.get(j) !== value) fail('文件页表校验失败');
      additions.push([j, value]);
    }
    for (const [j, value] of additions) this.addKnown(j, value);
  }

  sequenceBounds() {
    const ordered = [...this.pages.values()].sort((a, b) => a.offset - b.offset);
    const complete = ordered
      .map((p) => ({ ...p, bytes: this.read(p.offset + 18, 4) }))
      .filter((p) => p.bytes)
      .map((p) => ({ ...p, sequence: u32(p.bytes) }));
    for (let i = 1; i < complete.length; i += 1)
      if (complete[i].sequence <= complete[i - 1].sequence) fail('文件页序不一致');
    let cursor = 0;
    let remainingWork = 2_000_000;
    for (const page of ordered) {
      this.checkpoint();
      if (this.read(page.offset + 18, 4)) continue;
      while (cursor < complete.length && complete[cursor].offset < page.offset) cursor += 1;
      const prev = complete[cursor - 1];
      const next = complete[cursor];
      let low = 0;
      let high = Math.floor(this.cipher.length / 27);
      if (prev) {
        low = prev.sequence + 1;
        high = Math.min(high, prev.sequence + Math.floor((page.offset - prev.offset) / 27));
      }
      if (next) {
        low = Math.max(low, next.sequence - Math.floor((next.offset - page.offset) / 27));
        high = Math.min(high, next.sequence - 1);
      }
      if (high - low > 200_000 || high - low + 1 > remainingWork) continue;
      remainingWork -= Math.max(0, high - low + 1);
      const bytes = [0, 1, 2, 3].map((i) => this.read(page.offset + 18 + i, 1)?.[0]);
      const options = [new Set(), new Set(), new Set(), new Set()];
      let count = 0;
      for (let value = low; value <= high; value += 1) {
        if (!bytes.every((b, i) => b === undefined || b === ((value >>> (i * 8)) & 255))) continue;
        count += 1;
        for (let i = 0; i < 4; i += 1) options[i].add((value >>> (i * 8)) & 255);
      }
      if (!count) fail('文件页序不一致');
      options.forEach((values, i) => {
        if (values.size === 1) this.addExpected(page.offset, [[18 + i, [...values][0]]]);
      });
    }
  }

  chainPages() {
    for (const { offset } of [...this.pages.values()]) {
      this.checkpoint();
      const header = this.read(offset, 27);
      if (!header) continue;
      const count = header[26];
      const lace = this.read(offset + 27, count);
      if (!count || !lace || header[5] & 4) continue;
      const length = 27 + count + lace.reduce((sum, v) => sum + v, 0);
      const end = offset + length;
      if (end === this.cipher.length) continue;
      if (end + 27 > this.cipher.length) fail('文件内容不完整');
      const sequence = u32(header, 18);
      if (sequence >= Math.floor(this.cipher.length / 27)) fail();
      const expected = [...this.fixed, ...entries32(sequence + 1, 18)];
      const segment = Math.floor(end / BLOCK);
      const remainder = end % BLOCK;
      if (!this.shifts.has(segment) && remainder + 27 <= BLOCK) {
        const candidates = [];
        for (let delta = this.high - 511; delta <= this.low + 511; delta += 1) {
          const checked = new Set();
          let valid = true;
          for (const [i, plain] of expected) {
            const j = remainder + i + delta;
            if (!this.known.has(j)) continue;
            if ((this.cipher[end + i] ^ this.known.get(j)) !== plain) {
              valid = false;
              break;
            }
            checked.add(i);
          }
          if (
            valid &&
            checked.size >= 8 &&
            [...checked].some((i) => i >= 14 && i < 18) &&
            [...checked].some((i) => i >= 18 && i < 22)
          )
            candidates.push(delta);
        }
        if (candidates.length === 1) this.setShift(segment, candidates[0]);
      }
      if (!this.shifts.has(segment)) continue;
      this.addExpected(end, expected);
      this.addPage(end, segment, this.shifts.get(segment));
    }
  }

  iterate(progress) {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      this.checkpoint();
      const old = `${this.known.size}:${this.pages.size}:${this.shifts.size}`;
      this.scan();
      this.learnSerial();
      this.sequenceBounds();
      this.chainPages();
      this.voteLacing();
      progress(round);
      if (old === `${this.known.size}:${this.pages.size}:${this.shifts.size}`) return;
    }
    fail('文件结构恢复未能收敛', 'recovery_unresolved');
  }

  setupPosition() {
    let pos = this.seed.commentStart + 11 + this.seed.vendor.length;
    const countBytes = this.read(pos, 4);
    if (!countBytes) return null;
    const count = u32(countBytes);
    pos += 4;
    if (count > 256) return null;
    for (let i = 0; i < count; i += 1) {
      const lengthBytes = this.read(pos, 4);
      if (!lengthBytes) return null;
      const length = u32(lengthBytes);
      pos += 4;
      if (length > 4096 || pos + length >= BLOCK) return null;
      const comment = this.read(pos, length);
      if (comment) {
        try {
          if (!utf8.decode(comment).includes('=')) return null;
        } catch {
          return null;
        }
      }
      pos += length;
    }
    const framing = this.read(pos, 1);
    const marker = this.read(pos + 1, 7);
    if (
      !framing ||
      framing[0] !== 1 ||
      !marker ||
      !marker.every((v, i) => v === [5, 118, 111, 114, 98, 105, 115][i])
    )
      return null;
    return pos + 1;
  }

  templateCandidates(start) {
    if (start === null) return [];
    const matching = [];
    for (const template of vorbisTemplates()) {
      if (start + template.bytes.length > BLOCK) continue;
      let matches = 0;
      let tailMatches = 0;
      let valid = true;
      for (let i = 7; i < template.bytes.length; i += 1) {
        if (!this.known.has(start + i)) continue;
        if ((this.cipher[start + i] ^ this.known.get(start + i)) !== template.bytes[i]) {
          valid = false;
          break;
        }
        matches += 1;
        if (i >= template.bytes.length - 256) tailMatches += 1;
      }
      if (valid && matches >= 48) matching.push({ template, tailMatches, matches });
    }
    return matching.sort((a, b) => b.tailMatches - a.tailMatches || b.matches - a.matches);
  }

  templatePositions() {
    if (this.seed.setup) return [this.seed.setup];
    const parsed = this.setupPosition();
    if (parsed !== null) return [parsed];
    const last = BLOCK - Math.min(...vorbisTemplates().map(({ bytes }) => bytes.length));
    const positions = [];
    // A missing comment-length byte need not hide an otherwise recognizable
    // public setup packet. Match the packet itself against independent bytes.
    for (let start = 128; start <= last; start += 1) {
      this.checkpoint();
      if (this.templateCandidates(start).length) positions.push(start);
    }
    return positions;
  }

  prefixCandidates() {
    const templates = vorbisTemplates();
    const prefixes = [
      ...new Map(
        templates.map(({ bytes }) => {
          const prefix = bytes.subarray(0, 64);
          return [Array.from(prefix).join(','), prefix];
        }),
      ).values(),
    ];
    const first = Math.max(128, this.seed.commentStart + 11 + this.seed.vendor.length + 4);
    const last = BLOCK - Math.min(...templates.map(({ bytes }) => bytes.length));
    const patterns = new Map();
    let patternCount = 0;
    for (let start = first; start <= last; start += 1) {
      this.checkpoint();
      for (const prefix of prefixes) {
        const stream = Uint8Array.from(prefix, (plain, i) => this.cipher[start + i] ^ plain);
        if (
          stream.some(
            (value, i) => this.known.has(start + i) && this.known.get(start + i) !== value,
          )
        )
          continue;
        for (let j = 0; j + 27 < stream.length; j += 1) {
          if (++patternCount > 500_000)
            fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
          const needle = five(...MAGIC.map((plain, i) => plain ^ stream[j + i]));
          const options = patterns.get(needle) ?? [];
          options.push({ start, stream, j });
          patterns.set(needle, options);
        }
      }
    }
    const found = new Map();
    let matches = 0;
    for (let segment = 1; segment * BLOCK < this.cipher.length; segment += 1) {
      this.checkpoint();
      const end = Math.min(BLOCK - 27, last + 64 + 511, this.cipher.length - segment * BLOCK - 27);
      for (let remainder = 0; remainder <= end; remainder += 1) {
        const off = segment * BLOCK + remainder;
        const c = this.cipher;
        const options = patterns.get(five(c[off], c[off + 1], c[off + 2], c[off + 3], c[off + 4]));
        if (!options) continue;
        for (const { start, stream, j } of options) {
          if (++matches > 100_000) fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
          const delta = start + j - remainder;
          if (Math.abs(delta) > 511 || Math.max(this.high, delta) - Math.min(this.low, delta) > 511)
            continue;
          if (
            !this.fixed.every(([i, plain]) => (c[off + i] ^ stream[j + i]) === plain) ||
            (c[off + 5] ^ stream[j + 5]) > 7
          )
            continue;
          const id = `${start}:${Array.from(stream).join(',')}`;
          const candidate = found.get(id) ?? { start, stream, anchors: [] };
          candidate.anchors.push({ offset: off, segment, delta });
          found.set(id, candidate);
          if (found.size > 16) fail('文件结构存在歧义，无法安全转换', 'recovery_unresolved');
        }
      }
    }
    return [...found.values()];
  }

  crcEvidence() {
    let valid = 0;
    let invalid = 0;
    const segments = new Set();
    for (const { offset, segment } of this.pages.values()) {
      this.checkpoint();
      const head = this.read(offset, 27);
      if (!head) continue;
      const lace = this.read(offset + 27, head[26]);
      if (!lace) continue;
      const length = 27 + lace.length + lace.reduce((sum, value) => sum + value, 0);
      const page = this.read(offset, length);
      if (!page) continue;
      const stored = u32(page, 22);
      let crc = 0;
      for (let i = 0; i < page.length; i += 1) {
        const byte = i >= 22 && i < 26 ? 0 : page[i];
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 255]) >>> 0;
      }
      if (crc === stored) {
        valid += 1;
        segments.add(segment);
      } else invalid += 1;
    }
    return { valid, invalid, segments: segments.size };
  }
}

/** Ciphertext is the audio body, with its musicex footer already removed. */
export function recoverOggStream(ciphertext, onProgress = () => {}) {
  if (!(ciphertext instanceof Uint8Array) || ciphertext.length < BLOCK * 3)
    fail('文件太短，无法识别此加密方式', 'invalid_data');
  if (ciphertext.length > MAX_SIZE) fail('免密钥转换支持 100 MB 以内的文件', 'file_too_large');
  const started = performance.now();
  const checkpoint = () => {
    if (performance.now() - started > MAX_MS)
      fail('文件分析超时，请尝试其他文件', 'recovery_timeout');
  };
  let lastProgress = 0;
  const progress = (value) => {
    lastProgress = Math.max(lastProgress, value);
    onProgress(lastProgress);
  };
  progress(0.02);
  const seeds = seedCandidates(ciphertext, checkpoint);
  if (!seeds.length) fail();
  let accepted = null;
  const tryTemplates = (state, start) => {
    for (const { template } of state.templateCandidates(start)) {
      checkpoint();
      try {
        const candidate = state.clone();
        template.bytes.forEach((plain, i) =>
          candidate.addKnown(start + i, ciphertext[start + i] ^ plain),
        );
        progress(0.52);
        candidate.iterate((round) => progress(Math.min(0.94, 0.58 + round * 0.025)));
        const residues = new Set([...candidate.shifts.keys()].map((segment) => segment & 511));
        if (candidate.known.size < 4096 || residues.size !== 512) continue;
        const evidence = candidate.crcEvidence();
        // This selects a public-template hypothesis only. The caller still
        // reconstructs the key and checks EVERY original CRC before acceptance.
        // Some valid short files have an unknown stream byte on every page.
        // Do not require a complete page here: key/PRGA reconstruction and the
        // caller's full original-CRC validation remain mandatory afterwards.
        if (evidence.invalid) continue;
        if (accepted) {
          if (
            [...candidate.known].every(
              ([j, value]) => !accepted.known.has(j) || accepted.known.get(j) === value,
            )
          )
            continue;
          fail('文件结构存在歧义，无法安全转换', 'invalid_data');
        }
        accepted = candidate;
      } catch (error) {
        if (error.code !== 'file_only_unsupported') throw error;
      }
    }
  };
  for (const seed of seeds) {
    checkpoint();
    try {
      const state = new Recovery(ciphertext, seed, checkpoint);
      state.iterate((round) => progress(Math.min(0.48, 0.08 + round * 0.025)));
      if (state.pages.size < 8 || state.known.size < 48 || state.serial.some((v) => v === null))
        continue;
      const before = accepted;
      for (const start of state.templatePositions()) tryTemplates(state, start);
      if (accepted === before) {
        // If the setup lies entirely in an unknown stream region, jointly
        // locate its public prefix and independent later Ogg page headers.
        for (const { start, stream, anchors } of state.prefixCandidates()) {
          try {
            const candidate = state.clone();
            stream.forEach((value, i) => candidate.addKnown(start + i, value));
            for (const anchor of anchors)
              candidate.addPage(anchor.offset, anchor.segment, anchor.delta);
            candidate.iterate(() => {});
            tryTemplates(candidate, start);
          } catch (error) {
            if (error.code !== 'file_only_unsupported') throw error;
          }
        }
      }
    } catch (error) {
      if (error.code === 'recovery_timeout') throw error;
      if (error.code !== 'file_only_unsupported') throw error;
    }
  }
  if (!accepted) fail();
  const range = [-accepted.low, 511 - accepted.high];
  progress(1);
  return {
    known: accepted.known,
    shifts: accepted.shifts,
    referenceShift: range[0] === range[1] ? range[0] : null,
    referenceShiftRange: range,
    serial: Uint8Array.from(accepted.serial),
    pages: [...accepted.pages.values()],
  };
}

function globalTemplateSeeds(cipher, checkpoint) {
  const templates = vorbisTemplates();
  const prefixLength = 128;
  const prefixes = [
    ...new Map(
      templates.map(({ bytes }) => [
        Array.from(bytes.subarray(0, prefixLength)).join(','),
        bytes.subarray(0, prefixLength),
      ]),
    ).values(),
  ];
  const first = 128,
    last = BLOCK - Math.min(...templates.map(({ bytes }) => bytes.length));
  const positions = prefixLength - 27;
  const patternCount = (last - first + 1) * prefixes.length * positions;
  if (patternCount > 1_000_000) fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
  let capacity = 1;
  while (capacity < patternCount * 2) capacity *= 2;
  const needles = new Float64Array(capacity),
    heads = new Uint32Array(capacity),
    next = new Uint32Array(patternCount);
  const mask = capacity - 1;
  const slotFor = (needle) => {
    let slot =
      (Math.imul(
        (needle >>> 0) ^ Math.imul(Math.floor(needle / 0x100000000), 0x85ebca6b),
        0x9e3779b1,
      ) >>>
        0) &
      mask;
    while (heads[slot] && needles[slot] !== needle) slot = (slot + 1) & mask;
    return slot;
  };
  let node = 0;
  for (let start = first; start <= last; start++)
    for (const prefix of prefixes) {
      checkpoint();
      const stream = Uint8Array.from(prefix, (plain, i) => cipher[start + i] ^ plain);
      for (let j = 0; j < positions; j++) {
        const needle = five(...MAGIC.map((plain, i) => plain ^ stream[j + i]));
        const slot = slotFor(needle);
        needles[slot] = needle;
        next[node] = heads[slot];
        heads[slot] = ++node;
      }
    }
  const found = new Map();
  let matches = 0;
  for (let segment = 1; segment * BLOCK < cipher.length; segment++) {
    checkpoint();
    const end = Math.min(
      BLOCK - 27,
      last + prefixLength + 511,
      cipher.length - segment * BLOCK - 27,
    );
    for (let remainder = 0; remainder <= end; remainder++) {
      const off = segment * BLOCK + remainder;
      const needle = five(
        cipher[off],
        cipher[off + 1],
        cipher[off + 2],
        cipher[off + 3],
        cipher[off + 4],
      );
      let option = heads[slotFor(needle)];
      while (option) {
        const index = option - 1;
        option = next[index];
        if (++matches > 100_000) fail('文件结构过于复杂，无法完成分析', 'recovery_unresolved');
        const j = index % positions,
          location = Math.floor(index / positions);
        const prefixIndex = location % prefixes.length,
          start = first + Math.floor(location / prefixes.length);
        const delta = start + j - remainder;
        if (Math.abs(delta) > 511) continue;
        const prefix = prefixes[prefixIndex];
        const decode = (i) => cipher[off + i] ^ cipher[start + j + i] ^ prefix[j + i];
        if ([10, 11, 12, 13, 21].some((i) => decode(i) !== 0) || decode(5) > 7) continue;
        const sequence = u32(Uint8Array.from([18, 19, 20, 21], decode));
        if (sequence < 2 || sequence > MAX_PAGES) continue;
        const serial = Array.from([14, 15, 16, 17], decode);
        const id = `${start}:${prefixIndex}:${serial.join(',')}`;
        const seed = found.get(id) ?? {
          setup: start,
          commentStart: 0,
          vendor: new Uint8Array(),
          known: new Map(Array.from(prefix, (v, i) => [start + i, cipher[start + i] ^ v])),
          serial,
          anchors: [],
        };
        if (!seed.anchors.some((a) => a.offset === off))
          seed.anchors.push({ offset: off, segment, shift_delta: delta, stream_start: start + j });
        found.set(id, seed);
        if (found.size > 16) fail('文件结构存在歧义，无法安全转换', 'recovery_unresolved');
      }
    }
  }
  return [...found.values()].sort((a, b) => b.anchors.length - a.anchors.length);
}

export function refineRecovery(cipher, observation, checkpoint = () => {}) {
  observation = discoverHeader(cipher, observation);
  const seed = {
    known: new Map(observation.known),
    serial: Array.from(observation.serial),
    anchors: [],
    vendor: Uint8Array.from(observation.header?.vendor ?? []),
    commentStart: observation.header?.commentStart ?? 0,
    setup:
      typeof observation.header?.setup === 'number'
        ? observation.header.setup
        : observation.header?.setup?.start,
  };

  const s = new Recovery(cipher, seed, checkpoint);
  s.shifts = new Map(observation.shifts);
  s.pages = new Map(observation.pages.map((x) => [x.offset, x]));
  s.low = Math.min(...s.shifts.values());
  s.high = Math.max(...s.shifts.values());
  const setup = observation.header?.setup;
  if (setup?.start && setup?.length) {
    const off = setup.start + setup.length,
      segment = Math.floor(off / BLOCK);
    if (s.shifts.has(segment)) {
      s.addPage(off, segment, s.shifts.get(segment));
      s.addExpected(off, [...s.fixed, [5, 0], ...entries32(2, 18)]);
    }
  }
  s.iterate(() => {});
  return discoverHeader(cipher, {
    ...observation,
    known: [...s.known],
    shifts: [...s.shifts],
    pages: [...s.pages.values()],
    serial: s.serial,
    referenceShiftRange: [-s.low, 511 - s.high],
    referenceShift: -s.low === 511 - s.high ? -s.low : null,
  });
}
export function discoverHeader(cipher, observation) {
  const known = new Map(observation.known),
    shifts = new Map(observation.shifts);
  const setupValue = observation.header?.setup;
  const setupStart = typeof setupValue === 'number' ? setupValue : setupValue?.start;
  const matching = [];
  for (const vendor of VENDORS)
    for (let count = 1; count <= 255; count++) {
      const commentStart = 85 + count,
        vendorStart = commentStart + 11;
      if (setupStart && vendorStart + vendor.length + 5 > setupStart) continue;
      let seen = 0,
        valid = true;
      for (let i = 0; i < vendor.length; i++) {
        const off = vendorStart + i;
        if (off < 128) continue;
        const segment = Math.floor(off / BLOCK);
        if (!shifts.has(segment)) continue;
        const j = (off % BLOCK) + shifts.get(segment);
        if (!known.has(j)) continue;
        seen++;
        if ((cipher[off] ^ known.get(j)) !== vendor[i]) {
          valid = false;
          break;
        }
      }
      if (valid && seen >= 20) matching.push({ commentStart, vendor });
    }
  const header = { ...observation.header };
  if (matching.length === 1) {
    const { commentStart, vendor } = matching[0];
    header.commentStart = commentStart;
    header.vendor = Array.from(vendor);
    const expected = [
      3,
      118,
      111,
      114,
      98,
      105,
      115,
      ...[0, 1, 2, 3].map((i) => (vendor.length >>> (8 * i)) & 255),
      ...vendor,
    ];
    expected.forEach((v, i) => {
      const off = commentStart + i;
      if (off < 128) return;
      const segment = Math.floor(off / BLOCK);
      if (!shifts.has(segment)) return;
      const j = (off % BLOCK) + shifts.get(segment),
        q = cipher[off] ^ v;
      if (known.has(j) && known.get(j) !== q) fail();
      known.set(j, q);
    });
  }
  if (setupStart) {
    const candidates = vorbisTemplates().filter(
      (t) =>
        setupStart + t.bytes.length <= BLOCK &&
        t.bytes.every(
          (v, i) =>
            !known.has(setupStart + i) ||
            (cipher[setupStart + i] ^ known.get(setupStart + i)) === v,
        ),
    );
    if (candidates.length === 1)
      header.setup = {
        start: setupStart,
        length: candidates[0].bytes.length,
        id: candidates[0].id,
      };
  }
  return { ...observation, known: [...known], header };
}

/** Bounded, lazy hypotheses for the short-file path. None is a decrypted file. */
export function* recoverOggCandidates(cipher, checkpoint = () => {}) {
  if (!(cipher instanceof Uint8Array) || cipher.length < BLOCK * 3 || cipher.length > MAX_SIZE)
    fail();
  const seen = new Set();
  let emitted = 0;
  function* templates(state, start) {
    for (const { template } of state.templateCandidates(start)) {
      checkpoint();
      try {
        const candidate = state.clone();
        template.bytes.forEach((plain, i) =>
          candidate.addKnown(start + i, cipher[start + i] ^ plain),
        );
        candidate.iterate(() => checkpoint());
        if (
          candidate.pages.size < 8 ||
          candidate.serial.some((v) => v === null) ||
          candidate.crcEvidence().invalid
        )
          continue;
        const id = `${start}:${template.id}:${candidate.serial.join(',')}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (++emitted > 12) fail('文件结构候选过多，无法安全转换', 'recovery_unresolved');
        yield discoverHeader(cipher, {
          known: [...candidate.known],
          shifts: [...candidate.shifts],
          pages: [...candidate.pages.values()],
          serial: candidate.serial,
          referenceShiftRange: [-candidate.low, 511 - candidate.high],
          header: {
            commentStart: candidate.seed.commentStart,
            vendor: [...candidate.seed.vendor],
            setup: { start, length: template.bytes.length, id: template.id },
          },
        });
      } catch (error) {
        if (error.code !== 'file_only_unsupported') throw error;
      }
    }
  }
  for (const makeSeeds of [seedCandidates, globalTemplateSeeds]) {
    for (const seed of makeSeeds(cipher, checkpoint)) {
      checkpoint();
      try {
        const state = new Recovery(cipher, seed, checkpoint);
        state.iterate(() => checkpoint());
        if (state.serial.some((v) => v === null)) continue;
        const before = emitted;
        for (const start of state.templatePositions()) yield* templates(state, start);
        if (emitted === before && !seed.setup) {
          for (const { start, stream, anchors } of state.prefixCandidates()) {
            try {
              const candidate = state.clone();
              stream.forEach((value, i) => candidate.addKnown(start + i, value));
              for (const anchor of anchors)
                candidate.addPage(anchor.offset, anchor.segment, anchor.delta);
              candidate.iterate(() => checkpoint());
              yield* templates(candidate, start);
            } catch (error) {
              if (error.code !== 'file_only_unsupported') throw error;
            }
          }
        }
      } catch (error) {
        if (error.code !== 'file_only_unsupported') throw error;
      }
    }
  }
}
