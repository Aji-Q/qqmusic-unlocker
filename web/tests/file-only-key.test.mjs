import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Rc4Cipher } from '../src/qmc.js';
import { recoverFileKey, recoverHashCandidates, recoverKeyFromCandidates, verifyRecoveredOgg } from '../src/file-only-key.js';

function observation(seed, { firstByte, zeroIndices = [], segments = 1900 } = {}) {
  let random = seed;
  const key = Uint8Array.from({ length: 512 }, () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return 1 + (random % 255);
  });
  if (firstByte !== undefined) key[0] = firstByte;
  for (const index of zeroIndices) key[index] = 0;
  const cipher = new Rc4Cipher(key);
  const reference = cipher.segmentKey(0, key[0]) & 511;
  const shifts = new Map(Array.from({ length: segments }, (_, segment) => [
    segment, (cipher.segmentKey(segment, key[segment & 511]) & 511) - reference,
  ]));
  const data = new Uint8Array(5120);
  cipher.decrypt(0, data);
  const known = new Map(Array.from({ length: 4992 }, (_, i) => [i + 128, data[i + 128]]));
  return { key, known, shifts, cipher };
}

test('zero first seed uses another repeated group and retains other zero key bytes', () => {
  const { key, known, shifts } = observation(7, { firstByte: 0, zeroIndices: [31, 511] });
  assert.deepEqual(recoverFileKey({ known, shifts }), key);
});

test('IEEE-double skip rounding does not lose a valid integer-boundary hash', () => {
  const { key, known, shifts, cipher } = observation(27, { firstByte: 25 });
  const rationalFloor = Number(BigInt(cipher.hash) * 100n / BigInt(key[0]));
  assert.notEqual(rationalFloor, cipher.segmentKey(0, key[0]), 'fixture must exercise rounding');
  assert.deepEqual(recoverFileKey({ known, shifts }), key);
});

test('recovery stops when its time budget expires', (context) => {
  const { known, shifts } = observation(7);
  let now = 0;
  context.mock.method(performance, 'now', () => { now += 30_001; return now; });
  assert.throws(() => recoverFileKey({ known, shifts }), error => error.code === 'file_only_unsupported');
});

test('non-finite and out-of-range segment observations are rejected before searching', () => {
  const { known, shifts } = observation(7);
  shifts.set(Infinity, 0);
  assert.throws(() => recoverFileKey({ known, shifts }), error => error.code === 'file_only_unsupported');
  shifts.delete(Infinity);
  shifts.set(100 * 1024 * 1024 / 5120, 0);
  assert.throws(() => recoverFileKey({ known, shifts }), error => error.code === 'file_only_unsupported');
});

for (const seed of [7, 431, 2026]) {
  test(`recover an unrelated 512-byte key from repeated skips (${seed})`, () => {
    const { key, known, shifts } = observation(seed);
    assert.deepEqual(recoverFileKey({ known, shifts }), key);
  });
}

for (const [seed, segments] of [[7, 1187], [431, 1370], [1, 1370]]) {
  test(`three repeats recover a shorter file without retaining hash aliases (${seed}/${segments})`, () => {
    const { key, known, shifts } = observation(seed, { segments });
    assert.deepEqual(recoverFileKey({ known, shifts }), key);
  });
}

test('shorter files retain zero seeds and IEEE-rounding checks', () => {
  for (const options of [{ firstByte: 0, zeroIndices: [31, 511] }, { firstByte: 25 }]) {
    const { key, known, shifts } = observation(27, { ...options, segments: 1187 });
    assert.deepEqual(recoverFileKey({ known, shifts }), key);
  }
});

test('wrong inferred stream never accepts a merely plausible hash or header', () => {
  const { known, shifts } = observation(7);
  known.set(700, known.get(700) ^ 1);
  assert.throws(() => recoverFileKey({ known, shifts }), error => error.code === 'file_only_unsupported');
});

test('sparse seed observations are resolved against the independently inferred stream', () => {
  const { key, known, shifts } = observation(7);
  for (const segment of shifts.keys()) {
    if (segment >= 512 && (segment & 511) >= 100 && (segment & 511) <= 105) shifts.delete(segment);
  }
  assert.deepEqual(recoverFileKey({ known, shifts }), key);
});

test('insufficient segment reuse fails without credentials or guessed key bytes', () => {
  const { known, shifts } = observation(7);
  for (const segment of shifts.keys()) if (segment >= 1024) shifts.delete(segment);
  assert.throws(() => recoverFileKey({ known, shifts }), error => error.code === 'file_only_unsupported');
});

test('partial candidates preserve a missing seed group until independently inferred stream resolves it', () => {
  const { key, known, shifts } = observation(431);
  for (const segment of shifts.keys()) if ((segment & 511) === 400) shifts.delete(segment);
  assert.throws(() => recoverFileKey({ known, shifts }), error => error.code === 'file_only_unsupported');
  const candidates = recoverHashCandidates({ known, shifts });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].groups[400], 0);
  assert.equal(candidates[0].choices[400].length, 256);
  assert.deepEqual(recoverKeyFromCandidates({ known, candidates }), key);
  known.set(700, known.get(700) ^ 1);
  assert.throws(() => recoverKeyFromCandidates({ known, candidates }), error => error.code === 'file_only_unsupported');
});

test('candidate completion rejects invalid or unbounded seed choices', () => {
  const { key, known, cipher } = observation(7);
  const candidate = {
    hash: cipher.hash,
    reference: cipher.segmentKey(0, key[0]) & 511,
    choices: Array.from(key, value => [value]),
  };
  assert.deepEqual(recoverKeyFromCandidates({ known, candidates: [candidate] }), key);
  candidate.choices[0] = [Infinity];
  assert.throws(() => recoverKeyFromCandidates({ known, candidates: [candidate] }));
  for (let i = 0; i < 2; i += 1) candidate.choices[i] = Array.from({ length: 256 }, (_, value) => value);
  assert.throws(() => recoverKeyFromCandidates({ known, candidates: [candidate] }));
});

test('all original Ogg CRCs, including the first page, are mandatory', async () => {
  const input = new Uint8Array(await readFile(new URL('./fixtures/synthetic-control.ogg', import.meta.url)));
  assert.deepEqual(verifyRecoveredOgg(input), { pages: 4 });
  for (const offset of [22, 40, input.length - 1]) {
    const damaged = input.slice();
    damaged[offset] ^= 1;
    assert.throws(() => verifyRecoveredOgg(damaged), error => error.code === 'file_only_unsupported');
  }
  assert.throws(() => verifyRecoveredOgg(input.subarray(0, input.length - 1)));
  const extra = new Uint8Array(input.length + 1);
  extra.set(input);
  assert.throws(() => verifyRecoveredOgg(extra));
});
