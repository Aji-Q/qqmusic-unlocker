import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseFlacHeader, parseFlacMetadata, verifyRecoveredFlac } from '../src/file-only-flac-verify.js';

// Independent bitwise reference CRCs and valid verbatim mono FLAC fixtures.
function crc(bytes, width, polynomial) {
  let result = 0;
  for (const byte of bytes) {
    result ^= byte << (width - 8);
    for (let bit = 0; bit < 8; bit += 1) result = ((result << 1) ^ ((result & (1 << (width - 1))) ? polynomial : 0)) & ((1 << width) - 1);
  }
  return result;
}
function codedNumber(number) {
  if (number < 128) return [number];
  const ranges = [0, 0, 2048, 65536, 2097152, 67108864, 2147483648, 68719476736];
  const length = ranges.findIndex((limit, i) => i >= 2 && number < limit);
  const bytes = new Array(length);
  for (let i = length - 1; i > 0; i -= 1) {
    bytes[i] = 128 + (number % 64);
    number = Math.floor(number / 64);
  }
  bytes[0] = (256 - (256 >> length)) + number;
  return bytes;
}
function header({ number = 0, samples = 32, variable = false, rate = 9, channel = 0, depth = 4, coded = null } = {}) {
  const bytes = [255, variable ? 249 : 248, (samples <= 256 ? 0x60 : 0x70) | rate, channel * 16 + depth * 2,
    ...(coded ?? codedNumber(number)), ...(samples <= 256 ? [samples - 1] : [(samples - 1) >> 8, (samples - 1) & 255])];
  if (rate === 12) bytes.push(44);
  if (rate === 13) bytes.push(172, 68);
  if (rate === 14) bytes.push(17, 58);
  return Buffer.from([...bytes, crc(bytes, 8, 7)]);
}
function frame(options = {}) {
  const samples = options.samples ?? 32;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16BE((i * 977 + (options.number ?? 0) * 331) % 32768, i * 2);
  if (options.embed) options.embed.copy(pcm, 4);
  const body = Buffer.concat([header(options), options.payload ?? Buffer.concat([Buffer.from([2]), pcm])]);
  const checksum = crc(body, 16, 0x8005);
  return { bytes: Buffer.concat([body, Buffer.from([checksum >> 8, checksum & 255])]), samples, pcm };
}
function bits(fields) {
  const binary = fields.map(([value, width]) => value.toString(2).padStart(width, '0')).join('');
  return Buffer.from(binary.padEnd(Math.ceil(binary.length / 8) * 8, '0').match(/.{8}/g).map(byte => parseInt(byte, 2)));
}
function fixture(frames = [frame(), frame({ number: 1, samples: 3 })], { total, minBlock = 32, maxBlock = 32, md5 = true, tail = [] } = {}) {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(minBlock, 0);
  info.writeUInt16BE(maxBlock, 2);
  const samples = total ?? frames.reduce((sum, f) => sum + f.samples, 0);
  info.writeBigUInt64BE((44100n << 44n) | (15n << 36n) | BigInt(samples), 10);
  if (md5) {
    const pcm = Buffer.concat(frames.map(f => Buffer.from(f.pcm).swap16()));
    createHash('md5').update(pcm).digest().copy(info, 18);
  }
  return Buffer.concat([Buffer.from([102, 76, 97, 67, 128, 0, 0, 34]), info, ...frames.map(f => f.bytes), Buffer.from(tail)]);
}
const rejects = input => assert.throws(() => verifyRecoveredFlac(input), error => error.code === 'file_only_unsupported');

test('original FLAC metadata, every frame checksum and a short last block are preserved', () => {
  const input = fixture();
  const output = verifyRecoveredFlac(input);
  assert.deepEqual(output, input);
  assert.equal(output.buffer, input.buffer, 'verification returns a view, not a rewritten file');
  const info = parseFlacMetadata(input);
  assert.equal(info.totalSamples, 35);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.audioOffset, 42);
});

test('exact syntax boundary, not CRC scanning, identifies <=15 trailing MusicEx bytes', () => {
  const audio = fixture();
  for (const tail of [Array(15).fill(0), Array.from({ length: 15 }, (_, i) => i + 1), [255]]) {
    assert.deepEqual(verifyRecoveredFlac(Buffer.concat([audio, Buffer.from(tail)])), audio);
  }
  rejects(Buffer.concat([audio, Buffer.alloc(16)]));
});

test('a legal zero STREAMINFO MD5 is not mistaken for a verified PCM digest', () => {
  const input = fixture(undefined, { md5: false });
  assert.deepEqual(verifyRecoveredFlac(input), input);
});

test('header-like audio payload does not create a false frame boundary', () => {
  const fakeFrame = frame({ number: 1, samples: 3 }).bytes;
  const input = fixture([frame({ embed: fakeFrame }), frame({ number: 1, samples: 3 })]);
  assert.deepEqual(verifyRecoveredFlac(input), input);
});

test('changing any original header/data/footer checksum byte or truncating audio fails', () => {
  const input = fixture();
  for (const offset of [42, 48, 49, 64, input.length - 2, input.length - 1]) {
    const damaged = Buffer.from(input);
    damaged[offset] ^= 1;
    rejects(damaged);
  }
  for (const missing of [1, 2, 5, 20]) rejects(input.subarray(0, input.length - missing));
});

