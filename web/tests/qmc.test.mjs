import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { File } from 'node:buffer';
import { decryptFile, audioExtension, makeCipher, parseEkey, teaDecrypt } from '../src/qmc.js';

const fixtureRoot = new URL('./fixtures/', import.meta.url);
const vectors = JSON.parse(await readFile(new URL('vectors.json', fixtureRoot), 'utf8'));
const decode = (value) => new Uint8Array(Buffer.from(value, 'base64'));
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const uint32 = (value, littleEndian = true) => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, littleEndian);
  return data;
};
const file = (data, name = '测试.mflac') => new File([data], name);
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

for (const sample of vectors.cases) {
  test(`${sample.name}: embedded key matches Python byte for byte`, () => {
    assert.deepEqual(parseEkey(sample.ekey), decode(sample.key));
    assert.deepEqual(parseEkey(sample.ekey.replace(/=+$/, '')), decode(sample.key));
  });

  test(`${sample.name}: complete file matches Python byte for byte`, async () => {
    const input = await readFile(new URL(sample.file, fixtureRoot));
    const progress = [];
    const result = await decryptFile(file(input, `中文 ${sample.file}`), (fraction) => progress.push(fraction));
    assert.deepEqual(result.data, decode(sample.plain));
    assert.equal(result.extension, sample.extension);
    assert.equal(result.decrypted, true);
    assert.equal(result.name, `中文 ${sample.name}`);
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((fraction, index) => index === 0 || fraction >= progress[index - 1]));
  });

  test(`${sample.name}: arbitrary chunk boundaries retain Python cipher alignment`, () => {
    const cipher = makeCipher(decode(sample.key));
    const input = decode(sample.cipher);
    const boundaries = [0, 1, 7, 127, 128, 129, 5119, 5120, 5121, 10240, input.length];
    const valid = [...new Set(boundaries.filter((point) => point <= input.length))].sort((a, b) => a - b);
    for (let index = 0; index < valid.length - 1; index += 1) {
      cipher.decrypt(valid[index], input.subarray(valid[index], valid[index + 1]));
    }
    assert.deepEqual(input, decode(sample.plain));
  });
}

test('Tencent TEA matches Python and rejects malformed blocks/padding', () => {
  const sample = vectors.tea;
  assert.deepEqual(teaDecrypt(decode(sample.cipher), decode(sample.key)), decode(sample.plain));
  assert.equal(teaDecrypt(new Uint8Array(8), decode(sample.key)), null);
  assert.equal(teaDecrypt(new Uint8Array(17), decode(sample.key)), null);
  const damaged = decode(sample.cipher);
  damaged[damaged.length - 1] ^= 0xff;
  assert.equal(teaDecrypt(damaged, decode(sample.key)), null);
});

test('QTag uses big-endian length and accepts song id / flags after its ekey', async () => {
  const sample = vectors.cases[1];
  const key = new TextEncoder().encode(`${sample.ekey},123456,2`);
  const input = concat(decode(sample.cipher), key, uint32(key.length, false), new TextEncoder().encode('QTag'));
  const result = await decryptFile(file(input));
  assert.deepEqual(result.data, decode(sample.plain));
});