test('CRC-valid sequence gaps, sample total errors, and nonfinal short blocks fail', () => {
  rejects(fixture([frame(), frame({ number: 2, samples: 3 })]));
  for (const total of [0, 34, 36, 999]) rejects(fixture(undefined, { total }));
  rejects(fixture([frame({ samples: 3 }), frame({ number: 1 })]));
  rejects(fixture([frame(), frame({ number: 1, samples: 16 }), frame({ number: 2, samples: 3 })], { minBlock: 16 }));
});

test('variable blocks use exact sample numbers and cannot switch blocking strategies', () => {
  const frames = [frame({ variable: true }), frame({ variable: true, number: 32, samples: 19 }), frame({ variable: true, number: 51, samples: 3 })];
  const input = fixture(frames, { minBlock: 16 });
  assert.deepEqual(verifyRecoveredFlac(input), input);
  rejects(fixture([frames[0], frame({ variable: true, number: 31, samples: 3 })]));
  rejects(fixture([frame(), frame({ variable: true, number: 32, samples: 3 })]));
});

test('all frame audio parameters must match original STREAMINFO', () => {
  for (const options of [{ rate: 10 }, { channel: 1 }, { depth: 6 }]) rejects(fixture([frame(options)]));
  const inherited = fixture([frame({ rate: 0, depth: 0 })]);
  assert.deepEqual(verifyRecoveredFlac(inherited), inherited);
});

test('reserved or impossible subframe syntax cannot pass using a correct CRC', () => {
  for (const payload of [[4], [128], [16, 192], [64, 0, 0, 240], [1, 0]]) rejects(fixture([frame({ payload: Buffer.from(payload) })]));
});

test('constant, wasted-bit, fixed predictor, LPC and both Rice methods parse their actual boundaries', () => {
  const payloads = [
    bits([[0, 8], [0, 16]]),
    bits([[1, 8], [1, 2], [0, 14]]), // constant with two wasted bits
    bits([[16, 8], [0, 2], [0, 4], [0, 4], ...Array(32).fill([1, 1])]),
    bits([[64, 8], [0, 16], [0, 4], [0, 5], [0, 1], [1, 2], [0, 4], [0, 5], ...Array(31).fill([1, 1])]),
    bits([[16, 8], [0, 2], [0, 4], [15, 4], [0, 5]]), // escaped zero-bit residual
  ];
  for (const payload of payloads) {
    const input = fixture([frame({ payload })]);
    assert.deepEqual(verifyRecoveredFlac(input), input);
  }
  const invalidPartition = bits([[18, 8], [0, 16], [0, 2], [5, 4], ...Array(32).fill([15, 4])]);
  rejects(fixture([frame({ payload: invalidPartition })]));
  const nonzeroAlignment = Buffer.from(payloads[2]);
  nonzeroAlignment[nonzeroAlignment.length - 1] |= 1;
  rejects(fixture([frame({ payload: nonzeroAlignment })]));
});

test('metadata has strict bounded structure and a single first STREAMINFO', () => {
  const input = fixture();
  for (const mutate of [
    data => { data[0] = 0; },
    data => { data[4] = 129; },
    data => { data[7] = 33; },
    data => { data[8] = 0; data[9] = 15; },
    data => { data[10] = 0; data[11] = 16; },
  ]) {
    const damaged = Buffer.from(input);
    mutate(damaged);
    rejects(damaged);
  }
  const first = Buffer.from(input.subarray(0, 42));
  first[4] = 0;
  rejects(Buffer.concat([first, input.subarray(4)]));
  rejects(Buffer.concat([first, Buffer.from([129, 255, 255, 255]), input.subarray(42)]));
  rejects(Buffer.concat([first, Buffer.from([129, 0, 0, 1, 1]), input.subarray(42)]));
  const validPadding = Buffer.concat([first, Buffer.from([129, 0, 0, 3, 0, 0, 0]), input.subarray(42)]);
  assert.deepEqual(verifyRecoveredFlac(validPadding), validPadding);
});

test('Vorbis comment lengths cannot escape their metadata block', () => {
  const input = fixture();
  const first = Buffer.from(input.subarray(0, 42));
  first[4] = 0;
  const comment = Buffer.from([132, 0, 0, 9, 1, 0, 0, 0, 65, 0, 0, 0, 0]);
  const valid = Buffer.concat([first, comment, input.subarray(42)]);
  assert.deepEqual(verifyRecoveredFlac(valid), valid);
  const bad = Buffer.from(valid);
  bad[46] = 255;
  rejects(bad);
});

test('frame parser accepts canonical extended integers and rejects overlong/reserved encodings', () => {
  for (const number of [0, 127, 128, 2047, 2048, 65535, 65536, 2097152, 67108864, 0x7fffffff]) {
    const parsed = parseFlacHeader(header({ number }));
    assert.equal(parsed?.frameNumber, number);
  }
  assert.equal(parseFlacHeader(header({ variable: true, number: 0xfffffffff }))?.sampleNumber, 0xfffffffff);
  assert.equal(parseFlacHeader(header({ number: 0x80000000 })), null);
  assert.equal(parseFlacHeader(header({ coded: [192, 128] })), null);
  assert.equal(parseFlacHeader(header({ coded: [254, 128, 128, 128, 128, 128, 128] })), null);
  for (const options of [{ rate: 15 }, { channel: 11 }, { depth: 3 }, { samples: 65536 }]) assert.equal(parseFlacHeader(header(options)), null);
  for (const rate of [12, 13, 14]) assert.ok(parseFlacHeader(header({ rate }))?.sampleRate);
});