test('QTag fixtures independently contain big-endian length bytes', async () => {
  for (const sample of vectors.cases.filter(sample => sample.name.includes('qtag'))) {
    const input = await readFile(new URL(sample.file, fixtureRoot));
    const actual = input.subarray(input.length - 8, input.length - 4);
    const length = new TextEncoder().encode(sample.ekey).length;
    // Literal shifted bytes are independent of the fixture encoder/read helper.
    assert.deepEqual([...actual], [(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255]);
    assert.notDeepEqual([...actual], [length & 255, (length >>> 8) & 255, (length >>> 16) & 255, (length >>> 24) & 255]);
  }
});

test('incorrect little-endian QTag length is rejected, never accepted as V1', async () => {
  const sample = vectors.cases[1];
  const key = new TextEncoder().encode(`${sample.ekey},123456,2`);
  const input = concat(decode(sample.cipher), key, uint32(key.length, true), new TextEncoder().encode('QTag'));
  await rejectsCode(decryptFile(file(input)), 'invalid_footer');
});

test('valid plain audio passes through unchanged regardless of filename', async () => {
  const wav = new Uint8Array(await readFile(new URL('silence.wav', fixtureRoot)));
  for (const [extension, data] of [
    ['.wav', wav], ['.flac', new TextEncoder().encode('fLaC plain')],
    ['.ogg', new TextEncoder().encode('OggS plain')], ['.mp3', new TextEncoder().encode('ID3 plain')],
    ['.mp3', Uint8Array.of(0xff, 0xfb, 0x90, 0x64, 0, 0)],
  ]) {
    const result = await decryptFile(file(data, '音频.unknown'));
    assert.deepEqual(result.data, data);
    assert.equal(result.extension, extension);
    assert.equal(result.decrypted, false);
  }
  assert.equal(audioExtension(Uint8Array.of(0xff, 0xff, 0xff, 0xff)), null);
  assert.equal(audioExtension(new TextEncoder().encode('RIFFxxxxFAIL')), null);
});

test('valid encrypted FLAC audio decrypts to the original FLAC file', async () => {
  const expected = await readFile(new URL('silence.flac', fixtureRoot));
  for (const fixture of ['silence.mflac', 'silence-qtag.mflac']) {
    const source = await readFile(new URL(fixture, fixtureRoot));
    const result = await decryptFile(file(source, '静音 示例.mflac'));
    assert.deepEqual(result.data, new Uint8Array(expected));
    assert.equal(result.extension, '.flac');
    assert.equal(result.name, '静音 示例');
  }
});

test('musicex fails before reading the audio body or requesting credentials', async () => {
  const data = new Uint8Array(1024);
  new DataView(data.buffer).setUint32(data.length - 16, 168, true);
  data.set(new TextEncoder().encode('musicex\0'), data.length - 8);
  const original = file(data);
  const reads = [];
  const instrumented = {
    name: original.name,
    size: original.size,
    slice(start, end) {
      reads.push([start, end]);
      return original.slice(start, end);
    },
  };
  await rejectsCode(decryptFile(instrumented), 'external_key_required');
  assert.deepEqual(reads, [[0, 32], [1008, 1024]]);
});

test('empty, truncated, unknown and missing-key files give actionable failures', async () => {
  await rejectsCode(decryptFile(file(new Uint8Array())), 'empty_file');
  await rejectsCode(decryptFile(file(new Uint8Array([1, 2, 3]))), 'missing_key');
  await rejectsCode(decryptFile(file(new Uint8Array(40))), 'missing_key');
  await rejectsCode(decryptFile(file(new TextEncoder().encode('not audio'), 'readme.txt')), 'unsupported_format');
  await rejectsCode(decryptFile(null), 'invalid_file');
});

test('invalid QTag lengths are rejected without reading unbounded keys', async () => {
  for (const length of [0, 12, 16 * 1024 + 1, 0xffffffff]) {
    const input = concat(new Uint8Array(12), uint32(length, false), new TextEncoder().encode('QTag'));
    await rejectsCode(decryptFile(file(input)), 'invalid_footer');
  }
});

test('malformed musicex footer lengths are rejected', async () => {
  for (const length of [0, 8, 64, 0xffffffff]) {
    const data = new Uint8Array(64);
    new DataView(data.buffer).setUint32(48, length, true);
    data.set(new TextEncoder().encode('musicex\0'), 56);
    await rejectsCode(decryptFile(file(data)), 'invalid_footer');
  }
});

test('invalid base64, short keys and corrupt keys are rejected', async () => {
  for (const ekey of ['?', 'A', 'AAAAA', 'MTIzNDU2Nzg=garbage', 'abcd=']) {
    assert.throws(() => parseEkey(ekey), (error) => error.code === 'invalid_key');
  }
  const ciphertext = decode(vectors.cases[0].cipher);
  const short = new TextEncoder().encode('YQ==');
  await rejectsCode(decryptFile(file(concat(ciphertext, short, uint32(short.length)))), 'invalid_key');
  const wrong = new TextEncoder().encode('YWJjZGVmZ2g=');
  await rejectsCode(decryptFile(file(concat(ciphertext, wrong, uint32(wrong.length)))), 'decryption_failed');
});

test('large files decrypt across the asynchronous chunk boundary', async () => {
  const key = decode(vectors.cases[0].key);
  const data = new Uint8Array(600000);
  data.set(new TextEncoder().encode('fLaC'));
  for (let index = 4; index < data.length; index += 1) data[index] = index % 251;
  const encrypted = data.slice();
  makeCipher(key).decrypt(0, encrypted);
  const ekey = new TextEncoder().encode(vectors.cases[0].ekey);
  const progress = [];
  const result = await decryptFile(file(concat(encrypted, ekey, uint32(ekey.length))), (value) => progress.push(value));
  assert.deepEqual(result.data, data);
  assert.ok(progress.some((value) => value > 0 && value < 1));
});
